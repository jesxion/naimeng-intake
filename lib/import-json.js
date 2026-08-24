/**
 * 把 data/db.json 一次性导进 SQLite。
 *
 * 三条原则：
 *   1. **不删原文件。** 导完 db.json 原样留着，出问题能对账、能重来。
 *   2. **只导一次。** meta.importedFrom 记录来源，重复运行直接跳过，
 *      否则第二次启动会把用户新录的数据用旧快照盖掉。
 *   3. **整体事务。** 中途任何一条失败就全部回滚，不留半库。
 *
 * 导入不做任何字段转换 —— 对象什么样就存什么样。
 * 转换逻辑一旦掺进迁移，出了偏差很难查，而且没有第二次机会。
 */
import { readFileSync, existsSync } from 'node:fs';
import * as store from './store.js';

/** 与 db.json 里的集合一一对应。顺序无所谓，都在一个事务里。 */
const COLLECTIONS = [
  'users', 'creators', 'accounts', 'other_accounts', 'products',
  'collaborations', 'collab_items', 'collab_accounts', 'packages',
  'drafts', 'intake_logs', 'jobs',
];

/**
 * @returns {{skipped:boolean, reason?:string, counts?:Object, seq?:number}}
 */
export function importFromJson(jsonFile, { force = false } = {}) {
  if (!existsSync(jsonFile)) return { skipped: true, reason: '没有 db.json，按全新库处理' };

  const already = store.meta('importedFrom');
  if (already && !force) {
    return { skipped: true, reason: `已经从 ${already.file} 导入过（${already.at}），不重复导入` };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    // 这里必须抛，不能静默跳过 —— 静默跳过会让人以为数据没了
    throw new Error(`db.json 解析失败，导入中止：${e.message}`);
  }

  const counts = {};
  store.tx(() => {
    for (const name of COLLECTIONS) {
      const rows = Array.isArray(raw[name]) ? raw[name] : [];
      let n = 0;
      for (const row of rows) {
        if (!row?.id) continue;          // 没有 id 的行没法寻址，跳过并计入差额
        store.put(name, row);
        n++;
      }
      counts[name] = { source: rows.length, imported: n };
    }

    // 发号器必须跟着走，否则新记录的 id 会和历史记录撞车
    const seq = Number(raw._seq) || 0;
    store.setMeta('_seq', seq);
    /* 注意这里必须默认 1，不能默认成最新版。
       v1 的 db.json 根本没有 schemaVersion 字段，默认成最新版
       会让 v1→v2 迁移被静默跳过 —— 达人身上内嵌的 recipient 永远拆不出来，
       库里一条合作都不会有，而且没有任何报错。
       同一个陷阱在 JSON 实现里踩过一次（EMPTY.schemaVersion 曾被写成 SCHEMA_VERSION）。 */
    store.setMeta('schemaVersion', Number(raw.schemaVersion) || 1);
    store.setMeta('importedFrom', { file: jsonFile, at: new Date().toISOString(), seq });
    counts._seq = seq;
  });

  return { skipped: false, counts, seq: counts._seq };
}

/**
 * 导入后的对账。逐表比对行数，并抽查那些「长得像数字的字符串」有没有被改坏。
 * 合作码前导零是这个项目里最容易被静默破坏的字段，单独验。
 */
export function verifyImport(jsonFile) {
  const raw = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const problems = [];

  for (const name of COLLECTIONS) {
    const src = (Array.isArray(raw[name]) ? raw[name] : []).filter((r) => r?.id);
    const got = store.count(name);
    if (src.length !== got) problems.push(`${name}: 源 ${src.length} 行，库里 ${got} 行`);
  }

  for (const a of raw.accounts || []) {
    if (!a?.id) continue;
    const got = store.get('accounts', a.id);
    if (!got) { problems.push(`accounts ${a.id} 丢失`); continue; }
    for (const f of ['cooperationCode', 'uid', 'douyinId']) {
      if ((a[f] ?? null) !== (got[f] ?? null)) {
        problems.push(`accounts ${a.id}.${f}: 源 ${JSON.stringify(a[f])} → 库 ${JSON.stringify(got[f])}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
