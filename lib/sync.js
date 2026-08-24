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
 * ── 怎么知道该新建还是该更新 ───────────────────────────────────
 * 飞书表里需要有一列存本系统的合作 ID（默认列名「系统ID」）。
 * 本地 sync_links 表记住 合作ID ↔ record_id 的对应；
 * 万一本地映射丢了（换机器、重建库），再按那一列去飞书搜一次找回来。
 * 没有这一列就只能每次新建，会产生重复行 —— 所以它是必填映射。
 */
import * as store from './store.js';
import * as db from './db.js';
import * as fs from './feishu.js';

const TARGET = 'feishu';
const MAX_ATTEMPTS = 6;

/* ================================================================ 可同步的字段 */

/**
 * 本系统能提供的字段。用户在设置里把这些映射到飞书的列。
 * `suit` 是建议的飞书列类型，映射界面用它提醒「这列类型不合适」。
 */
export const SOURCE_FIELDS = [
  { id: 'systemId', label: '系统ID', suit: [1], required: true,
    hint: '本系统的合作编号。必须映射，靠它判断是新建还是更新',
    get: (cb) => cb.id },
  { id: 'creatorName', label: '达人名称', suit: [1], get: (cb) => cb.creatorName || '' },
  { id: 'douyinIds', label: '抖音号', suit: [1],
    get: (cb) => cb.fulfillments.map((f) => f.account?.douyinId).filter(Boolean).join('、') },
  { id: 'uids', label: 'UID', suit: [1],
    get: (cb) => cb.fulfillments.map((f) => f.account?.uid).filter(Boolean).join('、') },
  { id: 'cooperationCodes', label: '合作码', suit: [1],
    get: (cb) => cb.fulfillments.map((f) => f.account?.cooperationCode).filter(Boolean).join('、') },
  { id: 'status', label: '合作状态', suit: [1, 3], get: (cb) => cb.status },
  { id: 'products', label: '寄样产品', suit: [1],
    get: (cb) => cb.items.map((i) => `${i.productName} ×${i.quantity}`).join('、') },
  { id: 'sampleCost', label: '寄样费用', suit: [2, 1],
    get: (cb) => (cb.sampleCost == null ? null : Number(cb.sampleCost)) },
  { id: 'recipientName', label: '收件人', suit: [1], get: (cb) => cb.recipient?.name || '' },
  { id: 'recipientPhone', label: '收件电话', suit: [1, 13], get: (cb) => cb.recipient?.phone || '' },
  { id: 'recipientAddress', label: '收件地址', suit: [1], get: (cb) => cb.recipient?.address || '' },
  { id: 'deliveryNote', label: '配送备注', suit: [1], get: (cb) => cb.recipient?.deliveryNote || '' },
  { id: 'carriers', label: '快递公司', suit: [1],
    get: (cb) => cb.packages.map((p) => p.carrier).filter(Boolean).join('、') },
  { id: 'trackingNos', label: '快递单号', suit: [1],
    get: (cb) => cb.packages.map((p) => p.trackingNo).filter(Boolean).join('、') },
  { id: 'notified', label: '已告知达人', suit: [7, 1], get: (cb) => Boolean(cb.notifiedAt) },
  { id: 'filmingProgress', label: '拍摄进度', suit: [1],
    get: (cb) => cb.fulfillments.map((f) => f.filmingProgress).join('、') },
  { id: 'videoUrls', label: '视频链接', suit: [1, 15],
    get: (cb) => cb.fulfillments.map((f) => f.videoUrl).filter(Boolean).join('\n') },
  { id: 'ownerName', label: '归属商务', suit: [1], get: (cb) => cb.ownerName || '' },
  { id: 'createdAt', label: '建档时间', suit: [5, 1], get: (cb) => cb.createdAt },
  { id: 'updatedAt', label: '更新时间', suit: [5, 1], get: (cb) => cb.updatedAt },
];

const FIELD_BY_ID = new Map(SOURCE_FIELDS.map((f) => [f.id, f]));

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

/** 按映射把一条合作变成飞书的 fields 对象 */
export function buildFields(cb, mapping, fieldTypes = {}) {
  const out = {};
  for (const [srcId, colName] of Object.entries(mapping || {})) {
    if (!colName) continue;
    const src = FIELD_BY_ID.get(srcId);
    if (!src) continue;
    const v = coerce(src.get(cb), fieldTypes[colName]);
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

/** 推一条合作。已存在就更新，不存在就新建。 */
export async function pushOne(cfg, appToken, tableId, mapping, fieldTypes, collaborationId) {
  const cb = await db.getCollaboration(collaborationId);
  if (!cb) {
    // 合作被删了，本地映射也清掉，不留孤儿
    const link = linkOf(collaborationId);
    if (link) store.remove('sync_links', link.id);
    return { skipped: '合作已不存在' };
  }

  const fields = buildFields(cb, mapping, fieldTypes);
  const keyCol = mapping.systemId;

  let recordId = linkOf(collaborationId)?.externalId || null;
  // 本地映射丢了（换机器、重建库）就按系统ID列去飞书找回来
  if (!recordId) recordId = await fs.findRecordId(cfg, appToken, tableId, keyCol, cb.id);

  if (recordId) {
    try {
      await fs.updateRecord(cfg, appToken, tableId, recordId, fields);
    } catch (e) {
      // 记录被人在飞书里删了 → 重新建一条，而不是一直重试失败
      if (e.code === 1254005) recordId = await fs.createRecord(cfg, appToken, tableId, fields);
      else throw e;
    }
  } else {
    recordId = await fs.createRecord(cfg, appToken, tableId, fields);
  }

  saveLink(collaborationId, recordId);
  return { recordId };
}

const linkOf = (entityId) =>
  store.findBy('sync_links', 'entityId', entityId).find((l) => l.target === TARGET) || null;

function saveLink(entityId, externalId) {
  const exist = linkOf(entityId);
  store.put('sync_links', {
    id: exist?.id || store.nextSeq('sl'),
    target: TARGET, entityId, externalId,
    updatedAt: new Date().toISOString(),
  });
}

/* ================================================================ 全量 */

/** 手动把所有合作重推一遍。换表、改映射、或飞书那边被人误删之后用。 */
export async function enqueueAll(ownerUserId = null) {
  const list = await db.listCollaborations({ ownerUserId });
  for (const cb of list) enqueue(cb.id);
  return list.length;
}
