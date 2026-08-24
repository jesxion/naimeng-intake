/**
 * 飞书多维表格（Bitable）客户端。
 *
 * 用途：商务在系统里改了合作信息后，把结果推到公司现用的飞书表里，
 * 让不进这个系统的人（老板、运营）在熟悉的地方看到同一份数据。
 *
 * ── 这是服务端对服务端的集成 ───────────────────────────────────
 * 用 tenant_access_token（应用身份），不是用户 OAuth。
 * 和「飞书扫码登录」是两回事 —— 那个已经明确不做了，这个不需要任何人登录飞书。
 *
 * ── 两个最容易卡住的地方 ───────────────────────────────────────
 * 1. 开发者后台申请 bitable 权限**还不够**。
 *    必须再去那张多维表格里，「...」→「更多」→「添加文档应用」把这个应用加进去。
 *    少了这一步，接口一律返回没有权限，而错误信息不会告诉你缺的是这个。
 * 2. app_token 是 Base 的标识，不是表的标识。一个 Base 里有多张表，
 *    每张表还有自己的 table_id，要先列出来才知道。
 *
 * 本文件只管调接口，不含任何业务语义 —— 什么时候推、推哪些字段在 sync.js。
 */

/**
 * 接口根地址。可用 FEISHU_BASE 覆盖：
 *   · 回归测试指向本地假服务（真实接口既要凭据又会改公司正在用的表，不能碰）
 *   · 国际版 Lark 是 https://open.larksuite.com/open-apis
 */
const BASE = (process.env.FEISHU_BASE || 'https://open.feishu.cn/open-apis').replace(/\/+$/, '');

/* ================================================================ 令牌 */

let tokenCache = { token: '', expireAt: 0, key: '' };

/**
 * tenant_access_token 有效期 2 小时。这里缓存到过期前 5 分钟，
 * 避免每推一条记录都换一次令牌（飞书对令牌接口有频率限制）。
 * 换了凭据（key 变化）立刻作废缓存。
 */
export async function tenantToken({ appId, appSecret }) {
  const key = `${appId}:${appSecret}`;
  if (tokenCache.token && tokenCache.key === key && Date.now() < tokenCache.expireAt) {
    return tokenCache.token;
  }
  const r = await callRaw('POST', '/auth/v3/tenant_access_token/internal', null, {
    app_id: appId, app_secret: appSecret,
  });
  if (r.code !== 0 || !r.tenant_access_token) {
    throw new FeishuError(r.code, r.msg || '获取 tenant_access_token 失败', '/auth/v3/tenant_access_token/internal');
  }
  tokenCache = {
    token: r.tenant_access_token,
    expireAt: Date.now() + Math.max(60, (r.expire || 7200) - 300) * 1000,
    key,
  };
  return tokenCache.token;
}

/** 换凭据或想强制重新取令牌时调用 */
export function clearTokenCache() { tokenCache = { token: '', expireAt: 0, key: '' }; }

/* ================================================================ 错误 */

export class FeishuError extends Error {
  constructor(code, msg, path) {
    super(explain(code, msg));
    this.name = 'FeishuError';
    this.code = code;
    this.rawMsg = msg;
    this.path = path;
  }
}

/**
 * 把飞书的错误码翻译成能照着做的话。
 *
 * 飞书的原始 msg 经常是 "Forbidden" 这种，照着它排查不出任何东西 ——
 * 尤其是 91403，十有八九是「应用没被加进这张表」而不是权限没申请。
 */
function explain(code, msg) {
  const map = {
    99991663: 'app_id 或 app_secret 不对，去开发者后台「凭证与基础信息」核对',
    99991664: 'app_secret 不对',
    99991661: '应用未启用或已被停用',
    91402: '找不到这个多维表格（app_token 不对，或表已被删除）',
    91403: '没有权限。多半不是权限没申请，而是**应用没被加进这张表** —— '
         + '打开那张多维表格，右上角「...」→「更多」→「添加文档应用」，把应用加进去',
    1254005: '找不到这条记录（record_id 不对，或已被删除）',
    1254006: '找不到这个字段，检查列名是否被改过',
    1254002: '字段类型不匹配 —— 比如往数字列写了文本，或往单选列写了不在选项里的值',
    1254045: '字段名不存在，检查映射里的列名',
    1254043: '写入的选项不在单选/多选的候选项里，先去表里加这个选项',
    1061002: '请求太频繁，被限流了',
  };
  const hint = map[code];
  return hint ? `${hint}（飞书错误码 ${code}）` : `飞书返回 ${code}：${msg || '未知错误'}`;
}

/* ================================================================ 调用 */

const TIMEOUT_MS = 20000;

async function callRaw(method, path, token, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`飞书返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接飞书超时（20 秒）—— 检查这台机器能不能上外网');
    if (e instanceof TypeError) throw new Error(`连不上飞书：${e.message}。这台机器需要能访问 open.feishu.cn`);
    throw e;
  } finally { clearTimeout(timer); }
}

async function call(cfg, method, path, body) {
  const token = await tenantToken(cfg);
  const r = await callRaw(method, path, token, body);
  if (r.code !== 0) throw new FeishuError(r.code, r.msg, path);
  return r.data;
}

/* ================================================================ 元数据 */

/** 从分享链接里抠出 app_token：https://xxx.feishu.cn/base/{app_token}?... */
export function parseAppToken(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/\/base\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  // 也允许直接粘 app_token
  return /^[A-Za-z0-9]{10,}$/.test(s) ? s : '';
}

export async function listTables(cfg, appToken) {
  const d = await call(cfg, 'GET', `/bitable/v1/apps/${appToken}/tables?page_size=100`);
  return (d.items || []).map((t) => ({ tableId: t.table_id, name: t.name }));
}

export async function listFields(cfg, appToken, tableId) {
  const d = await call(cfg, 'GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=200`);
  return (d.items || []).map((f) => ({
    fieldId: f.field_id,
    name: f.field_name,
    type: f.type,
    typeName: FIELD_TYPE[f.type] || `类型${f.type}`,
  }));
}

/** 飞书字段类型编号 → 人话。映射时要用它提醒「这列是数字，别往里写文本」 */
export const FIELD_TYPE = {
  1: '多行文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期',
  7: '复选框', 11: '人员', 13: '电话号码', 15: '超链接',
  17: '附件', 18: '关联', 19: '公式', 20: '双向关联',
  21: '地理位置', 22: '群组', 1001: '创建时间', 1002: '最后更新时间',
  1003: '创建人', 1004: '修改人', 1005: '自动编号',
};

/** 只有这些类型我们敢写。公式、自动编号、创建时间这类是只读的 */
export const WRITABLE_TYPES = new Set([1, 2, 3, 4, 5, 7, 13, 15]);

/* ================================================================ 记录 */

/**
 * 按某一列的值找记录。用于判断该新建还是该更新。
 * 用 search 接口而不是拉全表 —— 表可能有几千行。
 */
export async function findRecordId(cfg, appToken, tableId, fieldName, value) {
  const d = await call(cfg, 'POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/search?page_size=1`, {
    filter: {
      conjunction: 'and',
      conditions: [{ field_name: fieldName, operator: 'is', value: [String(value)] }],
    },
    automatic_fields: false,
  });
  return d.items?.[0]?.record_id || null;
}

export async function createRecord(cfg, appToken, tableId, fields) {
  const d = await call(cfg, 'POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records`, { fields });
  return d.record?.record_id || null;
}

export async function updateRecord(cfg, appToken, tableId, recordId, fields) {
  const d = await call(cfg, 'PUT', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, { fields });
  return d.record?.record_id || recordId;
}

/* ================================================================ 自检 */

/**
 * 测试连接。逐级往下探，卡在哪一级就报哪一级 ——
 * 「凭据对不对」「Base 找不找得到」「应用有没有被加进表」是三个不同的问题，
 * 混成一句「连接失败」的话，用户根本不知道该去改什么。
 */
export async function testConnection(cfg, appToken, tableId = null) {
  const steps = [];
  try {
    await tenantToken(cfg);
    steps.push({ ok: true, step: '凭据校验', detail: 'app_id / app_secret 有效' });
  } catch (e) {
    steps.push({ ok: false, step: '凭据校验', detail: e.message });
    return { ok: false, steps };
  }

  let tables;
  try {
    tables = await listTables(cfg, appToken);
    steps.push({ ok: true, step: '访问多维表格', detail: `找到 ${tables.length} 张表` });
  } catch (e) {
    steps.push({ ok: false, step: '访问多维表格', detail: e.message });
    return { ok: false, steps };
  }

  if (tableId) {
    const hit = tables.find((t) => t.tableId === tableId);
    if (!hit) {
      steps.push({ ok: false, step: '定位数据表', detail: '这个 table_id 不在该 Base 里，可能表被删了或换了' });
      return { ok: false, steps, tables };
    }
    try {
      const fields = await listFields(cfg, appToken, tableId);
      steps.push({ ok: true, step: '读取字段', detail: `「${hit.name}」有 ${fields.length} 列` });
      return { ok: true, steps, tables, fields };
    } catch (e) {
      steps.push({ ok: false, step: '读取字段', detail: e.message });
      return { ok: false, steps, tables };
    }
  }
  return { ok: true, steps, tables };
}
