/**
 * 异步边界回归。
 *
 * 云端化的第一步是把 db.js 变成异步接口（现在底下还是 JSON 文件，
 * 将来换 Postgres 时只重写实现，server.js 一行不动）。
 * 这组测试锁住那条边界本身，以及改造过程中真实踩到的两个坑。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ================================================================ */

describe('db 层对外全是异步的', () => {
  test('每个导出的函数都返回 Promise', async () => {
    const DIR = mkdtempSync(join(tmpdir(), 'naimeng-async-'));
    process.env.NAIMENG_DATA_DIR = DIR;
    const db = await import('../lib/db.js');

    const fns = Object.entries(db).filter(([, v]) => typeof v === 'function');
    assert.ok(fns.length >= 40, `只找到 ${fns.length} 个导出函数，数量不对`);

    const sync = fns.filter(([, fn]) => fn.constructor.name !== 'AsyncFunction').map(([k]) => k);
    assert.deepEqual(sync, [],
      `这些函数还是同步的：${sync.join(', ')} —— 换 Postgres 时会漏掉，调用方拿到的是裸值不是 Promise`);

    try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

/* ================================================================ */

describe('链式 await 必须加括号', () => {
  /* 这是本次改造真实踩到的坑：
       await db.listUsers().find(...)     ← await 绑的是整个链式表达式，
       (await db.listUsers()).find(...)   ← 才是想要的
     错的那种语法完全合法，只在运行时报「Cannot read properties of null」，
     而且跨行时正则很容易漏掉，所以用配平括号的方式扫。 */
  const FILES = ['server.js', 'lib/db.js', 'tests/db.test.js', 'tests/api.test.js', 'tests/authz.test.js'];
  const CALLS = /await\s+(db\.[a-zA-Z]+|requireUser|userOf|privateOr404|ownerOr403|runVideo)\s*\(/g;

  const offenders = (src) => {
    const out = [];
    let m;
    CALLS.lastIndex = 0;
    while ((m = CALLS.exec(src))) {
      let i = CALLS.lastIndex - 1, depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
      }
      if (/^\s*[.[]/.test(src.slice(i))) {
        out.push(`行 ${src.slice(0, m.index).split('\n').length}: ${m[1]}`);
      }
    }
    return out;
  };

  for (const f of FILES) {
    test(`${f} 里没有未加括号的链式 await`, () => {
      const hits = offenders(readFileSync(join(ROOT, f), 'utf8'));
      assert.deepEqual(hits, [], `${f}:\n  ${hits.join('\n  ')}`);
    });
  }

  test('这个扫描本身是有效的（用一段已知错误的代码验证）', () => {
    assert.equal(offenders('const x = await db.listUsers().find(y);').length, 1);
    assert.equal(offenders('const x = (await db.listUsers()).find(y);').length, 0);
    // 跨行的也要抓到 —— 漏掉的那次就是跨行
    assert.equal(offenders('const x = await db.createCreator({\n  a: 1,\n}, u).id;').length, 1);
  });
});

/* ================================================================ */

describe('队列泵不丢任务', () => {
  test('一次塞满，全部会被消费完', async () => {
    const DIR = mkdtempSync(join(tmpdir(), 'naimeng-pump-'));
    process.env.NAIMENG_DATA_DIR = DIR;
    const db = await import('../lib/db.js?pump');

    await db.saveSettings({ user: { name: '商务甲', role: 'business' } });
    const me = await db.currentUser();
    const N = 12, SLOTS = 2;
    for (let i = 0; i < N; i++) await db.createJob({ ownerUserId: me.id, rawText: `账号名称：达人${i}` });

    // 模拟 pump 的领取循环：原子领取 + 处理 + 再看有没有剩的
    let done = 0, rounds = 0;
    for (;;) {
      if (++rounds > 100) break;
      const slots = SLOTS - (await db.runningCount());
      const got = slots > 0 ? await db.claimQueuedJobs(slots) : [];
      if (!got.length) break;
      for (const j of got) { await db.updateJob(j.id, { status: 'done', _pid: false }); done++; }
    }

    const all = await db.listJobs(me.id);
    const left = all.filter((j) => j.status === 'queued').length;
    assert.equal(done, N, `只消费了 ${done} 条，投入 ${N} 条`);
    assert.equal(left, 0, `还有 ${left} 条卡在 queued`);

    try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('claimQueuedJobs 是原子的：并发领取不会把同一条领两次', async () => {
    const DIR = mkdtempSync(join(tmpdir(), 'naimeng-claim-'));
    process.env.NAIMENG_DATA_DIR = DIR;
    const db = await import('../lib/db.js?claim');

    await db.saveSettings({ user: { name: '商务甲', role: 'business' } });
    const me = await db.currentUser();
    for (let i = 0; i < 6; i++) await db.createJob({ ownerUserId: me.id, rawText: `x${i}` });

    // 三路同时领，每路要 4 个 —— 加起来 12 > 6，必然发生争抢
    const batches = await Promise.all([db.claimQueuedJobs(4), db.claimQueuedJobs(4), db.claimQueuedJobs(4)]);
    const ids = batches.flat().map((j) => j.id);
    assert.equal(new Set(ids).size, ids.length, '同一条任务被领了多次，会重复调用模型烧 token');
    assert.ok(ids.length <= 6, `领出了 ${ids.length} 条，超过队列里的 6 条`);

    try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

/* ================================================================ */

describe('server.js 不再直接读同步存储', () => {
  test('server.js 不做任何文件写入', () => {
    const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
    const writes = src.match(/\b(writeFile|appendFile|unlink|rename|copyFile)(Sync)?\s*\(/g) || [];
    assert.deepEqual(writes, [],
      '所有持久化都必须经过 db.js，否则换 Postgres 时会成为漏网之鱼');
  });

  test('server.js 的读取只用于静态资源和 .env', () => {
    const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
    // readFileSync 允许存在，但参数只能是 .env 路径或 public 下的静态文件
    const reads = [...src.matchAll(/readFileSync\(([^,)]+)/g)].map((m) => m[1].trim());
    const allowed = new Set(['f', 'target']);   // f = .env，target = public 下的静态资源
    const bad = reads.filter((r) => !allowed.has(r));
    assert.deepEqual(bad, [], `server.js 读了预期外的文件：${bad.join(', ')}`);
  });
});
