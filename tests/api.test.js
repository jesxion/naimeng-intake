/**
 * API 端到端回归 —— 起真服务，走 HTTP。
 *
 * 重点锁住：身份守卫、归属过滤与脱敏、状态由动作驱动、
 * 重复账号无法绕过、视频口令本地解析不调模型。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-api-'));
process.env.NAIMENG_DATA_DIR = DIR;
process.env.NODE_ENV = 'test';
// 清掉可能存在的 .env 影响，确保测试跑在「本地模拟识别」下
for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];

const { server } = await import('../server.js');
const { makeApi, bootstrap, loginAs } = await import('./helpers/login.js');

let BASE, api, PRE_STATE;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  api = makeApi(BASE);
  // 先记下初始化前的状态，再完成初始化 —— 后面所有用例都带着这个会话跑
  PRE_STATE = await api('GET', '/api/auth/state', null, '');
  const { me } = await bootstrap(BASE, { name: '商务甲', role: 'business' });
  const { cookie } = await loginAs(BASE, { userId: me.id });
  api.setCookie(cookie);
});
after(async () => {
  await new Promise((r) => server.close(r));
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ================================================================ */

describe('身份守卫', () => {
  test('没有会话时业务接口一律 401', async () => {
    for (const p of ['/api/config', '/api/jobs', '/api/collaborations', '/api/products']) {
      assert.equal((await api('GET', p, null, '')).status, 401, `${p} 没被拦住`);
    }
  });

  test('未初始化时提示需要设置团队口令', () => {
    assert.equal(PRE_STATE.needsBootstrap, true);
  });

  test('初始化后身份生效', async () => {
    const c = await api('GET', '/api/config');
    assert.equal(c.me.name, '商务甲');
  });

  test('口令不对进不来', async () => {
    const r = await api('POST', '/api/auth/login', { passphrase: '猜的' }, '');
    assert.equal(r.status, 401);
  });

  test('伪造的会话 cookie 无效', async () => {
    const forged = 'naimeng_session=eyJ1IjoidS0wMDAwMSIsImV4cCI6OTk5OTk5OTk5OTk5OX0.fakesig';
    assert.equal((await api('GET', '/api/config', null, forged)).status, 401);
  });

  test('旧的 X-User-Id 请求头已经不管用', async () => {
    const res = await fetch(BASE + '/api/config', { headers: { 'X-User-Id': 'u-00001' } });
    assert.equal(res.status, 401, '自报身份的老路子必须彻底堵死');
  });

  test('bootstrap 只能用一次', async () => {
    const r = await api('POST', '/api/auth/bootstrap',
      { passphrase: 'another-pass', name: '冒充者', role: 'business' }, '');
    assert.equal(r.status, 409);
  });

  test('角色非法被拒', async () => {
    assert.equal((await api('PUT', '/api/settings', { user: { name: 'x', role: '老板' } })).status, 400);
  });
});

describe('输入路由接口', () => {
  test('三类输入分别命中', async () => {
    const intake = await api('POST', '/api/route', { rawText: '抖音号：a1\nUID：4000000000000001\n合作码：30000000001' });
    assert.equal(intake.kind, 'intake');
    const video = await api('POST', '/api/route',
      { rawText: '0.58 复制打开抖音，看看【示例小戏精的作品】x https://v.douyin.com/EXAMPLE01/ :9pm' });
    assert.equal(video.kind, 'video');
    assert.equal((await api('POST', '/api/route', { hasImage: true })).kind, 'shipment');
  });
});

describe('录入合作全链路', () => {
  let creatorId, cbId, p1, p2, fulfillmentId;
  const NICK = '示例达人甲';

  before(async () => {
    p1 = (await api('POST', '/api/products', { name: '洁齿冻干', petCategory: '通用' })).product;
    p2 = (await api('POST', '/api/products', { name: '鲜肉猫粮', petCategory: '猫' })).product;
    await api('POST', '/api/products', { name: '冻干双拼犬粮', petCategory: '狗' });
  });

  test('提交寄样缺产品行被阻断', async () => {
    const r = await api('POST', '/api/collaborations', { form: {
      
      accounts: [{ nickname: NICK, douyinId: '100000001', uid: '20000000001' }],
      recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号' },
      items: [] } });
    assert.equal(r.status, 400);
    assert.match(r.error, /产品/);
  });

  test('新建达人 + 合作', async () => {
    const r = await api('POST', '/api/collaborations', { form: {
      name: NICK, sampleCost: '128.5',
      accounts: [{ nickname: NICK, douyinId: '100000001', uid: '20000000001', cooperationCode: '04000000001' }],
      recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号', deliveryNote: '放菜鸟驿站' },
      items: [{ productId: p1.id, quantity: 2 }, { productId: p2.id, quantity: 1 }] } });
    assert.equal(r.status, 200);
    assert.equal(r.collaboration.status, '待寄样');
    assert.equal(r.collaboration.items.length, 2);
    assert.equal(r.collaboration.sampleCost, 128.5);
    creatorId = r.creator.id;
    cbId = r.collaboration.id;
    fulfillmentId = r.collaboration.fulfillments[0].id;
  });

  test('合作码以字符串入库，前导零保留', async () => {
    const c = await api('GET', `/api/creators/${creatorId}`);
    const a = c.creator.accounts[0];
    assert.equal(a.cooperationCode, '04000000001');
    assert.equal(typeof a.cooperationCode, 'string');
  });

  test('重复账号返回 409，且没有强制创建入口', async () => {
    const r = await api('POST', '/api/collaborations', { form: {
      name: '冒充者', 
      accounts: [{ nickname: '冒充', douyinId: '100000001', uid: '20000000001' }],
      recipient: { name: '李', phone: '13800138009', address: '示例省示例市' },
      items: [{ productId: p1.id, quantity: 1 }] } });
    assert.equal(r.status, 409);
    assert.ok(r.conflicts?.length);
    assert.match(r.error, /发起新合作|补充账号/);
    // 旧版的 forceIgnoreConflict 已移除，传了也不生效
    const forced = await api('POST', '/api/collaborations', { forceIgnoreConflict: true, form: {
      name: '冒充者', 
      accounts: [{ nickname: '冒充', douyinId: '100000001', uid: '20000000001' }],
      recipient: { name: '李', phone: '13800138009', address: '示例省示例市' },
      items: [{ productId: p1.id, quantity: 1 }] } });
    assert.equal(forced.status, 409, '强制创建必须已被移除');
  });

  test('在已有达人上发起新合作（账号自动复用）', async () => {
    const r = await api('POST', '/api/collaborations', { creatorId, form: {
      
      accounts: [{ nickname: NICK, douyinId: '100000001', uid: '20000000001', cooperationCode: '04000000001' }],
      recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号' },
      items: [{ productId: p2.id, quantity: 3 }] } });
    assert.equal(r.status, 200);
    assert.equal(r.creator.accounts.length, 1, '不应重复插入同一账号');
    assert.equal(r.creator.collaborations.length, 2);
  });

  test('回填快递 → 已寄样；多包裹文案不错位', async () => {
    await api('POST', `/api/collaborations/${cbId}/packages`, { carrier: '申通', trackingNo: '773435035826894' });
    const r = await api('POST', `/api/collaborations/${cbId}/packages`, { carrier: '圆通', trackingNo: '773435035826882' });
    assert.equal(r.collaboration.status, '已寄样');
    assert.equal(r.collaboration.packages.length, 2);
    assert.match(r.notifyText, /申通 773435035826894\n圆通 773435035826882/);
  });

  test('待办：告知达人 → 标记后消失', async () => {
    let todos = (await api('GET', '/api/todos')).todos;
    assert.ok(todos.some((t) => t.type === 'notify_creator' && t.collaborationId === cbId));
    await api('POST', `/api/collaborations/${cbId}/notified`, { value: true });
    todos = (await api('GET', '/api/todos')).todos;
    assert.ok(!todos.some((t) => t.type === 'notify_creator' && t.collaborationId === cbId));
  });

  test('视频口令：本地解析、昵称匹配、0 延迟不调模型', async () => {
    const token = `0.58 复制打开抖音，看看【${NICK}的作品】新品测试 https://v.douyin.com/S7dLGV2C8Xg/ :9pm KWM:/ 01/13 z@T.Lw`;
    const r = await api('POST', '/api/video/parse', { rawText: token });
    assert.equal(r.mode, 'local');
    assert.equal(r.elapsedMs, 0);
    assert.equal(r.parsed.nickname, NICK);
    assert.ok(r.matches.length >= 1);

    const sub = await api('POST', '/api/video/submit', { shareToken: token, fulfillmentId });
    assert.equal(sub.fulfillment.shareToken, token, '口令必须逐字节保存');
    assert.ok(sub.fulfillment.shareToken.endsWith('z@T.Lw'));
    assert.equal(sub.fulfillment.filmingProgress, '已发布');
    assert.equal(sub.collaboration.status, '已完成', '唯一账号发布 → 合作完成');
  });

  test('昵称匹配不上时给出提示而非静默失败', async () => {
    const r = await api('POST', '/api/video/parse',
      { rawText: '看看【查无此人的作品】x https://v.douyin.com/ZZZ/' });
    assert.equal(r.matches.length, 0);
    assert.ok(r.warnings.some((w) => w.code === 'NICKNAME_UNMATCHED'));
  });

  test('状态：禁止手动置已寄样，允许置已终止', async () => {
    assert.equal((await api('POST', `/api/collaborations/${cbId}/status`, { status: '已寄样' })).status, 400);
    const r = await api('POST', `/api/collaborations/${cbId}/status`, { status: '已终止' });
    assert.equal(r.collaboration.status, '已终止');
  });

  test('已终止的合作不再产生待办', async () => {
    const todos = (await api('GET', '/api/todos')).todos;
    assert.ok(!todos.some((t) => t.collaborationId === cbId));
  });
});

describe('归属过滤与脱敏', () => {
  test('切换身份后只看到自己的达人，他人记录脱敏', async () => {
    const mineBefore = (await api('GET', '/api/creators')).creators.length;
    assert.ok(mineBefore >= 1);

    const yi = await loginAs(BASE, { name: '商务乙', role: 'business' });
    const mine = (await api('GET', '/api/creators', null, yi.cookie)).creators;
    assert.equal(mine.length, 0, '新身份下不该看到别人的达人');

    const all = (await api('GET', '/api/creators?scope=all', null, yi.cookie)).creators;
    assert.ok(all.length >= 1);
    const other = all.find((c) => c.masked);
    assert.ok(other, '他人记录应被标记 masked');
    assert.match(other.defaultRecipient.phone, /\*{4}/, '手机号应脱敏');
    assert.ok(other.defaultRecipient.address.endsWith('…'), '地址应截断');
  });

  test('查重跨商务生效 —— 否则「已归属其他商务」无法工作', async () => {
    const r = await api('POST', '/api/collaborations', { form: {
      name: '另一个人', 
      accounts: [{ nickname: 'x', douyinId: '100000001', uid: '20000000001' }],
      recipient: { name: '王', phone: '13800138088', address: '示例省示例市' },
      items: [{ productName: '临时产品', quantity: 1 }] } });
    assert.equal(r.status, 409);
    assert.equal(r.conflicts[0].existing.owner, '商务甲', '应带出原归属人');
  });
});

describe('归属转交', () => {
  test('转交后合作跟着达人一起转', async () => {
    const all = (await api('GET', '/api/creators?scope=all')).creators;
    const target = all[0];
    const users = (await api('GET', '/api/config')).users;
    const me = (await api('GET', '/api/config')).me;
    const r = await api('POST', `/api/creators/${target.id}/transfer`, { toUserId: me.id, reason: '人员调岗' });
    assert.equal(r.creator.ownerUserId, me.id);
    assert.equal(r.creator.ownerHistory.at(-1).reason, '人员调岗');
    assert.ok(users.length >= 2);
    const mine = (await api('GET', '/api/creators')).creators;
    assert.ok(mine.some((c) => c.id === target.id), '转交后应出现在我的列表里');
  });
});

/* ================================================================ */

describe('写操作自动留痕', () => {
  test('每个非 GET 请求都记一条，路由自己什么都不用做', async () => {
    /* 在请求处理外层记，不在各个路由里记 —— 指望每个路由都记得调一次，
       迟早漏掉新加的那个，而漏掉的表现是「这条记录谁改的查不到」，
       等要查的时候才发现没记。 */
    const before = (await api('GET', '/api/logs/ops?limit=1')).total;
    await api('POST', '/api/products', { name: '留痕测试产品' });
    const after = await api('GET', '/api/logs/ops?limit=5');
    assert.equal(after.total, before + 1, '写操作没留下日志');
    assert.equal(after.rows[0].action, 'POST /api/products');
    assert.ok(after.rows[0].userName, '没记下是谁做的');
  });

  test('GET 不记 —— 读操作记进去只会把有用的淹掉', async () => {
    const before = (await api('GET', '/api/logs/ops?limit=1')).total;
    await api('GET', '/api/products');
    await api('GET', '/api/collaborations');
    assert.equal((await api('GET', '/api/logs/ops?limit=1')).total, before);
  });

  test('失败的操作也记，标成 ok=false', async () => {
    /* 「谁试图删了别人的记录但被拦住了」和「谁删成功了」都值得留痕。
       只记成功的话，被拦住的尝试完全看不见。 */
    const r = await api('POST', '/api/collaborations/cb-99999/status', { status: '已终止' });
    assert.ok(r.status >= 400);
    const top = (await api('GET', '/api/logs/ops?limit=1&failed=1')).rows[0];
    assert.equal(top.ok, 0);
    assert.ok(top.status >= 400);
  });

  test('日志里按路由模板聚合，不是每个 id 一种动作', async () => {
    /* 记成 `POST /api/collaborations/cb-42/status` 的话，
       「改状态这个动作一共发生过几次」永远算不出来。 */
    const rows = (await api('GET', '/api/logs/ops?limit=50')).rows;
    assert.ok(rows.some((r) => r.action.includes(':id')), '路由参数没有被模板化');
    assert.ok(!rows.some((r) => /\/cb-\d+/.test(r.action)), 'action 里混进了具体 id');
  });

  test('日志不含请求体', async () => {
    /* 请求体里有达人真实姓名手机地址、API Key、团队口令。
       日志的价值是「谁动了哪条」，不是「改成了什么」。 */
    await api('POST', '/api/products', { name: '秘密产品13800138123' });
    const rows = (await api('GET', '/api/logs/ops?limit=10')).rows;
    const blob = JSON.stringify(rows);
    assert.ok(!blob.includes('秘密产品13800138123'), '请求体进日志了');
  });

  test('未登录看不到日志', async () => {
    assert.equal((await api('GET', '/api/logs/ops', null, '')).status, 401);
    assert.equal((await api('GET', '/api/logs/errors', null, '')).status, 401);
  });
});
