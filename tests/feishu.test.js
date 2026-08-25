/**
 * 飞书多维表格同步回归。
 *
 * 全程打在本地假服务上（tests/helpers/fake-feishu.js），
 * 不碰真实凭据也不动公司正在用的那张表。
 *
 * 锁住四件事：
 *   1. 同步失败绝不影响商务干活 —— 这是整个设计的前提
 *   2. 同一条合作重复推送是更新不是新建（否则飞书表里会堆重复行）
 *   3. 值按飞书列类型转换 —— 类型不对飞书直接报错且不说是哪一列
 *   4. 错误码翻译成能照着做的话，尤其 91403
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startFakeFeishu } from './helpers/fake-feishu.js';
import { SYSTEM_TABLE } from '../lib/feishu-schema.js';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-feishu-'));
process.env.NAIMENG_DATA_DIR = DIR;

let fake, db, sync, feishu, store, me, prod;

before(async () => {
  fake = await startFakeFeishu();
  process.env.FEISHU_BASE = fake.origin + '/open-apis';

  db = await import('../lib/db.js');
  sync = await import('../lib/sync.js');
  feishu = await import('../lib/feishu.js');
  store = await import('../lib/store.js');

  me = await db.createUser({ name: '商务甲', role: 'business' });
  prod = await db.saveProduct({ name: '洁齿冻干' });
  await db.saveSettings({ feishu: {
    enabled: true,
    appId: 'cli_test', appSecret: 'secret_test',
    appToken: 'appTokenSample', tableId: 'tblSample', tableName: '达人寄样信息',
    /* 全量映射 —— 系统表的列名和字段一一对应，界面上也是按同名自动匹配的，
       所以测试就照真实配置来，不挑几个字段做一份不存在的配置。 */
    mapping: Object.fromEntries(SYSTEM_TABLE.map((w) => [w.from, w.col])),
  } });
});

after(async () => {
  await fake?.close();
  delete process.env.FEISHU_BASE;
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function newCollab(nickname, douyinId, uid) {
  const creator = await db.createCreator({
    name: nickname,
    recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号' },
    accounts: [{ nickname, douyinId, uid }],
  }, me.id);
  const accounts = (await db.getCreator(creator.id)).accounts;
  return db.createCollaboration({
    creatorId: creator.id,
    recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号' },
    items: [{ productId: prod.id, productName: prod.name, quantity: 2 }],
    accountIds: accounts.map((a) => a.id),
  }, me.id);
}

/* ================================================================ */

describe('值按飞书列类型转换', () => {
  test('数字列收到数字，不是字符串', () => {
    assert.equal(sync.coerce('88.5', 2), 88.5);
    assert.equal(sync.coerce('不是数字', 2), null);
  });

  test('日期列收到毫秒时间戳', () => {
    const t = sync.coerce('2026-08-01T00:00:00.000Z', 5);
    assert.equal(typeof t, 'number');
    assert.equal(new Date(t).toISOString(), '2026-08-01T00:00:00.000Z');
  });

  test('复选框的空是 false 而不是留空', () => {
    // 留空会被飞书当成「没传这一列」，已告知又变回未告知就看不出来了
    assert.equal(sync.coerce(null, 7), false);
    assert.equal(sync.coerce(true, 7), true);
  });

  test('布尔值写进文本列时转成「是/否」，不是 true/false', () => {
    assert.equal(sync.coerce(true, 1), '是');
    assert.equal(sync.coerce(false, 1), '否');
  });

  test('超链接列要的是对象不是字符串', () => {
    assert.deepEqual(sync.coerce('https://v.douyin.com/AB/', 15),
      { text: 'https://v.douyin.com/AB/', link: 'https://v.douyin.com/AB/' });
  });

  test('空值留空，不写 "null" 这种字符串进表', () => {
    assert.equal(sync.coerce(null, 1), null);
    assert.equal(sync.coerce('', 1), null);
    assert.equal(sync.coerce(undefined, 2), null);
  });
});

/* ================================================================ */

describe('推送', () => {
  let cb;

  test('建合作会自动入队 —— 不靠路由层记得调用', async () => {
    cb = await newCollab('豆豆的小窝', '100000031', '20000000031');
    const q = await sync.queueStatus();
    assert.ok(q.pending >= 1, '建合作后队列里应该有待推送');
  });

  test('推送成功后飞书里有这条记录，字段类型都对', async () => {
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0, `推送失败：${JSON.stringify(r)}`);
    assert.equal(fake.state.records.size, 1);

    const rec = [...fake.state.records.values()][0];
    /* 系统ID 是行标识 `合作ID#产品行ID`，不是合作 id ——
       一条合作有几款产品就有几行，光用合作 id 分不开它们。 */
    const item = (await db.getCollaboration(cb.id)).items[0];
    assert.equal(rec['系统ID'], `${cb.id}#${item.id}`);
    assert.equal(rec['合作ID'], cb.id);
    assert.equal(rec['达人名称'], '豆豆的小窝');
    assert.equal(rec['抖音号'], '100000031');
    assert.equal(rec['合作状态'], '待寄样');
    assert.equal(typeof rec['已告知达人'], 'boolean');
    assert.equal(typeof rec['建档时间'], 'number');
  });

  test('产品名称是纯名字，数量单独一列 —— 不是「名称 ×数量」', async () => {
    /* 真实反馈：产品名称列里出现「洁齿冻干 ×2」，而数量列永远是空的。
       原因是当时还在用老的「寄样产品」字段，它把整条合作的产品拼成一格。
       一行一款产品之后，这两件事必须是分开的两列。 */
    const rec = [...fake.state.records.values()][0];
    assert.equal(rec['产品名称'], '洁齿冻干');
    assert.ok(!/[×x]\s*\d/.test(rec['产品名称']), '产品名称里混进了数量');
    assert.equal(rec['数量'], 2);
    assert.equal(typeof rec['数量'], 'number', '数量列是数字类型，不能写字符串');
  });

  test('是否寄样 = 是；同步时间被写上', async () => {
    const rec = [...fake.state.records.values()][0];
    /* 「是否寄样」问的是这条记录是不是一次寄样，不是「有没有发出去」。
       有产品行就是「是」—— 之前按合作状态派生，待寄样时会写成「否」，
       而那一行明明已经有产品了。 */
    assert.equal(rec['是否寄样'], '是');
    assert.equal(typeof rec['同步时间'], 'number', '同步时间没记录');
    assert.ok(Math.abs(Date.now() - rec['同步时间']) < 60_000, '同步时间不是本次推送的时间');
  });

  test('推完队列清空', async () => {
    assert.equal((await sync.queueStatus()).pending, 0);
  });

  test('同一条合作再改是更新不是新建', async () => {
    await db.addPackage(cb.id, { carrier: '申通', trackingNo: '773000000000001' });
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0);
    assert.equal(fake.state.records.size, 1, '重复推送在飞书表里堆出了新行');

    const rec = [...fake.state.records.values()][0];
    assert.equal(rec['合作状态'], '已寄样', '状态没跟着更新');
    assert.equal(rec['快递单号'], '773000000000001');
  });

  test('本地映射丢了也不会重复建行 —— 按系统ID列找回来', async () => {
    // 模拟换机器/重建库：清掉本地 record_id 映射
    for (const l of store.all('sync_links')) store.remove('sync_links', l.id);
    await db.markNotified(cb.id, true);
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0);
    assert.equal(fake.state.records.size, 1, '映射丢失后又新建了一行');
    assert.equal([...fake.state.records.values()][0]['已告知达人'], true);
  });

  test('记录被人在飞书里删了 → 重新建一条，而不是一直重试失败', async () => {
    const recId = [...fake.state.records.keys()][0];
    fake.state.records.delete(recId);
    await db.markNotified(cb.id, false);
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0, '记录被删后应该能自愈');
    assert.equal(fake.state.records.size, 1);
  });
});

/* ================================================================ */

describe('失败不影响商务干活', () => {
  test('飞书拒绝权限时，业务动作照样成功', async () => {
    fake.state.denyPermission = true;
    try {
      const cb2 = await newCollab('权限测试达人', '100000032', '20000000032');
      assert.ok(cb2?.id, '飞书不可用时建合作也必须成功');

      const r = await sync.pump({ force: true });
      assert.ok(r.failed > 0 || r.error, '这次推送应该是失败的');

      // 业务数据完好
      assert.ok(await db.getCollaboration(cb2.id));
    } finally { fake.state.denyPermission = false; }
  });

  test('失败会留在队列里等重试，不会丢', async () => {
    const q = await sync.queueStatus();
    assert.ok(q.pending + q.failed >= 1, '失败的推送应该还在队列里');
    assert.ok(q.lastError, '应该记下失败原因');
  });

  test('91403 被翻译成「应用没被加进这张表」而不是干巴巴的 Forbidden', async () => {
    const q = await sync.queueStatus();
    assert.match(q.lastError, /添加文档应用|没有权限/,
      `错误信息没翻译，用户不知道该去改什么：${q.lastError}`);
  });

  test('恢复后重试能成功', async () => {
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0, `恢复后仍失败：${JSON.stringify(r)}`);
    assert.equal(fake.state.records.size, 2);
  });

  test('pump 永不抛异常 —— 它是被业务动作顺手触发的', async () => {
    const bad = await db.getSettings();
    await db.saveSettings({ feishu: { appToken: 'appTokenWrong' } });
    const r = await sync.pump({ force: true });   // 不该 throw
    assert.ok(r, 'pump 抛异常了，会污染商务的操作结果');
    await db.saveSettings({ feishu: { appToken: 'appTokenSample' } });
    assert.ok(bad);
  });
});

/* ================================================================ */

describe('配置校验与自检', () => {
  test('没映射系统ID时明确拒绝 —— 否则每次推送都新建，表里会堆重复行', async () => {
    const s = { feishu: { enabled: true, appId: 'a', appSecret: 'b', appToken: 'c', tableId: 'd', mapping: {} } };
    assert.equal(sync.isEnabled(s), false);
    assert.match(sync.configProblems(s).join(' '), /系统ID/);
  });

  test('测试连接逐级报告，卡在哪一级说哪一级', async () => {
    const cfg = { appId: 'cli_test', appSecret: 'secret_test' };
    const good = await feishu.testConnection(cfg, 'appTokenSample', 'tblSample');
    assert.equal(good.ok, true);
    /* 断言有哪几级，而不是有几级 —— 数量是会变的（后来就加了「写入权限」一级），
       而「这四件事都报告了」才是这个测试真正要守的东西。 */
    assert.deepEqual(good.steps.map((s) => s.step),
      ['凭据校验', '访问多维表格', '读取字段', '写入权限']);
    assert.ok(good.fields.some((f) => f.name === '系统ID'));

    const badCred = await feishu.testConnection({ appId: 'x', appSecret: 'y' }, 'appTokenSample');
    assert.equal(badCred.ok, false);
    assert.equal(badCred.steps[0].step, '凭据校验');
    assert.match(badCred.steps[0].detail, /app_id|app_secret/);
  });

  test('列表分页：表多于一页时要翻完，不能只拿第一页', async () => {
    /* 这是「今天好好的、以后表多了才静默少数据」的那类坑。
       用户已经遇到过「侧边栏 4 张、只识别出 3 张」的困惑 ——
       那次的原因是仪表盘不算数据表，但分页确实是另一个会造成同样症状的原因。 */
    /* 必须超过单页上限（飞书是 100）才会真的触发翻页。
       第一版只造了 7 张，客户端一次请求 100 条就全拿到了 ——
       把分页代码删掉测试照样绿，是个空转的用例。 */
    const many = Array.from({ length: 150 }, (_, i) => ({ table_id: `tblX${i}`, name: `表${i}` }));
    const backup = fake.state.tables;
    fake.state.tables = many;
    try {
      const got = await feishu.listTables({ appId: 'cli_test', appSecret: 'secret_test' }, 'appTokenSample');
      assert.equal(got.length, 150, `只拿到 ${got.length} 张，分页没翻完`);
      assert.deepEqual(got.map((t) => t.name), many.map((t) => t.name));
    } finally { fake.state.tables = backup; }
  });

  test('测试连接会把表名和 table_id 一起报出来', async () => {
    // 用户没法凭「找到 N 张表」这一句判断少的是哪一张
    const r = await feishu.testConnection(
      { appId: 'cli_test', appSecret: 'secret_test' }, 'appTokenSample');
    const step = r.steps.find((s) => s.step === '访问多维表格');
    assert.ok(step.tables?.length, '没有列出表清单');
    assert.ok(step.tables[0].tableId, '缺 table_id，没法和飞书侧边栏对照');
    assert.match(step.note || '', /仪表盘|表单/, '要说明哪些东西不算数据表');
  });

  test('保存时把分享链接归一成 app_token，不存原始 URL', async () => {
    /* 用户粘的是整条分享链接，而它会被直接拼进接口路径。
       存原始链接的话，凡是没记得调 parseAppToken 的调用点全部 404，
       返回的还是 HTML 错误页 —— 报错只说「不是 JSON」，极难定位。
       所以在**保存这个边界上**归一，而不是指望每个调用点都记得解析。 */
    const url = 'https://gcnss99go2yu.feishu.cn/base/appTokenSample?table=tblSample&view=vew1';
    const s = await db.saveSettings({ feishu: { appToken: url } });
    assert.equal(s.feishu.appToken, 'appTokenSample', '存进去的还是整条 URL');

    // 已经是纯 token 的不要被改坏
    assert.equal((await db.saveSettings({ feishu: { appToken: 'appTokenSample' } })).feishu.appToken,
      'appTokenSample');
  });

  test('路径里混进 URL 或空段时就地拒绝，不发出去换一个 404', async () => {
    await assert.rejects(
      () => feishu.listFields({ appId: 'cli_test', appSecret: 'secret_test' },
        'https://x.feishu.cn/base/ABC', 'tblSample'),
      /路径拼错/);
    await assert.rejects(
      () => feishu.listFields({ appId: 'cli_test', appSecret: 'secret_test' }, '', 'tblSample'),
      /路径拼错/);
  });

  test('能在飞书表里建「系统ID」列 —— 不必让用户手工加', async () => {
    /* 让用户自己去飞书加列是可以的，但那一步很容易卡住：
       类型选成「自动编号」这一列就不可写，而界面上只表现为
       「映射下拉里没有它」，没人猜得到原因。 */
    const cfg = { appId: 'cli_test', appSecret: 'secret_test' };
    const before = (await feishu.listFields(cfg, 'appTokenSample', 'tblSample')).length;

    const f = await feishu.createField(cfg, 'appTokenSample', 'tblSample', '新建列测试', 1);
    assert.equal(f.name, '新建列测试');

    const after = await feishu.listFields(cfg, 'appTokenSample', 'tblSample');
    assert.equal(after.length, before + 1);
    const made = after.find((x) => x.name === '新建列测试');
    assert.equal(made.type, 1, '必须建成多行文本 —— 其它类型可能不可写');
    assert.ok(feishu.WRITABLE_TYPES.has(made.type), '新建的列必须是可写类型');
  });

  test('从分享链接里解析 app_token', () => {
    assert.equal(
      feishu.parseAppToken('https://gcnss99go2yu.feishu.cn/base/BZHJbRYP9aMsXisYD2QcnpLqnke?from=from_copylink'),
      'BZHJbRYP9aMsXisYD2QcnpLqnke');
    assert.equal(feishu.parseAppToken('https://example.com/x'), '');
  });

  test('令牌被缓存，不会每推一条就换一次', async () => {
    const before = fake.state.tokenIssued;
    await feishu.listTables({ appId: 'cli_test', appSecret: 'secret_test' }, 'appTokenSample');
    await feishu.listTables({ appId: 'cli_test', appSecret: 'secret_test' }, 'appTokenSample');
    assert.equal(fake.state.tokenIssued, before, '令牌接口有频率限制，不能每次都换');
  });
});

/* ================================================================ */

describe('权限类错误码的翻译', () => {
  test('1254302 说清「读得到写不进」，并给出三条可执行的排查', async () => {
    /* 这个码和 91403 是两回事：91403 是压根进不来，
       1254302 是进来了但只能看。翻译混了会把人引到错误的方向上 ——
       去反复确认「添加文档应用」，而真正的原因在权限范围或高级权限里。 */
    const e = new feishu.FeishuError(1254302, 'permission denied', '/x');
    assert.match(e.message, /只有读权限|写不了/);
    assert.match(e.message, /发布新版本/, '漏了这条最容易踩的：改权限后不发版不生效');
    assert.match(e.message, /高级权限/);
    /* 和 91403 必须是两段不同的话。翻成一样的，用户会反复去确认
       「添加文档应用」—— 而那一步早就做过了，真正的原因在权限范围里。 */
    const p91403 = new feishu.FeishuError(91403, 'Forbidden', '/x');
    assert.notEqual(e.message, p91403.message);
    assert.ok(!/^没有权限。多半/.test(e.message), '不该照抄 91403 的开头');
  });

  test('测试连接不冒充验证过写入', async () => {
    /* 曾经有个 bug 让「保存」永远显示成功而配置根本没生效。
       同一类错误在这里的形态是：测试连接说成功，同步却一直失败 ——
       因为测的全是读操作。所以必须显式说明写入未验证。 */
    const r = await feishu.testConnection(
      { appId: 'cli_test', appSecret: 'secret_test' }, 'appTokenSample', 'tblSample');
    assert.equal(r.ok, true);
    const w = r.steps.find((s) => s.step === '写入权限');
    assert.ok(w, '缺少「写入权限」这一步，用户会以为测试通过就等于能写');
    assert.match(w.detail, /未验证/);
    assert.match(w.detail, /1254302/, '要指明失败时会看到什么码，否则这条提示没有落点');
  });
});

/* ================================================================ */

describe('一款产品一行', () => {
  let cb, p2;

  test('两款产品推出两行，各自带自己的数量', async () => {
    p2 = await db.saveProduct({ name: '鸡肉冻干条' });
    const creator = await db.createCreator({
      name: '多品测试', recipient: { name: '李某某', phone: '13800138001', address: '示例地址' },
      accounts: [{ nickname: '多品测试', douyinId: '100000041', uid: '20000000041' }],
    }, me.id);
    const accounts = (await db.getCreator(creator.id)).accounts;
    cb = await db.createCollaboration({
      creatorId: creator.id,
      recipient: { name: '李某某', phone: '13800138001', address: '示例地址' },
      items: [
        { productId: prod.id, productName: prod.name, quantity: 2 },
        { productId: p2.id, productName: p2.name, quantity: 5 },
      ],
      accountIds: accounts.map((a) => a.id),
    }, me.id);

    const before = fake.state.records.size;
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0, JSON.stringify(r));
    assert.equal(fake.state.records.size, before + 2, '两款产品应该推出两行');

    const mine = [...fake.state.records.values()].filter((x) => x['合作ID'] === cb.id);
    assert.deepEqual(mine.map((x) => x['产品名称']).sort(), ['洁齿冻干', '鸡肉冻干条']);
    assert.deepEqual(mine.map((x) => x['数量']).sort((a, b) => a - b), [2, 5]);
  });

  test('寄样费用只写第一行 —— 每行都写的话飞书求和会翻倍', async () => {
    /* 直接改库：目前还没有「编辑合作」的接口，
       而这条不变量必须现在就锁住 —— 等编辑功能做出来再补，
       就成了「上线后才发现合计虚高」。 */
    const raw = store.get('collaborations', cb.id);
    store.put('collaborations', { ...raw, sampleCost: 88 });
    sync.enqueue(cb.id);
    await sync.pump({ force: true });

    const mine = [...fake.state.records.values()].filter((x) => x['合作ID'] === cb.id);
    const withCost = mine.filter((x) => x['寄样费用'] != null);
    assert.equal(withCost.length, 1, `${withCost.length} 行都写了费用，合计会虚高`);
    assert.equal(withCost[0]['寄样费用'], 88);
  });

  test('删掉一款产品，飞书那一行也删掉，不留孤儿', async () => {
    const items = store.findBy('collab_items', 'collaborationId', cb.id);
    assert.equal(items.length, 2, '前提没成立');
    store.remove('collab_items', items[1].id);

    sync.enqueue(cb.id);
    const r = await sync.pump({ force: true });
    assert.equal(r.failed, 0, JSON.stringify(r));

    const mine = [...fake.state.records.values()].filter((x) => x['合作ID'] === cb.id);
    assert.equal(mine.length, 1, '飞书里留下了已删产品的孤儿行');
    assert.equal(mine[0]['产品名称'], '洁齿冻干');
  });

  test('整条合作没了时，它的所有行一起清掉', async () => {
    assert.ok([...fake.state.records.values()].some((x) => x['合作ID'] === cb.id), '前提没成立');
    store.remove('collaborations', cb.id);
    sync.enqueue(cb.id);
    await sync.pump({ force: true });

    const left = [...fake.state.records.values()].filter((x) => x['合作ID'] === cb.id);
    assert.equal(left.length, 0, '合作没了，飞书里还留着行');
    const links = store.all('sync_links').filter((l) => String(l.entityId).startsWith(cb.id + '#'));
    assert.equal(links.length, 0, '本地映射也该清掉，否则下次还会去删已经不存在的记录');
  });
});

/* ================================================================ */

describe('字段定义与取值函数不能分叉', () => {
  test('每一列都有取值函数，每个取值函数都有列', () => {
    /* 两处各维护一份的话，加了列忘了加取值函数不会有任何报错，
       只表现为「那一列永远是空的」；反过来则是「映射下拉里没有这一项」。
       这两种现象都真实发生过（数量、合作ID、是否寄样、同步时间四个字段
       就是这么丢的），而且都极难联想到根因。 */
    const cols = SYSTEM_TABLE.map((w) => w.from).sort();
    const fields = sync.SOURCE_FIELDS.map((f) => f.id).sort();
    assert.deepEqual(fields, cols);
    for (const f of sync.SOURCE_FIELDS) {
      assert.equal(typeof f.get, 'function', `${f.label} 没有取值函数`);
    }
  });

  test('列名不重复 —— 重名会让映射覆盖掉彼此', () => {
    const names = SYSTEM_TABLE.map((w) => w.col);
    assert.equal(new Set(names).size, names.length);
  });

  test('只用可写类型，不会定义出一个写不进去的列', () => {
    for (const w of SYSTEM_TABLE) {
      assert.ok(feishu.WRITABLE_TYPES.has(w.type), `${w.col} 的类型 ${w.type} 是只读的`);
    }
  });
});

/* ================================================================ */

describe('每条合作的同步状态', () => {
  let cb;

  test('推过的是已同步，带行数和时间', async () => {
    cb = await newCollab('状态测试达人', '100000051', '20000000051');
    await sync.pump({ force: true });
    const st = sync.statesFor([cb.id], await db.getSettings()).get(cb.id);
    assert.equal(st.state, 'synced');
    assert.equal(st.rows, 1, '一款产品应该是一行');
    assert.ok(st.at, '缺少同步时间');
  });

  test('刚改动过的是待同步', async () => {
    await db.markNotified(cb.id, true);   // 会 markDirty 入队
    const st = sync.statesFor([cb.id], await db.getSettings()).get(cb.id);
    assert.equal(st.state, 'pending');
    await sync.pump({ force: true });
  });

  test('从没推过的是未同步，不是已同步', async () => {
    /* 「未同步」和「同步失败」必须分得开：前者多半是开启同步之前的老记录，
       后者是真出了问题。混成一个的话，表里几十条灰的会把坏掉的那条淹没。 */
    const fresh = await newCollab('从未推送', '100000052', '20000000052');
    for (const r of store.findBy('outbox', 'target', 'feishu')) store.remove('outbox', r.id);
    const st = sync.statesFor([fresh.id], await db.getSettings()).get(fresh.id);
    assert.equal(st.state, 'never');
  });

  test('同步没配好时一律 off —— 不假装每条都「未同步」', async () => {
    const st = sync.statesFor([cb.id], { feishu: { enabled: false } }).get(cb.id);
    assert.equal(st.state, 'off');
  });

  test('状态是推导出来的，不额外存一份', () => {
    /* 存一份就要在每个改状态的地方记得更新它，迟早漏一处，
       而漏掉的表现是「界面说已同步、飞书里其实没有」—— 比不显示更糟。 */
    const cols = store.all('collaborations')[0] || {};
    assert.ok(!('syncState' in cols), '合作表里多了一个会和事实分叉的状态字段');
  });

  test('手动同步立刻推，不受退避约束', async () => {
    const before = fake.state.records.size;
    for (const l of store.all('sync_links')) store.remove('sync_links', l.id);
    /* 造一个「刚失败、正在退避」的局面：nextAt 设到很久以后 */
    sync.enqueue(cb.id);
    const row = store.findBy('outbox', 'entityId', cb.id)[0];
    store.put('outbox', { ...row, attempts: 3, nextAt: new Date(Date.now() + 3600_000).toISOString() });

    const idle = await sync.pump();          // 不带 force：应该什么都不做
    assert.equal(idle.done, 0, '退避期内不该自动推');
    await sync.syncOne(cb.id);
    assert.ok(fake.state.records.size >= before, '手动同步没有立刻推');
    assert.equal(sync.statesFor([cb.id], await db.getSettings()).get(cb.id).state, 'synced');
  });
});
