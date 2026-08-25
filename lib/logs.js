/**
 * 操作日志与错误日志。
 *
 * ── 两种日志，两个用途，不要混 ──────────────────────────────────
 * **操作日志**回答「谁在什么时候动了什么」。它是审计线索：
 * 记录被改了、被删了、归属被转走了，事后要能追问是谁做的。
 * 尤其是删除 —— 记录本身已经没了，日志是唯一还在的地方。
 *
 * **错误日志**回答「哪里坏了、怎么坏的」。它是排查线索。
 *
 * 和 `intake_logs` 都不一样：那张表记的是「模型抽出什么、人改成什么」，
 * 是调优提示词的语料，不是审计也不是排查。三者不要合并。
 *
 * ── 自动记录，不靠人记得 ────────────────────────────────────────
 * 记录发生在 server.js 的请求处理外层：**所有非 GET 请求**都会留下一条，
 * 路由自己不需要做任何事。指望每个路由都记得调一次 log()，
 * 迟早漏掉新加的那个，而漏掉的表现是「这条记录谁改的查不到」——
 * 等到需要查的时候才发现没记，已经晚了。
 *
 * 这和 `markDirty` 放在 db 层是同一个理由。
 *
 * ── 不记什么 ────────────────────────────────────────────────────
 * **请求体一律不入库。** 里面有达人的真实姓名、手机号、地址，
 * 还有 API Key 和团队口令。日志的价值是「谁动了哪条」，
 * 不是「改成了什么」—— 后者去看记录本身或 intake_logs。
 *
 * 错误的 message 和 stack 会存，但截断，并且过一遍脱敏。
 */
import * as store from './store.js';

/* 日志表是基础设施表，和 outbox / sync_links 一样由自己的模块直接访问 store。
   「数据访问只有一个出口 db.js」那条规则针对的是业务数据 ——
   把审计日志塞进 db.js 只会让那个文件更难读，而换存储时这几张表本来就要单独处理。 */

const KEEP_ERRORS = 1000;   // 错误可能成片爆发，留最近这些就够定位
const MAX_TEXT = 2000;      // 单条 message + stack 的上限

let seq = 0;
const nextId = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = () => new Date().toISOString();

/* ================================================================ 脱敏 */

/**
 * 从要落库的文本里抹掉敏感串。
 *
 * 错误信息里经常夹带触发它的那段内容 —— 达人手机号、API Key、
 * 甚至团队口令都可能顺着 stack 进来。日志本身权限比业务数据低
 * （排查的人不一定是归属人），所以在写入前就抹掉，而不是在展示时。
 */
export function scrub(text) {
  return String(text ?? '')
    .replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(-4))
    .replace(/\b(sk-|Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, '$1••••')
    .replace(/("?(?:apiKey|appSecret|passphrase|password|token)"?\s*[:=]\s*)("?)[^"',\s}]+/gi,
      '$1$2••••')
    .slice(0, MAX_TEXT);
}

/* ================================================================ 操作日志 */

/**
 * 记一条操作。**永不抛异常** —— 它是被业务动作顺手触发的，
 * 抛出去会污染那次操作的结果。日志写不进去是小事，
 * 因为写不进日志而让商务的「确认寄样」失败是大事。
 *
 * @param {object} o
 * @param {string} o.action  动作，如 `POST /api/collaborations`
 * @param {object} [o.user]  当前用户 {id,name}
 * @param {string} [o.target] 对象标识，如 `cb-00042`
 * @param {boolean} [o.ok]   成功与否
 * @param {number} [o.status] HTTP 状态
 * @param {string} [o.summary] 一句人话，如「删除合作 · 达人 豆豆的小窝」
 * @param {number} [o.ms]    耗时
 */
export function logOp({ action, user = null, target = '', ok = true, status = 0, summary = '', ms = 0 }) {
  try {
    store.put('op_logs', {
      id: nextId('op'),
      at: now(),
      userId: user?.id || '',
      userName: user?.name || '',
      action: String(action || ''),
      target: String(target || ''),
      ok: ok ? 1 : 0,
      status,
      summary: scrub(summary).slice(0, 300),
      ms,
    });
  } catch { /* 记不上就算了，绝不影响业务动作 */ }
}

/** 倒序翻。`user` / `target` / `onlyFailed` 三种筛法覆盖实际会问的问题 */
export function listOps({ limit = 100, offset = 0, userId = '', target = '', onlyFailed = false } = {}) {
  try {
    let rows = store.all('op_logs');
    if (userId) rows = rows.filter((r) => r.userId === userId);
    if (target) rows = rows.filter((r) => r.target === target);
    if (onlyFailed) rows = rows.filter((r) => !r.ok);
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  } catch { return { total: 0, rows: [] }; }
}

/* ================================================================ 错误日志 */

/**
 * 记一条错误。同样永不抛异常。
 *
 * **同时打到 stderr。** 表里那份是给界面看的，stderr 那份是
 * 「数据库都打不开了」时唯一还在的线索 —— 那种时候恰恰最需要日志。
 */
export function logError(where, err, { user = null, context = '' } = {}) {
  const message = scrub(err?.message || String(err));
  const stack = scrub(err?.stack || '');
  /* 先写 stderr。表可能写不进去（库锁了、磁盘满了），
     而那两种情况本身就是要排查的东西。 */
  try { console.error(`[错误] ${where} · ${message}${context ? ` · ${context}` : ''}`); } catch { /* ignore */ }
  try {
    store.put('err_logs', {
      id: nextId('er'),
      at: now(),
      source: String(where || ''),
      userId: user?.id || '',
      userName: user?.name || '',
      message,
      stack: stack.slice(0, MAX_TEXT),
      context: scrub(context).slice(0, 300),
    });
    trimErrors();
  } catch { /* ignore */ }
}

/** 错误可能成片爆发（比如飞书挂了一整晚），留最近 1000 条 */
function trimErrors() {
  try {
    const rows = store.all('err_logs');
    if (rows.length <= KEEP_ERRORS) return;
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    for (const r of rows.slice(KEEP_ERRORS)) store.remove('err_logs', r.id);
  } catch { /* ignore */ }
}

export function listErrors({ limit = 100, offset = 0 } = {}) {
  try {
    const rows = store.all('err_logs').sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  } catch { return { total: 0, rows: [] }; }
}

/* ================================================================ 进程级兜底 */

/**
 * 没被 catch 住的异常和 Promise 拒绝。
 *
 * **不退出进程。** launchd 的 KeepAlive 会把崩溃的进程拉起来，
 * 但那意味着正在处理的请求全断、内存里的队列状态丢掉。
 * 记下来继续跑，比崩了再起对 6 个人的团队更实用 ——
 * 代价是可能带着一个坏掉的状态继续服务，所以这条日志要显眼。
 */
export function installProcessHandlers() {
  process.on('uncaughtException', (e) => logError('uncaughtException', e));
  process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
}
