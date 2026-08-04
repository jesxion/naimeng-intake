/**
 * 耐萌达人资料录入工具 —— 本地 Web 服务
 *
 * 零第三方依赖，只用 Node 内置模块。
 *   node server.js       启动
 *   node --watch server.js  开发模式
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './lib/db.js';
import { extract, agentReady, agentConfig, testConnection, PROMPT_VERSION } from './lib/agent.js';
import { normalize, validateForSubmit, sanitizeForStore } from './lib/rules.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');

/* -------------------------------------------------------------- .env 读取 */
(function loadEnv() {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
})();

const PORT = Number(process.env.PORT || 5173);

/* -------------------------------------------------------------- 工具 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const userOf = (req) => db.currentUser(req.headers['x-user-id']);

/** 写操作前确认已经在设置里填了身份，否则归属和留痕会没有指向 */
function requireUser(req) {
  const u = userOf(req);
  if (!u) throw httpError(428, '请先在「设置 → 用户设置」里填写你的姓名和角色');
  return u;
}

/* -------------------------------------------------------------- 识别流水线 */

/** 把一段原文跑完整条识别链路：Agent 抽取 → 规则规整 → 查重 */
async function runPipeline(rawText, previousExtracted = null) {
  const started = Date.now();
  const result = await extract(rawText, previousExtracted);
  const { form, fieldMeta, warnings, ignored } = normalize(result.data);
  const conflicts = db.findConflicts(form.accounts, form.recipient.phone);

  if (conflicts.hard.length) {
    warnings.unshift({
      level: 'error', code: 'DUPLICATE_ACCOUNT',
      title: `检测到 ${conflicts.hard.length} 个已存在的账号`,
      detail: '同一抖音号或 UID 已归属其他记录，禁止重复创建。',
      conflicts: conflicts.hard,
    });
  }
  if (conflicts.soft.length) {
    warnings.push({
      level: 'info', code: 'SAME_PHONE_HINT',
      title: '发现手机号相同的已有达人',
      detail: '真实资料中同一达人的多个账号常分多次发来，可考虑合并到已有记录。',
      items: conflicts.soft.map((s) => `${s.creatorName}（归属 ${s.owner}）`),
    });
  }

  return {
    mode: result.mode,
    model: result.model,
    promptVersion: result.promptVersion,
    elapsedMs: Date.now() - started,
    usage: result.usage || null,
    extracted: result.data,
    form, fieldMeta, warnings, ignored, conflicts,
  };
}

/* -------------------------------------------------------------- 后台任务 */

const maxConcurrent = () => Math.max(1, Math.min(10, agentConfig().concurrency || 3));
let pumping = false;

/** 取出排队任务并发执行。识别慢也不阻塞商务继续粘贴下一个达人。 */
function pump() {
  if (pumping) return;
  pumping = true;
  queueMicrotask(async () => {
    try {
      const slots = maxConcurrent() - db.runningCount();
      if (slots <= 0) return;
      const jobs = db.claimQueuedJobs(slots);
      for (const job of jobs) {
        runPipeline(job.rawText)
          .then((r) => db.updateJob(job.id, {
            status: 'done', result: r, error: null,
            finishedAt: new Date().toISOString(),
            elapsedMs: r.elapsedMs,
            title: r.form?.name || r.form?.accounts?.[0]?.nickname || job.title,
            _pid: false,
          }))
          .catch((e) => db.updateJob(job.id, {
            status: 'failed', error: e.message || '识别失败',
            finishedAt: new Date().toISOString(), _pid: false,
          }))
          .finally(() => { pumping = false; pump(); });
      }
    } finally {
      pumping = false;
    }
  });
}

/* -------------------------------------------------------------- 路由 */

const routes = {

  'GET /api/config': async (req) => {
    const s = db.getSettings();
    const cfg = agentConfig();
    const me = userOf(req);
    return {
      agentReady: agentReady(),
      model: agentReady() ? cfg.model : 'local-mock',
      baseUrl: agentReady() ? cfg.baseUrl : null,
      apiStyle: cfg.apiStyle,
      promptVersion: PROMPT_VERSION,
      concurrency: maxConcurrent(),
      roles: db.ROLES,
      needsSetup: !me,
      me: me ? { id: me.id, name: me.name, role: me.role } : null,
      settings: {
        user: { ...s.user },
        model: {
          provider: s.model.provider || '',
          baseUrl: s.model.baseUrl || '',
          model: s.model.model || '',
          apiStyle: cfg.apiStyle,
          concurrency: s.model.concurrency ?? 3,
          timeoutMs: s.model.timeoutMs ?? 60000,
          // 不回传明文 key，只告诉前端有没有配
          hasApiKey: Boolean(s.model.apiKey),
          apiKeyMasked: s.model.apiKey ? s.model.apiKey.slice(0, 3) + '••••' + s.model.apiKey.slice(-4) : '',
          fromEnv: !s.model.baseUrl && Boolean(process.env.LLM_BASE_URL),
        },
      },
      stats: db.stats(),
    };
  },

  'PUT /api/settings': async (req) => {
    const patch = await readBody(req);
    if (patch.user) {
      const name = String(patch.user.name || '').trim();
      if (!name) throw httpError(400, '请填写姓名');
      const roles = db.ROLES.map((r) => r.id);
      if (!roles.includes(patch.user.role)) throw httpError(400, '角色不合法');
    }
    const s = db.saveSettings(patch);
    pump(); // 并发数或模型可能变了，推一下队列
    return { ok: true, settings: { user: s.user }, agentReady: agentReady() };
  },

  'POST /api/settings/test': async (req) => {
    const body = await readBody(req);
    const override = {};
    if (body.baseUrl) override.baseUrl = String(body.baseUrl).replace(/\/+$/, '');
    if (body.model) override.model = body.model;
    if (body.apiStyle) override.apiStyle = body.apiStyle === 'responses' ? 'responses' : 'chat';
    if (body.apiKey && !/^\*+$/.test(body.apiKey)) override.apiKey = body.apiKey;
    return await testConnection(Object.keys(override).length ? override : null);
  },

  /* 同步识别：用于确认页里的「合并新片段」，此时商务正在等结果 */
  'POST /api/extract': async (req) => {
    const { rawText, previousExtracted } = await readBody(req);
    const text = String(rawText || '').trim();
    if (!text) throw httpError(400, '请先粘贴微信资料');
    try {
      return await runPipeline(text, previousExtracted || null);
    } catch (e) {
      throw httpError(502, `识别失败：${e.message}`);
    }
  },

  /* 异步识别：提交即返回，后台跑，商务可继续粘贴下一个达人 */
  'POST /api/jobs': async (req) => {
    const { rawText } = await readBody(req);
    const text = String(rawText || '').trim();
    if (!text) throw httpError(400, '请先粘贴微信资料');
    const job = db.createJob({ ownerUserId: requireUser(req).id, rawText: text });
    pump();
    return { job };
  },

  'GET /api/jobs': async (req) => {
    const me = userOf(req);
    if (!me) return { jobs: [], running: 0, concurrency: maxConcurrent() };
    const raw = db.listJobs(me.id);

    // 队列内交叉查重：同一批里可能把同一个达人粘了两次，两条都还没入库，
    // 只查数据库是发现不了的。这里按抖音号 / UID 在待确认任务之间比对。
    const keyOwners = new Map();
    for (const j of raw) {
      if (j.status !== 'done' || !j.result) continue;
      for (const a of j.result.form?.accounts || []) {
        for (const k of [a.uid, a.douyinId].filter(Boolean)) {
          if (!keyOwners.has(k)) keyOwners.set(k, []);
          keyOwners.get(k).push(j.id);
        }
      }
    }

    const jobs = raw.map(({ result, ...j }) => {
      let dupInQueue = null;
      let dupInDb = null;
      if (result) {
        const keys = (result.form?.accounts || []).flatMap((a) => [a.uid, a.douyinId]).filter(Boolean);
        const others = [...new Set(keys.flatMap((k) => (keyOwners.get(k) || []).filter((id) => id !== j.id)))];
        if (others.length) {
          const hitKey = keys.find((k) => (keyOwners.get(k) || []).length > 1);
          dupInQueue = { jobIds: others, key: hitKey };
        }
        // 实时查库：识别时算出的告警会过期（同批里另一条可能刚刚入库）
        const hit = db.findConflicts(result.form?.accounts || []).hard[0];
        if (hit) {
          dupInDb = {
            key: hit.existing.uid || hit.existing.douyinId,
            creatorId: hit.existing.creatorId,
            creatorName: hit.existing.creatorName || hit.existing.nickname,
            owner: hit.existing.owner,
          };
        }
      }
      return {
        ...j,
        // 列表不返回完整结果，避免响应过大；点开时再取
        summary: result ? {
          name: result.form?.name || '',
          accounts: (result.form?.accounts || []).length,
          missing: countMissing(result.form),
          alerts: (result.warnings || []).filter((w) => w.level !== 'info').length,
          model: result.mode === 'llm' ? result.model : '本地模拟',
          tokens: result.usage?.total_tokens || null,
          dupInDb,
          dupInQueue,
        } : null,
      };
    });
    return { jobs, running: db.runningCount(), concurrency: maxConcurrent() };
  },

  'GET /api/jobs/:id': async (req, p) => {
    const j = db.getJob(p.id);
    if (!j) throw httpError(404, '任务不存在');
    return { job: j };
  },

  'DELETE /api/jobs/:id': async (req, p) => ({ ok: db.deleteJob(p.id) }),

  'POST /api/jobs/:id/retry': async (req, p) => {
    const j = db.getJob(p.id);
    if (!j) throw httpError(404, '任务不存在');
    db.updateJob(p.id, { status: 'queued', error: null, startedAt: null, finishedAt: null, _pid: false });
    pump();
    return { job: db.getJob(p.id) };
  },

  /* 草稿 */
  'GET /api/drafts': async (req) => {
    const me = userOf(req);
    return { drafts: me ? db.listDrafts(me.id) : [] };
  },

  'POST /api/drafts': async (req) => {
    const body = await readBody(req);
    const d = db.saveDraft({
      id: body.id || null,
      ownerUserId: requireUser(req).id,
      rawText: body.rawText || '',
      form: body.form || null,
      extracted: body.extracted || null,
    });
    return { draft: d };
  },

  'GET /api/drafts/:id': async (req, p) => {
    const d = db.getDraft(p.id);
    if (!d) throw httpError(404, '草稿不存在');
    return { draft: d };
  },

  'DELETE /api/drafts/:id': async (req, p) => ({ ok: db.deleteDraft(p.id) }),

  /* 入库 */
  'POST /api/creators': async (req) => {
    const body = await readBody(req);
    const user = requireUser(req);
    const form = sanitizeForStore(body.form || {});

    const v = validateForSubmit(form);
    if (!v.ok) throw httpError(400, v.blocking.join('；'));

    const conflicts = db.findConflicts(form.accounts, form.recipient.phone);
    if (conflicts.hard.length && !body.forceIgnoreConflict) {
      throw httpError(409, '账号已存在，禁止重复创建', { conflicts: conflicts.hard });
    }

    const creator = db.createCreator(form, user.id);

    db.appendIntakeLog({
      creatorId: creator.id,
      rawText: body.rawText || '',
      extracted: body.extracted || null,
      model: body.model || 'unknown',
      mode: body.mode || 'unknown',
      promptVersion: body.promptVersion || PROMPT_VERSION,
      diff: db.diffExtractedVsForm(body.extracted, body.form),
      confirmedBy: user.id,
      confirmedByName: user.name,
      confirmedAt: new Date().toISOString(),
      elapsedMs: body.elapsedMs ?? null,
    });

    if (body.draftId) db.deleteDraft(body.draftId);

    return { creator: db.getCreator(creator.id), soft: v.soft };
  },

  'GET /api/creators': async (req, p, url) => ({
    creators: db.listCreators({ q: url.searchParams.get('q') || '' }),
    stats: db.stats(),
  }),

  'GET /api/creators/:id': async (req, p) => {
    const c = db.getCreator(p.id);
    if (!c) throw httpError(404, '记录不存在');
    return { creator: c };
  },
};

/** 统计表单里还有多少空字段，用于任务列表上的「待补充 N 项」 */
function countMissing(form) {
  if (!form) return 0;
  let n = 0;
  const chk = (v) => { if (!String(v ?? '').trim()) n++; };
  chk(form.name);
  for (const a of form.accounts || []) { chk(a.nickname); chk(a.douyinId); chk(a.uid); chk(a.cooperationCode); }
  if (form.cooperationType !== '直播定向') {
    chk(form.recipient?.name); chk(form.recipient?.phone); chk(form.recipient?.address);
  }
  return n;
}

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

function match(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pa = pattern.split('/').filter(Boolean);
    const pb = pathname.split('/').filter(Boolean);
    if (pa.length !== pb.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pa.length; i++) {
      if (pa[i].startsWith(':')) params[pa[i].slice(1)] = decodeURIComponent(pb[i]);
      else if (pa[i] !== pb[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[key], params };
  }
  return null;
}

/* -------------------------------------------------------------- 服务 */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const hit = match(req.method, pathname);
    if (!hit) return send(res, 404, { error: '接口不存在' });
    try {
      const data = await hit.handler(req, hit.params, url);
      return send(res, 200, data);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[api]', pathname, e);
      return send(res, status, { error: e.message || '服务器错误', ...(e.extra || {}) });
    }
  }

  // 静态文件
  let file = pathname === '/' ? '/index.html' : pathname;
  const target = join(PUBLIC, normPath(file).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC) || !existsSync(target)) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  return send(res, 200, readFileSync(target), { 'Content-Type': type });
});

server.listen(PORT, () => {
  const ready = agentReady();
  const stale = db.resetStaleJobs(); // 上次进程残留的任务复位重跑
  if (stale) console.log(`  恢复    ${stale} 条中断的识别任务`);
  pump();
  console.log('');
  console.log('  耐萌达人资料录入工具');
  console.log('  ─────────────────────────────────────────');
  console.log(`  地址    http://localhost:${PORT}`);
  console.log(`  识别    ${ready ? `${agentConfig().model} @ ${agentConfig().baseUrl}` : '本地模拟（未配置 LLM_API_KEY）'}`);
  console.log(`  并发    ${maxConcurrent()} 条同时识别（可在设置页调整）`);
  console.log(`  数据    ./data/db.json`);
  if (!ready) {
    console.log('');
    console.log('  提示：复制 .env.example 为 .env 并填入 LLM_API_KEY，即可切换到真实模型识别。');
  }
  console.log('');
});
