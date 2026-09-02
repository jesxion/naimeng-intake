/**
 * 飞书边栏插件（public/plugin.html）。
 *
 * 分两半：
 *
 * 上半是**行为**：查重信息真的能到插件手里吗。
 * 插件相对于「让商务直接在飞书表格里敲」的唯一不可替代之处就是**事前查重**。
 * 而这条链是 findConflicts → GET /api/jobs 的 summary.dupInDb → 界面横幅，
 * 中间任何一环断掉都**不报错**，只表现为「横幅不出现了」——
 * 和 salesChannel 那次静默丢失是完全相同的形态。所以要从外面把整条链走一遍。
 *
 * 下半是**静态断言**：插件是一个 HTML 文件，跑不起浏览器，
 * 但几处「错了不会报错、只会悄悄变味」的地方可以从源码上锁住。
 * 注意每一条都断言**条件本身**，不是「某个字符串在不在」——
 * 后者在这个项目里已经给过八次假绿了。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'naimeng-plugin-'));
process.env.NAIMENG_DATA_DIR = DIR;
process.env.NODE_ENV = 'test';
for (const k of ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete process.env[k];

const { server } = await import('../server.js');
const { makeApi, bootstrap, PASS } = await import('./helpers/login.js');

const HTML = readFileSync(new URL('../public/plugin.html', import.meta.url), 'utf8');

let BASE, api, cookie;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  api = makeApi(BASE);
  cookie = (await bootstrap(BASE, { name: '插件商务', role: 'business' })).cookie;
});
after(async () => {
  await new Promise((r) => server.close(r));
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ================================================================ 行为 */

describe('插件的查重链路：从库里一路走到插件能看见的字段', () => {
  const DOUYIN = '100000777';
  const NICK = '示例达人柒柒';

  before(async () => {
    const prod = (await api('POST', '/api/products', { name: '示例冻干' }, cookie)).product;
    const r = await api('POST', '/api/collaborations', {
      form: {
        name: NICK, sampleCost: '99',
        accounts: [{ nickname: NICK, douyinId: DOUYIN, uid: '20000000777' }],
        recipient: { name: '示例收件人', phone: '13800138077', address: '示例省示例市示范路 7 号' },
        items: [{ productId: prod.id, quantity: 1 }],
      },
    }, cookie);
    assert.equal(r.status, 200, '前置建档失败：' + r.error);
  });

  /** 把一段文本丢进识别队列，等它跑完，返回 GET /api/jobs 里的那一条 */
  async function runJob(rawText) {
    const { job } = await api('POST', '/api/jobs', { rawText }, cookie);
    for (let i = 0; i < 50; i++) {
      const hit = ((await api('GET', '/api/jobs', null, cookie)).jobs || [])
        .find((j) => j.id === job.id);
      if (hit && hit.status !== 'pending' && hit.status !== 'running') return hit;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('识别任务没跑完');
  }

  test('粘进一个已经建过档的抖音号，GET /api/jobs 就带回 dupInDb', async () => {
    /* 这是插件那条红色横幅的**唯一数据来源**。它不见了，
       横幅就静默消失，而插件看上去一切正常 —— 只是不再拦人了。 */
    const j = await runJob(`昵称：${NICK}\n抖音号：${DOUYIN}\n收件人：示例收件人 13800138077\n地址：示例省示例市示范路 7 号`);
    assert.equal(j.status, 'done', '识别没成功：' + (j.error || ''));
    const dup = j.summary?.dupInDb;
    assert.ok(dup, 'summary 里没有 dupInDb —— 插件的查重横幅会静默消失');
    assert.equal(dup.creatorName, NICK);
    assert.equal(dup.owner, '插件商务', '没带出归属人 —— 横幅就只能说「重复了」，说不出找谁');
    assert.ok(dup.collaborationCount >= 1, '没带出合作次数');
  });

  test('没建过档的号不会误报重复', async () => {
    /* 只测「重复的能报出来」不够：一个恒返回 dupInDb 的实现也能过。 */
    const j = await runJob('昵称：从来没见过的人\n抖音号：100000888');
    assert.equal(j.status, 'done');
    assert.ok(!j.summary?.dupInDb, '把没重复的也报成重复了');
  });

  test('就算插件不拦，服务端也会拒 —— 查重不是只靠界面', async () => {
    /* 界面上的横幅是**提示**，不是防线。插件被绕过（旧版本、
       手改 DOM、将来别的客户端）时，重复建档必须还是进不去。 */
    const r = await api('POST', '/api/collaborations', {
      form: {
        /* 用不寄样合作，这样表单校验（收件人/产品必填）先过得去，
           才能真正走到查重那一步。否则 400 就返回了，
           这条用例看着是绿的，验的却是另一件事。 */
        name: '想重复建档', type: '不寄样合作',
        accounts: [{ nickname: 'x', douyinId: DOUYIN }],
        recipient: {}, items: [],
      },
    }, cookie);
    assert.equal(r.status, 409);
    assert.match(r.error, /已属于/);
  });
});

/* ================================================================ 静态 */

describe('插件源码里几处「错了不会报错」的地方', () => {
  test('查重命中时提交按钮是禁用的', () => {
    /* 断言的是**条件**。只搜 "disabled" 在不在的话，
       把条件改成 `S.busy` 也照样绿 —— 那正是横幅还在、
       但按钮能点下去的样子。 */
    const m = HTML.match(/提交建档[\s\S]{0,80}?|<button class="primary" onclick="submit\(\)"([^>]*)>/);
    assert.ok(/\$\{\s*S\.busy\s*\|\|\s*S\.dup\s*\?\s*'disabled'/.test(HTML),
      '提交按钮的禁用条件里没有 S.dup —— 查重横幅会显示，但按钮照样能点');
  });

  test('不寄样时把产品清空，而不是留着上一次选的', () => {
    assert.ok(/else\s*\{[\s\S]{0,400}?f\.items\s*=\s*\[\]/.test(HTML),
      '不寄样分支没有清空 items —— 会提交出一条「不寄样但带着产品」的合作');
  });

  test('收件字段在 DOM 里只有一份', () => {
    /* 不寄样时那一块是 display:none，字段还在。
       如果再补一份隐藏字段，就会有重复 id，而 querySelector 只返回第一个 ——
       submit() 读到的可能是另一份，现象是「明明填了却提交成空的」。 */
    for (const id of ['f-rname', 'f-rphone', 'f-raddr', 'f-prod', 'f-qty', 'f-cost']) {
      const n = HTML.split(`id="${id}"`).length - 1;
      assert.equal(n, 1, `${id} 在源码里出现了 ${n} 次，重复 id 会让 submit() 读错元素`);
    }
  });

  test('401 会清掉令牌并回登录页', () => {
    /* 令牌 90 天后过期。不清的话商务看到的是一连串「请先登录」，
       而页面还停在录入界面上，没人猜得到要重登。 */
    assert.ok(/res\.status === 401[\s\S]{0,200}store\.clear\(\)/.test(HTML),
      '401 之后没有清令牌');
    assert.ok(/res\.status === 401[\s\S]{0,220}S\.view = 'login'/.test(HTML),
      '401 之后没有回登录页');
  });

  test('localStorage 的每一处都包了 try', () => {
    /* 第三方 iframe 里它可能直接抛（用户屏蔽第三方 cookie）。
       裸调一次就是一个白屏。 */
    const bare = HTML.split('\n').filter((l) =>
      /localStorage\./.test(l) && !/try\s*\{/.test(l));
    assert.equal(bare.length, 0,
      '这些行裸调了 localStorage：\n' + bare.join('\n'));
  });

  test('启动时校验的是「认没认出人」，不是「请求成没成功」', () => {
    /* /api/ping 匿名可访问，200 不代表令牌有效。
       只看 res.ok 的话，一个废令牌会一路放行到第一次提交才报错。 */
    assert.ok(/if \(!r\.you\) throw/.test(HTML),
      'boot 没有检查 ping 返回里的 you —— 废令牌会被当成有效');
  });

  test('轮询有次数上限', () => {
    /* 模型不通时任务会一直 pending。没上限的话页面转到天荒地老，
       而商务只会觉得「这东西卡死了」。 */
    assert.ok(/function poll\(jobId, tries = \d+\)/.test(HTML), 'poll 没有次数上限');
    assert.ok(/识别超时/.test(HTML), '超时之后没有给出下一步该干什么');
  });

  test('转义函数把五个字符都转了', () => {
    /* 和 app.js 里那份保持一致。少转单引号是「下一个人写
       attr='${esc(x)}' 时才炸」的坑，而炸的时候没人会想到是这里。 */
    const src = HTML.match(/const esc = \(s\) => [\s\S]*?;\n/)[0];
    const esc = new Function(`${src} return esc;`)();
    assert.equal(esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  });
});
