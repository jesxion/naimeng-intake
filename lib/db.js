/**
 * 数据层 —— 目前用单个 JSON 文件，够本地几千条记录用。
 *
 * 迁移到 PostgreSQL 时只需替换本文件，对外导出的函数签名保持不变。
 * 表对应关系：
 *   users            用户
 *   creators         达人（含收件信息，一个达人一份收件地址）
 *   accounts         抖音账号（creator 一对多）
 *   other_accounts   其他平台账号（仅存档，不参与业务）
 *   drafts           录入草稿
 *   intake_logs      识别留痕（原文 / 模型输出 / 版本 / 人工修改差异）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const DB_FILE = join(DATA_DIR, 'db.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const EMPTY = {
  // 首次运行为空，由「设置 → 用户设置」创建。见 currentUser()
  users: [],
  creators: [],
  accounts: [],
  other_accounts: [],
  drafts: [],
  intake_logs: [],
  jobs: [],
  _seq: 0,
};

/**
 * 配置单独存 data/settings.json，与业务数据分开。
 *
 * 理由：两类数据的处置方式不同 —— 业务数据要备份、要迁移，
 * 密钥不能备份、不能跟着数据走。混在一个文件里迟早会连着密钥一起复制出去。
 * 两个文件都在 .gitignore 中。
 */
const DEFAULT_SETTINGS = {
  user: { name: '', role: 'business', phone: '' },
  model: {
    provider: '', baseUrl: '', apiKey: '', model: '',
    apiStyle: 'chat',      // chat = /chat/completions；responses = /responses
    concurrency: 3,
    timeoutMs: 60000,
  },
};

export const ROLES = [
  { id: 'business', name: '商务' },
  { id: 'operations', name: '运营' },
  { id: 'warehouse', name: '仓库' },
];

let cache = null;

function load() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    cache = structuredClone(EMPTY);
    flush();
    return cache;
  }
  try {
    cache = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    console.error('[db] 读取失败，已使用空库：', e.message);
    cache = structuredClone(EMPTY);
  }
  return cache;
}

/** 原子写入：先写临时文件再 rename，避免进程中断导致文件损坏 */
function flush() {
  const tmp = DB_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  renameSync(tmp, DB_FILE);
}

let settingsCache = null;

function loadSettings() {
  if (settingsCache) return settingsCache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
      settingsCache = {
        user: { ...DEFAULT_SETTINGS.user, ...(raw.user || {}) },
        model: { ...DEFAULT_SETTINGS.model, ...(raw.model || {}) },
      };
    } catch (e) {
      console.error('[db] settings.json 读取失败，已使用默认值：', e.message);
      settingsCache = structuredClone(DEFAULT_SETTINGS);
    }
    return settingsCache;
  }

  // 迁移：旧版本把 settings 塞在 db.json 里，搬出来并从 db.json 删掉
  const db = load();
  if (db.settings) {
    settingsCache = {
      user: { ...DEFAULT_SETTINGS.user, ...(db.settings.user || {}) },
      model: { ...DEFAULT_SETTINGS.model, ...(db.settings.model || {}) },
    };
    delete db.settings;
    flush();
    console.log('[db] 已把配置从 db.json 迁移到 settings.json');
  } else {
    settingsCache = structuredClone(DEFAULT_SETTINGS);
  }
  flushSettings();
  return settingsCache;
}

function flushSettings() {
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(settingsCache, null, 2), 'utf8');
  renameSync(tmp, SETTINGS_FILE);
}

function nextId(prefix) {
  const db = load();
  db._seq += 1;
  return `${prefix}-${String(db._seq).padStart(5, '0')}`;
}

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ 用户 */

export function listUsers() {
  return load().users;
}

export function getUser(id) {
  return load().users.find((u) => u.id === id) || null;
}

/* ------------------------------------------------------------------ 设置 */

export function getSettings() {
  return loadSettings();
}

/**
 * 保存设置。用户信息同时同步为一条 user 记录（按姓名 upsert），
 * 这样达人归属、留痕里的确认人才有稳定的 id 可以指向。
 */
export function saveSettings(patch = {}) {
  const db = load();
  const s = getSettings();

  if (patch.user) {
    s.user = { ...s.user, ...patch.user };
    const name = String(s.user.name || '').trim();
    if (name) {
      let u = db.users.find((x) => x.name === name);
      if (!u) { u = { id: nextId('u'), name, role: s.user.role, phone: s.user.phone }; db.users.push(u); }
      else { u.role = s.user.role; u.phone = s.user.phone; }
      s.user.id = u.id;
    }
  }
  if (patch.model) {
    // apiKey 传空字符串表示「不修改」，避免前端回显掩码时把真 key 覆盖掉
    const { apiKey, ...rest } = patch.model;
    s.model = { ...s.model, ...rest };
    if (typeof apiKey === 'string' && apiKey.trim() && !/^\*+$/.test(apiKey.trim())) {
      s.model.apiKey = apiKey.trim();
    }
    if (patch.model.clearApiKey) s.model.apiKey = '';
  }
  flushSettings();   // 配置写 settings.json
  flush();           // 用户记录写 db.json
  return s;
}

/** 当前操作人：优先设置里的身份，其次请求头指定，最后取第一个用户 */
export function currentUser(headerId) {
  const db = load();
  const s = getSettings();
  if (s.user?.id) {
    const u = db.users.find((x) => x.id === s.user.id);
    if (u) return u;
  }
  if (headerId) {
    const u = db.users.find((x) => x.id === headerId);
    if (u) return u;
  }
  return db.users[0] || null;
}

/* ------------------------------------------------------------------ 查重 */

/**
 * 按抖音号 / UID 查已有账号。
 * 蓝图 §18.9：UID 与抖音号精确匹配；昵称、手机号仅作弱提示。
 */
export function findConflicts(accounts = [], phone = null, excludeCreatorId = null) {
  const db = load();
  const hard = [];
  const soft = [];

  for (const a of accounts) {
    const uid = (a.uid || '').trim();
    const did = (a.douyinId || '').trim();
    if (!uid && !did) continue;
    const hit = db.accounts.find(
      (x) =>
        x.creatorId !== excludeCreatorId &&
        ((uid && x.uid === uid) || (did && x.douyinId === did)),
    );
    if (hit) {
      const creator = db.creators.find((c) => c.id === hit.creatorId);
      const owner = db.users.find((u) => u.id === creator?.ownerUserId);
      hard.push({
        matchedOn: uid && hit.uid === uid ? 'uid' : 'douyinId',
        input: { uid, douyinId: did },
        existing: {
          creatorId: hit.creatorId,
          creatorName: creator?.name || '',
          nickname: hit.nickname,
          douyinId: hit.douyinId,
          uid: hit.uid,
          owner: owner?.name || '未知',
          createdAt: creator?.createdAt || '',
        },
      });
    }
  }

  // 弱提示：同手机号可能是同一达人的另一批账号（真实资料中常见）
  if (phone) {
    const p = String(phone).trim();
    for (const c of db.creators) {
      if (c.id === excludeCreatorId) continue;
      if (c.recipient?.phone && c.recipient.phone === p) {
        const owner = db.users.find((u) => u.id === c.ownerUserId);
        soft.push({
          reason: '收件手机号相同',
          creatorId: c.id,
          creatorName: c.name,
          owner: owner?.name || '未知',
        });
      }
    }
  }

  return { hard, soft };
}

/* ------------------------------------------------------------------ 达人 */

export function createCreator(payload, userId) {
  const db = load();
  const id = nextId('cr');
  const ts = now();

  const creator = {
    id,
    name: payload.name || '',
    ownerUserId: userId,
    cooperationType: payload.cooperationType || '寄样合作',
    petCategory: payload.petCategory || '',
    salesChannel: payload.salesChannel || '',
    recipient: {
      name: payload.recipient?.name || '',
      phone: payload.recipient?.phone || '',
      address: payload.recipient?.address || '',
      deliveryNote: payload.recipient?.deliveryNote || '',
    },
    contactPhone: payload.contactPhone || '',
    remark: payload.remark || '',
    createdAt: ts,
    updatedAt: ts,
  };
  db.creators.push(creator);

  for (const a of payload.accounts || []) {
    if (!a.douyinId && !a.uid && !a.nickname && !a.cooperationCode) continue;
    db.accounts.push({
      id: nextId('ac'),
      creatorId: id,
      nickname: a.nickname || '',
      douyinId: a.douyinId || '',
      // 合作码务必以字符串保存，值可能以 0 开头
      uid: a.uid ? String(a.uid) : '',
      cooperationCode: a.cooperationCode ? String(a.cooperationCode) : '',
      profileUrl: a.profileUrl || '',
      createdAt: ts,
    });
  }

  for (const o of payload.otherAccounts || []) {
    if (!o.accountId) continue;
    db.other_accounts.push({
      id: nextId('oa'),
      creatorId: id,
      platform: o.platform || '其他',
      accountId: String(o.accountId),
      sourceText: o.sourceText || '',
      createdAt: ts,
    });
  }

  flush();
  return creator;
}

export function listCreators({ q = '', ownerUserId = null } = {}) {
  const db = load();
  const key = q.trim().toLowerCase();

  return db.creators
    .filter((c) => !ownerUserId || c.ownerUserId === ownerUserId)
    .map((c) => {
      const accounts = db.accounts.filter((a) => a.creatorId === c.id);
      const owner = db.users.find((u) => u.id === c.ownerUserId);
      return { ...c, accounts, ownerName: owner?.name || '未知' };
    })
    .filter((c) => {
      if (!key) return true;
      const hay = [
        c.name, c.recipient?.name, c.recipient?.phone, c.recipient?.address,
        c.petCategory, c.ownerName,
        ...c.accounts.flatMap((a) => [a.nickname, a.douyinId, a.uid, a.cooperationCode]),
      ].join(' ').toLowerCase();
      return hay.includes(key);
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getCreator(id) {
  const db = load();
  const c = db.creators.find((x) => x.id === id);
  if (!c) return null;
  const owner = db.users.find((u) => u.id === c.ownerUserId);
  return {
    ...c,
    ownerName: owner?.name || '未知',
    accounts: db.accounts.filter((a) => a.creatorId === id),
    otherAccounts: db.other_accounts.filter((a) => a.creatorId === id),
    logs: db.intake_logs.filter((l) => l.creatorId === id),
  };
}

export function stats() {
  const db = load();
  return {
    creators: db.creators.length,
    accounts: db.accounts.length,
    drafts: db.drafts.length,
  };
}

/* ------------------------------------------------------------------ 草稿 */

export function listDrafts(userId = null) {
  const db = load();
  return db.drafts
    .filter((d) => !userId || d.ownerUserId === userId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function saveDraft({ id, ownerUserId, rawText, form, extracted }) {
  const db = load();
  const ts = now();
  let d = id ? db.drafts.find((x) => x.id === id) : null;
  if (!d) {
    d = { id: nextId('df'), ownerUserId, createdAt: ts };
    db.drafts.push(d);
  }
  d.ownerUserId = ownerUserId ?? d.ownerUserId;
  d.rawText = rawText ?? d.rawText ?? '';
  d.form = form ?? d.form ?? null;
  d.extracted = extracted ?? d.extracted ?? null;
  d.title = form?.name || form?.accounts?.[0]?.nickname || '未命名草稿';
  d.updatedAt = ts;
  flush();
  return d;
}

export function getDraft(id) {
  return load().drafts.find((d) => d.id === id) || null;
}

export function deleteDraft(id) {
  const db = load();
  const i = db.drafts.findIndex((d) => d.id === id);
  if (i >= 0) { db.drafts.splice(i, 1); flush(); return true; }
  return false;
}

/* ------------------------------------------------------------------ 识别任务 */

/**
 * 识别任务队列。
 * 商务提交后立刻返回，识别在后台跑，期间可以继续粘贴下一个达人。
 * 状态：queued → running → done / failed
 */
export function createJob({ ownerUserId, rawText }) {
  const db = load();
  const first = String(rawText).split('\n').map((s) => s.trim()).find(Boolean) || '未命名';
  const job = {
    id: nextId('jb'),
    ownerUserId,
    rawText,
    title: first.slice(0, 24),
    status: 'queued',
    result: null,
    error: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
  };
  db.jobs.push(job);
  flush();
  return job;
}

export function listJobs(userId = null) {
  const db = load();
  return db.jobs
    .filter((j) => !userId || j.ownerUserId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getJob(id) {
  return load().jobs.find((j) => j.id === id) || null;
}

export function updateJob(id, patch) {
  const db = load();
  const j = db.jobs.find((x) => x.id === id);
  if (!j) return null;
  Object.assign(j, patch);
  flush();
  return j;
}

export function deleteJob(id) {
  const db = load();
  const i = db.jobs.findIndex((j) => j.id === id);
  if (i >= 0) { db.jobs.splice(i, 1); flush(); return true; }
  return false;
}

/** 服务启动时调用：上次进程退出时残留的 running 任务全部复位重跑 */
export function resetStaleJobs() {
  const db = load();
  let n = 0;
  for (const j of db.jobs) {
    if (j.status === 'running') { j.status = 'queued'; j.startedAt = null; delete j._pid; n++; }
  }
  if (n) flush();
  return n;
}

export function claimQueuedJobs(limit) {
  const db = load();
  let dirty = false;
  const picked = [];
  for (const j of db.jobs) {
    if (picked.length >= limit) break;
    if (j.status === 'queued') {
      j.status = 'running';
      j.startedAt = now();
      j._pid = true;
      picked.push(j);
      dirty = true;
    }
  }
  if (dirty) flush();
  return picked;
}

export function runningCount() {
  return load().jobs.filter((j) => j.status === 'running').length;
}

/* ------------------------------------------------------------------ 留痕 */

/** 蓝图 §19.1：原文、模型输出、版本、置信度、人工修改差异、确认人与时间 */
export function appendIntakeLog(entry) {
  const db = load();
  const log = { id: nextId('lg'), createdAt: now(), ...entry };
  db.intake_logs.push(log);
  flush();
  return log;
}

/** 对比模型输出与商务最终提交值，得到字段级修改差异 */
export function diffExtractedVsForm(extracted, form) {
  const diff = [];
  const val = (o) => (o && typeof o === 'object' && 'v' in o ? (o.v ?? '') : (o ?? ''));
  const cmp = (label, before, after) => {
    const b = String(before ?? '').trim();
    const a = String(after ?? '').trim();
    if (b !== a) diff.push({ field: label, before: b, after: a });
  };

  cmp('达人名称', val(extracted?.creator_name), form?.name);
  cmp('宠物类别', val(extracted?.pet_category), form?.petCategory);
  cmp('带货方式', val(extracted?.sales_channel), form?.salesChannel);
  cmp('收件人', val(extracted?.recipient?.name), form?.recipient?.name);
  cmp('手机号', val(extracted?.recipient?.phone), form?.recipient?.phone);
  cmp('地址', val(extracted?.recipient?.address), form?.recipient?.address);
  cmp('配送备注', val(extracted?.recipient?.delivery_note), form?.recipient?.deliveryNote);

  const ea = extracted?.accounts || [];
  const fa = form?.accounts || [];
  const n = Math.max(ea.length, fa.length);
  for (let i = 0; i < n; i++) {
    cmp(`账号${i + 1}·昵称`, val(ea[i]?.nickname), fa[i]?.nickname);
    cmp(`账号${i + 1}·抖音号`, val(ea[i]?.douyin_id), fa[i]?.douyinId);
    cmp(`账号${i + 1}·UID`, val(ea[i]?.uid), fa[i]?.uid);
    cmp(`账号${i + 1}·合作码`, val(ea[i]?.cooperation_code), fa[i]?.cooperationCode);
  }
  return diff;
}
