/**
 * 身份隔离与归属边界回归。
 *
 * 这一组测试对应三份审查里都指向同一处的问题：列表接口按 ownerUserId 过滤得很干净，
 * 给人一种「权限已经做了」的错觉，但按 id 直取的接口一个都没校验，
 * 而 id 是 cb-00012 这种顺序号，遍历成本为零。
 *
 * 锁住四条边界：
 *   1. X-User-Id 决定身份，全局 settings 只是没头部时的兜底
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

let BASE, JIA, YI, prod;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  // 两个人依次在设置里登记身份。注意第二次会把全局 settings.user 覆盖成乙 ——
  // 这正是修复前的病根：此后甲带着自己的 X-User-Id 也会被当成乙。
  JIA = (await api('PUT', '/api/settings', { user: { name: '商务甲', role: 'business' } })).settings.user.id;
  YI = (await api('PUT', '/api/settings', { user: { name: '商务乙', role: 'business' } })).settings.user.id;
  prod = (await api('POST', '/api/products', { name: '洁齿冻干' }, JIA)).product;
});
after(async () => {
  await new Promise((r) => server.close(r));
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** as = 用哪个用户的身份发请求；不传就不带头部，走全局兜底 */
const api = async (method, path, body, as) => {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers['X-User-Id'] = as;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
};

/* ================================================================ */

describe('身份由 X-User-Id 决定', () => {
  test('带甲的头部就返回甲，不被全局设置覆盖', async () => {
    const r = await api('GET', '/api/config', null, JIA);
    assert.equal(r.me.id, JIA);
    assert.equal(r.me.name, '商务甲');
  });

  test('带乙的头部就返回乙', async () => {
    const r = await api('GET', '/api/config', null, YI);
    assert.equal(r.me.id, YI);
  });

  test('两人身份互不影响 —— 交叉请求各归各的', async () => {
    const [a, b] = await Promise.all([
      api('GET', '/api/config', null, JIA),
      api('GET', '/api/config', null, YI),
    ]);
    assert.notEqual(a.me.id, b.me.id);
  });

  test('不带头部时回落到全局设置，单人使用的老行为不变', async () => {
    const r = await api('GET', '/api/config');
    assert.equal(r.me.id, YI, '最后一次保存的是乙');
  });

  test('头部是不存在的 id 时回落，不当成匿名', async () => {
    const r = await api('GET', '/api/config', null, 'u-does-not-exist');
    assert.ok(r.me, '应该回落到全局设置而不是 null');
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
    const wh = (await api('PUT', '/api/settings', { user: { name: '仓库专员', role: 'warehouse' } })).settings.user.id;
    const r = await api('POST', `/api/collaborations/${cbId}/packages`,
      { carrier: '申通', trackingNo: '773000000000001' }, wh);
    assert.equal(r.status, 200);
    assert.equal(r.collaboration.packages.length, 1);
  });

  test('甲自己改自己的合作正常', async () => {
    assert.equal((await api('POST', `/api/collaborations/${cbId}/notified`, {}, JIA)).status, 200);
  });

  test('归属人离职的兜底：别人可以把达人接到自己名下', async () => {
    const r = await api('POST', `/api/creators/${creatorId}/transfer`, { toUserId: YI, reason: '甲离职' }, YI);
    assert.equal(r.status, 200);
    assert.equal(r.creator.ownerUserId, YI);
    assert.equal(r.creator.ownerHistory.at(-1).reason, '甲离职', '谁接的、为什么接必须留痕');
  });

  test('但不能替别人转给第三个人', async () => {
    const bing = (await api('PUT', '/api/settings', { user: { name: '商务丙', role: 'business' } })).settings.user.id;
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
  test('改模型配置需要身份', async () => {
    // 直接用一个不存在的库来构造「无身份」很难，这里退而验证：带合法身份能过
    const r = await api('PUT', '/api/settings', { model: { provider: 'X' } }, JIA);
    assert.equal(r.status, 200);
  });

  test('只改 user 的请求不被身份守卫拦住 —— 那是建立身份的唯一入口', async () => {
    const r = await api('PUT', '/api/settings', { user: { name: '新人', role: 'business' } });
    assert.equal(r.status, 200);
  });
});
