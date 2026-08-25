/**
 * SQLite 存储引擎 —— db.js 底下的那一层。
 *
 * 只管「怎么存」，不管业务规则。业务语义在 db.js，规则判断在 rules.js。
 *
 * 用 node:sqlite（Node 内置），保持零第三方依赖，服务器上不需要编译原生模块。
 * 注意它目前带 experimental 标记，Node 大版本升级前要复测一遍。
 *
 * ── 表结构的取舍 ────────────────────────────────────────────────
 * 每张表 = 一个实体，一行一条记录。但字段不全部拆成列，只把
 * **会被查询、排序、关联的字段**独立成列并建索引，其余整体存进 data JSON 列。
 *
 * 这么做的理由：
 *   · 热点路径（查重、按归属过滤、按合作关联）走真索引，不再全表扫
 *   · 剩下的字段增删不用改表结构，业务还在快速变
 *   · 从 db.json 迁移时一条对象直接对应一行，语义不会在转换中走样
 * 将来某个字段需要查询了，再把它从 JSON 里提成列，是渐进的，不用一次做完。
 *
 * 所有 ID 一律 TEXT。合作码、抖音号、UID 这类「看起来像数字的字符串」
 * 绝不能进数值列 —— 04000000031 一旦被当成整数，前导零就没了。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* ================================================================ 表结构 */

/**
 * 每张表声明：哪些字段提成列（cols），其余进 data。
 * 列一律可空 —— 历史数据里这些字段不一定都有，导入时不能因为缺字段就失败。
 */
export const TABLES = {
  users: { cols: {} },
  creators: { cols: { ownerUserId: 'TEXT', name: 'TEXT', createdAt: 'TEXT' } },
  accounts: { cols: { creatorId: 'TEXT', uid: 'TEXT', douyinId: 'TEXT', nickname: 'TEXT', cooperationCode: 'TEXT' } },
  other_accounts: { cols: { creatorId: 'TEXT', platform: 'TEXT' } },
  products: { cols: { name: 'TEXT', active: 'INTEGER' } },
  collaborations: { cols: { creatorId: 'TEXT', ownerUserId: 'TEXT', status: 'TEXT', createdAt: 'TEXT' } },
  collab_items: { cols: { collaborationId: 'TEXT', productId: 'TEXT' } },
  collab_accounts: { cols: { collaborationId: 'TEXT', accountId: 'TEXT', filmingProgress: 'TEXT' } },
  packages: { cols: { collaborationId: 'TEXT', trackingNo: 'TEXT' } },
  drafts: { cols: { ownerUserId: 'TEXT', updatedAt: 'TEXT' } },
  intake_logs: { cols: { creatorId: 'TEXT', collaborationId: 'TEXT', createdAt: 'TEXT' } },
  jobs: { cols: { ownerUserId: 'TEXT', status: 'TEXT', kind: 'TEXT', createdAt: 'TEXT' } },

  /* 会话相关。当前用的是签名 cookie（无状态），这两张表留给将来
     需要「主动踢单个人下线」时用 —— 那时候会话必须有服务端状态。 */
  identities: { cols: { userId: 'TEXT', provider: 'TEXT', externalId: 'TEXT', tenantKey: 'TEXT' } },
  sessions: { cols: { userId: 'TEXT', tokenHash: 'TEXT', expiresAt: 'TEXT' } },

  /* 飞书同步的出站队列。
     业务动作只负责往这里塞一条，推送在后台做 ——
     飞书挂了、断网了、令牌过期了，都不能让商务点不了「确认寄样」。 */
  outbox: { cols: { target: 'TEXT', entityId: 'TEXT', status: 'TEXT', nextAt: 'TEXT' } },

  /* 本地合作 ↔ 飞书记录的对应关系。
     有了它才知道该新建还是该更新，也避免每次推送都去飞书搜一遍。 */
  sync_links: { cols: { target: 'TEXT', entityId: 'TEXT', externalId: 'TEXT' } },

  /* 操作日志：谁在什么时候动了什么。
     和 intake_logs 不是一回事 —— 那个记的是「模型抽出什么、人改成什么」，
     这个记的是「谁做了哪个动作」。前者是语料，后者是审计。 */
  op_logs: { cols: { at: 'TEXT', userId: 'TEXT', action: 'TEXT', target: 'TEXT', ok: 'INTEGER' } },

  /* 错误日志。同时还会打到 stderr —— 进程起不来的时候表里是写不进去的，
     那种情况只有 stderr 能留下线索。 */
  /* 列名叫 source 不叫 where —— where 是 SQLite 保留字，
     建表时会报一个只说「near "where": syntax error」的错，
     完全看不出是哪一列。热列的名字要避开保留字。 */
  err_logs: { cols: { at: 'TEXT', source: 'TEXT', userId: 'TEXT' } },
};

/** 索引：对应上面那些「会被查询」的列 */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_creators_owner   ON creators(ownerUserId)',
  // 查重的两条主路径。uid 和 douyinId 分开建，因为两者是独立判据
  'CREATE INDEX IF NOT EXISTS idx_accounts_uid     ON accounts(uid)',
  'CREATE INDEX IF NOT EXISTS idx_accounts_douyin  ON accounts(douyinId)',
  'CREATE INDEX IF NOT EXISTS idx_accounts_creator ON accounts(creatorId)',
  'CREATE INDEX IF NOT EXISTS idx_accounts_code    ON accounts(cooperationCode)',
  'CREATE INDEX IF NOT EXISTS idx_other_creator    ON other_accounts(creatorId)',
  'CREATE INDEX IF NOT EXISTS idx_collab_owner     ON collaborations(ownerUserId)',
  'CREATE INDEX IF NOT EXISTS idx_collab_creator   ON collaborations(creatorId)',
  'CREATE INDEX IF NOT EXISTS idx_collab_status    ON collaborations(status)',
  'CREATE INDEX IF NOT EXISTS idx_items_collab     ON collab_items(collaborationId)',
  'CREATE INDEX IF NOT EXISTS idx_ca_collab        ON collab_accounts(collaborationId)',
  'CREATE INDEX IF NOT EXISTS idx_ca_account       ON collab_accounts(accountId)',
  'CREATE INDEX IF NOT EXISTS idx_pkg_collab       ON packages(collaborationId)',
  'CREATE INDEX IF NOT EXISTS idx_pkg_tracking     ON packages(trackingNo)',
  'CREATE INDEX IF NOT EXISTS idx_drafts_owner     ON drafts(ownerUserId)',
  'CREATE INDEX IF NOT EXISTS idx_logs_creator     ON intake_logs(creatorId)',
  'CREATE INDEX IF NOT EXISTS idx_logs_collab      ON intake_logs(collaborationId)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_owner       ON jobs(ownerUserId, status)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_ident_ext ON identities(provider, externalId)',
  'CREATE INDEX IF NOT EXISTS idx_sess_token       ON sessions(tokenHash)',
  // 队列按状态取待办，按 entityId 去重（同一条合作连改三次只推最后一次）
  'CREATE INDEX IF NOT EXISTS idx_outbox_status    ON outbox(target, status, nextAt)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_ent ON outbox(target, entityId)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_link_ent  ON sync_links(target, entityId)',
  // 日志都是「按时间倒序翻」和「按人/按对象筛」两种读法
  'CREATE INDEX IF NOT EXISTS idx_op_at            ON op_logs(at)',
  'CREATE INDEX IF NOT EXISTS idx_op_user          ON op_logs(userId, at)',
  'CREATE INDEX IF NOT EXISTS idx_op_target        ON op_logs(target)',
  'CREATE INDEX IF NOT EXISTS idx_err_at           ON err_logs(at)',
];

/* ================================================================ 连接 */

let handle = null;
let dbPath = null;

export function open(file) {
  if (handle && dbPath === file) return handle;
  if (handle) close();

  const dir = dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  handle = new DatabaseSync(file);
  dbPath = file;

  // WAL：读不阻塞写。这个服务边识别边查询，读写是并发的。
  // 内存库不支持 WAL，忽略失败即可。
  try { handle.exec('PRAGMA journal_mode = WAL'); } catch { /* :memory: */ }
  handle.exec('PRAGMA foreign_keys = ON');
  // NORMAL 在 WAL 下已经足够安全，且省掉每次提交的 fsync
  try { handle.exec('PRAGMA synchronous = NORMAL'); } catch { /* ignore */ }

  createSchema();
  return handle;
}

export function close() {
  if (handle) { try { handle.close(); } catch { /* ignore */ } }
  handle = null;
  dbPath = null;
}

export function db() {
  if (!handle) throw new Error('store 未初始化：请先调用 open(file)');
  return handle;
}

function createSchema() {
  handle.exec(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  for (const [name, def] of Object.entries(TABLES)) {
    const extra = Object.entries(def.cols).map(([c, t]) => `,\n    ${c} ${t}`).join('');
    handle.exec(`CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY${extra},
    data TEXT NOT NULL
  )`);
  }
  for (const sql of INDEXES) handle.exec(sql);
}

/* ================================================================ 读写 */

const rowToObj = (r) => (r ? JSON.parse(r.data) : null);

/** 整表读出。冷路径用，热路径请走 query() 让 SQLite 过滤。 */
export function all(table) {
  return db().prepare(`SELECT data FROM ${table}`).all().map(rowToObj);
}

export function get(table, id) {
  if (id == null) return null;
  return rowToObj(db().prepare(`SELECT data FROM ${table} WHERE id = ?`).get(String(id)));
}

/** 按提取列等值查询，走索引。 */
export function findBy(table, col, value) {
  if (!(col in TABLES[table].cols)) throw new Error(`${table}.${col} 不是提取列，加不了索引查询`);
  return db().prepare(`SELECT data FROM ${table} WHERE ${col} = ?`).all(value == null ? null : String(value))
    .map(rowToObj);
}

/** 按提取列取值列表（IN 查询），用于「这些合作的所有产品行」这类批量关联。 */
export function findIn(table, col, values) {
  const list = [...new Set((values || []).filter((v) => v != null).map(String))];
  if (!list.length) return [];
  const holes = list.map(() => '?').join(',');
  return db().prepare(`SELECT data FROM ${table} WHERE ${col} IN (${holes})`).all(...list).map(rowToObj);
}

export function put(table, obj) {
  const def = TABLES[table];
  if (!def) throw new Error(`未知表：${table}`);
  if (!obj?.id) throw new Error(`${table} 的记录缺少 id`);

  const cols = Object.keys(def.cols);
  const names = ['id', ...cols, 'data'];
  const vals = [
    String(obj.id),
    ...cols.map((c) => {
      const v = obj[c];
      if (v == null) return null;
      // 布尔提列时存 0/1；其余一律转字符串，避免 SQLite 把 '007' 变成 7
      if (def.cols[c] === 'INTEGER') return v ? 1 : 0;
      return String(v);
    }),
    JSON.stringify(obj),
  ];
  const holes = names.map(() => '?').join(',');
  const upd = names.filter((n) => n !== 'id').map((n) => `${n} = excluded.${n}`).join(', ');
  db().prepare(
    `INSERT INTO ${table} (${names.join(',')}) VALUES (${holes})
     ON CONFLICT(id) DO UPDATE SET ${upd}`,
  ).run(...vals);
  return obj;
}


export function remove(table, id) {
  const r = db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(String(id));
  return r.changes > 0;
}

export function removeBy(table, col, value) {
  const r = db().prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(value == null ? null : String(value));
  return r.changes;
}

export function count(table, where = '', params = []) {
  const sql = `SELECT COUNT(*) AS c FROM ${table}${where ? ' WHERE ' + where : ''}`;
  return db().prepare(sql).get(...params).c;
}

/** 自定义查询。返回的是 data 列反序列化后的对象，所以 SELECT 必须带 data。 */
export function query(sql, params = []) {
  return db().prepare(sql).all(...params).map(rowToObj);
}

/* ================================================================ 事务 */

let depth = 0;

/**
 * 事务。支持嵌套 —— 内层不会真的开启新事务，只跟着外层一起提交或回滚。
 * 「建达人 + 建合作 + 写留痕」这种必须整体成败的操作要包在这里面。
 */
export function tx(fn) {
  if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
  db().exec('BEGIN');
  depth = 1;
  try {
    const r = fn();
    db().exec('COMMIT');
    return r;
  } catch (e) {
    try { db().exec('ROLLBACK'); } catch { /* 已经回滚过 */ }
    throw e;
  } finally {
    depth = 0;
  }
}

/* ================================================================ meta */

export function meta(key, fallback = null) {
  const r = db().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}

export function setMeta(key, value) {
  db().prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
  return value;
}

/**
 * 自增序号。原来在 JSON 里是内存里 +1 再整file 写回，
 * 两个进程同时跑会发号重复。这里靠事务保证唯一。
 */
export function nextSeq(prefix) {
  return tx(() => {
    const n = (meta('_seq', 0) || 0) + 1;
    setMeta('_seq', n);
    return `${prefix}-${String(n).padStart(5, '0')}`;
  });
}
