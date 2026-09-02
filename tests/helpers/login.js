/**
 * 测试用登录辅助。
 *
 * 身份已经从「前端自报的 X-User-Id」改成「服务端签发的会话 cookie」，
 * 测试也必须走同一条真实路径 —— 如果测试能绕开登录直接指定身份，
 * 那它就验证不了鉴权本身。
 */

export const PASS = 'naimeng-test-2026';

/** 从响应头里取出会话 cookie（只要 name=value 部分） */
const grabCookie = (res) => {
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : '';
};

/**
 * 造一个绑定到 BASE 的请求器。
 * @param {string} base
 * @returns {(method:string, path:string, body?:any, cookie?:string) => Promise<object>}
 *   cookie 传 '' 表示匿名；不传表示用该请求器自己持有的会话。
 */
export function makeApi(base) {
  let jar = '';
  /* 第五个参数是额外请求头 —— 外部客户端走 Authorization: Bearer，
     不走 cookie，所以测试也得能发那条路径上的请求。 */
  const api = async (method, path, body, cookie, extraHeaders) => {
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    const c = cookie === undefined ? jar : cookie;
    if (c) headers.Cookie = c;
    const res = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const got = grabCookie(res);
    if (got && cookie === undefined) jar = got;
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  api.cookie = () => jar;
  api.setCookie = (c) => { jar = c; };
  return api;
}

/**
 * 首次初始化：设团队口令并创建第一个人。
 * @returns {{cookie:string, me:object}}
 */
export async function bootstrap(base, { name = '商务甲', role = 'business' } = {}) {
  const res = await fetch(base + '/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASS, name, role }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`bootstrap 失败：${body.error}`);
  return { cookie: grabCookie(res), me: body.me };
}

/**
 * 以某个人的身份登录，拿到属于他的 cookie。
 * 传 name 会在不存在时创建这个人。
 * @returns {{cookie:string, me:object}}
 */
export async function loginAs(base, { userId = null, name = null, role = 'business' } = {}) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userId ? { passphrase: PASS, userId } : { passphrase: PASS, name, role }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`登录失败：${body.error}`);
  return { cookie: grabCookie(res), me: body.me };
}
