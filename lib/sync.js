/**
 * 飞书多维表格同步 —— 业务侧。
 *
 * 一条铁律：**同步失败绝不能影响商务干活。**
 * 所以业务动作只往出站队列塞一条记录就返回，真正的推送在后台做。
 * 飞书挂了、断网了、令牌过期了、列名被人改了 —— 商务照样能建档、能回填快递。
 * 这也是为什么不在业务函数里直接 await 飞书接口。
 *
 * ── 单向 ────────────────────────────────────────────────────────
 * 只从本系统推到飞书，不反向读回。
 * 代价说清楚：**被同步的那几列在飞书里手工改会被下一次推送覆盖。**
 * 双向同步要处理冲突和回环，复杂度是这个的好几倍，而这里的诉求是
 * 「让不进系统的人在熟悉的地方看到同一份数据」，单向就够。
 *
 * ── 粒度：一行 = 一条合作 × 一款产品 ──────────────────────────
 * 和团队表的「一次寄样」对齐。一条合作有几款产品就推几行。
 * 产品行被删掉时，对应的飞书行也要删 —— 见 pushOne 末尾的孤儿清理。
 *
 * ── 怎么知道该新建还是该更新 ───────────────────────────────────
 * 飞书表里需要有一列存行标识 rowKey = `合作ID#产品行ID`（默认列名「系统ID」）。
 * 本地 sync_links 表记住 rowKey ↔ record_id 的对应；
 * 万一本地映射丢了（换机器、重建库），再按那一列去飞书搜一次找回来。
 * 没有这一列就只能每次新建，会产生重复行 —— 所以它是必填映射。
 */
import * as store from './store.js';
import * as db from './db.js';
import * as fs from './feishu.js';
import { SYSTEM_TABLE } from './feishu-schema.js';
import * as rules from './rules.js';

const TARGET = 'feishu';
const MAX_ATTEMPTS = 6;

/* ================================================================ 可同步的字段 */

/**
 * 取值函数，按 feishu-schema.js 里的 `from` 索引。
 *
 * 签名是 `(cb, item)` —— item 是本行对应的那一款产品。
 * 一条合作有几款产品就推几行，所以「本行」这个概念必须一路传到取值这里，
 * 否则又会退回「把所有产品拼成一格」。
 *
 * 账号相关的字段仍然是拼接的（一条合作可能挂多个抖音号），
 * 这是当前接受的取舍，见 docs/飞书同步方案-v2.md。
 */
const join = (arr) => arr.filter(Boolean).join('、');

const GETTERS = {
  /* 身份 */
  systemId: (cb, item) => rowKeyOf(cb, item),
  collaborationId: (cb) => cb.id,

  /* 达人与账号 */
  creatorName: (cb) => cb.creatorName || '',
  accountNickname: (cb) => join(cb.fulfillments.map((f) => f.account?.nickname)),
  douyinIds: (cb) => join(cb.fulfillments.map((f) => f.account?.douyinId)),
  uids: (cb) => join(cb.fulfillments.map((f) => f.account?.uid)),
  cooperationCodes: (cb) => join(cb.fulfillments.map((f) => f.account?.cooperationCode)),

  /* 合作 */
  type: (cb) => cb.type || '',
  status: (cb) => cb.status,
  /* 「是否寄样」问的是这条记录是不是一次寄样，不是「有没有发出去」——
     发没发看「合作状态」和「快递单号」。
     按**类型**判定而不是「有没有产品行」：寄样合作在产品补全之前
     也是寄样，靠有没有产品行去猜的话，那段时间会写成「否」。 */
  shipped: (cb) => (rules.needsSample(cb.type) ? '是' : '否'),
  salesChannel: (cb) => cb.salesChannel || '',

  /* 产品（本行）*/
  itemProduct: (cb, item) => item?.productName || '',
  itemQuantity: (cb, item) => (item?.quantity == null ? null : Number(item.quantity)),
  /* 费用是整条合作的，拆成多行后只写第一行 —— 每行都写的话飞书求和会翻倍。
     第一行 = 产品行 id 最小的那行，和展开顺序一致，不会因为重推而换行。 */
  sampleCostFirst: (cb, item) => {
    if (cb.sampleCost == null || cb.sampleCost === '') return null;
    const first = cb.items?.[0];
    if (first && item && first.id !== item.id) return null;
    return Number(cb.sampleCost);
  },

  /* 收件 */
  recipientName: (cb) => cb.recipient?.name || '',
  recipientPhone: (cb) => cb.recipient?.phone || '',
  recipientAddress: (cb) => cb.recipient?.address || '',
  deliveryNote: (cb) => cb.recipient?.deliveryNote || '',
  recipientFull: (cb) => {
    const r = cb.recipient || {};
    return join([r.name, r.phone, r.address].map((x) => (x || '').trim())).replace(/、/g, ' ');
  },

  /* 物流 */
  carriers: (cb) => join(cb.packages.map((p) => p.carrier)),
  trackingNos: (cb) => join(cb.packages.map((p) => p.trackingNo)),
  notified: (cb) => Boolean(cb.notifiedAt),

  /* 出片 */
  filmingProgress: (cb) => join(cb.fulfillments.map((f) => f.filmingProgress)),
  videoUrls: (cb) => cb.fulfillments.map((f) => f.videoUrl).filter(Boolean).join('\n'),

  /* 元信息 */
  ownerName: (cb) => cb.ownerName || '',
  createdAt: (cb) => cb.createdAt,
  updatedAt: (cb) => cb.updatedAt,
  /* 推送那一刻的时间。看「同步是不是还在跑」这一列最直接 ——
     它由推送行为本身产生，不来自业务数据。 */
  syncedAt: () => new Date().toISOString(),
};

/**
 * 用户在设置里能映射的字段。
 *
 * **由 feishu-schema.js 派生**，不是另写一份。
 * 两处各维护一份列表的话，加了列忘了加取值函数（或反过来）不会有任何报错，
 * 只会表现为「映射下拉里没有这一项」或者「这一列永远是空的」——
 * 这两种现象都已经真实发生过。
 */
export const SOURCE_FIELDS = SYSTEM_TABLE.map((w) => ({
  id: w.from,
  label: w.col,
  suit: [w.type],
  required: Boolean(w.required),
  hint: w.note || '',
  get: GETTERS[w.from],
}));

/** 定义了列却没有取值函数 —— 启动时就该发现，而不是等那一列一直空着 */
const orphan = SYSTEM_TABLE.filter((w) => typeof GETTERS[w.from] !== 'function');
if (orphan.length) {
  throw new Error(`feishu-schema 里这些列没有取值函数：${orphan.map((w) => `${w.col}(${w.from})`).join('、')}`);
}

const FIELD_BY_ID = new Map(SOURCE_FIELDS.map((f) => [f.id, f]));

/* ================================================================ 行展开 */

/** 行标识：合作ID#产品行ID。用产品行 id 而不是下标 —— 下标会因增删产品整体错位 */
export const rowKeyOf = (cb, item) => (item ? `${cb.id}#${item.id}` : `${cb.id}#-`);

/**
 * 把一条合作展开成若干行，一款产品一行。
 *
 * 没有产品行的合作也给一行（rowKey 以 `#-` 结尾）——
 * 建档时产品可能还没补全，这种合作照样要在飞书里看得见，
 * 不然会出现「系统里有、飞书里没有」而没人知道为什么。
 */
export function expandRows(cb) {
  const items = cb.items || [];
  return items.length ? items.map((item) => ({ rowKey: rowKeyOf(cb, item), item }))
                      : [{ rowKey: rowKeyOf(cb, null), item: null }];
}

/* ================================================================ 取值与类型适配 */

/**
 * 把本系统的值转成飞书那一列能接受的形态。
 *
 * 类型不对时飞书会直接报错（1254002），而错误信息不会说是哪一列，
 * 所以宁可在这里转好，也不要指望对面兼容。
 */
export function coerce(value, feishuType) {
  if (value === null || value === undefined || value === '') {
    // 复选框的「空」是 false，不是 null；其余留空
    return feishuType === 7 ? false : null;
  }
  switch (feishuType) {
    case 2:   // 数字
      return Number.isFinite(Number(value)) ? Number(value) : null;
    case 5: { // 日期：飞书要毫秒时间戳
      const t = value instanceof Date ? value.getTime() : Date.parse(value);
      return Number.isFinite(t) ? t : null;
    }
    case 7:   // 复选框
      return Boolean(value);
    case 15: { // 超链接
      const link = String(value).split('\n')[0];
      return { text: link, link };
    }
    case 3:   // 单选：值必须已存在于选项里，否则 1254043
    case 4:   // 多选
    case 13:  // 电话
    case 1:   // 多行文本
    default:
      return typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
  }
}

/** 按映射把一条合作的某一行变成飞书的 fields 对象 */
export function buildFields(cb, mapping, fieldTypes = {}, item = null) {
  const out = {};
  for (const [srcId, colName] of Object.entries(mapping || {})) {
    if (!colName) continue;
    const src = FIELD_BY_ID.get(srcId);
    if (!src) continue;
    const v = coerce(src.get(cb, item), fieldTypes[colName]);
    if (v !== null) out[colName] = v;
  }
  return out;
}

/* ================================================================ 配置 */

export function isEnabled(settings) {
  const f = settings?.feishu;
  return Boolean(f?.enabled && f.appId && f.appSecret && f.appToken && f.tableId && f.mapping?.systemId);
}

/** 配置不完整时说清缺哪一项，而不是笼统地「未启用」 */
export function configProblems(settings) {
  const f = settings?.feishu || {};
  const out = [];
  if (!f.appId || !f.appSecret) out.push('缺 App ID / App Secret');
  if (!f.appToken) out.push('缺多维表格链接');
  if (!f.tableId) out.push('还没选要写入哪张表');
  if (!f.mapping?.systemId) out.push('必须把「系统ID」映射到一列 —— 没有它无法判断新建还是更新，会产生重复行');
  return out;
}

/* ================================================================ 出站队列 */

/**
 * 入队。同一条合作短时间内改多次只保留一条待推送记录 ——
 * 推的是当前完整快照，不是增量，所以合并掉重复没有信息损失。
 */
export function enqueue(collaborationId) {
  if (!collaborationId) return;
  const exist = store.findBy('outbox', 'entityId', collaborationId).find((r) => r.target === TARGET);
  const row = exist || { id: store.nextSeq('ob'), target: TARGET, entityId: collaborationId, attempts: 0 };
  row.status = 'pending';
  row.nextAt = new Date().toISOString();
  row.lastError = exist?.lastError ?? null;
  store.put('outbox', row);
}

/** 退避：1 分钟起步逐次翻倍，最长 30 分钟 */
const backoffMs = (attempts) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));

export async function pending() {
  return store.findBy('outbox', 'target', TARGET);
}

export async function queueStatus() {
  const rows = store.findBy('outbox', 'target', TARGET);
  return {
    pending: rows.filter((r) => r.status === 'pending').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    lastError: rows.find((r) => r.lastError)?.lastError || null,
  };
}

/* ================================================================ 推送 */

let pumping = null;

/**
 * 后台推送。整个过程包在 try 里 —— 这个函数**永远不抛异常**，
 * 因为它是被业务动作顺手触发的，抛出去会污染商务的操作结果。
 */
export async function pump({ force = false } = {}) {
  if (pumping) return pumping;
  pumping = (async () => {
    try {
      const settings = await db.getSettings();
      if (!isEnabled(settings)) return { skipped: '未启用或配置不完整' };

      const cfg = { appId: settings.feishu.appId, appSecret: settings.feishu.appSecret };
      const { appToken, tableId, mapping } = settings.feishu;

      const now = Date.now();
      const due = store.findBy('outbox', 'target', TARGET)
        .filter((r) => r.status !== 'done')
        .filter((r) => force || !r.nextAt || Date.parse(r.nextAt) <= now)
        .sort((a, b) => (a.nextAt < b.nextAt ? -1 : 1));
      if (!due.length) return { done: 0, failed: 0 };

      // 列类型只取一次，整批复用
      let fieldTypes = {};
      try {
        const fields = await fs.listFields(cfg, appToken, tableId);
        fieldTypes = Object.fromEntries(fields.map((f) => [f.name, f.type]));
      } catch (e) {
        // 连列都读不到，整批都别试了，留着下次
        for (const r of due) markFailed(r, e.message);
        return { done: 0, failed: due.length, error: e.message };
      }

      let done = 0, failed = 0;
      for (const row of due) {
        try {
          await pushOne(cfg, appToken, tableId, mapping, fieldTypes, row.entityId);
          store.remove('outbox', row.id);   // 推成功就没必要留着
          done++;
        } catch (e) {
          markFailed(row, e.message);
          failed++;
        }
      }
      return { done, failed };
    } catch (e) {
      return { error: e.message };
    } finally { pumping = null; }
  })();
  return pumping;
}

function markFailed(row, message) {
  const attempts = (row.attempts || 0) + 1;
  store.put('outbox', {
    ...row,
    attempts,
    status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
    lastError: message,
    nextAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
  });
}

/**
 * 推一条合作 —— 可能是好几行。
 *
 * 一款产品一行，所以这里既要推当前该有的行，也要删掉不该再有的行
 * （合作从两款产品改成一款，飞书里那一行就成了孤儿）。
 */
export async function pushOne(cfg, appToken, tableId, mapping, fieldTypes, collaborationId) {
  const cb = await db.getCollaboration(collaborationId);
  const keyCol = mapping.systemId;
  const known = linksOfCollaboration(collaborationId);

  if (!cb) {
    /* 合作被删了：把它在飞书里的所有行一起删掉。
       只删 sync_links 里记着的 record_id —— 手工加的行不碰。 */
    for (const l of known) {
      try { await fs.deleteRecord(cfg, appToken, tableId, l.externalId); } catch { /* 尽力而为 */ }
      store.remove('sync_links', l.id);
    }
    return { deleted: known.length, skipped: '合作已不存在' };
  }

  const rows = expandRows(cb);
  const wanted = new Set(rows.map((r) => r.rowKey));
  let created = 0, updated = 0;

  for (const { rowKey, item } of rows) {
    const fields = buildFields(cb, mapping, fieldTypes, item);

    let recordId = linkOf(rowKey)?.externalId || null;
    // 本地映射丢了（换机器、重建库）就按系统ID列去飞书找回来
    if (!recordId) recordId = await fs.findRecordId(cfg, appToken, tableId, keyCol, rowKey);

    if (recordId) {
      try {
        await fs.updateRecord(cfg, appToken, tableId, recordId, fields);
        updated++;
      } catch (e) {
        // 记录被人在飞书里删了 → 重新建一条，而不是一直重试失败
        if (e.code === 1254005) { recordId = await fs.createRecord(cfg, appToken, tableId, fields); created++; }
        else throw e;
      }
    } else {
      recordId = await fs.createRecord(cfg, appToken, tableId, fields);
      created++;
    }
    saveLink(rowKey, recordId, collaborationId);
  }

  /* 孤儿行：上次推过、这次不该再有的。
     放在最后做 —— 先把该有的写好，再删多余的。反过来的话中途失败会留下缺口。 */
  let deleted = 0;
  for (const l of known) {
    if (wanted.has(l.entityId)) continue;
    await fs.deleteRecord(cfg, appToken, tableId, l.externalId);
    store.remove('sync_links', l.id);
    deleted++;
  }

  return { rows: rows.length, created, updated, deleted };
}

const linkOf = (entityId) =>
  store.findBy('sync_links', 'entityId', entityId).find((l) => l.target === TARGET) || null;

/**
 * 一条合作在飞书里的所有行。
 *
 * entityId 存的是 rowKey（`合作ID#产品行ID`），按合作查得扫一遍 ——
 * sync_links 只在 entityId 上有索引。行数量级是「合作数 × 产品数」，
 * 几千行以内扫全表比加一列索引划算；真涨上去了再把 collaborationId 提成列。
 */
function linksOfCollaboration(collaborationId) {
  const prefix = collaborationId + '#';
  return store.all('sync_links')
    .filter((l) => l.target === TARGET && String(l.entityId || '').startsWith(prefix));
}

function saveLink(entityId, externalId, collaborationId = null) {
  const exist = linkOf(entityId);
  store.put('sync_links', {
    id: exist?.id || store.nextSeq('sl'),
    target: TARGET, entityId, externalId, collaborationId,
    updatedAt: new Date().toISOString(),
  });
}

/* ================================================================ 每条合作的同步状态 */

/**
 * 一批合作各自的同步状态，给记录表那一列用。
 *
 * 状态从两张表推导，不额外存一份 ——
 * 存一份就要在每个改状态的地方记得更新它，迟早漏掉一处，
 * 而漏掉的表现是「界面显示已同步，飞书里其实没有」，比不显示更糟。
 *
 *   off      同步没开或没配完
 *   failed   重试到上限了，需要人介入
 *   pending  在队列里等推送（刚建档、刚改动，或上一次失败正在退避）
 *   synced   飞书里有对应的行
 *   never    从没推过 —— 多半是同步开启之前就存在的老记录
 */
export function statesFor(ids, settings) {
  const enabled = isEnabled(settings);
  const out = new Map();

  const queued = new Map();
  for (const r of store.findBy('outbox', 'target', TARGET)) queued.set(r.entityId, r);

  /* 按合作分组一次，避免每条合作都扫一遍 sync_links */
  const linked = new Map();
  for (const l of store.all('sync_links')) {
    if (l.target !== TARGET) continue;
    const cbId = String(l.entityId || '').split('#')[0];
    if (!cbId) continue;
    const cur = linked.get(cbId) || { rows: 0, at: null };
    cur.rows++;
    if (!cur.at || (l.updatedAt || '') > cur.at) cur.at = l.updatedAt || null;
    linked.set(cbId, cur);
  }

  for (const id of ids) {
    if (!enabled) { out.set(id, { state: 'off' }); continue; }
    const q = queued.get(id);
    const link = linked.get(id);
    if (q && q.status === 'failed') {
      out.set(id, { state: 'failed', error: q.lastError || '', attempts: q.attempts || 0 });
    } else if (q) {
      out.set(id, { state: 'pending', error: q.lastError || '', nextAt: q.nextAt || null });
    } else if (link) {
      out.set(id, { state: 'synced', at: link.at, rows: link.rows });
    } else {
      out.set(id, { state: 'never' });
    }
  }
  return out;
}

/** 单条重推。用户在记录里点「同步」时走这里 */
export async function syncOne(collaborationId) {
  enqueue(collaborationId);
  /* 手动触发要立刻试，不受退避约束 —— 用户点了按钮就是在说「现在试」，
     而且他多半刚去飞书那边把权限或列名修好了。 */
  const r = await pump({ force: true });
  return r;
}

/* ================================================================ 全量 */

/** 手动把所有合作重推一遍。换表、改映射、或飞书那边被人误删之后用。 */
export async function enqueueAll(ownerUserId = null) {
  const list = await db.listCollaborations({ ownerUserId });
  for (const cb of list) enqueue(cb.id);
  return list.length;
}
