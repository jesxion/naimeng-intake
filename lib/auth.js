/**
 * 登录与会话 —— 团队口令 + 服务端签发的身份。
 *
 * 为什么是这个方案：
 *   系统跑在办公室局域网的一台 Mac mini 上，同网段任何设备都能访问。
 *   库里有达人的真实姓名、手机号、收件地址，不能谁连上 WiFi 就能看。
 *   团队只有 6 个人且都在同一间办公室，所以不需要每人一套密码体系 ——
 *   一道团队口令挡住「不该在这个网段上的设备」，就已经覆盖了真实威胁。
 *
 * 但身份必须是服务端签的。
 *   改造前身份来自前端自报的 X-User-Id，改个请求头就能变成任何人，
 *   那些按归属拦截的 403 形同虚设。现在身份写在签名 cookie 里，
 *   签名用的密钥只在服务器上，前端伪造不了。
 *
 * 不依赖任何外部服务：断网时照常登录、照常干活。
 */
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.NAIMENG_DATA_DIR || join(ROOT, 'data');
const SECRET_FILE = join(DATA_DIR, '.session-secret');

export const COOKIE_NAME = 'naimeng_session';
export const SESSION_DAYS = 30;

/* ================================================================ 密钥 */

let secretCache = null;

/**
 * 会话签名密钥。首次启动自动生成并落盘，权限 0600。
 * 放在 data/ 下，和数据库一起被 .gitignore 挡住。
 * 换掉这个文件等于让所有人重新登录 —— 这就是「踢所有人下线」的开关。
 */
export function sessionSecret() {
  if (secretCache) return secretCache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(SECRET_FILE)) {
    secretCache = readFileSync(SECRET_FILE, 'utf8').trim();
    if (secretCache) return secretCache;
  }
  secretCache = randomBytes(32).toString('hex');
  writeFileSync(SECRET_FILE, secretCache, 'utf8');
  try { chmodSync(SECRET_FILE, 0o600); } catch { /* Windows 上没有 POSIX 权限 */ }
  return secretCache;
}

/* ================================================================ 口令 */

/**
 * 口令用 scrypt 加盐哈希后存进 settings，不存明文。
 * 就算 settings.json 被人拷走，也拿不到口令本身。
 */
export function hashPassphrase(plain) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(String(plain), salt, 32).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassphrase(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const got = scryptSync(String(plain ?? ''), salt, 32);
  const want = Buffer.from(key, 'hex');
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);   // 定长比较，不因为前几位对上就快速返回
}

/* ================================================================ 会话 */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

/**
 * 会话令牌 = base64url(JSON) + '.' + HMAC。
 *
 * 有效期写在载荷里并参与签名，所以改不了 —— 前端把 exp 往后挪一年
 * 会导致签名不匹配，直接判为无效。
 */
export function issueSession(userId, days = SESSION_DAYS) {
  const body = JSON.stringify({ u: userId, exp: Date.now() + days * 864e5 });
  const payload = b64u(body);
  return `${payload}.${sign(payload)}`;
}

/** @returns {string|null} 通过校验且未过期时返回 userId */
export function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const mac = token.slice(i + 1);

  const want = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!u || !exp || Date.now() > exp) return null;
    return u;
  } catch { return null; }
}

/* ================================================================ cookie */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 不设 Secure：局域网是明文 http，带上 Secure 浏览器就不会回传 cookie，
 * 直接导致登录不上。上 HTTPS 后应当把它加回来。
 * SameSite=Lax 足以挡住跨站提交。
 */
export function sessionCookie(token, days = SESSION_DAYS) {
  const maxAge = Math.floor(days * 86400);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
