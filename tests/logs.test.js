/**
 * 操作日志与错误日志。
 *
 * 这两样东西平时没人看，出事时是唯一线索 —— 所以更需要测试守着：
 * 「以为记了其实没记」比「没有日志」更糟，因为出事时才发现已经晚了。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-logs-'));
process.env.NAIMENG_DATA_DIR = DIR;

let logs, db, store;

before(async () => {
  db = await import('../lib/db.js');
  logs = await import('../lib/logs.js');
  store = await import('../lib/store.js');
  await db.getSettings();          // 触发建表
});
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

/* ================================================================ */

describe('脱敏', () => {
  test('手机号只留头尾', () => {
    assert.equal(logs.scrub('联系 13800138000 收货'), '联系 138****8000 收货');
  });

  test('API Key 不落库', () => {
    assert.match(logs.scrub('Authorization: Bearer sk-abcdefgh12345678'), /••••/);
    assert.ok(!/abcdefgh12345678/.test(logs.scrub('sk-abcdefgh12345678')));
  });

  test('口令、密钥这类键名后面的值一律抹掉', () => {
    /* 错误信息里经常夹带触发它的那段内容，配置对象整个被 JSON 化进 stack
       是最常见的一种。 */
    for (const k of ['apiKey', 'appSecret', 'passphrase', 'password', 'token']) {
      const out = logs.scrub(`{"${k}":"super-secret-value"}`);
      assert.ok(!out.includes('super-secret-value'), `${k} 的值泄漏了：${out}`);
    }
  });

  test('长文本截断，不让一条日志撑爆表', () => {
    assert.ok(logs.scrub('x'.repeat(9000)).length <= 2000);
  });
});

/* ================================================================ */

describe('操作日志', () => {
  test('记下来能查回来', () => {
    logs.logOp({ action: 'DELETE /api/collaborations/:id', user: { id: 'u-1', name: '商务甲' },
      target: 'cb-00042', ok: true, status: 200, summary: '删除合作 · 达人 某某' });
    const r = logs.listOps({ limit: 10 });
    assert.ok(r.total >= 1);
    assert.equal(r.rows[0].target, 'cb-00042');
    assert.equal(r.rows[0].userName, '商务甲');
  });

  test('按人、按对象、只看失败三种筛法', () => {
    logs.logOp({ action: 'POST /api/x', user: { id: 'u-2', name: '商务乙' }, target: 'cb-00043', ok: false, status: 403 });
    assert.equal(logs.listOps({ userId: 'u-2' }).rows.every((r) => r.userId === 'u-2'), true);
    assert.equal(logs.listOps({ target: 'cb-00042' }).rows.every((r) => r.target === 'cb-00042'), true);
    const failed = logs.listOps({ onlyFailed: true });
    assert.ok(failed.total >= 1);
    assert.equal(failed.rows.every((r) => !r.ok), true);
  });

  test('倒序 —— 最近发生的在最前面', () => {
    const rows = logs.listOps({ limit: 50 }).rows;
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].at >= rows[i].at);
  });

  test('摘要也过脱敏', () => {
    logs.logOp({ action: 'POST /api/x', target: 'cb-1', summary: '收件人 13800138777' });
    assert.ok(!logs.listOps({ target: 'cb-1' }).rows[0].summary.includes('13800138777'));
  });

  test('记日志永不抛异常 —— 它是被业务动作顺手触发的', () => {
    /* 抛出去会污染那次操作的结果：因为写不进日志而让「确认寄样」失败，
       是拿一件小事去毁一件大事。

       **必须制造真正会抛的场景。** 只喂几个空参数是测不出来的 ——
       那种输入本来就不会抛，把 catch 整个删掉这条断言照样绿。
       这里传一个取 id 就抛的对象，模拟「上游给了个坏东西」。 */
    const landmine = { get id() { throw new Error('boom'); }, name: 'x' };
    assert.doesNotThrow(() => logs.logOp({ action: 'POST /x', user: landmine }));
    assert.doesNotThrow(() => logs.logOp({}));
  });
});

/* ================================================================ */

describe('错误日志', () => {
  test('message 和 stack 都记，且都脱敏', () => {
    const e = new Error('调用失败 sk-secretkey123456 手机 13800138999');
    logs.logError('测试位置', e, { user: { id: 'u-1', name: '商务甲' }, context: 'HTTP 500' });
    const r = logs.listErrors({ limit: 5 }).rows[0];
    assert.equal(r.source, '测试位置');
    assert.ok(!r.message.includes('sk-secretkey123456'));
    assert.ok(!r.message.includes('13800138999'));
    assert.ok(r.stack.length > 0);
  });

  test('永不抛异常', () => {
    const landmine = { get id() { throw new Error('boom'); } };
    assert.doesNotThrow(() => logs.logError('x', new Error('e'), { user: landmine }));
    assert.doesNotThrow(() => logs.logError('x', null));
    assert.doesNotThrow(() => logs.logError(undefined, 'just a string'));
  });

  test('库关掉时也不抛 —— 那正是最需要 stderr 那一份的时候', () => {
    /* 数据库打不开的场景下，表里那份日志写不进去。
       这时候唯一还在的线索是 stderr —— 所以写表失败绝不能冒泡。 */
    store.close();
    try {
      assert.doesNotThrow(() => logs.logError('库已关闭', new Error('x')));
      assert.doesNotThrow(() => logs.logOp({ action: 'POST /x' }));
      assert.deepEqual(logs.listOps({ limit: 1 }), { total: 0, rows: [] });
    } finally {
      store.open(join(DIR, 'naimeng.db'));
    }
  });

  test('只留最近 1000 条 —— 错误会成片爆发', () => {
    /* 飞书挂一整晚能刷出几千条同样的错。不设上限的话，
       库会被一种错误撑满，而那对定位没有任何额外帮助。 */
    for (let i = 0; i < 1010; i++) logs.logError('压测', new Error('e' + i));
    assert.ok(logs.listErrors({ limit: 1 }).total <= 1000);
  });

  test('操作日志不设上限 —— 那是审计线索，剪掉就失去意义', () => {
    /* 和错误日志刻意不同：错误是噪声，操作是账。 */
    const before = logs.listOps({ limit: 1 }).total;
    for (let i = 0; i < 50; i++) logs.logOp({ action: 'POST /api/y', target: 't' + i });
    assert.equal(logs.listOps({ limit: 1 }).total, before + 50);
  });
});

/* ================================================================ */

describe('三种日志不是一回事', () => {
  test('op_logs / err_logs / intake_logs 各有各的表', () => {
    /* intake_logs 记「模型抽出什么、人改成什么」，是语料；
       op_logs 记「谁做了什么」，是审计；
       err_logs 记「哪里坏了」，是排查。合并任何两个都会让第三个用途变难。 */
    for (const t of ['op_logs', 'err_logs', 'intake_logs']) {
      assert.ok(Array.isArray(store.all(t)), `${t} 不存在`);
    }
  });

  test('热列名字避开 SQL 保留字', () => {
    /* 曾经把错误来源那一列取名 where，建表直接报
       「near "where": syntax error」—— 而那句话完全看不出是哪一列。 */
    const reserved = new Set(['where', 'order', 'group', 'select', 'from', 'index', 'table', 'when']);
    for (const [name, def] of Object.entries(store.TABLES)) {
      for (const col of Object.keys(def.cols)) {
        assert.ok(!reserved.has(col.toLowerCase()), `${name}.${col} 是 SQL 保留字`);
      }
    }
  });
});
