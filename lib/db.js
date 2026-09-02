/**
 * 数据层 —— 单一出口。
 *
 * 业务数据存 SQLite（`lib/store.js`），配置存 `data/settings.json`。
 * 业务规则一律不写在这里（见 rules.js），这里只管存取。
 *
 * ── 为什么业务数据和配置分开 ────────────────────────────────────
 *   data/naimeng.db     业务数据（含达人 PII）—— 要备份、要迁移
 *   data/settings.json  配置（含 API Key、团队口令哈希）—— 密钥不能跟着备份走
 * 两类数据处置方式不同，所以不放一起。整个 data/ 都在 .gitignore。
 *
 * ── 关于 async ──────────────────────────────────────────────────
 * 对外全部 async。node:sqlite 本身是同步的，所以内部辅助函数保持同步，
 * 只有导出层包一层 async —— 这样将来换成 Postgres（异步驱动）时，
 * 只需要改本文件内部，server.js 一行不动。
 * 这个约定已经兑现过一次代价：早先 agent.js 漏了一个 await，
 * 模型配置静默回落到环境变量，界面上「已保存」照常显示却永远走本地模拟。
 *
 * 模型分层（见《商务动作入口改造方案 v1》§2）：
 *   达人 creators          稳定身份 + 归属人 + 默认收件信息
 *   账号 accounts          抖音号/UID/合作码，合作码长期不变
 *   合作 collaborations    一次合作：收件快照 + 费用 + 状态
 *     ├ 产品行 collab_items      一次合作可含多个产品，各自数量
 *     ├ 履约项 collab_accounts   每个参与账号一条：拍摄进度 + 视频口令
 *     └ 包裹 packages            一次合作可拆多个快递单
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './store.js';
import { importFromJson } from './import-json.js';
import * as rules from './rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 测试用 NAIMENG_DATA_DIR 指向临时目录，避免污染真实数据
const DATA_DIR = process.env.NAIMENG_DATA_DIR || join(ROOT, 'data');
const DB_FILE = join(DATA_DIR, 'naimeng.db');
const LEGACY_JSON = join(DATA_DIR, 'db.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export const SCHEMA_VERSION = 2;

export const ROLES = [
  { id: 'business', name: '商务' },
  { id: 'operations', name: '运营' },
  { id: 'warehouse', name: '仓库' },
];

/**
 * 合作状态。全部由动作驱动，只有「已终止」是手动的。
 *
 * 「进行中」是不寄样合作的起点 —— 它没有寄样这一步，
 * 落成「待寄样」的话表里会一直挂着一个永远不会被寄的东西，
 * 看到的人只会困惑。
 */
export const COLLAB_STATUS = ['待寄样', '进行中', '已寄样', '已完成', '已终止'];

/** 履约项（账号级）拍摄进度 */
export const FILMING_PROGRESS = ['待拍摄', '已催拍', '已发布', '本次不出片'];

const DEFAULT_SETTINGS = {
  // 团队口令的 scrypt 哈希。空表示还没初始化，此时任何人都能完成 bootstrap。
  // 只存哈希不存明文，settings.json 被拷走也拿不到口令本身。
  auth: { passphrase: '' },
  /* 已签发的 API token 清单：[{ id, name, userId, createdAt, lastUsedAt }]。
     token 本身不存 —— 只存 id。丢了就吊销重发，找不回来是对的。 */
  apiTokens: [],
  /* 允许跨源访问的 origin 白名单，如 https://xxx.feishu.cn。
     空数组 = 不允许任何跨源，这是默认。 */
  cors: { origins: [] },
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
  // 飞书多维表格同步。单向推送，appSecret 和 API Key 一样只存不回显。
  feishu: {
    enabled: false,
    appId: '', appSecret: '',
    appToken: '', tableId: '', tableName: '',
    mapping: {},            // { 本系统字段id: 飞书列名 }
  },
  // {物流} 每个包裹一行「承运商 单号」，一次合作拆多个快递时不会错位
  notifyTemplate:
    '宝子，样品已经寄出啦～\n{物流}\n{商品}\n收到后麻烦帮忙确认下，有问题随时找我',
};

let settingsCache = null;
let opened = false;

/* ================================================================ 备份 */

const BACKUP_DIR = join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 7;

/**
 * 启动时把数据库复制一份到 data/backups/，只保留最近 KEEP_BACKUPS 份。
 *
 * SQLite 有事务和锁，不会再出现「两个进程互相覆盖」那种问题，
 * 但误删、误改、磁盘故障依然存在，而备份很便宜。
 *
 * WAL 模式下光拷 .db 可能漏掉还在 WAL 里的最新事务，
 * 所以先 checkpoint 把 WAL 落盘再拷。
 */
export async function backupNow(reason = 'startup') {
  ensure();
  if (!existsSync(DB_FILE)) return null;
  try {
    try { store.db().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 内存库没有 WAL */ }
    mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = join(BACKUP_DIR, `naimeng-${ts}-${reason}.db`);
    copyFileSync(DB_FILE, target);

    // 文件名里的时间戳是定长的，字典序等于时间序
    const old = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('naimeng-') && f.endsWith('.db')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
      try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* 删不掉就算了，不能因为清理失败挡住启动 */ }
    }
    return target;
  } catch (e) {
    console.error('[db] 备份失败（不影响启动）：', e.message);
    return null;
  }
}

/* ================================================================ 打开 */

/**
 * 打开数据库；首次运行时把历史 db.json 一次性导进来。
 *
 * 导入只做一次（store 的 meta 里记了来源），**且不删 db.json** ——
 * 出问题能对账、能重来。重复导入会被跳过，
 * 否则第二次启动就会用旧快照盖掉用户新录的数据。
 */
function ensure() {
  if (opened) return;
  opened = true;
  store.open(DB_FILE);

  if (existsSync(LEGACY_JSON) && !store.meta('importedFrom')) {
    try {
      const r = importFromJson(LEGACY_JSON);
      if (!r.skipped) {
        const n = Object.entries(r.counts)
          .filter(([k, v]) => k !== '_seq' && v.imported)
          .map(([k, v]) => `${k} ${v.imported}`).join('、');
        console.log(`[db] 已从 db.json 迁入 SQLite：${n || '（空库）'}`);
        console.log('[db] 原 db.json 保留未删，确认无误后可自行归档');
      }
    } catch (e) {
      // 迁移失败必须响亮，不能静默当成空库继续跑
      console.error('');
      console.error('  ⚠ 从 db.json 迁入失败：' + e.message);
      console.error('  ⚠ 数据库现在是空的，先别录入任何东西。');
      console.error('');
    }
  }
  migrateV1toV2();
  if (!store.meta('schemaVersion')) store.setMeta('schemaVersion', SCHEMA_VERSION);
}

/**
 * v1 → v2：达人身上内嵌的 recipient 拆出去。
 *
 * v1 里「一条 creator」实际代表商务录的一次合作，但缺商品、数量、费用。
 * 迁移策略：收件信息同时留作达人默认值（下次录入自动带出），
 * 并生成一条「待寄样」合作保存快照 —— 缺的商品行会在待办里提示补充，
 * 这样既不丢历史，也不凭空编造数据。
 *
 * 跑在导入之后：老 db.json 先原样进库，再在库里做结构变换。
 * 迁移逻辑不掺进导入器 —— 导入只负责搬运，出了偏差才好分辨是搬错了还是变换错了。
 */
function migrateV1toV2() {
  if ((store.meta('schemaVersion', 1) || 1) >= SCHEMA_VERSION) return;

  const moved = store.tx(() => {
    let n = 0;
    for (const c of store.all('creators')) {
      if (!c.recipient) continue;

      c.defaultRecipient = { ...c.recipient };
      c.channel ??= '抖音达人广场';

      const accountIds = store.findBy('accounts', 'creatorId', c.id).map((a) => a.id);
      const collabId = nextId('cb');
      store.put('collaborations', {
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
        store.put('collab_accounts', {
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
      for (const log of store.findBy('intake_logs', 'creatorId', c.id)) {
        if (!log.collaborationId) { log.collaborationId = collabId; store.put('intake_logs', log); }
      }

      delete c.recipient;
      delete c.cooperationType;
      delete c.petCategory;   // 迁到合作级没有依据，v1 时也基本没填
      delete c.salesChannel;
      store.put('creators', c);
      n += 1;
    }
    store.setMeta('schemaVersion', SCHEMA_VERSION);
    return n;
  });

  if (moved) console.log(`[db] 已迁移 ${moved} 条达人记录到「达人 + 合作」模型`);
}

/* ================================================================ 设置 */

function loadSettings() {
  if (settingsCache) return settingsCache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  /* settings.user 已废弃。它曾是一份全局的「当前用户」，谁保存谁覆盖，
     是「商务甲改到商务乙资料」那个 bug 的根源。身份现在只由会话决定。
     merge 直接丢掉这个键 —— 留在文件里迟早有人再读它一次。
     不会丢数据：那些人早就在 users 表里有记录了。 */
  const merge = (raw) => ({
    auth: { ...DEFAULT_SETTINGS.auth, ...(raw.auth || {}) },
    apiTokens: Array.isArray(raw.apiTokens) ? raw.apiTokens : [],
    cors: { origins: Array.isArray(raw.cors?.origins) ? raw.cors.origins : [] },
    model: { ...DEFAULT_SETTINGS.model, ...(raw.model || {}) },
    vision: { ...DEFAULT_SETTINGS.vision, ...(raw.vision || {}) },
    followUp: { ...DEFAULT_SETTINGS.followUp, ...(raw.followUp || {}) },
    feishu: { ...DEFAULT_SETTINGS.feishu, ...(raw.feishu || {}),
      mapping: { ...(raw.feishu?.mapping || {}) } },
    notifyTemplate: raw.notifyTemplate ?? DEFAULT_SETTINGS.notifyTemplate,
  });

  if (existsSync(SETTINGS_FILE)) {
    try {
      settingsCache = merge(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
      /* 早先版本把整条分享链接原样存进了 appToken，导致它被直接拼进接口路径 → 404。
         读取时顺手修正，用户不必回去重填。 */
      const fixed = parseFeishuAppToken(settingsCache.feishu?.appToken);
      if (settingsCache.feishu && fixed !== settingsCache.feishu.appToken) {
        console.log(`[db] 已修正飞书 app_token：${settingsCache.feishu.appToken} → ${fixed || '(空)'}`);
        settingsCache.feishu.appToken = fixed;
        flushSettings();
      }
    }
    catch (e) {
      console.error('[db] settings.json 读取失败，已使用默认值：', e.message);
      settingsCache = structuredClone(DEFAULT_SETTINGS);
    }
    return settingsCache;
  }
  settingsCache = structuredClone(DEFAULT_SETTINGS);
  flushSettings();
  return settingsCache;
}

/** 原子写入：先写临时文件再 rename，避免进程中断损坏文件 */
function flushSettings() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(settingsCache, null, 2), 'utf8');
  renameSync(tmp, SETTINGS_FILE);
}

/** 从飞书分享链接里抠出 app_token；已经是纯 token 就原样返回 */
function parseFeishuAppToken(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  const m = v.match(/\/base\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{10,}$/.test(v) ? v : '';
}

const nextId = (prefix) => store.nextSeq(prefix);
const now = () => new Date().toISOString();


/* ================================================================ 外部同步 */

/**
 * 标记一条合作「有变更，待推送到外部系统」。
 *
 * 放在 db 层而不是 server 的每个路由里，是因为**这样忘不掉** ——
 * 改动合作的入口有八九个，靠人记得在每处调一次，迟早会漏掉新加的那个，
 * 而漏掉的表现是「飞书表里这条一直不更新」，很难发现。
 *
 * 这里只往 outbox 写一行，不引 sync.js（那会造成循环依赖），
 * 也不真的发请求 —— 推送在后台做，飞书挂了不影响商务干活。
 * 同一条合作短时间内改多次只留一行：推的是当前完整快照，不是增量。
 */
function markDirty(collaborationId) {
  if (!collaborationId) return;
  try {
    const exist = store.findBy('outbox', 'entityId', collaborationId).find((r) => r.target === 'feishu');
    const row = exist || { id: nextId('ob'), target: 'feishu', entityId: collaborationId, attempts: 0 };
    row.status = 'pending';
    row.nextAt = new Date().toISOString();
    store.put('outbox', row);
  } catch { /* 入队失败绝不能影响业务动作本身 */ }
}

/* ================================================================ 用户 */

export async function listUsers() { ensure(); return store.all('users'); }

export async function getSettings() { ensure(); return loadSettings(); }

/**
 * 保存设置。用户信息同步 upsert 成一条 user 记录，
 * 让归属和留痕有稳定的 id 可指。
 */
export async function saveSettings(patch = {}) {
  ensure();
  const s = loadSettings();

  /* 这里**不再处理 patch.user**。
     曾经 settings.user 是一份全局的「当前用户」，谁保存谁覆盖：
     商务甲打开设置页看到的是商务乙最后存的姓名和角色，
     一点保存就按姓名去 users 表里匹配 —— 改到的是商务乙的记录。
     身份现在由会话决定，改自己的资料走 updateUser(me.id, ...)。 */
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
  if (patch.auth) s.auth = { ...s.auth, ...patch.auth };
  if (patch.feishu) {
    // appSecret 传空表示「不修改」，和 API Key 一个道理：界面回显的是掩码
    const { appSecret, clearSecret, mapping, appToken, ...rest } = patch.feishu;
    s.feishu = { ...s.feishu, ...rest };
    /* appToken 在**入口处**归一成纯 token，不存原始链接。
       用户粘的是整条分享 URL，而它会被直接拼进接口路径 ——
       存原始链接的话，凡是没记得调 parseAppToken 的调用点全部 404，
       而且返回的是 HTML 错误页，报错只说「不是 JSON」，极难定位。
       在边界上归一，比指望每个调用点都记得解析可靠得多。 */
    if (appToken !== undefined) s.feishu.appToken = parseFeishuAppToken(appToken);
    if (mapping) s.feishu.mapping = { ...mapping };
    if (typeof appSecret === 'string' && appSecret.trim() && !/^[*•]+$/.test(appSecret.trim())) {
      s.feishu.appSecret = appSecret.trim();
    }
    if (clearSecret) s.feishu.appSecret = '';
  }
  if (patch.cors) {
    /* origin 必须是纯源（协议+主机+端口），带路径的一律不收 ——
       CORS 比对的就是源，存了路径只会在比对时永远不匹配，
       而那个现象看起来像「白名单没生效」。 */
    const list = (patch.cors.origins || []).map((o) => rules.normalizeOrigin(o)).filter(Boolean);
    s.cors = { origins: [...new Set(list)] };
  }
  if (patch.followUp) s.followUp = { ...s.followUp, ...patch.followUp };
  if (typeof patch.notifyTemplate === 'string') s.notifyTemplate = patch.notifyTemplate;

  flushSettings();
  return s;
}

/**
 * 当前操作人。
 *
 * 参数名叫 sessionUserId：它来自服务端签发的会话 cookie，不是前端自报的。
 * 没有会话就是匿名，**不回落到任何人** —— 早先会回落到全局 settings.user，
 * 意味着任何未登录请求都自动获得「最后一个保存过身份的人」的权限。
 */
/**
 * 改某个人的资料。**按 id 改，不按姓名匹配。**
 *
 * 按姓名匹配是上一版的做法，后果是「商务甲保存自己的资料，
 * 改到了商务乙的记录」—— 因为表单里显示的是全局最后保存的那个人。
 * 调用方必须先从会话拿到 id，这条路径上不存在「猜是谁」的余地。
 */
export async function updateUser(userId, patch = {}) {
  ensure();
  const u = store.get('users', userId);
  if (!u) return null;

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('姓名不能为空');
    /* 重名会让登录时的成员列表分不清谁是谁 —— 那份列表就是按姓名给人选的 */
    const clash = store.all('users').find((x) => x.id !== userId && x.name === name);
    if (clash) throw new Error(`已经有一位「${name}」了，换一个名字或加个后缀`);
    u.name = name;
  }
  if (patch.role !== undefined) {
    if (!ROLES.some((r) => r.id === patch.role)) throw new Error('角色不合法');
    u.role = patch.role;
  }
  if (patch.phone !== undefined) u.phone = String(patch.phone || '').trim();

  store.put('users', u);
  return u;
}

/** 建一个成员。目前只有 bootstrap（首次初始化）用得到 */
export async function createUser({ name, role = 'business', phone = '' }) {
  ensure();
  const n = String(name || '').trim();
  if (!n) throw new Error('姓名不能为空');
  if (store.all('users').some((x) => x.name === n)) throw new Error(`已经有一位「${n}」了`);
  if (!ROLES.some((r) => r.id === role)) throw new Error('角色不合法');
  const u = { id: nextId('u'), name: n, role, phone: String(phone || '').trim() };
  store.put('users', u);
  return u;
}

/* ================================================================ API token */

export async function listApiTokens() {
  ensure();
  return (loadSettings().apiTokens || []).map((t) => ({ ...t }));
}

/**
 * 记一条已签发的令牌。**只存 id 和元信息，不存 token 本身** ——
 * 存了就等于把长期凭据明文落在 settings.json 里，
 * 而那个文件出问题时人是会直接打开看的。
 */
export async function addApiToken({ name, userId, kind = 'manual' }) {
  ensure();
  const s = loadSettings();
  const rec = {
    id: nextId('at'), name: String(name || '未命名').slice(0, 40),
    userId, kind, createdAt: now(), lastUsedAt: null,
  };
  s.apiTokens = [...(s.apiTokens || []), rec];
  flushSettings();
  return rec;
}

/**
 * 吊销某人某一类的全部令牌，返回吊销掉的条数。
 *
 * 插件每登录一次就换一个新令牌。不清掉旧的话，一个人登录十次
 * 就在清单里留下十个**都还有效**的 90 天凭据，而且没人会记得去清 ——
 * 「发出去的凭据收不回来」正是当初给令牌加 id 的原因，
 * 在这儿又攒回来就白做了。
 *
 * 代价是同一个人在两台设备上用插件时，后登录的会把先登录的顶掉。
 * 这里选了「凭据数量可控」而不是「多设备同时在线」——
 * 6 个人、都在办公室、都在电脑上用飞书。
 */
export async function revokeApiTokensOf(userId, kind) {
  ensure();
  const s = loadSettings();
  const before = (s.apiTokens || []).length;
  s.apiTokens = (s.apiTokens || []).filter((t) => !(t.userId === userId && t.kind === kind));
  const n = before - s.apiTokens.length;
  if (n) flushSettings();
  return n;
}

export async function revokeApiToken(id) {
  ensure();
  const s = loadSettings();
  const before = (s.apiTokens || []).length;
  s.apiTokens = (s.apiTokens || []).filter((t) => t.id !== id);
  if (s.apiTokens.length === before) return false;
  flushSettings();
  return true;
}

/** 令牌还在清单里吗。吊销 = 从清单里删掉，所以这是唯一的判据 */
export async function isApiTokenLive(id) {
  ensure();
  try { return (loadSettings().apiTokens || []).some((t) => t.id === id); } catch { return false; }
}

/**
 * 记一次使用。**故意做成尽力而为、不阻塞请求** ——
 * 每次 API 调用都写一次 settings.json 太重，所以只在跨过一小时时才落盘。
 * 「上次使用」精确到小时足够回答「这个令牌还有人在用吗」。
 */
export async function touchApiToken(id) {
  ensure();
  try {
    const s = loadSettings();
    const t = (s.apiTokens || []).find((x) => x.id === id);
    if (!t) return;
    if (t.lastUsedAt && Date.now() - Date.parse(t.lastUsedAt) < 3600_000) return;
    t.lastUsedAt = now();
    flushSettings();
  } catch { /* 记不上不影响请求 */ }
}

export async function currentUser(sessionUserId) {
  ensure();
  if (sessionUserId) return store.get('users', sessionUserId);
  return null;
}

/* ================================================================ 产品 */

export async function listProducts({ includeInactive = false, petCategory = '' } = {}) {
  ensure();
  return store.all('products')
    .filter((p) => includeInactive || p.active !== false)
    .filter((p) => !petCategory || !p.petCategory || p.petCategory === '通用' || p.petCategory === petCategory)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

export async function saveProduct(p) {
  ensure();
  if (p.id) {
    const found = store.get('products', p.id);
    if (!found) return null;
    Object.assign(found, {
      name: p.name ?? found.name,
      petCategory: p.petCategory ?? found.petCategory,
      spec: p.spec ?? found.spec,
      active: p.active ?? found.active,
    });
    store.put('products', found);
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
  store.put('products', created);
  return created;
}

export async function deleteProduct(id) {
  ensure();
  const used = store.findBy('collab_items', 'productId', id).length > 0;
  if (used) {                       // 已被合作引用的产品只停用，不物理删除
    const p = store.get('products', id);
    if (p) { p.active = false; store.put('products', p); }
    return { ok: true, softDeleted: true };
  }
  return store.remove('products', id) ? { ok: true } : { ok: false };
}

/* ================================================================ 查重 */

/**
 * 按抖音号 / UID 精确查重（蓝图 §18.9）。
 * 查重永远全局，不按归属过滤 —— 否则「已归属其他商务」这条规则无法工作。
 *
 * uid 和 douyinId 都建了索引，这里走索引不再全表扫。
 */
export async function findConflicts(accounts = [], phone = null, excludeCreatorId = null) {
  ensure();
  const hard = [];
  const soft = [];

  for (const a of accounts) {
    const uid = String(a.uid || '').trim();
    const did = String(a.douyinId || '').trim();
    if (!uid && !did) continue;

    const cands = [
      ...(uid ? store.findBy('accounts', 'uid', uid) : []),
      ...(did ? store.findBy('accounts', 'douyinId', did) : []),
    ];
    const hit = cands.find((x) => x.creatorId !== excludeCreatorId);
    if (!hit) continue;

    const creator = store.get('creators', hit.creatorId);
    const owner = creator?.ownerUserId ? store.get('users', creator.ownerUserId) : null;
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
        collaborationCount: store.findBy('collaborations', 'creatorId', hit.creatorId).length,
      },
    });
  }

  // 弱提示：同手机号可能是同一达人的另一批账号（§4.2 建模缺口的折中）
  if (phone) {
    const p = String(phone).trim();
    for (const c of store.all('creators')) {
      if (c.id === excludeCreatorId) continue;
      if (c.defaultRecipient?.phone === p) {
        const owner = c.ownerUserId ? store.get('users', c.ownerUserId) : null;
        soft.push({ reason: '收件手机号相同', creatorId: c.id, creatorName: c.name, owner: owner?.name || '未知' });
      }
    }
  }
  return { hard, soft };
}

/* ================================================================ 达人 */

export async function createCreator(payload, userId) {
  ensure();
  return store.tx(() => {
    const id = nextId('cr');
    const ts = now();
    const creator = {
      id,
      name: payload.name || '',
      ownerUserId: userId,
      defaultRecipient: { ...(payload.recipient || {}) },
      createdAt: ts,
      updatedAt: ts,
    };
    store.put('creators', creator);
    addAccountsSync(id, payload.accounts || [], payload.otherAccounts || []);
    return creator;
  });
}

/** 往已有达人上补充账号。重复的跳过，不报错 —— 场景是「同一达人的新账号分次发来」 */
function addAccountsSync(creatorId, accounts = [], otherAccounts = []) {
  const ts = now();
  const added = [];
  const mine = store.findBy('accounts', 'creatorId', creatorId);

  for (const a of accounts) {
    if (!a.douyinId && !a.uid && !a.nickname && !a.cooperationCode) continue;
    const dup = mine.find(
      (x) => (a.uid && x.uid === String(a.uid)) || (a.douyinId && x.douyinId === a.douyinId),
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
    store.put('accounts', rec);
    mine.push(rec);
    added.push(rec);
  }

  const others = store.findBy('other_accounts', 'creatorId', creatorId);
  for (const o of otherAccounts) {
    if (!o.accountId) continue;
    if (others.some((x) => x.accountId === String(o.accountId))) continue;
    const rec = {
      id: nextId('oa'), creatorId,
      platform: o.platform || '其他',
      accountId: String(o.accountId),
      sourceText: o.sourceText || '',
      createdAt: ts,
    };
    store.put('other_accounts', rec);
    others.push(rec);
  }
  return added;
}

export async function addAccounts(creatorId, accounts = [], otherAccounts = []) {
  ensure();
  return store.tx(() => addAccountsSync(creatorId, accounts, otherAccounts));
}

export async function updateCreator(id, patch) {
  ensure();
  const c = store.get('creators', id);
  if (!c) return null;
  if (patch.name !== undefined) c.name = patch.name;
  if (patch.defaultRecipient) c.defaultRecipient = { ...c.defaultRecipient, ...patch.defaultRecipient };
  c.updatedAt = now();
  store.put('creators', c);
  return c;
}

/**
 * 归属转交。归属人是责任人不是标签，人员变动时必须能转，否则待办无人认领。
 * 转交留痕。
 */
export async function transferOwner(creatorId, toUserId, byUserId, reason = '') {
  ensure();
  return store.tx(() => {
    const c = store.get('creators', creatorId);
    const to = store.get('users', toUserId);
    if (!c || !to) return null;
    const from = c.ownerUserId;
    c.ownerUserId = toUserId;
    c.updatedAt = now();
    c.ownerHistory = [...(c.ownerHistory || []), { from, to: toUserId, by: byUserId, reason, at: now() }];
    store.put('creators', c);
    // 合作跟着达人走
    for (const cb of store.findBy('collaborations', 'creatorId', creatorId)) {
      cb.ownerUserId = toUserId;
      store.put('collaborations', cb);
      markDirty(cb.id);
    }
    return c;
  });
}

export async function getCreator(id) {
  ensure();
  const c = store.get('creators', id);
  if (!c) return null;
  const owner = c.ownerUserId ? store.get('users', c.ownerUserId) : null;
  return {
    ...c,
    ownerName: owner?.name || '未知',
    accounts: store.findBy('accounts', 'creatorId', id),
    otherAccounts: store.findBy('other_accounts', 'creatorId', id),
    collaborations: store.findBy('collaborations', 'creatorId', id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((cb) => expandCollaboration(cb)),
  };
}

export async function listCreators({ q = '', ownerUserId = null } = {}) {
  ensure();
  const key = q.trim().toLowerCase();
  const base = ownerUserId ? store.findBy('creators', 'ownerUserId', ownerUserId) : store.all('creators');
  return base
    .map((c) => {
      const accounts = store.findBy('accounts', 'creatorId', c.id);
      const collabs = store.findBy('collaborations', 'creatorId', c.id);
      const owner = c.ownerUserId ? store.get('users', c.ownerUserId) : null;
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

/**
 * 展开一条合作：补上达人名、归属人名、产品行、履约项、包裹。
 *
 * 保持同步（node:sqlite 本身同步），并且四处关联查询都走索引，
 * 所以 listCollaborations 是 N×常数而不是 N²。
 */
function expandCollaboration(cb) {
  const creator = cb.creatorId ? store.get('creators', cb.creatorId) : null;
  const owner = cb.ownerUserId ? store.get('users', cb.ownerUserId) : null;
  const fulfillments = store.findBy('collab_accounts', 'collaborationId', cb.id)
    .map((f) => ({ ...f, account: f.accountId ? store.get('accounts', f.accountId) : null }));
  return {
    ...cb,
    creatorName: creator?.name || '',
    /* 视频号 / 快手这些。模型一直在抽、库里一直在存，但界面上没有出口 ——
       花了 token、占了库，还给人「系统记着呢」的错觉。带出来给达人档案显示。 */
    otherAccounts: creator ? store.findBy('other_accounts', 'creatorId', creator.id) : [],
    ownerName: owner?.name || '未知',
    items: store.findBy('collab_items', 'collaborationId', cb.id),
    fulfillments,
    packages: store.findBy('packages', 'collaborationId', cb.id),
  };
}

export async function createCollaboration(payload, userId) {
  ensure();
  const id = store.tx(() => {
    const creator = store.get('creators', payload.creatorId);
    if (!creator) return null;

    const cid = nextId('cb');
    const ts = now();
    store.put('collaborations', {
      id: cid,
      creatorId: creator.id,
      ownerUserId: creator.ownerUserId || userId,   // 归属跟达人走
      type: rules.COLLAB_TYPES.includes(payload.type) ? payload.type : '寄样合作',
      recipient: { ...(payload.recipient || {}) },  // 本次快照
      sampleCost: payload.sampleCost ?? null,
      petCategory: payload.petCategory || '',
      salesChannel: payload.salesChannel || '',
      /* 不寄样的合作直接进「进行中」，跳过整个寄样阶段 */
      status: rules.needsSample(payload.type) ? '待寄样' : '进行中',
      notifiedAt: null,
      createdAt: ts,
      updatedAt: ts,
    });

    for (const it of payload.items || []) {
      if (!it.productId && !it.productName) continue;
      const product = it.productId ? store.get('products', it.productId) : null;
      store.put('collab_items', {
        id: nextId('ci'), collaborationId: cid,
        productId: it.productId || null,
        productName: it.productName || product?.name || '',   // 快照，产品改名不影响历史
        quantity: Number(it.quantity) || 1,
      });
    }

    for (const accountId of payload.accountIds || []) {
      if (!store.get('accounts', accountId)) continue;
      store.put('collab_accounts', {
        id: nextId('ca'), collaborationId: cid, accountId,
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
      store.put('creators', creator);
    }
    return cid;
  });
  if (id) markDirty(id);
  return id ? expandCollaboration(store.get('collaborations', id)) : null;
}

export async function getCollaboration(id) {
  ensure();
  const cb = store.get('collaborations', id);
  return cb ? expandCollaboration(cb) : null;
}

export async function listCollaborations({ ownerUserId = null, status = null, q = '' } = {}) {
  ensure();
  const key = q.trim().toLowerCase();
  let base = ownerUserId
    ? store.findBy('collaborations', 'ownerUserId', ownerUserId)
    : store.all('collaborations');
  if (status) base = base.filter((cb) => cb.status === status);

  return base
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
/**
 * 删掉一条合作。**不可逆。**
 *
 * 连带删：产品行、履约项、包裹。
 * **不删达人档案** —— 同一个达人可能还有别的合作，删档案是另一件事。
 * **不删 intake_logs** —— 那是「模型抽出什么、人改成什么」的语料，
 * 是这个系统里最难再生的数据，和这条合作在不在没有关系。
 *
 * 飞书那边的行由 sync.js 清理：这里只把 sync_links 留着，
 * 推送时发现合作已经不存在，就按记着的 record_id 把行删掉。
 * 反过来（这里直接删 sync_links）会让飞书里留下永远没人认领的孤儿行。
 */
export async function deleteCollaboration(id) {
  ensure();
  const ok = store.tx(() => {
    const cb = store.get('collaborations', id);
    if (!cb) return false;
    for (const t of ['collab_items', 'collab_accounts', 'packages']) {
      for (const row of store.findBy(t, 'collaborationId', id)) store.remove(t, row.id);
    }
    store.remove('collaborations', id);
    return true;
  });
  if (!ok) return false;
  /* 入队，让 pump 去删飞书那几行。放在事务外 ——
     入队失败绝不能把已经完成的删除回滚掉。 */
  markDirty(id);
  return true;
}

export async function setCollaborationStatus(id, status) {
  ensure();
  const cb = store.get('collaborations', id);
  if (!cb || !['已终止', '已完成'].includes(status)) return null;
  cb.status = status;
  cb.updatedAt = now();
  store.put('collaborations', cb);
  markDirty(id);
  return expandCollaboration(cb);
}

/* ================================================================ 包裹 */

/** 回填快递 → 合作自动变「已寄样」。将来接速店通 API 时走同一个入口 */
export async function addPackage(collaborationId, { carrier, trackingNo, shippedAt = null, source = 'manual', shotId = null }) {
  ensure();
  const ok = store.tx(() => {
    const cb = store.get('collaborations', collaborationId);
    if (!cb) return false;
    const existing = store.findBy('packages', 'collaborationId', collaborationId);
    if (existing.some((p) => p.trackingNo === String(trackingNo || ''))) return true;   // 同单号重复回填，幂等

    store.put('packages', {
      id: nextId('pk'), collaborationId,
      carrier: carrier || '', trackingNo: String(trackingNo || ''),
      shippedAt: shippedAt || now(), source, createdAt: now(),
      /* 从截图识别来的包裹记住是哪张图 —— 单号对不上时，
         只有原图能说明是模型看错了还是仓库本来就发错了。 */
      shotId: shotId || null,
    });
    if (cb.status === '待寄样') cb.status = '已寄样';
    cb.updatedAt = now();
    store.put('collaborations', cb);
    return true;
  });
  if (!ok) return null;
  markDirty(collaborationId);
  return expandCollaboration(store.get('collaborations', collaborationId));
}

export async function removePackage(packageId) {
  ensure();
  return store.tx(() => {
    const pkg = store.get('packages', packageId);
    if (!pkg) return false;
    const { collaborationId } = pkg;
    store.remove('packages', packageId);

    const cb = store.get('collaborations', collaborationId);
    const left = store.findBy('packages', 'collaborationId', collaborationId);
    if (cb && !left.length && cb.status === '已寄样') {
      cb.status = '待寄样';
      store.put('collaborations', cb);
    }
    markDirty(collaborationId);
    return true;
  });
}

export async function markNotified(collaborationId, value = true) {
  ensure();
  const cb = store.get('collaborations', collaborationId);
  if (!cb) return null;
  cb.notifiedAt = value ? now() : null;
  cb.updatedAt = now();
  store.put('collaborations', cb);
  markDirty(collaborationId);
  return expandCollaboration(cb);
}

/* ================================================================ 履约项 */

/**
 * 更新履约项。粘贴视频口令时自动置「已发布」并推动合作完成 —— 状态是动作的副产品。
 * shareToken 逐字节保存：完整口令是交接载荷，抖音跳转和千川加载都依赖它，改一个字符就可能失效。
 */
export async function updateFulfillment(fulfillmentId, patch) {
  ensure();
  return store.tx(() => {
    const f = store.get('collab_accounts', fulfillmentId);
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
    /* 只给链接、没有口令的情形：达人直接发了个链接过来。
       口令那条路必须走 shareToken 分支（要逐字节保存），这条不碰它。 */
    if (patch.videoUrl !== undefined && patch.shareToken === undefined) {
      const url = String(patch.videoUrl || '').trim();
      f.videoUrl = url;
      if (url) {
        f.filmingProgress = '已发布';
        f.publishedAt = f.publishedAt || now();
      }
    }

    store.put('collab_accounts', f);
    syncCollaborationCompletion(f.collaborationId);
    markDirty(f.collaborationId);
    return f;
  });
}

/** 所有需要出片的履约项都已发布 → 合作自动完成 */
function syncCollaborationCompletion(collaborationId) {
  const cb = store.get('collaborations', collaborationId);
  if (!cb || cb.status === '已终止') return;
  const list = store.findBy('collab_accounts', 'collaborationId', collaborationId);
  if (!list.length) return;
  const pending = list.filter((f) => f.expectVideo && f.filmingProgress !== '已发布' && f.filmingProgress !== '本次不出片');
  if (!pending.length && cb.status !== '已完成') {
    cb.status = '已完成'; cb.updatedAt = now(); store.put('collaborations', cb);
  } else if (pending.length && cb.status === '已完成') {
    cb.status = store.findBy('packages', 'collaborationId', collaborationId).length ? '已寄样' : '待寄样';
    cb.updatedAt = now();
    store.put('collaborations', cb);
  }
}

/**
 * 手动挑合作用的搜索。
 *
 * 存在的理由：达人改昵称、或者商务直接甩一条裸链接过来，按昵称什么都匹配不到。
 * 这时候必须让人自己搜自己选，否则「更新视频」这个动作就地断掉。
 * 返回结构和 matchFulfillmentByNickname 保持一致，前端共用同一套卡片。
 */
export async function searchFulfillments({ q = '', ownerUserId = null, limit = 20 } = {}) {
  ensure();
  const key = String(q || '').trim().toLowerCase();
  if (!key) return [];

  return store.all('collab_accounts')
    .map((f) => {
      const cb = store.get('collaborations', f.collaborationId);
      return { fulfillment: f, collaboration: cb ? expandCollaboration(cb) : null };
    })
    .filter((x) => x.collaboration && x.collaboration.status !== '已终止')
    .filter((x) => !ownerUserId || x.collaboration.ownerUserId === ownerUserId)
    .filter((x) => {
      const acc = x.collaboration.fulfillments.find((f) => f.id === x.fulfillment.id)?.account || {};
      // 抖音号、UID、合作码都要能搜 —— 昵称改了的时候，这几个才是稳定标识
      return [x.collaboration.creatorName, acc.nickname, acc.douyinId, acc.uid, acc.cooperationCode]
        .join(' ').toLowerCase().includes(key);
    })
    .sort((a, b) => {
      const ap = a.fulfillment.shareToken ? 1 : 0;
      const bp = b.fulfillment.shareToken ? 1 : 0;
      if (ap !== bp) return ap - bp;             // 没回传过的排前面
      return a.collaboration.createdAt < b.collaboration.createdAt ? 1 : -1;
    })
    .slice(0, limit);
}

/** 按昵称在「进行中且该账号未回传」的合作里定位履约项，供视频口令自动匹配 */
export async function matchFulfillmentByNickname(nickname, ownerUserId = null) {
  ensure();
  const key = String(nickname || '').trim().toLowerCase();
  if (!key) return [];
  const accounts = store.all('accounts').filter((a) => (a.nickname || '').trim().toLowerCase() === key);
  if (!accounts.length) return [];

  return accounts
    .flatMap((a) => store.findBy('collab_accounts', 'accountId', a.id))
    .map((f) => {
      const cb = store.get('collaborations', f.collaborationId);
      return { fulfillment: f, collaboration: cb ? expandCollaboration(cb) : null };
    })
    .filter((x) => x.collaboration && x.collaboration.status !== '已终止')
    // 传了 ownerUserId 就只匹配自己的合作。不加这条的话，甲粘一条视频口令
    // 可能匹配到乙的合作并把口令写进去，乙那边会凭空多出一条回传记录。
    .filter((x) => !ownerUserId || x.collaboration.ownerUserId === ownerUserId)
    // 优先未回传、进行中的；其次按创建时间倒序
    .sort((a, b) => {
      const ap = a.fulfillment.shareToken ? 1 : 0;
      const bp = b.fulfillment.shareToken ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return a.collaboration.createdAt < b.collaboration.createdAt ? 1 : -1;
    });
}

export async function getFulfillment(id) {
  ensure();
  const f = store.get('collab_accounts', id);
  if (!f) return null;
  const cb = store.get('collaborations', f.collaborationId);
  return {
    ...f,
    account: f.accountId ? store.get('accounts', f.accountId) : null,
    collaboration: cb ? expandCollaboration(cb) : null,
  };
}

/* ================================================================ 统计 */

export async function stats() {
  ensure();
  return {
    creators: store.count('creators'),
    accounts: store.count('accounts'),
    collaborations: store.count('collaborations'),
    drafts: store.count('drafts'),
    products: store.all('products').filter((p) => p.active !== false).length,
  };
}

/* ================================================================ 草稿 */

export async function listDrafts(userId = null) {
  ensure();
  const base = userId ? store.findBy('drafts', 'ownerUserId', userId) : store.all('drafts');
  return base.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function saveDraft({ id, ownerUserId, rawText, form, extracted }) {
  ensure();
  const ts = now();
  let d = id ? store.get('drafts', id) : null;
  if (!d) d = { id: nextId('df'), ownerUserId, createdAt: ts };
  d.ownerUserId = ownerUserId ?? d.ownerUserId;
  d.rawText = rawText ?? d.rawText ?? '';
  d.form = form ?? d.form ?? null;
  d.extracted = extracted ?? d.extracted ?? null;
  d.title = form?.name || form?.accounts?.[0]?.nickname || '未命名草稿';
  d.updatedAt = ts;
  store.put('drafts', d);
  return d;
}

export async function getDraft(id) { ensure(); return store.get('drafts', id); }

export async function deleteDraft(id) { ensure(); return store.remove('drafts', id); }

/* ================================================================ 识别任务 */

export async function createJob({ ownerUserId, rawText, kind = 'intake', imageBase64 = null, shotId = null }) {
  ensure();
  const first = String(rawText || '').split('\n').map((s) => s.trim()).find(Boolean) || '截图';
  const job = {
    /* imageBase64 识别完就清掉（几 MB 一张，留在库里会把备份撑爆）；
       shotId 指向 data/shots/ 下的存档文件，那份要留着核对。 */
    id: nextId('jb'), ownerUserId, kind, rawText: rawText || '', imageBase64, shotId,
    title: first.slice(0, 24),
    status: 'queued', result: null, error: null,
    createdAt: now(), startedAt: null, finishedAt: null, elapsedMs: null,
  };
  store.put('jobs', job);
  return job;
}

export async function listJobs(userId = null) {
  ensure();
  const base = userId ? store.findBy('jobs', 'ownerUserId', userId) : store.all('jobs');
  return base.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getJob(id) { ensure(); return store.get('jobs', id); }

export async function updateJob(id, patch) {
  ensure();
  const j = store.get('jobs', id);
  if (!j) return null;
  Object.assign(j, patch);
  store.put('jobs', j);
  return j;
}

export async function deleteJob(id) { ensure(); return store.remove('jobs', id); }

/** 服务启动时调用：上次进程退出残留的 running 任务复位重跑 */
export async function resetStaleJobs() {
  ensure();
  return store.tx(() => {
    let n = 0;
    for (const j of store.all('jobs')) {
      if (j.status === 'running') {
        j.status = 'queued'; j.startedAt = null; delete j._pid;
        store.put('jobs', j); n++;
      }
    }
    return n;
  });
}

/**
 * 原子领取排队中的任务。
 *
 * 整个领取过程包在一个事务里 —— 这是并发安全的关键：
 * 两路同时来领，后一路看到的已经是前一路改过的状态，不会把同一条领两次
 * （领两次意味着同一段资料被送去模型识别两遍，白烧 token）。
 */
export async function claimQueuedJobs(limit) {
  ensure();
  return store.tx(() => {
    const picked = [];
    for (const j of store.all('jobs').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
      if (picked.length >= limit) break;
      if (j.status === 'queued') {
        j.status = 'running'; j.startedAt = now(); j._pid = true;
        store.put('jobs', j);
        picked.push(j);
      }
    }
    return picked;
  });
}

export async function runningCount() {
  ensure();
  return store.count('jobs', 'status = ?', ['running']);
}

/* ================================================================ 留痕 */

/** 蓝图 §19.1：原文、模型输出、版本、置信度、人工修改差异、确认人与时间 */
export async function appendIntakeLog(entry) {
  ensure();
  const log = { id: nextId('lg'), createdAt: now(), ...entry };
  store.put('intake_logs', log);
  return log;
}

export async function listIntakeLogs({ creatorId = null, collaborationId = null } = {}) {
  ensure();
  if (creatorId) {
    return store.findBy('intake_logs', 'creatorId', creatorId)
      .filter((l) => !collaborationId || l.collaborationId === collaborationId);
  }
  if (collaborationId) return store.findBy('intake_logs', 'collaborationId', collaborationId);
  return store.all('intake_logs');
}

/** 对比模型输出与商务最终提交值，得到字段级修改差异 */
export async function diffExtractedVsForm(extracted, form) {
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
