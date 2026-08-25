/**
 * 数据层回归 —— 用临时目录，不碰真实 data/。
 *
 * 重点锁住三件事：
 *   1. v1 → v2 迁移不丢数据、不编造数据
 *   2. 状态由动作驱动，不是手选
 *   3. 合作码 / UID 始终是字符串
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-db-'));
process.env.NAIMENG_DATA_DIR = DIR;

// 造一份 v1 数据：达人身上内嵌 recipient，没有 collaborations 表
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'db.json'), JSON.stringify({
  users: [{ id: 'u-1', name: '商务甲', role: 'business' }],
  creators: [{
    id: 'cr-1', name: '示例达人甲', ownerUserId: 'u-1',
    recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号', deliveryNote: '放菜鸟驿站' },
    cooperationType: '寄样合作', createdAt: '2026-07-01T00:00:00.000Z',
  }],
  accounts: [
    { id: 'ac-1', creatorId: 'cr-1', nickname: '示例达人甲', douyinId: '100000001', uid: '20000000001', cooperationCode: '04000000001' },
    { id: 'ac-2', creatorId: 'cr-1', nickname: '示例小号', douyinId: 'K9petlife', uid: '4000000000000003', cooperationCode: '' },
  ],
  intake_logs: [{ id: 'lg-1', creatorId: 'cr-1', confirmedByName: '商务甲' }],
  _seq: 100,
}), 'utf8');

const db = await import('../lib/db.js');

after(async () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

/* ================================================================ 迁移 */

describe('v1 → v2 迁移', () => {
  test('每条老记录生成一个「待寄样」合作，收件信息成为快照', async () => {
    const list = await db.listCollaborations({});
    assert.equal(list.length, 1);
    const cb = list[0];
    assert.equal(cb.status, '待寄样');
    assert.equal(cb.recipient.address, '示例省示例市示范路1号');
    assert.equal(cb.recipient.deliveryNote, '放菜鸟驿站');
    assert.equal(cb.migratedFromV1, true);
  });

  test('收件信息同时成为达人默认值，达人身上不再内嵌 recipient', async () => {
    const c = await db.getCreator('cr-1');
    assert.equal(c.defaultRecipient.phone, '13800138000');
    assert.equal('recipient' in c, false);
    assert.equal(c.channel, '抖音达人广场');
  });

  test('按账号生成履约项，一个账号一条', async () => {
    const cb = (await db.listCollaborations({}))[0];
    assert.equal(cb.fulfillments.length, 2);
    assert.deepEqual(cb.fulfillments.map((f) => f.filmingProgress), ['待拍摄', '待拍摄']);
  });

  test('不编造缺失数据：产品行和费用留空，等待补充', async () => {
    const cb = (await db.listCollaborations({}))[0];
    assert.equal(cb.items.length, 0);
    assert.equal(cb.sampleCost, null);
  });

  test('识别留痕重新指向合作', async () => {
    const cb = (await db.listCollaborations({}))[0];
    assert.equal((await db.listIntakeLogs({ collaborationId: cb.id })).length, 1);
  });

  test('迁移幂等：重复调用不会再生成合作', async () => {
    const n = (await db.listCollaborations({})).length;
    await db.stats();
    assert.equal((await db.listCollaborations({})).length, n);
  });
});

/* ================================================================ 合作 */

describe('合作与状态流转', () => {
  let cbId;

  before(async () => {
    const p1 = await db.saveProduct({ name: '洁齿冻干', petCategory: '通用' });
    const p2 = await db.saveProduct({ name: '鲜肉猫粮', petCategory: '猫' });
    await db.saveProduct({ name: '冻干双拼犬粮', petCategory: '狗' });
    const cb = await db.createCollaboration({
      creatorId: 'cr-1', sampleCost: 128.5,
      recipient: { name: '李某某', phone: '13800138009', address: '示例省示例市新址2号' },
      items: [{ productId: p1.id, quantity: 2 }, { productId: p2.id, quantity: 1 }],
      accountIds: ['ac-1', 'ac-2'],
    }, 'u-1');
    cbId = cb.id;
  });

  test('一次合作可含多个产品，各自数量', async () => {
    const cb = await db.getCollaboration(cbId);
    assert.equal(cb.items.length, 2);
    assert.deepEqual(cb.items.map((i) => `${i.productName}×${i.quantity}`), ['洁齿冻干×2', '鲜肉猫粮×1']);
  });

  test('产品名是快照，产品改名不影响历史', async () => {
    const p = (await db.listProducts()).find((x) => x.name === '洁齿冻干');
    await db.saveProduct({ id: p.id, name: '洁齿冻干（改名版）' });
    assert.equal((await db.getCollaboration(cbId)).items[0].productName, '洁齿冻干');
    await db.saveProduct({ id: p.id, name: '洁齿冻干' });
  });

  test('收件信息回写为达人默认值，下次录入自动带出', async () => {
    assert.equal((await db.getCreator('cr-1')).defaultRecipient.address, '示例省示例市新址2号');
  });

  test('回填快递单号 → 状态自动变已寄样', async () => {
    assert.equal((await db.getCollaboration(cbId)).status, '待寄样');
    const cb = await db.addPackage(cbId, { carrier: '申通', trackingNo: '773435035826894' });
    assert.equal(cb.status, '已寄样');
  });

  test('一次合作可拆多个包裹，同单号重复回填幂等', async () => {
    await db.addPackage(cbId, { carrier: '圆通', trackingNo: '773435035826882' });
    assert.equal((await db.getCollaboration(cbId)).packages.length, 2);
    await db.addPackage(cbId, { carrier: '申通', trackingNo: '773435035826894' });
    assert.equal((await db.getCollaboration(cbId)).packages.length, 2);
  });

  test('删掉最后一个包裹会退回待寄样', async () => {
    const cb = await db.getCollaboration(cbId);
    const ids = cb.packages.map((p) => p.id);
    await db.removePackage(ids[0]);
    assert.equal((await db.getCollaboration(cbId)).status, '已寄样');
    await db.removePackage(ids[1]);
    assert.equal((await db.getCollaboration(cbId)).status, '待寄样');
    await db.addPackage(cbId, { carrier: '申通', trackingNo: '773435035826894' });
  });

  test('贴口令 → 履约项自动已发布，且口令逐字节保存', async () => {
    const cb = await db.getCollaboration(cbId);
    const token = '0.58 复制打开抖音，看看【示例达人甲的作品】测试 https://v.douyin.com/EXAMPLE01/ :9pm KWM:/ 01/13 z@T.Lw';
    await db.updateFulfillment(cb.fulfillments[0].id, { shareToken: token, videoUrl: 'https://v.douyin.com/EXAMPLE01/' });
    const f = await db.getFulfillment(cb.fulfillments[0].id);
    assert.equal(f.filmingProgress, '已发布');
    assert.equal(f.shareToken, token);
    assert.ok(f.shareToken.endsWith('z@T.Lw'), '尾串必须保留');
  });

  test('部分账号发布时合作不算完成', async () => {
    assert.equal((await db.getCollaboration(cbId)).status, '已寄样');
  });

  test('全部需出片账号发布 → 合作自动完成', async () => {
    const cb = await db.getCollaboration(cbId);
    const rest = cb.fulfillments.find((f) => f.filmingProgress !== '已发布');
    await db.updateFulfillment(rest.id, { shareToken: 'x https://v.douyin.com/EXAMPLE02/', videoUrl: 'https://v.douyin.com/EXAMPLE02/' });
    assert.equal((await db.getCollaboration(cbId)).status, '已完成');
  });

  test('标记「本次不出片」也能推动完成', async () => {
    const cb = await db.createCollaboration({ creatorId: 'cr-1', type: '寄样合作',
      recipient: { name: 'x', phone: '13800138000', address: 'y' },
      items: [], accountIds: ['ac-1', 'ac-2'] }, 'u-1');
    await db.updateFulfillment(cb.fulfillments[0].id, { shareToken: 'a https://v.douyin.com/A/', videoUrl: 'https://v.douyin.com/A/' });
    assert.equal((await db.getCollaboration(cb.id)).status, '待寄样');
    await db.updateFulfillment(cb.fulfillments[1].id, { filmingProgress: '本次不出片' });
    assert.equal((await db.getCollaboration(cb.id)).status, '已完成');
  });

  test('只有已终止/已完成可手动设置', async () => {
    assert.equal(await db.setCollaborationStatus(cbId, '已寄样'), null);
    assert.equal(await db.setCollaborationStatus(cbId, '待寄样'), null);
    assert.equal((await db.setCollaborationStatus(cbId, '已终止')).status, '已终止');
  });
});

/* ================================================================ 达人 */

describe('达人与账号', () => {
  test('合作码在账号级，第二次合作自动带出', async () => {
    const a = (await db.getCreator('cr-1')).accounts.find((x) => x.id === 'ac-1');
    assert.equal(a.cooperationCode, '04000000001');
    assert.equal(typeof a.cooperationCode, 'string', '必须是字符串，否则前导零丢失');
  });

  test('补充账号：重复的跳过，新的插入', async () => {
    const before = (await db.getCreator('cr-1')).accounts.length;
    await db.addAccounts('cr-1', [{ nickname: '示例达人甲', uid: '20000000001' }]);
    assert.equal((await db.getCreator('cr-1')).accounts.length, before);
    await db.addAccounts('cr-1', [{ nickname: '新账号', douyinId: 'newacct01', uid: '4000000000000099' }]);
    assert.equal((await db.getCreator('cr-1')).accounts.length, before + 1);
  });

  test('查重命中并带出归属人与历史合作数', async () => {
    const c = await db.findConflicts([{ uid: '20000000001' }]);
    assert.equal(c.hard.length, 1);
    assert.equal(c.hard[0].existing.owner, '商务甲');
    assert.ok(c.hard[0].existing.collaborationCount >= 1);
  });

  test('手机号相同只做弱提示，不拦截', async () => {
    // 用达人当前的默认收件手机 —— 它会随每次新合作回写，不能写死
    const phone = (await db.getCreator('cr-1')).defaultRecipient.phone;
    const c = await db.findConflicts([{ uid: '不存在的uid' }], phone);
    assert.equal(c.hard.length, 0, '手机号相同不应硬拦截');
    assert.equal(c.soft.length, 1, '应产生弱提示');
    assert.match(c.soft[0].reason, /手机号/);
  });

  test('归属转交留痕，合作跟着达人一起转', async () => {
    const u2 = await db.createUser({ name: '商务乙', role: 'business' });
    const c = await db.transferOwner('cr-1', u2.id, 'u-1', '人员调岗');
    assert.equal(c.ownerUserId, u2.id);
    assert.equal(c.ownerHistory.at(-1).reason, '人员调岗');
    assert.ok((await db.listCollaborations({})).every((cb) => cb.ownerUserId === u2.id));
  });
});

/* ================================================================ 配置 */

describe('配置与业务数据分离', () => {
  test('API Key 只写 settings.json，不落 db.json', async () => {
    await db.saveSettings({ model: { provider: 'DeepSeek', apiKey: 'sk-testkey0123456789' } });
    const raw = JSON.parse(readFileSync(join(DIR, 'db.json'), 'utf8'));
    assert.ok(!JSON.stringify(raw).includes('sk-testkey0123456789'), 'key 泄漏进了业务数据文件');
    assert.equal((await db.getSettings()).model.apiKey, 'sk-testkey0123456789');
  });

  test('apiKey 传空表示不修改，避免前端回显掩码时覆盖真 key', async () => {
    await db.saveSettings({ model: { provider: '改个名', apiKey: '' } });
    assert.equal((await db.getSettings()).model.apiKey, 'sk-testkey0123456789');
    assert.equal((await db.getSettings()).model.provider, '改个名');
  });

  test('clearApiKey 显式清除', async () => {
    await db.saveSettings({ model: { clearApiKey: true } });
    assert.equal((await db.getSettings()).model.apiKey, '');
  });
});

/* ================================================================ */

describe('db 层的类型与身份契约', () => {
  test('上游传数字 uid 时归一成字符串，否则同一个号会被插两条', async () => {
    /* 这条不是理论洁癖。addAccountsSync 的去重比较是
         x.uid === String(a.uid)
       如果第一次插入时 uid 存成了 Number，第二次拿字符串来比就对不上，
       同一个抖音号会在同一个达人下重复建账号 —— 实测过，确实会变成 2 条。
       store 层只归一了「列」，JSON 载荷里的类型得 db 层自己管。 */
    const u = await db.createUser({ name: '类型测试员', role: 'business' });
    const c = await db.createCreator({ name: '类型达人', accounts: [{ nickname: 'n', uid: 20000000031 }] }, u.id);
    await db.addAccounts(c.id, [{ nickname: 'n', uid: '20000000031' }]);   // 同一个号，这次是字符串

    const got = await db.getCreator(c.id);
    assert.equal(got.accounts.length, 1, '同一个号被插了两条，去重失效');
    assert.equal(typeof got.accounts[0].uid, 'string', 'uid 必须是字符串');
  });

  test('合作码同样归一 —— 必须喂数字才能打到这条防线', async () => {
    /* 喂字符串的话 String() 是空操作，去掉它测试也不会红（这个坑在
       store.test.js 里踩过一次）。所以这里故意传 Number。
       注意：数字形态的合作码前导零在到达这里之前就已经没了，
       String() 救不回来 —— 它保证的是「不会以 Number 形态存进去」，
       否则后续所有 === 字符串比较都会静默失配。 */
    const u = await db.createUser({ name: '合作码测试员', role: 'business' });
    const c = await db.createCreator({
      name: '合作码达人',
      accounts: [{ nickname: 'm', douyinId: '100000099', cooperationCode: 4000000099 }],
    }, u.id);
    const got = await db.getCreator(c.id);
    assert.equal(typeof got.accounts[0].cooperationCode, 'string', '合作码存成了数字');
    assert.equal(got.accounts[0].cooperationCode, '4000000099');
  });

  test('字符串形态的前导零合作码原样保留', async () => {
    const u = await db.createUser({ name: '前导零测试员', role: 'business' });
    const c = await db.createCreator({
      name: '前导零达人',
      accounts: [{ nickname: 'z', douyinId: '100000098', cooperationCode: '04000000098' }],
    }, u.id);
    assert.equal((await db.getCreator(c.id)).accounts[0].cooperationCode, '04000000098');
  });

  test('没有会话就是匿名：currentUser(null) 返回 null，不回落到任何人', async () => {
    /* server 层的 userOf 在没有有效会话时会直接返回 null，
       根本不会调到这里 —— 所以这条抓的是「契约」而不是「现在有没有洞」。
       写下来是因为这个回落曾经真实存在过：任何未登录请求都会自动
       获得「最后一个保存过身份的人」的权限。 */
    assert.equal(await db.currentUser(null), null);
    assert.equal(await db.currentUser(''), null);
    assert.equal(await db.currentUser(undefined), null);
    assert.equal(await db.currentUser('u-does-not-exist'), null, '不存在的 id 也不能回落');
  });
});

/* ================================================================ */

describe('不寄样合作的初始状态', () => {
  test('不寄样直接进「进行中」，不落成「待寄样」', async () => {
    /* 落成「待寄样」的话，表里会一直挂着一个永远不会被寄的东西 ——
       筛选「待寄样」的人以为有活要干，点进去才发现根本不需要寄。 */
    for (const t of ['不寄样合作', '直播定向']) {
      const cb = await db.createCollaboration({ creatorId: 'cr-1', type: t, accountIds: ['ac-1'] }, 'u-1');
      assert.equal(cb.status, '进行中', `${t} 的初始状态不对`);
      assert.equal(cb.type, t, '类型没存进去');
    }
  });

  test('寄样合作仍然是「待寄样」', async () => {
    const cb = await db.createCollaboration({ creatorId: 'cr-1', type: '寄样合作', accountIds: ['ac-1'] }, 'u-1');
    assert.equal(cb.status, '待寄样');
  });

  test('没传类型时按寄样处理', async () => {
    const cb = await db.createCollaboration({ creatorId: 'cr-1', accountIds: ['ac-1'] }, 'u-1');
    assert.equal(cb.type, '寄样合作');
    assert.equal(cb.status, '待寄样');
  });

  test('「进行中」在状态枚举里 —— 否则筛选和统计会漏掉它', () => {
    assert.ok(db.COLLAB_STATUS.includes('进行中'));
  });
});

/* ================================================================ */

describe('其他平台账号有出口', () => {
  test('合作详情带出达人名下的其他平台账号', async () => {
    /* 之前模型抽了、库里存了，但 expandCollaboration 不带出来，
       前端也就没法显示 —— 整条链路只差最后一步，等于白做。 */
    const c = await db.createCreator({
      name: '多平台达人',
      accounts: [{ nickname: '多平台达人', douyinId: '100000077' }],
      otherAccounts: [{ platform: '微信视频号', accountId: 'sphDemo000000009' }],
    }, 'u-1');
    const cb = await db.createCollaboration({ creatorId: c.id, accountIds: [] }, 'u-1');
    const full = await db.getCollaboration(cb.id);
    assert.equal(full.otherAccounts.length, 1);
    assert.equal(full.otherAccounts[0].accountId, 'sphDemo000000009');
  });

  test('没有其他平台账号时是空数组，不是 undefined', async () => {
    const c = await db.createCreator({
      name: '单平台达人', accounts: [{ nickname: '单平台达人', douyinId: '100000078' }],
    }, 'u-1');
    const cb = await db.createCollaboration({ creatorId: c.id, accountIds: [] }, 'u-1');
    assert.deepEqual((await db.getCollaboration(cb.id)).otherAccounts, []);
  });

  test('带货方式能存进去', async () => {
    const c = await db.createCreator({
      name: '带货方式达人', accounts: [{ nickname: '带货方式达人', douyinId: '100000079' }],
    }, 'u-1');
    const cb = await db.createCollaboration({ creatorId: c.id, salesChannel: '直播', accountIds: [] }, 'u-1');
    assert.equal((await db.getCollaboration(cb.id)).salesChannel, '直播');
  });
});
