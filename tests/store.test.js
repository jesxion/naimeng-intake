/**
 * SQLite 存储层回归。
 *
 * 这一层底下是 node:sqlite（Node 内置，带 experimental 标记）。
 * Node 大版本升级时这组测试就是复测清单。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as store from '../lib/store.js';
import { importFromJson, verifyImport } from '../lib/import-json.js';

let DIR;
before(() => { DIR = mkdtempSync(join(tmpdir(), 'naimeng-store-')); });
after(() => { store.close(); try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

const fresh = (name) => { store.close(); store.open(join(DIR, name)); };

/* ================================================================ */

describe('看起来像数字的字符串不能被改坏', () => {
  before(() => fresh('types.db'));

  test('合作码前导零原样往返', () => {
    store.put('accounts', { id: 'ac-1', creatorId: 'cr-1', cooperationCode: '04000000031' });
    const got = store.get('accounts', 'ac-1');
    assert.equal(got.cooperationCode, '04000000031');
    assert.equal(typeof got.cooperationCode, 'string');
  });

  test('提取成列之后仍然是字符串，索引查得到', () => {
    const rows = store.findBy('accounts', 'cooperationCode', '04000000031');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cooperationCode, '04000000031');
  });

  test('UID 这种超长数字串不丢精度', () => {
    // 20 位已经超过 Number.MAX_SAFE_INTEGER，一旦走数值列就会被改写
    const uid = '20000000000000000031';
    store.put('accounts', { id: 'ac-2', uid });
    assert.equal(store.get('accounts', 'ac-2').uid, uid);
    assert.equal(store.findBy('accounts', 'uid', uid).length, 1);
  });

  test('抖音号以 0 开头也不丢', () => {
    store.put('accounts', { id: 'ac-3', douyinId: '007700' });
    assert.equal(store.get('accounts', 'ac-3').douyinId, '007700');
  });

  test('上游误传数字时，提取列仍按字符串入库并可被字符串查到', () => {
    /* 这条才真正打到 put() 里的 String(v)。
       上面那些用例全都喂的是字符串，那条防线是空转的 —— 去掉也不会红。
       现实里的风险是别处（导入脚本、手工修数据）塞进来一个 Number：
       SQLite 的 TEXT 亲和性会把 4000000031 存成 '4000000031'，
       和字符串 '04000000031' 是两条不同的记录，查重就此失效。 */
    store.put('accounts', { id: 'ac-4', uid: 20000000031 });
    const col = store.db().prepare('SELECT uid FROM accounts WHERE id = ?').get('ac-4').uid;
    assert.equal(typeof col, 'string', '提取列存成了数字，索引查询会对不上');
    assert.equal(store.findBy('accounts', 'uid', '20000000031').length, 1,
      '用字符串查不到刚写进去的数字，查重会漏');
  });
});

/* ================================================================ */

describe('事务', () => {
  before(() => fresh('tx.db'));

  test('抛错时整体回滚', () => {
    assert.throws(() => store.tx(() => {
      store.put('users', { id: 'u-a', name: '甲' });
      store.put('users', { id: 'u-b', name: '乙' });
      throw new Error('中途失败');
    }), /中途失败/);
    assert.equal(store.count('users'), 0, '回滚后不该留下半库');
  });

  test('成功时整体提交', () => {
    store.tx(() => {
      store.put('users', { id: 'u-c', name: '丙' });
      store.put('users', { id: 'u-d', name: '丁' });
    });
    assert.equal(store.count('users'), 2);
  });

  test('嵌套事务跟随外层，内层不独立提交', () => {
    assert.throws(() => store.tx(() => {
      store.put('users', { id: 'u-e', name: '戊' });
      store.tx(() => store.put('users', { id: 'u-f', name: '己' }));
      throw new Error('外层失败');
    }), /外层失败/);
    assert.equal(store.get('users', 'u-f'), null, '内层不能抢先提交');
    assert.equal(store.count('users'), 2, '之前提交的两条应保留');
  });
});

/* ================================================================ */

describe('发号器', () => {
  before(() => fresh('seq.db'));

  test('连续发号不重复', () => {
    const ids = Array.from({ length: 50 }, () => store.nextSeq('cb'));
    assert.equal(new Set(ids).size, 50);
  });

  test('号码持久化，重开库不会退回去', () => {
    const before1 = store.nextSeq('cb');
    store.close();
    store.open(join(DIR, 'seq.db'));
    const after1 = store.nextSeq('cb');
    const n = (s) => Number(s.split('-')[1]);
    assert.ok(n(after1) > n(before1), `重开后发号退回了：${before1} → ${after1}`);
  });
});

/* ================================================================ */

describe('upsert 与删除', () => {
  before(() => fresh('crud.db'));

  test('同 id 再次写入是更新不是新增', () => {
    store.put('products', { id: 'pr-1', name: '洁齿冻干', active: true });
    store.put('products', { id: 'pr-1', name: '改名了', active: false });
    assert.equal(store.count('products'), 1);
    assert.equal(store.get('products', 'pr-1').name, '改名了');
  });

  test('提取列跟着一起更新', () => {
    assert.equal(store.findBy('products', 'name', '改名了').length, 1);
    assert.equal(store.findBy('products', 'name', '洁齿冻干').length, 0, '旧值还留在列里说明没更新');
  });

  test('删除返回是否真的删掉了', () => {
    assert.equal(store.remove('products', 'pr-1'), true);
    assert.equal(store.remove('products', 'pr-1'), false, '删不存在的应返回 false');
  });

  test('按列批量删除', () => {
    store.put('collab_items', { id: 'ci-1', collaborationId: 'cb-1' });
    store.put('collab_items', { id: 'ci-2', collaborationId: 'cb-1' });
    store.put('collab_items', { id: 'ci-3', collaborationId: 'cb-2' });
    assert.equal(store.removeBy('collab_items', 'collaborationId', 'cb-1'), 2);
    assert.equal(store.count('collab_items'), 1);
  });

  test('findIn 批量关联', () => {
    store.put('collab_items', { id: 'ci-4', collaborationId: 'cb-3' });
    const rows = store.findIn('collab_items', 'collaborationId', ['cb-2', 'cb-3']);
    assert.equal(rows.length, 2);
    assert.equal(store.findIn('collab_items', 'collaborationId', []).length, 0, '空列表不该退化成全表');
  });
});

/* ================================================================ */

describe('从 db.json 导入', () => {
  const sample = {
    schemaVersion: 2,
    _seq: 164,
    users: [{ id: 'u-1', name: '商务甲', role: 'business' }],
    creators: [{ id: 'cr-1', name: '豆豆', ownerUserId: 'u-1' }],
    accounts: [{ id: 'ac-1', creatorId: 'cr-1', uid: '20000000031',
      douyinId: '100000031', cooperationCode: '04000000031' }],
    products: [], collaborations: [], collab_items: [], collab_accounts: [],
    packages: [], drafts: [], intake_logs: [], jobs: [], other_accounts: [],
  };
  let file;

  before(() => {
    fresh('import.db');
    file = join(DIR, 'db.json');
    writeFileSync(file, JSON.stringify(sample), 'utf8');
  });

  test('逐表导入且行数一致', () => {
    const r = importFromJson(file);
    assert.equal(r.skipped, false);
    assert.equal(store.count('users'), 1);
    assert.equal(store.count('accounts'), 1);
  });

  test('合作码前导零穿过迁移没被改', () => {
    const v = verifyImport(file);
    assert.deepEqual(v.problems, []);
    assert.equal(store.get('accounts', 'ac-1').cooperationCode, '04000000031');
  });

  test('_seq 承接，新号不会和历史记录撞车', () => {
    const id = store.nextSeq('cb');
    assert.equal(id, 'cb-00165', `发号从 ${id} 开始，会覆盖历史 id`);
  });

  test('重复导入被跳过 —— 否则第二次启动会用旧快照盖掉新数据', () => {
    store.put('users', { id: 'u-2', name: '后来录的' });
    const r = importFromJson(file);
    assert.equal(r.skipped, true);
    assert.ok(store.get('users', 'u-2'), '新录的数据被旧快照盖掉了');
  });

  test('db.json 损坏时抛错而不是静默跳过', () => {
    fresh('bad.db');
    const bad = join(DIR, 'bad.json');
    writeFileSync(bad, '{ 不是合法 JSON', 'utf8');
    assert.throws(() => importFromJson(bad), /解析失败/);
  });

  test('没有 db.json 时按全新库处理，不报错', () => {
    fresh('none.db');
    const r = importFromJson(join(DIR, 'does-not-exist.json'));
    assert.equal(r.skipped, true);
    assert.match(r.reason, /全新库/);
  });
});
