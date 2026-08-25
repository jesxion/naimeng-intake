/**
 * 身份隔离与归属边界回归。
 *
 * 这一组测试对应三份审查里都指向同一处的问题：列表接口按 ownerUserId 过滤得很干净，
 * 给人一种「权限已经做了」的错觉，但按 id 直取的接口一个都没校验，
 * 而 id 是 cb-00012 这种顺序号，遍历成本为零。
 *
 * 锁住四条边界：
 *   1. 身份来自服务端签发的会话 cookie，前端伪造不了，也不回落到任何人
 *   2. 识别任务和草稿是私人工作区，别人读不到也删不掉
 *   3. 合作和达人全员可读（记录页的「全部」就是这么用的），但只有归属人能改
 *   4. 视频匹配不跨归属，否则甲的口令会写进乙的合作
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-authz-'));
process.env.NAIMENG_DATA_DIR = DIR;
process.env.NODE_ENV = 'test';
for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];

const { server } = await import('../server.js');
const { makeApi, bootstrap, loginAs } = await import('./helpers/login.js');

let BASE, api, JIA, YI, prod;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  api = makeApi(BASE);

  /* 每个人一个真实会话。身份已经是服务端签发的了，
     测试不能再靠塞请求头来「扮演」某个人 —— 那样就绕开了要验证的东西本身。 */
  const boot = await bootstrap(BASE, { name: '商务甲', role: 'business' });
  JIA = boot.cookie;
  YI = (await loginAs(BASE, { name: '商务乙', role: 'business' })).cookie;
  prod = (await api('POST', '/api/products', { name: '洁齿冻干' }, JIA)).product;
});
after(async () => {
  await new Promise((r) => server.close(r));
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ================================================================ */

describe('身份由服务端签发的会话决定', () => {
  test('甲的会话返回甲', async () => {
    assert.equal((await api('GET', '/api/config', null, JIA)).me.name, '商务甲');
  });

  test('乙的会话返回乙', async () => {
    assert.equal((await api('GET', '/api/config', null, YI)).me.name, '商务乙');
  });

  test('两人身份互不影响 —— 交叉请求各归各的', async () => {
    const [a, b] = await Promise.all([
      api('GET', '/api/config', null, JIA),
      api('GET', '/api/config', null, YI),
    ]);
    assert.notEqual(a.me.id, b.me.id);
    assert.equal(a.me.name, '商务甲');
    assert.equal(b.me.name, '商务乙');
  });

  test('没有会话就是匿名，不回落到任何人', async () => {
    /* 改造前这里会回落到全局 settings.user —— 意味着任何未登录请求
       都自动获得「最后一个保存身份的人」的权限。局域网上线后这是致命的。 */
    assert.equal((await api('GET', '/api/config', null, '')).status, 401);
  });

  test('伪造签名的会话无效', async () => {
    const forged = 'naimeng_session=eyJ1IjoidS0wMDAwMSIsImV4cCI6OTk5OTk5OTk5OTk5OX0.fake';
    assert.equal((await api('GET', '/api/config', null, forged)).status, 401);
  });

  test('拿别人的 userId 塞进请求头没有用', async () => {
    const res = await fetch(BASE + '/api/config', { headers: { 'X-User-Id': 'u-00001' } });
    assert.equal(res.status, 401);
  });
});

/* ================================================================ */

describe('私人工作区：识别任务与草稿', () => {
  let jobId, draftId;

  before(async () => {
    jobId = (await api('POST', '/api/jobs', { rawText: '账号名称：私密达人\n账号id：100000009' }, JIA)).job.id;
    draftId = (await api('POST', '/api/drafts', { rawText: '甲的草稿', form: {} }, JIA)).draft.id;
  });

  test('乙读不到甲的识别任务', async () => {
    const r = await api('GET', '/api/jobs/' + jobId, null, YI);
    assert.equal(r.status, 404, '越权读应该 404，且不能暴露 id 是否存在');
  });

  test('乙删不掉甲的识别任务', async () => {
    const r = await api('DELETE', '/api/jobs/' + jobId, null, YI);
    assert.equal(r.status, 404);
    assert.ok((await api('GET', '/api/jobs/' + jobId, null, JIA)).job, '甲的任务应该还在');
  });

  test('乙重试不了甲的识别任务', async () => {
    assert.equal((await api('POST', `/api/jobs/${jobId}/retry`, {}, YI)).status, 404);
  });

  test('乙读不到甲的草稿', async () => {
    assert.equal((await api('GET', '/api/drafts/' + draftId, null, YI)).status, 404);
  });

  test('乙删不掉甲的草稿', async () => {
    assert.equal((await api('DELETE', '/api/drafts/' + draftId, null, YI)).status, 404);
  });

  test('甲自己读写都正常', async () => {
    assert.equal((await api('GET', '/api/jobs/' + jobId, null, JIA)).status, 200);
    assert.equal((await api('GET', '/api/drafts/' + draftId, null, JIA)).status, 200);
  });
});

/* ================================================================ */

describe('共享业务数据：全员可读，归属人可改', () => {
  let cbId, creatorId, fulfillmentId;

  before(async () => {
    const r = await api('POST', '/api/collaborations', { form: {
      accounts: [{ nickname: '甲的达人', douyinId: '100000010', uid: '20000000010' }],
      recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号' },
      items: [{ productId: prod.id, productName: prod.name, quantity: 1 }],
    } }, JIA);
    cbId = r.collaboration.id;
    creatorId = r.collaboration.creatorId;
    fulfillmentId = r.collaboration.fulfillments[0].id;
  });

  test('乙能读到甲的合作 —— 这是设计意图，记录页有「全部」', async () => {
    const r = await api('GET', '/api/collaborations/' + cbId, null, YI);
    assert.equal(r.status, 200);
  });

  test('乙改不了甲的合作状态', async () => {
    const r = await api('POST', `/api/collaborations/${cbId}/status`, { status: '已终止' }, YI);
    assert.equal(r.status, 403);
    assert.match(r.error, /商务甲/, '要说清归属人是谁，不然商务不知道找谁');
  });

  test('乙标记不了甲的合作为已告知', async () => {
    assert.equal((await api('POST', `/api/collaborations/${cbId}/notified`, {}, YI)).status, 403);
  });

  test('乙改不了甲的履约项', async () => {
    assert.equal((await api('POST', '/api/fulfillments/' + fulfillmentId,
      { filmingProgress: '已发布' }, YI)).status, 403);
  });

  test('乙改不了甲的达人档案，也加不了账号', async () => {
    assert.equal((await api('PATCH', '/api/creators/' + creatorId, { note: 'x' }, YI)).status, 403);
    assert.equal((await api('POST', `/api/creators/${creatorId}/accounts`,
      { accounts: [{ nickname: '偷加的号' }] }, YI)).status, 403);
  });

  test('但仓库回填快递单不看归属 —— 卡了就把仓库挡在外面了', async () => {
    const wh = (await loginAs(BASE, { name: '仓库专员', role: 'warehouse' })).cookie;
    const r = await api('POST', `/api/collaborations/${cbId}/packages`,
      { carrier: '申通', trackingNo: '773000000000001' }, wh);
    assert.equal(r.status, 200);
    assert.equal(r.collaboration.packages.length, 1);
  });

  test('甲自己改自己的合作正常', async () => {
    assert.equal((await api('POST', `/api/collaborations/${cbId}/notified`, {}, JIA)).status, 200);
  });

  test('归属人离职的兜底：别人可以把达人接到自己名下', async () => {
    const yiId = (await api('GET', '/api/config', null, YI)).me.id;
    const r = await api('POST', `/api/creators/${creatorId}/transfer`, { toUserId: yiId, reason: '甲离职' }, YI);
    assert.equal(r.status, 200);
    assert.equal(r.creator.ownerUserId, yiId);
    assert.equal(r.creator.ownerHistory.at(-1).reason, '甲离职', '谁接的、为什么接必须留痕');
  });

  test('但不能替别人转给第三个人', async () => {
    const bing = (await loginAs(BASE, { name: '商务丙', role: 'business' })).me.id;
    // 此刻达人归乙，甲想把它转给丙 —— 这是纯粹的越权，两种合法情形都不沾
    const r = await api('POST', `/api/creators/${creatorId}/transfer`, { toUserId: bing, reason: '乱转' }, JIA);
    assert.equal(r.status, 403);
  });
});

/* ================================================================ */

describe('视频匹配不跨归属', () => {
  const NICK = '同名达人';
  let jiaFid;

  before(async () => {
    // 甲和乙各自建一个昵称完全相同的账号，模拟两人撞号
    const a = await api('POST', '/api/collaborations', { form: {
      accounts: [{ nickname: NICK, douyinId: '100000021', uid: '20000000021' }],
      recipient: { name: '张某某', phone: '13800138000', address: '示例省示例市示范路1号' },
      items: [{ productId: prod.id, productName: prod.name, quantity: 1 }],
    } }, JIA);
    jiaFid = a.collaboration.fulfillments[0].id;

    await api('POST', '/api/collaborations', { form: {
      accounts: [{ nickname: NICK, douyinId: '100000022', uid: '20000000022' }],
      recipient: { name: '李某某', phone: '13800138001', address: '示例省示例市示范路2号' },
      items: [{ productId: prod.id, productName: prod.name, quantity: 1 }],
    } }, YI);
  });

  test('甲粘口令只匹配到自己的那条，不会撞上乙的', async () => {
    const r = await api('POST', '/api/video/parse', {
      rawText: `看看这个视频 https://v.douyin.com/ABCDE123/ 【${NICK}的作品】`,
    }, JIA);
    const ids = (r.matches || []).map((m) => m.fulfillmentId);
    assert.ok(ids.includes(jiaFid), '应该匹配到甲自己的');
    assert.equal(ids.length, 1, `跨归属匹配了 ${ids.length} 条，甲的口令会写进乙的合作`);
  });
});

/* ================================================================ */

describe('裸链接可以手动搜索并选择', () => {
  test('搜索接口按抖音号命中，形状和自动匹配一致', async () => {
    const r = await api('GET', '/api/fulfillments/search?q=100000021', null, JIA);
    assert.equal(r.status, 200);
    assert.equal(r.matches.length, 1);
    const m = r.matches[0];
    // 这几个字段是确认页卡片直接读的，缺一个前端就渲染不出来
    for (const k of ['fulfillmentId', 'alreadyHasVideo', 'filmingProgress', 'account', 'collaboration']) {
      assert.ok(k in m, `搜索结果缺字段 ${k}，前端卡片会渲染不出来`);
    }
    assert.ok(m.collaboration.items && m.collaboration.recipient, '要够商务判断这是不是那一条');
  });

  test('合作码和 UID 也能搜 —— 达人改名时只剩这些是稳定的', async () => {
    assert.equal((await api('GET', '/api/fulfillments/search?q=20000000021', null, JIA)).matches.length, 1);
  });

  test('搜索不跨归属', async () => {
    const r = await api('GET', '/api/fulfillments/search?q=100000022', null, JIA);
    assert.equal(r.matches.length, 0, '甲不该搜到乙的合作');
  });

  test('空关键词返回空，不返回全表', async () => {
    assert.equal((await api('GET', '/api/fulfillments/search?q=', null, JIA)).matches.length, 0);
  });

  test('裸链接走 route 时给出可操作的提示', async () => {
    const r = await api('POST', '/api/video/parse', { rawText: 'https://v.douyin.com/ABCDE123/' }, JIA);
    const w = (r.warnings || []).find((x) => x.code === 'NO_NICKNAME');
    assert.ok(w, '裸链接应该提示没有昵称');
    assert.match(w.detail, /搜/, '提示必须告诉商务可以搜，而不是干说「请手动选择」');
  });
});

/* ================================================================ */

describe('花钱和改配置的接口要有身份', () => {
  test('带会话能改模型配置', async () => {
    assert.equal((await api('PUT', '/api/settings', { model: { provider: 'X' } }, JIA)).status, 200);
  });

  test('没有会话时改不了模型配置，也烧不了 token', async () => {
    assert.equal((await api('PUT', '/api/settings', { model: { provider: 'X' } }, '')).status, 401);
    assert.equal((await api('POST', '/api/extract', { rawText: 'x' }, '')).status, 401);
  });
});

/* ================================================================ */

describe('我的资料只能改自己', () => {
  test('甲改资料不会动到乙 —— 哪怕请求体里指定了乙的 id', async () => {
    /* 上一版的做法是按**姓名**去 users 表匹配，而表单里显示的是
       全局最后保存的那个人 —— 于是甲一点保存就改到了乙的记录。
       现在改谁只由会话决定，请求体里的 id 一律不看。 */
    const a = await loginAs(BASE, { name: '资料甲', role: 'business' });
    const b = await loginAs(BASE, { name: '资料乙', role: 'warehouse' });

    const r = await api('PUT', '/api/settings',
      { user: { id: b.me.id, name: '资料甲', role: 'business', phone: '13800138077' } }, a.cookie);
    assert.equal(r.status, 200);
    assert.equal(r.settings.user.id, a.me.id, '改到了别人头上');

    const cfgB = await api('GET', '/api/config', null, b.cookie);
    assert.equal(cfgB.me.name, '资料乙', '乙的姓名被改了');
    assert.equal(cfgB.me.role, 'warehouse', '乙的角色被改了');
    assert.equal(cfgB.settings.user.phone || '', '', '乙的电话被写进去了');
  });

  test('每个人看到的「我的资料」是自己的', async () => {
    const a = await loginAs(BASE, { name: '资料甲' });
    const b = await loginAs(BASE, { name: '资料乙' });
    assert.equal((await api('GET', '/api/config', null, a.cookie)).settings.user.name, '资料甲');
    assert.equal((await api('GET', '/api/config', null, b.cookie)).settings.user.name, '资料乙');
  });

  test('未登录不能改任何人的资料', async () => {
    /* 拦住它的是全局守卫（/api/settings 不在 OPEN_ROUTES 里），
       路由里那句 requireUser 是第二层 —— 变异验证过：单独去掉它这条仍然绿，
       因为外层已经拦住了。两层都留着，是因为将来万一有人把这条路由
       加进 OPEN_ROUTES，里层还能兜住。
       以前「只改 user 的不拦」是真的放行过，那时设置页兼着首次建身份；
       现在那件事归 /api/auth/bootstrap。 */
    const r = await api('PUT', '/api/settings', { user: { name: '闯入者', role: 'business' } }, '');
    assert.equal(r.status, 401);
  });

  test('改成别人的名字会被拒 —— 重名会让登录时的名单分不清谁是谁', async () => {
    const a = await loginAs(BASE, { name: '资料甲' });
    const r = await api('PUT', '/api/settings', { user: { name: '资料乙', role: 'business' } }, a.cookie);
    assert.equal(r.status, 400);
    assert.match(r.error || '', /已经有一位/);
  });
});

/* ================================================================ */

describe('删除合作的权限', () => {
  test('别人的合作删不掉', async () => {
    const a = await loginAs(BASE, { name: '删除甲' });
    const b = await loginAs(BASE, { name: '删除乙' });

    const made = await api('POST', '/api/collaborations', {
      action: 'createRecord',
      form: { name: '归甲的达人', accounts: [{ nickname: '归甲的达人', douyinId: '100000081' }], recipient: {} },
    }, a.cookie);
    assert.equal(made.status, 200, JSON.stringify(made));
    const id = made.collaboration.id;

    const denied = await api('DELETE', `/api/collaborations/${id}`, null, b.cookie);
    assert.equal(denied.status, 403);
    assert.ok((await api('GET', `/api/collaborations/${id}`, null, a.cookie)).collaboration,
      '被拒了却还是删掉了');

    const ok = await api('DELETE', `/api/collaborations/${id}`, null, a.cookie);
    assert.equal(ok.status, 200);
    assert.equal((await api('GET', `/api/collaborations/${id}`, null, a.cookie)).status, 404);
  });

  test('未登录删不掉', async () => {
    assert.equal((await api('DELETE', '/api/collaborations/cb-00001', null, '')).status, 401);
  });

  test('删不存在的返回 404 而不是 500', async () => {
    const a = await loginAs(BASE, { name: '删除甲' });
    assert.equal((await api('DELETE', '/api/collaborations/cb-99999', null, a.cookie)).status, 404);
  });
});

/* ================================================================ */

describe('原始识别记录也要拦归属', () => {
  test('别人的合作看不到原文', async () => {
    /* 原文里有达人的真实姓名、手机号、地址 —— 是这个系统里最敏感的一段。
       其他按 id 直取的接口都拦了归属，这一条不能例外。 */
    const a = await loginAs(BASE, { name: '原文甲' });
    const b = await loginAs(BASE, { name: '原文乙' });
    const made = await api('POST', '/api/collaborations', {
      action: 'createRecord',
      form: { name: '原文测试达人', accounts: [{ nickname: '原文测试达人', douyinId: '100000091' }], recipient: {} },
    }, a.cookie);
    assert.equal(made.status, 200, JSON.stringify(made));
    const id = made.collaboration.id;

    assert.equal((await api('GET', `/api/collaborations/${id}/logs`, null, b.cookie)).status, 403);
    assert.equal((await api('GET', `/api/collaborations/${id}/logs`, null, a.cookie)).status, 200);
    assert.equal((await api('GET', `/api/collaborations/${id}/logs`, null, '')).status, 401);
  });

  test('合作不存在时是 404，不是空数组', async () => {
    const a = await loginAs(BASE, { name: '原文甲' });
    assert.equal((await api('GET', '/api/collaborations/cb-99999/logs', null, a.cookie)).status, 404);
  });
});
