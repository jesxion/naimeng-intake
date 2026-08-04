/**
 * 数据层 —— 单一出口。
 *
 * 现在用 JSON 文件，将来整体换 PostgreSQL 时只重写本文件，对外函数签名不变。
 * 业务规则一律不写在这里（见 rules.js），这里只管存取。
 *
 * 文件划分：
 *   data/db.json        业务数据（含达人 PII）
 *   data/settings.json  配置（含 API Key）
 * 两类数据处置方式不同 —— 业务数据要备份要迁移，密钥不能跟着走。两个文件都在 .gitignore。
 *
 * 模型分层（见《商务动作入口改造方案 v1》§2）：
 *   达人 creators          稳定身份 + 归属人 + 默认收件信息
 *   账号 accounts          抖音号/UID/合作码，合作码长期不变
 *   合作 collaborations    一次合作：收件快照 + 费用 + 状态
 *     ├ 产品行 collab_items      一次合作可含多个产品，各自数量
 *     ├ 履约项 collab_accounts   每个参与账号一条：拍摄进度 + 视频口令
 *     └ 包裹 packages            一次合作可拆多个快递单
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 测试用 NAIMENG_DATA_DIR 指向临时目录，避免污染真实数据
const DATA_DIR = process.env.NAIMENG_DATA_DIR || join(ROOT, 'data');
const DB_FILE = join(DATA_DIR, 'db.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export const SCHEMA_VERSION = 2;

export const ROLES = [
  { id: 'business', name: '商务' },
  { id: 'operations', name: '运营' },
  { id: 'warehouse', name: '仓库' },
];

/** 合作状态。全部由动作驱动，只有「已终止」是手动的 */
export const COLLAB_STATUS = ['待寄样', '已寄样', '已完成', '已终止'];

/** 履约项（账号级）拍摄进度 */
export const FILMING_PROGRESS = ['待拍摄', '已催拍', '已发布', '本次不出片'];

const EMPTY = {
  // 注意：这里必须是 1，不能写 SCHEMA_VERSION。
  // 旧 db.json 没有这个字段，展开时会继承默认值 —— 若默认成最新版，迁移会被静默跳过。
  // 全新库在 load() 里显式置为 SCHEMA_VERSION。
  schemaVersion: 1,
  users: [],            // 首次运行为空，由「设置 → 用户设置」创建
  creators: [],
  accounts: [],
  other_accounts: [],
  products: [],
  collaborations: [],
  collab_items: [],
  collab_accounts: [],
  packages: [],
  drafts: [],
  intake_logs: [],
  jobs: [],
  _seq: 0,
};

const DEFAULT_SETTINGS = {
  user: { name: '', role: 'business', phone: '' },
  model: {
    provider: '', baseUrl: '', apiKey: '', model: '',
    apiStyle: 'chat',
    concurrency: 3,
    timeoutMs: 60000,
  },
  vision: {                 // 发货截图识别用，与文本模型分开配
    provider: '', baseUrl: '', apiKey: '', model: '',
    apiStyle: 'chat',
  },
  followUp: {
    firstDays: 7,           // 建档满 N 天回访（团队现行做法：从建档算，不从发货算）
    repeatDays: 5,          // 回访后未出片，隔 N 天再提醒
  },
  // {物流} 每个包裹一行「承运商 单号」，一次合作拆多个快递时不会错位
  notifyTemplate:
    '宝子，样品已经寄出啦～\n{物流}\n{商品}\n收到后麻烦帮忙确认下，有问题随时找我',
};

let cache = null;
let settingsCache = null;

/* ================================================================ 载入 */

function load() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    cache = structuredClone(EMPTY);
    cache.schemaVersion = SCHEMA_VERSION;   // 全新库无需迁移
    flush();
    return cache;
  }
  try {
    cache = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    console.error('[db] 读取失败，已使用空库：', e.message);
    cache = structuredClone(EMPTY);
  }
  migrate();
  return cache;
}

/** 原子写入：先写临时文件再 rename，避免进程中断损坏文件 */
function flush() {
  const tmp = DB_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  renameSync(tmp, DB_FILE);
}

function loadSettings() {
  if (settingsCache) return settingsCache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const merge = (raw) => ({
    user: { ...DEFAULT_SETTINGS.user, ...(raw.user || {}) },
    model: { ...DEFAULT_SETTINGS.model, ...(raw.model || {}) },
    vision: { ...DEFAULT_SETTINGS.vision, ...(raw.vision || {}) },
    followUp: { ...DEFAULT_SETTINGS.followUp, ...(raw.followUp || {}) },
    notifyTemplate: raw.notifyTemplate ?? DEFAULT_SETTINGS.notifyTemplate,
  });

  if (existsSync(SETTINGS_FILE)) {
    try { settingsCache = merge(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))); }
    catch (e) {
      console.error('[db] settings.json 读取失败，已使用默认值：', e.message);
      settingsCache = structuredClone(DEFAULT_SETTINGS);
    }
    return settingsCache;
  }

  // 迁移：旧版本把 settings 塞在 db.json 里
  const db = load();
  settingsCache = db.settings ? merge(db.settings) : structuredClone(DEFAULT_SETTINGS);
  if (db.settings) { delete db.settings; flush(); console.log('[db] 配置已从 db.json 迁出到 settings.json'); }
  flushSettings();
  return settingsCache;
}

function flushSettings() {
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(settingsCache, null, 2), 'utf8');
  renameSync(tmp, SETTINGS_FILE);
}

function nextId(prefix) {
  const db = cache;
  db._seq += 1;
  return `${prefix}-${String(db._seq).padStart(5, '0')}`;
}

const now = () => new Date().toISOString();

/* ================================================================ 迁移 */

/**
 * v1 → v2：达人身上内嵌的 recipient 拆出去。
 *
 * v1 里「一条 creator」实际代表商务录的一次合作，但缺商品、数量、费用。
 * 迁移策略：收件信息同时留作达人默认值（下次录入自动带出），
 * 并生成一条「待寄样」合作保存快照 —— 缺的商品行会在待办里提示补充，
 * 这样既不丢历史，也不凭空编造数据。
 */
function migrate() {
  const db = cache;
  if ((db.schemaVersion || 1) >= SCHEMA_VERSION) return;

  let moved = 0;
  for (const c of db.creators) {
    if (!c.recipient) continue;

    c.defaultRecipient = { ...c.recipient };
    c.channel ??= '抖音达人广场';

    const accountIds = db.accounts.filter((a) => a.creatorId === c.id).map((a) => a.id);
    const collabId = nextId('cb');
    db.collaborations.push({
      id: collabId,
      creatorId: c.id,
      ownerUserId: c.ownerUserId,
      type: c.cooperationType || '寄样合作',
      recipient: { ...c.recipient },
      sampleCost: null,
      status: '待寄样',
      notifiedAt: null,
      createdAt: c.createdAt || now(),
      updatedAt: now(),
      migratedFromV1: true,
    });
    for (const accountId of accountIds) {
      db.collab_accounts.push({
        id: nextId('ca'),
        collaborationId: collabId,
        accountId,
        expectVideo: true,
        filmingProgress: '待拍摄',
        shareToken: '', videoUrl: '', publishedAt: null,
        deliveryStatus: null, planId: null,   // 投流预留，本期不启用
      });
    }
    // 把留痕指到合作上
    for (const log of db.intake_logs) {
      if (log.creatorId === c.id && !log.collaborationId) log.collaborationId = collabId;
    }

    delete c.recipient;
    delete c.cooperationType;
    delete c.petCategory;   // 迁到合作级没有依据，v1 时也基本没填
    delete c.salesChannel;
    moved += 1;
  }

  db.schemaVersion = SCHEMA_VERSION;
  flush();
  if (moved) console.log(`[db] 已迁移 ${moved} 条达人记录到「达人 + 合作」模型`);
}

/* ================================================================ 用户 */

export function listUsers() { return load().users; }
export function getUser(id) { return load().users.find((u) => u.id === id) || null; }

export function getSettings() { return loadSettings(); }

/**
 * 保存设置。用户信息同步 upsert 成一条 user 记录，
 * 让归属和留痕有稳定的 id 可指。
 */
export function saveSettings(patch = {}) {
  const db = load();
  const s = loadSettings();

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
  for (const key of ['model', 'vision']) {
    if (!patch[key]) continue;
    // apiKey 传空表示「不修改」，避免前端回显掩码时覆盖真 key
    const { apiKey, clearApiKey, ...rest } = patch[key];
    s[key] = { ...s[key], ...rest };
    if (typeof apiKey === 'string' && apiKey.trim() && !/^[*•]+$/.test(apiKey.trim())) {
      s[key].apiKey = apiKey.trim();
    }
    if (clearApiKey) s[key].apiKey = '';
  }
  if (patch.followUp) s.followUp = { ...s.followUp, ...patch.followUp };
  if (typeof patch.notifyTemplate === 'string') s.notifyTemplate = patch.notifyTemplate;

  flushSettings();
  flush();
  return s;
}

/** 当前操作人：设置里的身份优先，其次请求头，最后第一个用户 */
export function currentUser(headerId) {
  const db = load();
  const s = loadSettings();
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

/* ================================================================ 产品 */

export function listProducts({ includeInactive = false, petCategory = '' } = {}) {
  const db = load();
  return db.products
    .filter((p) => includeInactive || p.active !== false)
    .filter((p) => !petCategory || !p.petCategory || p.petCategory === '通用' || p.petCategory === petCategory)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

export function saveProduct(p) {
  const db = load();
  if (p.id) {
    const found = db.products.find((x) => x.id === p.id);
    if (!found) return null;
    Object.assign(found, {
      name: p.name ?? found.name,
      petCategory: p.petCategory ?? found.petCategory,
      spec: p.spec ?? found.spec,
      active: p.active ?? found.active,
    });
    flush();
    return found;
  }
  const created = {
    id: nextId('pd'),
    name: String(p.name || '').trim(),
    petCategory: p.petCategory || '通用',
    spec: p.spec || '',
    active: p.active !== false,
    createdAt: now(),
  };
  db.products.push(created);
  flush();
  return created;
}

export function deleteProduct(id) {
  const db = load();
  const used = db.collab_items.some((i) => i.productId === id);
  if (used) {                       // 已被合作引用的产品只停用，不物理删除
    const p = db.products.find((x) => x.id === id);
    if (p) { p.active = false; flush(); }
    return { ok: true, softDeleted: true };
  }
  const i = db.products.findIndex((x) => x.id === id);
  if (i >= 0) { db.products.splice(i, 1); flush(); return { ok: true }; }
  return { ok: false };
}

/* ================================================================ 查重 */

/**
 * 按抖音号 / UID 精确查重（蓝图 §18.9）。
 * 查重永远全局，不按归属过滤 —— 否则「已归属其他商务」这条规则无法工作。
 */
export function findConflicts(accounts = [], phone = null, excludeCreatorId = null) {
  const db = load();
  const hard = [];
  const soft = [];

  for (const a of accounts) {
    const uid = String(a.uid || '').trim();
    const did = String(a.douyinId || '').trim();
    if (!uid && !did) continue;
    const hit = db.accounts.find(
      (x) => x.creatorId !== excludeCreatorId && ((uid && x.uid === uid) || (did && x.douyinId === did)),
    );
    if (!hit) continue;
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
        collaborationCount: db.collaborations.filter((cb) => cb.creatorId === hit.creatorId).length,
      },
    });
  }

  // 弱提示：同手机号可能是同一达人的另一批账号（§4.2 建模缺口的折中）
  if (phone) {
    const p = String(phone).trim();
    for (const c of db.creators) {
      if (c.id === excludeCreatorId) continue;
      if (c.defaultRecipient?.phone === p) {
        const owner = db.users.find((u) => u.id === c.ownerUserId);
        soft.push({ reason: '收件手机号相同', creatorId: c.id, creatorName: c.name, owner: owner?.name || '未知' });
      }
    }
  }
  return { hard, soft };
}

/* ================================================================ 达人 */

export function createCreator(payload, userId) {
  const db = load();
  const id = nextId('cr');
  const ts = now();
  const creator = {
    id,
    name: payload.name || '',
    ownerUserId: userId,
    channel: payload.channel || '抖音达人广场',
    defaultRecipient: { ...(payload.recipient || {}) },
    remark: payload.remark || '',
    createdAt: ts,
    updatedAt: ts,
  };
  db.creators.push(creator);
  addAccounts(id, payload.accounts || [], payload.otherAccounts || []);
  flush();
  return creator;
}

/** 往已有达人上补充账号。重复的跳过，不报错 —— 场景是「同一达人的新账号分次发来」 */
export function addAccounts(creatorId, accounts = [], otherAccounts = []) {
  const db = load();
  const ts = now();
  const added = [];
  for (const a of accounts) {
    if (!a.douyinId && !a.uid && !a.nickname && !a.cooperationCode) continue;
    const dup = db.accounts.find(
      (x) => x.creatorId === creatorId &&
        ((a.uid && x.uid === String(a.uid)) || (a.douyinId && x.douyinId === a.douyinId)),
    );
    if (dup) { added.push(dup); continue; }
    const rec = {
      id: nextId('ac'),
      creatorId,
      nickname: a.nickname || '',
      douyinId: a.douyinId || '',
      // UID 与合作码一律字符串，合作码可能以 0 开头
      uid: a.uid ? String(a.uid) : '',
      cooperationCode: a.cooperationCode ? String(a.cooperationCode) : '',
      profileUrl: a.profileUrl || '',
      createdAt: ts,
    };
    db.accounts.push(rec);
    added.push(rec);
  }
  for (const o of otherAccounts) {
    if (!o.accountId) continue;
    if (db.other_accounts.some((x) => x.creatorId === creatorId && x.accountId === String(o.accountId))) continue;
    db.other_accounts.push({
      id: nextId('oa'), creatorId,
      platform: o.platform || '其他',
      accountId: String(o.accountId),
      sourceText: o.sourceText || '',
      createdAt: ts,
    });
  }
  flush();
  return added;
}

export function updateCreator(id, patch) {
  const db = load();
  const c = db.creators.find((x) => x.id === id);
  if (!c) return null;
  if (patch.name !== undefined) c.name = patch.name;
  if (patch.remark !== undefined) c.remark = patch.remark;
  if (patch.defaultRecipient) c.defaultRecipient = { ...c.defaultRecipient, ...patch.defaultRecipient };
  c.updatedAt = now();
  flush();
  return c;
}

/**
 * 归属转交。归属人是责任人不是标签，人员变动时必须能转，否则待办无人认领。
 * 转交留痕。
 */
export function transferOwner(creatorId, toUserId, byUserId, reason = '') {
  const db = load();
  const c = db.creators.find((x) => x.id === creatorId);
  const to = db.users.find((u) => u.id === toUserId);
  if (!c || !to) return null;
  const from = c.ownerUserId;
  c.ownerUserId = toUserId;
  c.updatedAt = now();
  c.ownerHistory = [...(c.ownerHistory || []), { from, to: toUserId, by: byUserId, reason, at: now() }];
  // 合作跟着达人走
  for (const cb of db.collaborations) if (cb.creatorId === creatorId) cb.ownerUserId = toUserId;
  flush();
  return c;
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
    collaborations: db.collaborations
      .filter((cb) => cb.creatorId === id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((cb) => expandCollaboration(cb)),
  };
}

export function listCreators({ q = '', ownerUserId = null } = {}) {
  const db = load();
  const key = q.trim().toLowerCase();
  return db.creators
    .filter((c) => !ownerUserId || c.ownerUserId === ownerUserId)
    .map((c) => {
      const accounts = db.accounts.filter((a) => a.creatorId === c.id);
      const collabs = db.collaborations.filter((cb) => cb.creatorId === c.id);
      const owner = db.users.find((u) => u.id === c.ownerUserId);
      return {
        ...c, accounts, ownerName: owner?.name || '未知',
        collaborationCount: collabs.length,
        lastCollaborationAt: collabs.map((x) => x.createdAt).sort().pop() || null,
      };
    })
    .filter((c) => {
      if (!key) return true;
      const hay = [c.name, c.defaultRecipient?.name, c.defaultRecipient?.phone, c.defaultRecipient?.address, c.ownerName,
        ...c.accounts.flatMap((a) => [a.nickname, a.douyinId, a.uid, a.cooperationCode])].join(' ').toLowerCase();
      return hay.includes(key);
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/* ================================================================ 合作 */

function expandCollaboration(cb) {
  const db = cache;
  const creator = db.creators.find((c) => c.id === cb.creatorId);
  const owner = db.users.find((u) => u.id === cb.ownerUserId);
  const items = db.collab_items.filter((i) => i.collaborationId === cb.id);
  const fulfillments = db.collab_accounts
    .filter((f) => f.collaborationId === cb.id)
    .map((f) => ({ ...f, account: db.accounts.find((a) => a.id === f.accountId) || null }));
  return {
    ...cb,
    creatorName: creator?.name || '',
    ownerName: owner?.name || '未知',
    items,
    fulfillments,
    packages: db.packages.filter((p) => p.collaborationId === cb.id),
  };
}

export function createCollaboration(payload, userId) {
  const db = load();
  const creator = db.creators.find((c) => c.id === payload.creatorId);
  if (!creator) return null;

  const id = nextId('cb');
  const ts = now();
  db.collaborations.push({
    id,
    creatorId: creator.id,
    ownerUserId: creator.ownerUserId || userId,   // 归属跟达人走
    type: payload.type === '直播定向' ? '直播定向' : '寄样合作',
    recipient: { ...(payload.recipient || {}) },  // 本次快照
    sampleCost: payload.sampleCost ?? null,
    petCategory: payload.petCategory || '',
    salesChannel: payload.salesChannel || '',
    status: '待寄样',
    notifiedAt: null,
    createdAt: ts,
    updatedAt: ts,
  });

  for (const it of payload.items || []) {
    if (!it.productId && !it.productName) continue;
    const product = db.products.find((p) => p.id === it.productId);
    db.collab_items.push({
      id: nextId('ci'), collaborationId: id,
      productId: it.productId || null,
      productName: it.productName || product?.name || '',   // 快照，产品改名不影响历史
      quantity: Number(it.quantity) || 1,
    });
  }

  for (const accountId of payload.accountIds || []) {
    if (!db.accounts.some((a) => a.id === accountId)) continue;
    db.collab_accounts.push({
      id: nextId('ca'), collaborationId: id, accountId,
      expectVideo: true,
      filmingProgress: '待拍摄',
      shareToken: '', videoUrl: '', publishedAt: null,
      deliveryStatus: null, planId: null,
    });
  }

  // 收件信息同时更新达人默认值，下次录入自动带出
  if (payload.recipient?.address) {
    creator.defaultRecipient = { ...payload.recipient };
    creator.updatedAt = ts;
  }

  flush();
  return getCollaboration(id);
}

export function getCollaboration(id) {
  const db = load();
  const cb = db.collaborations.find((x) => x.id === id);
  return cb ? expandCollaboration(cb) : null;
}

export function listCollaborations({ ownerUserId = null, status = null, q = '' } = {}) {
  const db = load();
  const key = q.trim().toLowerCase();
  return db.collaborations
    .filter((cb) => !ownerUserId || cb.ownerUserId === ownerUserId)
    .filter((cb) => !status || cb.status === status)
    .map(expandCollaboration)
    .filter((cb) => {
      if (!key) return true;
      const hay = [cb.creatorName, cb.recipient?.name, cb.recipient?.phone, cb.recipient?.address,
        ...cb.items.map((i) => i.productName),
        ...cb.packages.map((p) => p.trackingNo),
        ...cb.fulfillments.map((f) => [f.account?.nickname, f.account?.douyinId, f.account?.uid].join(' )'))]
        .join(' ').toLowerCase();
      return hay.includes(key);
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 手动置状态。仅「已终止」「已完成」允许，其余状态必须由动作驱动 */
export function setCollaborationStatus(id, status) {
  const db = load();
  const cb = db.collaborations.find((x) => x.id === id);
  if (!cb || !['已终止', '已完成'].includes(status)) return null;
  cb.status = status;
  cb.updatedAt = now();
  flush();
  return expandCollaboration(cb);
}

/* ================================================================ 包裹 */

/** 回填快递 → 合作自动变「已寄样」。将来接速店通 API 时走同一个入口 */
export function addPackage(collaborationId, { carrier, trackingNo, shippedAt = null, source = 'manual' }) {
  const db = load();
  const cb = db.collaborations.find((x) => x.id === collaborationId);
  if (!cb) return null;
  if (db.packages.some((p) => p.collaborationId === collaborationId && p.trackingNo === trackingNo)) {
    return expandCollaboration(cb);   // 同单号重复回填，幂等
  }
  db.packages.push({
    id: nextId('pk'), collaborationId,
    carrier: carrier || '', trackingNo: String(trackingNo || ''),
    shippedAt: shippedAt || now(), source, createdAt: now(),
  });
  if (cb.status === '待寄样') cb.status = '已寄样';
  cb.updatedAt = now();
  flush();
  return expandCollaboration(cb);
}

export function removePackage(packageId) {
  const db = load();
  const i = db.packages.findIndex((p) => p.id === packageId);
  if (i < 0) return false;
  const { collaborationId } = db.packages[i];
  db.packages.splice(i, 1);
  const cb = db.collaborations.find((x) => x.id === collaborationId);
  if (cb && !db.packages.some((p) => p.collaborationId === collaborationId) && cb.status === '已寄样') {
    cb.status = '待寄样';
  }
  flush();
  return true;
}

export function markNotified(collaborationId, value = true) {
  const db = load();
  const cb = db.collaborations.find((x) => x.id === collaborationId);
  if (!cb) return null;
  cb.notifiedAt = value ? now() : null;
  cb.updatedAt = now();
  flush();
  return expandCollaboration(cb);
}

/* ================================================================ 履约项 */

/**
 * 更新履约项。粘贴视频口令时自动置「已发布」并推动合作完成 —— 状态是动作的副产品。
 * shareToken 逐字节保存：完整口令是交接载荷，抖音跳转和千川加载都依赖它，改一个字符就可能失效。
 */
export function updateFulfillment(fulfillmentId, patch) {
  const db = load();
  const f = db.collab_accounts.find((x) => x.id === fulfillmentId);
  if (!f) return null;

  if (patch.shareToken !== undefined) {
    f.shareToken = patch.shareToken;                       // 不 trim、不清洗
    f.videoUrl = patch.videoUrl || '';
    f.publishedAt = patch.shareToken ? now() : null;
    if (patch.shareToken) f.filmingProgress = '已发布';
  }
  if (patch.filmingProgress && FILMING_PROGRESS.includes(patch.filmingProgress)) {
    f.filmingProgress = patch.filmingProgress;
  }
  if (patch.expectVideo !== undefined) f.expectVideo = Boolean(patch.expectVideo);

  syncCollaborationCompletion(f.collaborationId);
  flush();
  return f;
}

/** 所有需要出片的履约项都已发布 → 合作自动完成 */
function syncCollaborationCompletion(collaborationId) {
  const db = cache;
  const cb = db.collaborations.find((x) => x.id === collaborationId);
  if (!cb || ['已终止'].includes(cb.status)) return;
  const list = db.collab_accounts.filter((f) => f.collaborationId === collaborationId);
  if (!list.length) return;
  const pending = list.filter((f) => f.expectVideo && f.filmingProgress !== '已发布' && f.filmingProgress !== '本次不出片');
  if (!pending.length && cb.status !== '已完成') { cb.status = '已完成'; cb.updatedAt = now(); }
  else if (pending.length && cb.status === '已完成') {
    cb.status = db.packages.some((p) => p.collaborationId === collaborationId) ? '已寄样' : '待寄样';
    cb.updatedAt = now();
  }
}

/** 按昵称在「进行中且该账号未回传」的合作里定位履约项，供视频口令自动匹配 */
export function matchFulfillmentByNickname(nickname, ownerUserId = null) {
  const db = load();
  const key = String(nickname || '').trim().toLowerCase();
  if (!key) return [];
  const accounts = db.accounts.filter((a) => (a.nickname || '').trim().toLowerCase() === key);
  if (!accounts.length) return [];
  const ids = new Set(accounts.map((a) => a.id));

  return db.collab_accounts
    .filter((f) => ids.has(f.accountId))
    .map((f) => {
      const cb = db.collaborations.find((x) => x.id === f.collaborationId);
      return { fulfillment: f, collaboration: cb ? expandCollaboration(cb) : null };
    })
    .filter((x) => x.collaboration && x.collaboration.status !== '已终止')
    // 优先未回传、进行中的；其次按创建时间倒序
    .sort((a, b) => {
      const ap = a.fulfillment.shareToken ? 1 : 0;
      const bp = b.fulfillment.shareToken ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return a.collaboration.createdAt < b.collaboration.createdAt ? 1 : -1;
    });
}

export function getFulfillment(id) {
  const db = load();
  const f = db.collab_accounts.find((x) => x.id === id);
  if (!f) return null;
  return { ...f, account: db.accounts.find((a) => a.id === f.accountId) || null,
    collaboration: getCollaboration(f.collaborationId) };
}

/* ================================================================ 统计 */

export function stats() {
  const db = load();
  return {
    creators: db.creators.length,
    accounts: db.accounts.length,
    collaborations: db.collaborations.length,
    drafts: db.drafts.length,
    products: db.products.filter((p) => p.active !== false).length,
  };
}

/* ================================================================ 草稿 */

export function listDrafts(userId = null) {
  const db = load();
  return db.drafts.filter((d) => !userId || d.ownerUserId === userId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function saveDraft({ id, ownerUserId, rawText, form, extracted }) {
  const db = load();
  const ts = now();
  let d = id ? db.drafts.find((x) => x.id === id) : null;
  if (!d) { d = { id: nextId('df'), ownerUserId, createdAt: ts }; db.drafts.push(d); }
  d.ownerUserId = ownerUserId ?? d.ownerUserId;
  d.rawText = rawText ?? d.rawText ?? '';
  d.form = form ?? d.form ?? null;
  d.extracted = extracted ?? d.extracted ?? null;
  d.title = form?.name || form?.accounts?.[0]?.nickname || '未命名草稿';
  d.updatedAt = ts;
  flush();
  return d;
}

export function getDraft(id) { return load().drafts.find((d) => d.id === id) || null; }

export function deleteDraft(id) {
  const db = load();
  const i = db.drafts.findIndex((d) => d.id === id);
  if (i >= 0) { db.drafts.splice(i, 1); flush(); return true; }
  return false;
}

/* ================================================================ 识别任务 */

export function createJob({ ownerUserId, rawText, kind = 'intake', imageBase64 = null }) {
  const db = load();
  const first = String(rawText || '').split('\n').map((s) => s.trim()).find(Boolean) || '截图';
  const job = {
    id: nextId('jb'), ownerUserId, kind, rawText: rawText || '', imageBase64,
    title: first.slice(0, 24),
    status: 'queued', result: null, error: null,
    createdAt: now(), startedAt: null, finishedAt: null, elapsedMs: null,
  };
  db.jobs.push(job);
  flush();
  return job;
}

export function listJobs(userId = null) {
  const db = load();
  return db.jobs.filter((j) => !userId || j.ownerUserId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getJob(id) { return load().jobs.find((j) => j.id === id) || null; }

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

/** 服务启动时调用：上次进程退出残留的 running 任务复位重跑 */
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
  const picked = [];
  let dirty = false;
  for (const j of db.jobs) {
    if (picked.length >= limit) break;
    if (j.status === 'queued') {
      j.status = 'running'; j.startedAt = now(); j._pid = true;
      picked.push(j); dirty = true;
    }
  }
  if (dirty) flush();
  return picked;
}

export function runningCount() { return load().jobs.filter((j) => j.status === 'running').length; }

/* ================================================================ 留痕 */

/** 蓝图 §19.1：原文、模型输出、版本、置信度、人工修改差异、确认人与时间 */
export function appendIntakeLog(entry) {
  const db = load();
  const log = { id: nextId('lg'), createdAt: now(), ...entry };
  db.intake_logs.push(log);
  flush();
  return log;
}

export function listIntakeLogs({ creatorId = null, collaborationId = null } = {}) {
  const db = load();
  return db.intake_logs.filter((l) =>
    (!creatorId || l.creatorId === creatorId) && (!collaborationId || l.collaborationId === collaborationId));
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
  for (let i = 0; i < Math.max(ea.length, fa.length); i++) {
    cmp(`账号${i + 1}·昵称`, val(ea[i]?.nickname), fa[i]?.nickname);
    cmp(`账号${i + 1}·抖音号`, val(ea[i]?.douyin_id), fa[i]?.douyinId);
    cmp(`账号${i + 1}·UID`, val(ea[i]?.uid), fa[i]?.uid);
    cmp(`账号${i + 1}·合作码`, val(ea[i]?.cooperation_code), fa[i]?.cooperationCode);
  }
  return diff;
}
