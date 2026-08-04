/**
 * 耐萌 · 商务动作入口 —— 本地 Web 服务
 *
 * 零第三方依赖，只用 Node 内置模块。
 *   node server.js          启动
 *   node --watch server.js  开发模式
 *   node --test tests/      跑回归
 *
 * 身份只有一个入口：userOf(req)。现在读设置，将来读 token。
 * 代码里任何其他地方不得出现第二种「当前用户」取法。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './lib/db.js';
import { extract, agentReady, agentConfig, visionReady, testConnection, PROMPT_VERSION } from './lib/agent.js';
import {
  normalize, sanitizeForStore, validateForAction, validateVideoSubmit,
  routeInput, parseVideoToken, buildTodos, renderNotifyText,
} from './lib/rules.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');

/* -------------------------------------------------------------- .env */
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit = 12_000_000) {   // 截图 base64 可能较大
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

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

/** 身份唯一入口 */
const userOf = (req) => db.currentUser(req.headers['x-user-id']);

function requireUser(req) {
  const u = userOf(req);
  if (!u) throw httpError(428, '请先在「设置 → 用户设置」里填写你的姓名和角色');
  return u;
}

/* -------------------------------------------------------------- 识别流水线 */

async function runIntake(rawText, previousExtracted = null) {
  const started = Date.now();
  const result = await extract(rawText, previousExtracted);
  const { form, fieldMeta, warnings, ignored } = normalize(result.data);
  const conflicts = db.findConflicts(form.accounts, form.recipient.phone);

  if (conflicts.hard.length) {
    warnings.unshift({
      level: 'error', code: 'DUPLICATE_ACCOUNT',
      title: `该账号已属于「${conflicts.hard[0].existing.creatorName}」`,
      detail: '同一抖音号或 UID 已归属已有达人。若这是同一达人的新合作或新账号，请用「发起新合作」，不要新建达人。',
      conflicts: conflicts.hard,
    });
  }
  if (conflicts.soft.length) {
    warnings.push({
      level: 'info', code: 'SAME_PHONE_HINT',
      title: '发现手机号相同的已有达人',
      detail: '同一达人的多个账号常分多次发来，可考虑合并到已有记录。',
      items: conflicts.soft.map((s) => `${s.creatorName}（归属 ${s.owner}）`),
    });
  }

  return {
    kind: 'intake',
    mode: result.mode, model: result.model, promptVersion: result.promptVersion,
    elapsedMs: Date.now() - started, usage: result.usage || null,
    extracted: result.data, form, fieldMeta, warnings, ignored, conflicts,
  };
}

/** 视频口令：纯本地正则，不调模型 */
function runVideo(rawText, ownerUserId) {
  const parsed = parseVideoToken(rawText);
  const matches = parsed.nickname ? db.matchFulfillmentByNickname(parsed.nickname, ownerUserId) : [];
  return {
    kind: 'video', mode: 'local', model: '本地解析', elapsedMs: 0,
    parsed,
    matches: matches.map((m) => ({
      fulfillmentId: m.fulfillment.id,
      alreadyHasVideo: Boolean(m.fulfillment.shareToken),
      filmingProgress: m.fulfillment.filmingProgress,
      collaboration: {
        id: m.collaboration.id, creatorName: m.collaboration.creatorName,
        status: m.collaboration.status, createdAt: m.collaboration.createdAt,
        items: m.collaboration.items, packages: m.collaboration.packages,
      },
      account: m.fulfillment.accountId,
    })),
    warnings: !parsed.ok
      ? [{ level: 'error', code: 'TOKEN_UNPARSABLE', title: '没解析出抖音链接', detail: parsed.error }]
      : !parsed.nickname
        ? [{ level: 'warn', code: 'NO_NICKNAME', title: '口令里没有【昵称】', detail: '请手动选择这条视频对应的合作和抖音号。' }]
        : matches.length === 0
          ? [{ level: 'warn', code: 'NICKNAME_UNMATCHED', title: `昵称「${parsed.nickname}」没匹配到账号`,
              detail: '可能是达人改过昵称，请手动选择。' }]
          : [],
  };
}

/* -------------------------------------------------------------- 后台任务 */

const maxConcurrent = () => Math.max(1, Math.min(10, agentConfig().concurrency || 3));
let pumping = false;

function pump() {
  if (pumping) return;
  pumping = true;
  queueMicrotask(async () => {
    try {
      const slots = maxConcurrent() - db.runningCount();
      if (slots <= 0) return;
      for (const job of db.claimQueuedJobs(slots)) {
        runIntake(job.rawText)
          .then((r) => db.updateJob(job.id, {
            status: 'done', result: r, error: null,
            finishedAt: new Date().toISOString(), elapsedMs: r.elapsedMs,
            title: r.form?.name || r.form?.accounts?.[0]?.nickname || job.title, _pid: false,
          }))
          .catch((e) => db.updateJob(job.id, {
            status: 'failed', error: e.message || '识别失败',
            finishedAt: new Date().toISOString(), _pid: false,
          }))
          .finally(() => { pumping = false; pump(); });
      }
    } finally { pumping = false; }
  });
}

function countMissing(form) {
  if (!form) return 0;
  let n = 0;
  const chk = (v) => { if (!String(v ?? '').trim()) n++; };
  chk(form.name);
  for (const a of form.accounts || []) { chk(a.nickname); chk(a.douyinId); chk(a.uid); chk(a.cooperationCode); }
  chk(form.recipient?.name); chk(form.recipient?.phone); chk(form.recipient?.address);
  return n;
}

/* -------------------------------------------------------------- 路由 */

const routes = {

  'GET /api/config': async (req) => {
    const s = db.getSettings();
    const cfg = agentConfig();
    const me = userOf(req);
    const mask = (k) => (k ? k.slice(0, 3) + '••••' + k.slice(-4) : '');
    return {
      agentReady: agentReady(), visionReady: visionReady(),
      model: agentReady() ? cfg.model : 'local-mock',
      promptVersion: PROMPT_VERSION, concurrency: maxConcurrent(),
      roles: db.ROLES, filmingProgress: db.FILMING_PROGRESS, collabStatus: db.COLLAB_STATUS,
      needsSetup: !me,
      me: me ? { id: me.id, name: me.name, role: me.role } : null,
      users: db.listUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })),
      settings: {
        user: { ...s.user },
        model: { provider: s.model.provider, baseUrl: s.model.baseUrl, model: s.model.model,
          apiStyle: s.model.apiStyle, concurrency: s.model.concurrency, timeoutMs: s.model.timeoutMs,
          hasApiKey: Boolean(s.model.apiKey), apiKeyMasked: mask(s.model.apiKey),
          fromEnv: !s.model.baseUrl && Boolean(process.env.LLM_BASE_URL) },
        vision: { provider: s.vision.provider, baseUrl: s.vision.baseUrl, model: s.vision.model,
          apiStyle: s.vision.apiStyle, hasApiKey: Boolean(s.vision.apiKey), apiKeyMasked: mask(s.vision.apiKey) },
        followUp: { ...s.followUp },
        notifyTemplate: s.notifyTemplate,
      },
      stats: db.stats(),
    };
  },

  'PUT /api/settings': async (req) => {
    const patch = await readBody(req);
    if (patch.user) {
      if (!String(patch.user.name || '').trim()) throw httpError(400, '请填写姓名');
      if (!db.ROLES.some((r) => r.id === patch.user.role)) throw httpError(400, '角色不合法');
    }
    const s = db.saveSettings(patch);
    pump();
    return { ok: true, settings: { user: s.user }, agentReady: agentReady(), visionReady: visionReady() };
  },

  'POST /api/settings/test': async (req) => {
    const b = await readBody(req);
    const which = b.which === 'vision' ? 'vision' : 'model';
    const override = {};
    if (b.baseUrl) override.baseUrl = String(b.baseUrl).replace(/\/+$/, '');
    if (b.model) override.model = b.model;
    if (b.apiStyle) override.apiStyle = b.apiStyle === 'responses' ? 'responses' : 'chat';
    if (b.apiKey && !/^[*•]+$/.test(b.apiKey)) override.apiKey = b.apiKey;
    return await testConnection(which, Object.keys(override).length ? override : null);
  },

  /* ---------- 统一输入路由 ---------- */

  'POST /api/route': async (req) => {
    const { rawText, hasImage } = await readBody(req);
    return routeInput(rawText, { hasImage: Boolean(hasImage) });
  },

  /* ---------- 识别任务（建档走队列）---------- */

  'POST /api/jobs': async (req) => {
    const { rawText } = await readBody(req);
    const text = String(rawText || '').trim();
    if (!text) throw httpError(400, '请先粘贴内容');
    const job = db.createJob({ ownerUserId: requireUser(req).id, rawText: text, kind: 'intake' });
    pump();
    return { job };
  },

  'GET /api/jobs': async (req) => {
    const me = userOf(req);
    if (!me) return { jobs: [], running: 0, concurrency: maxConcurrent() };
    const raw = db.listJobs(me.id);

    // 队列内交叉查重：同一批里可能把同一个达人粘了两次，两条都还没入库
    const keyOwners = new Map();
    for (const j of raw) {
      if (j.status !== 'done' || !j.result?.form) continue;
      for (const a of j.result.form.accounts || []) {
        for (const k of [a.uid, a.douyinId].filter(Boolean)) {
          if (!keyOwners.has(k)) keyOwners.set(k, []);
          keyOwners.get(k).push(j.id);
        }
      }
    }

    const jobs = raw.map(({ result, imageBase64, ...j }) => {
      let dupInQueue = null;
      let dupInDb = null;
      if (result?.form) {
        const keys = (result.form.accounts || []).flatMap((a) => [a.uid, a.douyinId]).filter(Boolean);
        const others = [...new Set(keys.flatMap((k) => (keyOwners.get(k) || []).filter((id) => id !== j.id)))];
        if (others.length) dupInQueue = { jobIds: others, key: keys.find((k) => (keyOwners.get(k) || []).length > 1) };
        // 实时查库：识别时算的告警会过期（同批里另一条可能刚入库）
        const hit = db.findConflicts(result.form.accounts || []).hard[0];
        if (hit) dupInDb = { key: hit.existing.uid || hit.existing.douyinId, creatorId: hit.existing.creatorId,
          creatorName: hit.existing.creatorName || hit.existing.nickname, owner: hit.existing.owner,
          collaborationCount: hit.existing.collaborationCount };
      }
      return { ...j, summary: result?.form ? {
        name: result.form.name || '', accounts: (result.form.accounts || []).length,
        missing: countMissing(result.form),
        alerts: (result.warnings || []).filter((w) => w.level !== 'info').length,
        model: result.mode === 'llm' ? result.model : '本地模拟',
        tokens: result.usage?.total_tokens || null, dupInDb, dupInQueue,
      } : null };
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
    if (!db.getJob(p.id)) throw httpError(404, '任务不存在');
    db.updateJob(p.id, { status: 'queued', error: null, startedAt: null, finishedAt: null, _pid: false });
    pump();
    return { job: db.getJob(p.id) };
  },

  /* 同步识别：确认页里「合并新片段」用 */
  'POST /api/extract': async (req) => {
    const { rawText, previousExtracted } = await readBody(req);
    const text = String(rawText || '').trim();
    if (!text) throw httpError(400, '请先粘贴内容');
    try { return await runIntake(text, previousExtracted || null); }
    catch (e) { throw httpError(502, `识别失败：${e.message}`); }
  },

  /* ---------- 视频口令：本地即时 ---------- */

  'POST /api/video/parse': async (req) => {
    const me = requireUser(req);
    const { rawText } = await readBody(req);
    if (!String(rawText || '').trim()) throw httpError(400, '请先粘贴视频口令');
    return runVideo(rawText, me.id);
  },

  'POST /api/video/submit': async (req) => {
    requireUser(req);
    const { shareToken, fulfillmentId } = await readBody(req);
    const v = validateVideoSubmit({ shareToken, fulfillmentId });
    if (!v.ok) throw httpError(400, v.blocking.join('；'));
    const f = db.getFulfillment(fulfillmentId);
    if (!f) throw httpError(404, '履约项不存在');
    // shareToken 逐字节保存 —— 完整口令是交接载荷
    db.updateFulfillment(fulfillmentId, { shareToken: v.parsed.shareToken, videoUrl: v.parsed.videoUrl });
    return { fulfillment: db.getFulfillment(fulfillmentId), collaboration: db.getCollaboration(f.collaborationId) };
  },

  /* ---------- 草稿 ---------- */

  'GET /api/drafts': async (req) => {
    const me = userOf(req);
    return { drafts: me ? db.listDrafts(me.id) : [] };
  },

  'POST /api/drafts': async (req) => {
    const b = await readBody(req);
    return { draft: db.saveDraft({ id: b.id || null, ownerUserId: requireUser(req).id,
      rawText: b.rawText || '', form: b.form || null, extracted: b.extracted || null }) };
  },

  'GET /api/drafts/:id': async (req, p) => {
    const d = db.getDraft(p.id);
    if (!d) throw httpError(404, '草稿不存在');
    return { draft: d };
  },

  'DELETE /api/drafts/:id': async (req, p) => ({ ok: db.deleteDraft(p.id) }),

  /* ---------- 产品 ---------- */

  'GET /api/products': async (req, p, url) => ({
    products: db.listProducts({
      includeInactive: url.searchParams.get('all') === '1',
      petCategory: url.searchParams.get('petCategory') || '',
    }),
  }),

  'POST /api/products': async (req) => {
    requireUser(req);
    const b = await readBody(req);
    if (!String(b.name || '').trim()) throw httpError(400, '请填写产品名称');
    return { product: db.saveProduct(b) };
  },

  'DELETE /api/products/:id': async (req, p) => db.deleteProduct(p.id),

  /* ---------- 录入合作 ---------- */

  /**
   * 一次提交建立「达人 + 账号 + 合作」。
   * creatorId 传了就是在已有达人上发起新合作，不再新建达人。
   */
  'POST /api/collaborations': async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    const form = sanitizeForStore(body.form || {});
    const action = body.action === 'createRecord' ? 'createRecord' : 'submitSample';

    const v = validateForAction(form, action);
    if (!v.ok) throw httpError(400, v.blocking.join('；'));

    let creatorId = body.creatorId || null;

    if (creatorId) {
      if (!db.getCreator(creatorId)) throw httpError(404, '达人不存在');
      db.addAccounts(creatorId, form.accounts, form.otherAccounts);
    } else {
      const conflicts = db.findConflicts(form.accounts, form.recipient.phone);
      if (conflicts.hard.length) {
        // 强制创建已移除 —— 与蓝图 §4.1 归属固定、B03 禁止重复创建冲突
        throw httpError(409, `该账号已属于「${conflicts.hard[0].existing.creatorName}」，请改用「发起新合作」或在已有达人上补充账号`,
          { conflicts: conflicts.hard });
      }
      creatorId = db.createCreator({ name: form.name, recipient: form.recipient,
        accounts: form.accounts, otherAccounts: form.otherAccounts }, user.id).id;
    }

    const creator = db.getCreator(creatorId);
    const accountIds = creator.accounts
      .filter((a) => form.accounts.some((x) =>
        (x.uid && x.uid === a.uid) || (x.douyinId && x.douyinId === a.douyinId)))
      .map((a) => a.id);

    const collaboration = db.createCollaboration({
      creatorId, recipient: form.recipient, sampleCost: form.sampleCost,
      items: form.items, accountIds: accountIds.length ? accountIds : creator.accounts.map((a) => a.id),
    }, user.id);

    db.appendIntakeLog({
      creatorId, collaborationId: collaboration.id,
      rawText: body.rawText || '', extracted: body.extracted || null,
      model: body.model || 'unknown', mode: body.mode || 'unknown',
      promptVersion: body.promptVersion || PROMPT_VERSION,
      diff: db.diffExtractedVsForm(body.extracted, body.form),
      confirmedBy: user.id, confirmedByName: user.name,
      confirmedAt: new Date().toISOString(), elapsedMs: body.elapsedMs ?? null,
    });

    if (body.draftId) db.deleteDraft(body.draftId);
    if (body.jobId) db.deleteJob(body.jobId);

    return { collaboration, creator: db.getCreator(creatorId), soft: v.soft };
  },

  'GET /api/collaborations': async (req, p, url) => {
    const me = userOf(req);
    const mine = url.searchParams.get('scope') !== 'all';
    return {
      collaborations: db.listCollaborations({
        ownerUserId: mine && me ? me.id : null,
        status: url.searchParams.get('status') || null,
        q: url.searchParams.get('q') || '',
      }),
      stats: db.stats(),
    };
  },

  'GET /api/collaborations/:id': async (req, p) => {
    const cb = db.getCollaboration(p.id);
    if (!cb) throw httpError(404, '合作不存在');
    return { collaboration: cb, notifyText: renderNotifyText(db.getSettings().notifyTemplate, cb) };
  },

  'POST /api/collaborations/:id/packages': async (req, p) => {
    requireUser(req);
    const b = await readBody(req);
    if (!String(b.trackingNo || '').trim()) throw httpError(400, '请填写快递单号');
    const cb = db.addPackage(p.id, { carrier: b.carrier, trackingNo: b.trackingNo, source: b.source || 'manual' });
    if (!cb) throw httpError(404, '合作不存在');
    return { collaboration: cb, notifyText: renderNotifyText(db.getSettings().notifyTemplate, cb) };
  },

  'DELETE /api/packages/:id': async (req, p) => ({ ok: db.removePackage(p.id) }),

  'POST /api/collaborations/:id/notified': async (req, p) => {
    requireUser(req);
    const b = await readBody(req);
    const cb = db.markNotified(p.id, b.value !== false);
    if (!cb) throw httpError(404, '合作不存在');
    return { collaboration: cb };
  },

  'POST /api/collaborations/:id/status': async (req, p) => {
    requireUser(req);
    const b = await readBody(req);
    const cb = db.setCollaborationStatus(p.id, b.status);
    if (!cb) throw httpError(400, '只有「已终止」「已完成」可以手动设置，其余状态由动作驱动');
    return { collaboration: cb };
  },

  'POST /api/fulfillments/:id': async (req, p) => {
    requireUser(req);
    const b = await readBody(req);
    const f = db.updateFulfillment(p.id, b);
    if (!f) throw httpError(404, '履约项不存在');
    return { fulfillment: db.getFulfillment(p.id), collaboration: db.getCollaboration(f.collaborationId) };
  },

  /* ---------- 达人 ---------- */

  'GET /api/creators': async (req, p, url) => {
    const me = userOf(req);
    const mine = url.searchParams.get('scope') !== 'all';
    const list = db.listCreators({ q: url.searchParams.get('q') || '', ownerUserId: mine && me ? me.id : null });
    // 他人记录脱敏（蓝图 §19.3）
    const masked = list.map((c) => {
      if (!me || c.ownerUserId === me.id) return c;
      const r = c.defaultRecipient || {};
      return { ...c, masked: true, defaultRecipient: {
        ...r,
        phone: r.phone ? r.phone.slice(0, 3) + '****' + r.phone.slice(-2) : '',
        address: r.address ? r.address.slice(0, 6) + '…' : '',
      } };
    });
    return { creators: masked, stats: db.stats() };
  },

  'GET /api/creators/:id': async (req, p) => {
    const c = db.getCreator(p.id);
    if (!c) throw httpError(404, '达人不存在');
    return { creator: c, logs: db.listIntakeLogs({ creatorId: p.id }) };
  },

  'PATCH /api/creators/:id': async (req, p) => {
    requireUser(req);
    const c = db.updateCreator(p.id, await readBody(req));
    if (!c) throw httpError(404, '达人不存在');
    return { creator: db.getCreator(p.id) };
  },

  'POST /api/creators/:id/transfer': async (req, p) => {
    const me = requireUser(req);
    const b = await readBody(req);
    const c = db.transferOwner(p.id, b.toUserId, me.id, b.reason || '');
    if (!c) throw httpError(400, '转交失败：达人或目标用户不存在');
    return { creator: db.getCreator(p.id) };
  },

  'POST /api/creators/:id/accounts': async (req, p) => {
    requireUser(req);
    const b = await readBody(req);
    if (!db.getCreator(p.id)) throw httpError(404, '达人不存在');
    db.addAccounts(p.id, b.accounts || [], b.otherAccounts || []);
    return { creator: db.getCreator(p.id) };
  },

  /* ---------- 待办 ---------- */

  'GET /api/todos': async (req) => {
    const me = userOf(req);
    if (!me) return { todos: [] };
    const s = db.getSettings();
    return {
      todos: buildTodos({
        collaborations: db.listCollaborations({ ownerUserId: me.id }),
        drafts: db.listDrafts(me.id),
        jobs: db.listJobs(me.id),
        followUp: s.followUp,
      }),
    };
  },
};

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

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const hit = match(req.method, pathname);
    if (!hit) return send(res, 404, { error: '接口不存在' });
    try {
      return send(res, 200, await hit.handler(req, hit.params, url));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[api]', pathname, e);
      return send(res, status, { error: e.message || '服务器错误', ...(e.extra || {}) });
    }
  }

  let file = pathname === '/' ? '/index.html' : pathname;
  const target = join(PUBLIC, normPath(file).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC) || !existsSync(target)) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  return send(res, 200, readFileSync(target), {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
  });
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    const stale = db.resetStaleJobs();
    console.log('');
    console.log('  耐萌 · 商务动作入口');
    console.log('  ─────────────────────────────────────────');
    console.log(`  地址    http://localhost:${PORT}`);
    console.log(`  识别    ${agentReady() ? `${agentConfig().model} @ ${agentConfig().baseUrl}` : '本地模拟（未配置模型）'}`);
    console.log(`  截图    ${visionReady() ? agentConfig('vision').model : '未配置视觉模型，暂不支持发货截图'}`);
    console.log(`  并发    ${maxConcurrent()} 条`);
    console.log(`  数据    ./data/db.json   配置 ./data/settings.json`);
    if (stale) console.log(`  恢复    ${stale} 条中断的识别任务`);
    console.log('');
    pump();
  });
}
