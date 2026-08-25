/**
 * 发货截图的存档。
 *
 * ── 为什么存文件而不是存库 ──────────────────────────────────────
 * 一张截图 base64 之后 0.5～3 MB。启动时会把 `naimeng.db` 整个备份一份、
 * 保留 7 份 —— 图片进库意味着**这些体积要乘以 7**，而备份的价值在于
 * 达人资料和合作记录，不在于几个月前的一张快递截图。
 *
 * 所以图片落到 `data/shots/` 下的独立文件，库里只存一个 id。
 * 备份策略照旧，图片单独按数量上限清理。
 *
 * ── 为什么要留 ──────────────────────────────────────────────────
 * 识别出来的单号和实际截图对不上时，只有原图能说明是模型看错了、
 * 还是仓库本来就发错了。之前识别完立刻丢掉图片，
 * 于是「这个单号哪来的」永远查不到。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.NAIMENG_DATA_DIR
  || join(process.cwd(), 'data');
const DIR = join(DATA_DIR, 'shots');

/** 留最近这么多张。仓库每天发一两张，1000 张够翻大半年 */
export const KEEP = 1000;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/**
 * id 只允许这个形状。
 *
 * 它会被拼进文件路径 —— 不校验的话 `../../etc/passwd` 就能读到任意文件。
 * 用白名单而不是「过滤掉 ..」：过滤是黑名单思路，总有绕过的写法。
 */
const SAFE_ID = /^sh-[a-z0-9]+-[a-z0-9]+$/;

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/**
 * 存一张。传入的是 `data:image/png;base64,...`。
 * @returns {string|null} 存档 id；格式不认识就返回 null（调用方照常往下走）
 */
export function save(dataUrl) {
  try {
    const m = String(dataUrl || '').match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i);
    if (!m) return null;
    const ext = EXT[m[1].toLowerCase()] || 'png';
    ensureDir();
    /* 时间戳打头，文件名排序就是时间序 —— 清理时不用 stat 每个文件 */
    const id = `sh-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    writeFileSync(join(DIR, `${id}.${ext}`), Buffer.from(m[2], 'base64'));
    prune();
    return id;
  } catch { return null; }   // 存档失败绝不能挡住识别本身
}

/** 读一张。返回 null 表示不存在或已被清理 —— 调用方应显示「原图已清理」而不是报错 */
export function read(id) {
  if (!SAFE_ID.test(String(id || ''))) return null;
  for (const ext of ['png', 'jpg', 'webp']) {
    const p = join(DIR, `${id}.${ext}`);
    try {
      if (existsSync(p)) return { buffer: readFileSync(p), mime: MIME[ext], bytes: statSync(p).size };
    } catch { /* 继续试下一个后缀 */ }
  }
  return null;
}

/** 超过上限就从最老的删起。文件名带时间戳，直接按名字排序即可 */
export function prune(keep = KEEP) {
  try {
    if (!existsSync(DIR)) return 0;
    const files = readdirSync(DIR).filter((f) => /^sh-.+\.(png|jpg|webp)$/.test(f)).sort();
    const over = files.length - keep;
    if (over <= 0) return 0;
    for (const f of files.slice(0, over)) {
      try { unlinkSync(join(DIR, f)); } catch { /* ignore */ }
    }
    return over;
  } catch { return 0; }
}

export function stats() {
  try {
    if (!existsSync(DIR)) return { count: 0, bytes: 0 };
    const files = readdirSync(DIR).filter((f) => /^sh-.+\.(png|jpg|webp)$/.test(f));
    let bytes = 0;
    for (const f of files) { try { bytes += statSync(join(DIR, f)).size; } catch { /* ignore */ } }
    return { count: files.length, bytes };
  } catch { return { count: 0, bytes: 0 }; }
}
