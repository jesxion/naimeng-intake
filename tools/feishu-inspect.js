#!/usr/bin/env node
/**
 * 把飞书表的结构打印出来 —— 用于设计列映射，也用于排查同步问题。
 *
 *   node tools/feishu-inspect.js                 # 列出所有表
 *   node tools/feishu-inspect.js tbl2zfl51fVdGq5n  # 看某张表的列
 *
 * 凭据从 data/settings.json 里读（就是设置界面里填的那套），
 * 不需要在命令行传 App Secret，也不会把它打出来。
 *
 * 只读。这个脚本不会往飞书写任何东西。
 */
import * as db from '../lib/db.js';
import * as fs from '../lib/feishu.js';
import { SOURCE_FIELDS } from '../lib/sync.js';

const arg = process.argv[2];

const settings = await db.getSettings();
const f = settings.feishu || {};
if (!f.appId || !f.appSecret) {
  console.error('还没配 App ID / App Secret，先去「设置 → 飞书同步」填上。');
  process.exit(1);
}
if (!f.appToken) {
  console.error('还没填多维表格链接。');
  process.exit(1);
}

const cfg = { appId: f.appId, appSecret: f.appSecret };
console.log(`多维表格：${f.appToken}\n`);

try {
  if (!arg) {
    const tables = await fs.listTables(cfg, f.appToken);
    console.log(`共 ${tables.length} 张表：\n`);
    for (const t of tables) {
      const cur = t.tableId === f.tableId ? '  ← 当前同步目标' : '';
      console.log(`  ${t.tableId}   ${t.name}${cur}`);
    }
    console.log('\n看某张表的列：node tools/feishu-inspect.js <table_id>');
  } else {
    const fields = await fs.listFields(cfg, f.appToken, arg);
    console.log(`表 ${arg} 共 ${fields.length} 列：\n`);
    const pad = Math.max(...fields.map((x) => [...x.name].length)) + 2;
    for (const x of fields) {
      const ro = fs.WRITABLE_TYPES.has(x.type) ? '' : '   [只读，不能作为同步目标]';
      console.log(`  ${x.name.padEnd(pad, '　')} ${String(x.type).padStart(4)}  ${x.typeName}${ro}`);
    }

    /* 顺手给一份「名字对得上就是它」的映射猜测，省去人工比对 */
    const norm = (s) => String(s).replace(/[\s（）()、/_-]/g, '').toLowerCase();
    const byNorm = new Map(fields.map((x) => [norm(x.name), x]));
    console.log('\n按列名猜的映射（仅供参考，最终以设置界面里选的为准）：\n');
    for (const s of SOURCE_FIELDS) {
      const hit = byNorm.get(norm(s.label));
      const mark = s.required ? '*' : ' ';
      console.log(`  ${mark} ${s.label.padEnd(8, '　')} → ${hit ? hit.name : '（没有同名列）'}`);
    }
    console.log('\n  * = 必填映射');
  }
} catch (e) {
  console.error('\n读取失败：' + e.message);
  process.exit(1);
}
