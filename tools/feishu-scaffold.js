#!/usr/bin/env node
/**
 * 在飞书里把「系统表」的列建好。
 *
 *   node tools/feishu-scaffold.js <table_id>           # 预演，只说要建什么，不动手
 *   node tools/feishu-scaffold.js <table_id> --apply   # 真的建
 *
 * **默认是预演。** 这是本项目第一个会往飞书写东西的脚本，
 * 而且用户很可能手滑把团队正在用的那张表的 id 贴进来 ——
 * 所以默认什么都不做，先把计划打印出来给人看。
 *
 * 只新建缺的列。已存在的列一律不碰：不改名、不改类型、不删除。
 * 可以反复跑，第二次会说「都齐了」。
 */
import * as db from '../lib/db.js';
import * as fs from '../lib/feishu.js';
import { SYSTEM_TABLE } from '../lib/feishu-schema.js';

const tableId = process.argv[2];
const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

if (!tableId || tableId.startsWith('--')) {
  console.error('用法：node tools/feishu-scaffold.js <table_id> [--apply]');
  console.error('先跑 node tools/feishu-inspect.js 看有哪些表。');
  process.exit(1);
}

const settings = await db.getSettings();
const f = settings.feishu || {};
if (!f.appId || !f.appSecret || !f.appToken) {
  console.error('飞书还没配好，先去「设置 → 飞书同步」填 App ID / Secret / 表格链接。');
  process.exit(1);
}
const cfg = { appId: f.appId, appSecret: f.appSecret };

let existing;
try {
  existing = await fs.listFields(cfg, f.appToken, tableId);
} catch (e) {
  console.error('读不到这张表的列：' + e.message);
  process.exit(1);
}

const have = new Map(existing.map((x) => [x.name, x]));
const want = SYSTEM_TABLE;

/* ── 防手滑：这张表看着不像空的系统表 ───────────────────────── */
const foreign = existing.filter((x) => !want.some((w) => w.col === x.name));
if (foreign.length > 3 && !force) {
  console.error(`\n这张表已经有 ${foreign.length} 列不属于系统表的定义：`);
  console.error('  ' + foreign.slice(0, 8).map((x) => x.name).join('、')
    + (foreign.length > 8 ? ' …' : ''));
  console.error('\n看着像团队正在用的表，不是新建的空表。');
  console.error('系统表应该是一张新表 —— 先在飞书里新建一张，再用它的 table_id。');
  console.error('确认没搞错的话，加 --force 跳过这个检查。\n');
  process.exit(1);
}

/* ── 对账 ──────────────────────────────────────────────────── */
const missing = [], typeMismatch = [], ok = [];
for (const w of want) {
  const cur = have.get(w.col);
  if (!cur) missing.push(w);
  else if (cur.type !== w.type) typeMismatch.push({ w, cur });
  else ok.push(w);
}

console.log(`\n表 ${tableId}：现有 ${existing.length} 列，系统表定义 ${want.length} 列\n`);
if (ok.length) console.log(`  已就绪 ${ok.length} 列`);

if (typeMismatch.length) {
  console.log(`\n  类型对不上 ${typeMismatch.length} 列 —— 脚本不会改，需要你在飞书里手工处理：`);
  for (const { w, cur } of typeMismatch) {
    console.log(`    ${w.col}：现在是「${cur.typeName}」，应该是「${fs.FIELD_TYPE[w.type]}」`);
  }
  console.log('    （改列类型可能丢数据，所以这一步不自动做）');
}

if (!missing.length) {
  console.log('\n缺的列：无。系统表已经齐了。\n');
  process.exit(typeMismatch.length ? 1 : 0);
}

console.log(`\n  需要新建 ${missing.length} 列：`);
const pad = Math.max(...missing.map((w) => [...w.col].length)) + 2;
for (const w of missing) {
  console.log(`    ${w.col.padEnd(pad, '　')} ${fs.FIELD_TYPE[w.type]}`
    + (w.note ? `   ← ${w.note}` : ''));
}

if (!apply) {
  console.log('\n以上是预演，什么都没做。确认无误后加 --apply 真正执行。\n');
  process.exit(0);
}

/* ── 执行 ──────────────────────────────────────────────────── */
console.log('\n开始新建…\n');
let done = 0, failed = 0;
for (const w of missing) {
  try {
    await fs.createField(cfg, f.appToken, tableId, w.col, w.type);
    console.log(`  ✓ ${w.col}`);
    done++;
  } catch (e) {
    console.log(`  ✗ ${w.col} —— ${e.message}`);
    failed++;
  }
}
console.log(`\n建好 ${done} 列${failed ? `，失败 ${failed} 列` : ''}。`);
if (!failed) {
  console.log('\n下一步：\n'
    + `  1. 去「设置 → 飞书同步」把数据表选成这张（${tableId}）\n`
    + '  2. 映射会自动按同名列对上，核对一遍\n'
    + '  3. 在团队表里加一个「关联」列指向这张表，再加查找引用列\n');
}
process.exit(failed ? 1 : 0);
