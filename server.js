/**
 * 耐萌 · 商务动作入口 —— 本地 Web 服务
 *
 * 零第三方依赖，只用 Node 内置模块。
 *   node server.js          启动
 *   node --watch server.js  开发模式
 *   node --test tests/      跑回归
 *
 * 身份只有一个入口：await userOf(req)。现在读设置，将来读 token。
 * 代码里任何其他地方不得出现第二种「当前用户」取法。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './lib/db.js';
import { extract, extractShipment, agentReady, agentConfig, visionReady, testConnection, PROMPT_VERSION } from './lib/agent.js';
import {
  normalize, sanitizeForStore, validateForAction, validateVideoSubmit,
  routeInput, parseVideoToken, buildTodos, renderNotifyText,
  normalizeShipmentRows, matchShipments,
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
const HOST = process.env.HOST || '127.0.0.1';

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
const userOf = async (req) => db.currentUser(req.headers['x-user-id']);

async function requireUser(req) {
  const u = await userOf(req);
  if (!u) throw httpError(428, '请先在「设置 → 用户设置」里填写你的姓名和角色');
  return u;
}

/* 归属边界。这里区分两类东西，不要合并成一条规则：

   一、私人工作区（识别任务、草稿）—— 只有本人能读能写。
       列表接口本来就按 ownerUserId 过滤了，详情接口不跟上就等于没过滤，
       而 id 是 job-00012 这种顺序号，遍历成本为零。

   二、共享业务数据（合作、达人）—— 全员可读（记录页的「全部」本来就是这么用的，
       仓库和运营也要看整张表），但只有归属人能改。
       例外是快递单回填，那本来就是仓库对别人的合作做的事，见 canFillPackage。 */

async function privateOr404(entity, req, label) {
  const me = await userOf(req);
  if (!entity) throw httpError(404, `${label}不存在`);
  if (entity.ownerUserId && (!me || entity.ownerUserId !== me.id)) {
    throw httpError(404, `${label}不存在`);   // 用 404 不用 403，不暴露这个 id 是否真实存在
  }
  return entity;
}

async function ownerOr403(entity, req, label) {
  const me = await requireUser(req);
  if (!entity) throw httpError(404, `${label}不存在`);
  if (entity.ownerUserId && entity.ownerUserId !== me.id) {
    const owner = (await db.listUsers()).find((u) => u.id === entity.ownerUserId);
    throw httpError(403, `这条${label}归属${owner ? `「${owner.name}」` : '别人'}，请让 TA 来操作`);
  }
  return entity;
}

/* -------------------------------------------------------------- 识别流水线 */

async function runIntake(rawText, previousExtracted = null) {
  const started = Date.now();
  const result = await extract(rawText, previousExtracted);
  const { form, fieldMeta, warnings, ignored } = normalize(result.data);
  const conflicts = await db.findConflicts(form.accounts, form.recipient.phone);

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

/**
 * 视频口令：纯本地正则，不调模型。
 *
 * 匹配结果要带足信息 —— 一次合作可能挂多个账号，商务得看清「这条视频对应哪个号、
 * 哪次合作、寄的什么、寄到哪」才敢确认，光给昵称是判断不了的。
 */
/** 自动匹配和手动搜索共用同一个出参形状，前端才能复用同一套卡片。 */
function shapeMatch(m) {
  const cb = m.collaboration;
  const acc = cb.fulfillments.find((f) => f.id === m.fulfillment.id)?.account || null;
  return {
    fulfillmentId: m.fulfillment.id,
    alreadyHasVideo: Boolean(m.fulfillment.shareToken),
    filmingProgress: m.fulfillment.filmingProgress,
    account: acc && {
      nickname: acc.nickname, douyinId: acc.douyinId,
      uid: acc.uid, cooperationCode: acc.cooperationCode,
    },
    collaboration: {
      id: cb.id, creatorName: cb.creatorName, ownerName: cb.ownerName,
      status: cb.status, createdAt: cb.createdAt, notifiedAt: cb.notifiedAt,
      sampleCost: cb.sampleCost,
      items: cb.items, packages: cb.packages,
      recipient: cb.recipient,
      accountCount: cb.fulfillments.length,
      publishedCount: cb.fulfillments.filter((f) => f.shareToken).length,
    },
  };
}

async function runVideo(rawText, ownerUserId) {
  const parsed = parseVideoToken(rawText);
  const matches = parsed.nickname ? await db.matchFulfillmentByNickname(parsed.nickname, ownerUserId) : [];
  return {
    kind: 'video', mode: 'local', model: '本地解析', elapsedMs: 0,
    parsed,
    matches: matches.map(shapeMatch),
    warnings: !parsed.ok
      ? [{ level: 'error', code: 'TOKEN_UNPARSABLE', title: '没解析出抖音链接', detail: parsed.error }]
      : !parsed.nickname
        ? [{ level: 'warn', code: 'NO_NICKNAME', title: '口令里没有【昵称】',
            detail: '这多半是一条裸链接。在下面搜达人名、抖音号、UID 或合作码，自己挑一条。' }]
        : matches.length === 0
          ? [{ level: 'warn', code: 'NICKNAME_UNMATCHED', title: `昵称「${parsed.nickname}」没匹配到账号`,
              detail: '可能是达人改过昵称。在下面换个词搜，比如抖音号或合作码。' }]
          : [],
  };
}

/**
 * 发货截图：视觉模型识别 + 本地匹配。
 * 一张截图 → N 条记录，是队列里唯一的 1→N 型任务。
 */
async function runShipment(job) {
  const started = Date.now();
  const result = await extractShipment(job.imageBase64);
  const rows = normalizeShipmentRows(result.data);
  const owner = job.ownerUserId;
  // 只在自己名下的合作里匹配
  const candidates = await db.listCollaborations({ ownerUserId: owner });
  const matched = matchShipments(rows, candidates);

  return {
    kind: 'shipment',
    mode: result.mode, model: result.model,
    elapsedMs: Date.now() - started, usage: result.usage || null,
    rows, matched,
    summaryCounts: {
      total: matched.length,
      high: matched.filter((m) => m.level === 'high').length,
      low: matched.filter((m) => m.level === 'low').length,
      none: matched.filter((m) => m.level === 'none').length,
      already: matched.filter((m) => m.already).length,
    },
  };
}

/* -------------------------------------------------------------- 后台任务 */

const maxConcurrent = () => Math.max(1, Math.min(10, agentConfig().concurrency || 3));

/* 队列泵。
 *
 * 原来用一个 pumping 布尔量当锁，但外层 finally 在「发起」任务后就立刻放锁，
 * 真正防超发的一直是 claimQueuedJobs 的原子领取 + runningCount 兜底 ——
 * 那个变量只挡住同一个事件循环 tick 内的重入，是个假的安全感。
 * 这里换成 Promise 链：锁的生命周期跟着这一轮领取走，跑完再看有没有剩的。
 */
let pumpChain = null;

function pump() {
  if (pumpChain) return pumpChain;
  pumpChain = (async () => {
    try {
      const slots = maxConcurrent() - (await db.runningCount());
      if (slots <= 0) return;
      const jobs = await db.claimQueuedJobs(slots);
      if (!jobs.length) return;

      await Promise.all(jobs.map(async (job) => {
        try {
          const r = await (job.kind === 'shipment' ? runShipment(job) : runIntake(job.rawText));
          await db.updateJob(job.id, {
            status: 'done', result: r, error: null,
            finishedAt: new Date().toISOString(), elapsedMs: r.elapsedMs,
            title: r.kind === 'shipment'
              ? `发货截图 · ${r.rows.length} 条`
              : (r.form?.name || r.form?.accounts?.[0]?.nickname || job.title),
            imageBase64: null,   // 识别完就丢掉图片，避免 db.json 膨胀
            _pid: false,
          });
        } catch (e) {
          await db.updateJob(job.id, {
            status: 'failed', error: e.message || '识别失败',
            finishedAt: new Date().toISOString(), _pid: false,
          });
        }
      }));
    } finally {
      pumpChain = null;
    }
    pump();   // 这一轮做完再看队列里还有没有；放在 finally 外面，避免自引用死锁
  })();
  return pumpChain;
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
    const s = await db.getSettings();
    const cfg = agentConfig();
    const me = await userOf(req);
    const mask = (k) => (k ? k.slice(0, 3) + '••••' + k.slice(-4) : '');
    return {
      agentReady: agentReady(), visionReady: visionReady(),
      model: agentReady() ? cfg.model : 'local-mock',
      promptVersion: PROMPT_VERSION, concurrency: maxConcurrent(),
      roles: db.ROLES, filmingProgress: db.FILMING_PROGRESS, collabStatus: db.COLLAB_STATUS,
      needsSetup: !me,
      me: me ? { id: me.id, name: me.name, role: me.role } : null,
      users: (await db.listUsers()).map((u) => ({ id: u.id, name: u.name, role: u.role })),
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
      stats: await db.stats(),
    };
  },

  'PUT /api/settings': async (req) => {
    const patch = await readBody(req);
    if (patch.user) {
      if (!String(patch.user.name || '').trim()) throw httpError(400, '请填写姓名');
      if (!db.ROLES.some((r) => r.id === patch.user.role)) throw httpError(400, '角色不合法');
    }
    // 改模型配置要花钱、还能把后续识别内容导向别人的服务器，必须先有身份。
    // 只改 user 的不拦 —— 那是首次建立身份的唯一入口，拦了会死锁。
    if (Object.keys(patch).some((k) => k !== 'user')) await requireUser(req);
    const s = await db.saveSettings(patch);
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
    const { rawText, imageBase64 } = await readBody(req);
    const user = await requireUser(req);

    if (imageBase64) {
      if (!visionReady()) throw httpError(400, '未配置视觉模型，请到「设置 → 视觉模型」填写后再上传截图');
      if (!/^data:image\/(png|jpe?g|webp);base64,/.test(imageBase64)) {
        throw httpError(400, '只支持 PNG / JPG / WebP 图片');
      }
      const job = await db.createJob({ ownerUserId: user.id, kind: 'shipment', imageBase64, rawText: '' });
      pump();
      return { job: { ...job, imageBase64: undefined } };
    }

    const text = String(rawText || '').trim();
    if (!text) throw httpError(400, '请先粘贴内容');
    const job = await db.createJob({ ownerUserId: user.id, rawText: text, kind: 'intake' });
    pump();
    return { job };
  },

  /* 发货截图：批量把识别出的单号回填到对应合作 */
  'POST /api/shipments/confirm': async (req) => {
    await requireUser(req);
    const { items = [], jobId } = await readBody(req);
    const done = [];
    const failed = [];
    for (const it of items) {
      if (!it.collaborationId || !it.trackingNo) continue;
      try {
        const cb = await db.addPackage(it.collaborationId, { carrier: it.carrier, trackingNo: it.trackingNo, source: 'screenshot' });
        if (cb) done.push({ collaborationId: cb.id, creatorName: cb.creatorName, trackingNo: it.trackingNo, status: cb.status });
        else failed.push({ trackingNo: it.trackingNo, error: '合作不存在' });
      } catch (e) {
        failed.push({ trackingNo: it.trackingNo, error: e.message });
      }
    }
    if (jobId && !failed.length) await db.deleteJob(jobId);
    return { done, failed };
  },

  'GET /api/jobs': async (req) => {
    const me = await userOf(req);
    if (!me) return { jobs: [], running: 0, concurrency: maxConcurrent() };
    const raw = await db.listJobs(me.id);

    // 队列内交叉查重：同一批里可能把同一个达人粘了两次，两条都还没入库
    const keyOwners = new Map();
    for (const j of raw) {
      if (j.status !== 'done' || !j.result?.form) continue;   // shipment 任务没有 form，跳过
      for (const a of j.result.form.accounts || []) {
        for (const k of [a.uid, a.douyinId].filter(Boolean)) {
          if (!keyOwners.has(k)) keyOwners.set(k, []);
          keyOwners.get(k).push(j.id);
        }
      }
    }

    // 查重要读库，读库是异步的。先把这一批的查重结果并行取完，
    // 下面的组装就还能保持同步 map —— 不然每条记录都要 await，串行等 N 次。
    const conflictOf = new Map();
    await Promise.all(raw.map(async (j) => {
      if (j.result?.form) conflictOf.set(j.id, await db.findConflicts(j.result.form.accounts || []));
    }));

    const jobs = raw.map(({ result, imageBase64, ...j }) => {
      let dupInQueue = null;
      let dupInDb = null;
      if (result?.form) {
        const keys = (result.form.accounts || []).flatMap((a) => [a.uid, a.douyinId]).filter(Boolean);
        const others = [...new Set(keys.flatMap((k) => (keyOwners.get(k) || []).filter((id) => id !== j.id)))];
        if (others.length) dupInQueue = { jobIds: others, key: keys.find((k) => (keyOwners.get(k) || []).length > 1) };
        // 实时查库：识别时算的告警会过期（同批里另一条可能刚入库）
        const hit = conflictOf.get(j.id)?.hard[0];
        if (hit) dupInDb = { key: hit.existing.uid || hit.existing.douyinId, creatorId: hit.existing.creatorId,
          creatorName: hit.existing.creatorName || hit.existing.nickname, owner: hit.existing.owner,
          collaborationCount: hit.existing.collaborationCount };
      }
      if (result?.kind === 'shipment') {
        return { ...j, kind: 'shipment', summary: { shipment: result.summaryCounts } };
      }
      return { ...j, summary: result?.form ? {
        name: result.form.name || '', accounts: (result.form.accounts || []).length,
        missing: countMissing(result.form),
        alerts: (result.warnings || []).filter((w) => w.level !== 'info').length,
        model: result.mode === 'llm' ? result.model : '本地模拟',
        tokens: result.usage?.total_tokens || null, dupInDb, dupInQueue,
      } : null };
    });
    return { jobs, running: await db.runningCount(), concurrency: maxConcurrent() };
  },

  'GET /api/jobs/:id': async (req, p) => ({ job: await privateOr404(await db.getJob(p.id), req, '任务') }),

  'DELETE /api/jobs/:id': async (req, p) => {
    await privateOr404(await db.getJob(p.id), req, '任务');
    return { ok: await db.deleteJob(p.id) };
  },

  'POST /api/jobs/:id/retry': async (req, p) => {
    await privateOr404(await db.getJob(p.id), req, '任务');
    await db.updateJob(p.id, { status: 'queued', error: null, startedAt: null, finishedAt: null, _pid: false });
    pump();
    return { job: await db.getJob(p.id) };
  },

  /* 同步识别：确认页里「合并新片段」用 */
  'POST /api/extract': async (req) => {
    await requireUser(req);   // 这个接口真实消耗 token，不能无身份调用
    const { rawText, previousExtracted } = await readBody(req);
    const text = String(rawText || '').trim();
    if (!text) throw httpError(400, '请先粘贴内容');
    try { return await runIntake(text, previousExtracted || null); }
    catch (e) { throw httpError(502, `识别失败：${e.message}`); }
  },

  /* ---------- 视频口令：本地即时 ---------- */

  'POST /api/video/parse': async (req) => {
    const me = await requireUser(req);
    const { rawText } = await readBody(req);
    if (!String(rawText || '').trim()) throw httpError(400, '请先粘贴视频口令');
    return await runVideo(rawText, me.id);
  },

  'POST /api/video/submit': async (req) => {
    await requireUser(req);
    const { shareToken, fulfillmentId } = await readBody(req);
    const v = validateVideoSubmit({ shareToken, fulfillmentId });
    if (!v.ok) throw httpError(400, v.blocking.join('；'));
    const f = await db.getFulfillment(fulfillmentId);
    if (!f) throw httpError(404, '履约项不存在');
    // shareToken 逐字节保存 —— 完整口令是交接载荷
    await db.updateFulfillment(fulfillmentId, { shareToken: v.parsed.shareToken, videoUrl: v.parsed.videoUrl });
    return { fulfillment: await db.getFulfillment(fulfillmentId), collaboration: await db.getCollaboration(f.collaborationId) };
  },

  /* ---------- 草稿 ---------- */

  'GET /api/drafts': async (req) => {
    const me = await userOf(req);
    return { drafts: me ? await db.listDrafts(me.id) : [] };
  },

  'POST /api/drafts': async (req) => {
    const b = await readBody(req);
    return { draft: await db.saveDraft({ id: b.id || null, ownerUserId: (await requireUser(req)).id,
      rawText: b.rawText || '', form: b.form || null, extracted: b.extracted || null }) };
  },

  'GET /api/drafts/:id': async (req, p) => ({ draft: await privateOr404(await db.getDraft(p.id), req, '草稿') }),

  'DELETE /api/drafts/:id': async (req, p) => {
    await privateOr404(await db.getDraft(p.id), req, '草稿');
    return { ok: await db.deleteDraft(p.id) };
  },

  /* ---------- 产品 ---------- */

  'GET /api/products': async (req, p, url) => ({
    products: await db.listProducts({
      includeInactive: url.searchParams.get('all') === '1',
      petCategory: url.searchParams.get('petCategory') || '',
    }),
  }),

  'POST /api/products': async (req) => {
    await requireUser(req);
    const b = await readBody(req);
    if (!String(b.name || '').trim()) throw httpError(400, '请填写产品名称');
    return { product: await db.saveProduct(b) };
  },

  'DELETE /api/products/:id': async (req, p) => await db.deleteProduct(p.id),

  /* ---------- 录入合作 ---------- */

  /**
   * 一次提交建立「达人 + 账号 + 合作」。
   * creatorId 传了就是在已有达人上发起新合作，不再新建达人。
   */
  'POST /api/collaborations': async (req) => {
    const user = await requireUser(req);
    const body = await readBody(req);
    const form = sanitizeForStore(body.form || {});
    const action = body.action === 'createRecord' ? 'createRecord' : 'submitSample';

    const v = validateForAction(form, action);
    if (!v.ok) throw httpError(400, v.blocking.join('；'));

    let creatorId = body.creatorId || null;

    if (creatorId) {
      if (!await db.getCreator(creatorId)) throw httpError(404, '达人不存在');
      await db.addAccounts(creatorId, form.accounts, form.otherAccounts);
    } else {
      const conflicts = await db.findConflicts(form.accounts, form.recipient.phone);
      if (conflicts.hard.length) {
        // 强制创建已移除 —— 与蓝图 §4.1 归属固定、B03 禁止重复创建冲突
        throw httpError(409, `该账号已属于「${conflicts.hard[0].existing.creatorName}」，请改用「发起新合作」或在已有达人上补充账号`,
          { conflicts: conflicts.hard });
      }
      creatorId = (await db.createCreator({ name: form.name, recipient: form.recipient,
        accounts: form.accounts, otherAccounts: form.otherAccounts }, user.id)).id;
    }

    const creator = await db.getCreator(creatorId);
    const accountIds = creator.accounts
      .filter((a) => form.accounts.some((x) =>
        (x.uid && x.uid === a.uid) || (x.douyinId && x.douyinId === a.douyinId)))
      .map((a) => a.id);

    const collaboration = await db.createCollaboration({
      creatorId, recipient: form.recipient, sampleCost: form.sampleCost,
      items: form.items, accountIds: accountIds.length ? accountIds : creator.accounts.map((a) => a.id),
    }, user.id);

    await db.appendIntakeLog({
      creatorId, collaborationId: collaboration.id,
      rawText: body.rawText || '', extracted: body.extracted || null,
      model: body.model || 'unknown', mode: body.mode || 'unknown',
      promptVersion: body.promptVersion || PROMPT_VERSION,
      diff: await db.diffExtractedVsForm(body.extracted, body.form),
      confirmedBy: user.id, confirmedByName: user.name,
      confirmedAt: new Date().toISOString(), elapsedMs: body.elapsedMs ?? null,
    });

    if (body.draftId) await db.deleteDraft(body.draftId);
    if (body.jobId) await db.deleteJob(body.jobId);

    return { collaboration, creator: await db.getCreator(creatorId), soft: v.soft };
  },

  'GET /api/collaborations': async (req, p, url) => {
    const me = await userOf(req);
    const mine = url.searchParams.get('scope') !== 'all';
    return {
      collaborations: await db.listCollaborations({
        ownerUserId: mine && me ? me.id : null,
        status: url.searchParams.get('status') || null,
        q: url.searchParams.get('q') || '',
      }),
      stats: await db.stats(),
    };
  },

  'GET /api/collaborations/:id': async (req, p) => {
    const cb = await db.getCollaboration(p.id);
    if (!cb) throw httpError(404, '合作不存在');
    return { collaboration: cb, notifyText: renderNotifyText((await db.getSettings()).notifyTemplate, cb) };
  },

  // 不限归属：回填快递单本来就是仓库对商务的合作做的动作，卡归属会把仓库挡在外面。
  'POST /api/collaborations/:id/packages': async (req, p) => {
    await requireUser(req);
    const b = await readBody(req);
    if (!String(b.trackingNo || '').trim()) throw httpError(400, '请填写快递单号');
    const cb = await db.addPackage(p.id, { carrier: b.carrier, trackingNo: b.trackingNo, source: b.source || 'manual' });
    if (!cb) throw httpError(404, '合作不存在');
    return { collaboration: cb, notifyText: renderNotifyText((await db.getSettings()).notifyTemplate, cb) };
  },

  // 同 addPackage，不限归属：仓库填错单号要能自己改回来。
  'DELETE /api/packages/:id': async (req, p) => {
    await requireUser(req);
    return { ok: await db.removePackage(p.id) };
  },

  'POST /api/collaborations/:id/notified': async (req, p) => {
    await ownerOr403(await db.getCollaboration(p.id), req, '合作');
    const b = await readBody(req);
    const cb = await db.markNotified(p.id, b.value !== false);
    if (!cb) throw httpError(404, '合作不存在');
    return { collaboration: cb };
  },

  'POST /api/collaborations/:id/status': async (req, p) => {
    await ownerOr403(await db.getCollaboration(p.id), req, '合作');
    const b = await readBody(req);
    const cb = await db.setCollaborationStatus(p.id, b.status);
    if (!cb) throw httpError(400, '只有「已终止」「已完成」可以手动设置，其余状态由动作驱动');
    return { collaboration: cb };
  },

  // 裸链接 / 昵称改过时，商务自己搜自己挑。出参形状和自动匹配一致。
  'GET /api/fulfillments/search': async (req, p, url) => {
    const me = await requireUser(req);
    return {
      matches: (await db.searchFulfillments({
        q: url.searchParams.get('q') || '',
        ownerUserId: url.searchParams.get('scope') === 'all' ? null : me.id,
      })).map(shapeMatch),
    };
  },

  'POST /api/fulfillments/:id': async (req, p) => {
    const cur = await db.getFulfillment(p.id);
    if (!cur) throw httpError(404, '履约项不存在');
    await ownerOr403(await db.getCollaboration(cur.collaborationId), req, '合作');
    const b = await readBody(req);
    const f = await db.updateFulfillment(p.id, b);
    if (!f) throw httpError(404, '履约项不存在');
    return { fulfillment: await db.getFulfillment(p.id), collaboration: await db.getCollaboration(f.collaborationId) };
  },

  /* ---------- 达人 ---------- */

  'GET /api/creators': async (req, p, url) => {
    const me = await userOf(req);
    const mine = url.searchParams.get('scope') !== 'all';
    const list = await db.listCreators({ q: url.searchParams.get('q') || '', ownerUserId: mine && me ? me.id : null });
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
    return { creators: masked, stats: await db.stats() };
  },

  'GET /api/creators/:id': async (req, p) => {
    const c = await db.getCreator(p.id);
    if (!c) throw httpError(404, '达人不存在');
    return { creator: c, logs: await db.listIntakeLogs({ creatorId: p.id }) };
  },

  'PATCH /api/creators/:id': async (req, p) => {
    await ownerOr403(await db.getCreator(p.id), req, '达人');
    const c = await db.updateCreator(p.id, await readBody(req));
    if (!c) throw httpError(404, '达人不存在');
    return { creator: await db.getCreator(p.id) };
  },

  'POST /api/creators/:id/transfer': async (req, p) => {
    const me = await requireUser(req);
    const b = await readBody(req);
    const cur = await db.getCreator(p.id);
    if (!cur) throw httpError(404, '达人不存在');
    // 两种合法情形：归属人自己转出，或别人把无人管的记录接到自己名下。
    // 不能只允许归属人 —— 那样商务一离职，他名下的达人就永远转不走了。
    // 谁转的、为什么转都记在 ownerHistory 里，乱接会留痕。
    if (cur.ownerUserId && cur.ownerUserId !== me.id && b.toUserId !== me.id) {
      const owner = (await db.listUsers()).find((u) => u.id === cur.ownerUserId);
      throw httpError(403, `这条达人归属${owner ? `「${owner.name}」` : '别人'}，`
        + '你可以接到自己名下，但不能转给第三个人');
    }
    const c = await db.transferOwner(p.id, b.toUserId, me.id, b.reason || '');
    if (!c) throw httpError(400, '转交失败：达人或目标用户不存在');
    return { creator: await db.getCreator(p.id) };
  },

  'POST /api/creators/:id/accounts': async (req, p) => {
    await ownerOr403(await db.getCreator(p.id), req, '达人');
    const b = await readBody(req);
    await db.addAccounts(p.id, b.accounts || [], b.otherAccounts || []);
    return { creator: await db.getCreator(p.id) };
  },

  /* ---------- 待办 ---------- */

  'GET /api/todos': async (req) => {
    const me = await userOf(req);
    if (!me) return { todos: [] };
    const s = await db.getSettings();
    return {
      todos: buildTodos({
        collaborations: await db.listCollaborations({ ownerUserId: me.id }),
        drafts: await db.listDrafts(me.id),
        jobs: await db.listJobs(me.id),
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
  // 默认只绑回环。这个服务里有达人手机号和地址，且没有登录，
  // 绑 0.0.0.0 等于同一个 WiFi 下谁都能打开。要局域网访问就显式 HOST=0.0.0.0。
  server.listen(PORT, HOST, async () => {
    const backup = await db.backupNow('startup');
    const stale = await db.resetStaleJobs();
    console.log('');
    console.log('  耐萌 · 商务动作入口');
    console.log('  ─────────────────────────────────────────');
    console.log(`  地址    http://localhost:${PORT}`);
    console.log(`  绑定    ${HOST}${HOST === '127.0.0.1' ? '（仅本机）' : '  ⚠ 局域网可访问，服务没有登录鉴权'}`);
    console.log(`  识别    ${agentReady() ? `${agentConfig().model} @ ${agentConfig().baseUrl}` : '本地模拟（未配置模型）'}`);
    console.log(`  截图    ${visionReady() ? agentConfig('vision').model : '未配置视觉模型，暂不支持发货截图'}`);
    console.log(`  并发    ${maxConcurrent()} 条`);
    console.log(`  数据    ./data/db.json   配置 ./data/settings.json`);
    if (backup) console.log(`  备份    ${backup.replace(/.*[\\/]backups[\\/]/, 'data/backups/')}（保留最近 7 份）`);
    if (stale) console.log(`  恢复    ${stale} 条中断的识别任务`);
    console.log('');
    pump();
  });
}
