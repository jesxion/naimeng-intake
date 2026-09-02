/* 探针第 1 步的判据。
   它改过两次，两次都是「用不可靠的信号下硬结论」：

   - 第一版：「你能看到这个页面就算过」  → 普通浏览器里也成立，**假通过**
   - 第二版：要求 bitable SDK 注入或 UA 含飞书 → SDK 是 npm 包容器不注入、
     UA 只有飞书客户端才带，于是在**真的插件容器里判了假失败**

   两次都是靠人肉跑一遍才发现的。所以把判据本身从页面里抠出来直接跑，
   让四种环境各有一条用例守着 —— 页面里的逻辑没法用浏览器测，
   但它是纯函数，抠出来就能测。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/probe.html', import.meta.url), 'utf8');

/* 直接执行页面里的那份源码，而不是在测试里重写一遍。
   重写一遍的话，改了页面没改测试，测试照样绿。 */
const src = (() => {
  const a = html.indexOf('function containerEvidence()');
  const b = html.indexOf('const STEPS', a);
  assert.ok(a > 0 && b > a, 'probe.html 里找不到 containerEvidence —— 判据被挪走或改名了');
  return html.slice(a, b);
})();

const run = (env) => new Function('window', 'location', 'document', 'navigator',
  `${src}\nreturn containerEvidence();`)(
  { self: env.self, top: env.top, bitable: env.bitable },
  { origin: 'http://192.168.1.18:5173', ancestorOrigins: env.ancestorOrigins || [] },
  { referrer: env.referrer || '' },
  { userAgent: env.userAgent || 'Mozilla/5.0 (Macintosh) Chrome/120' },
);

const TOP = {}; // 顶层窗口：self === top
const FRAME = { self: {}, top: {} };

test('探针判据', async (t) => {
  await t.test('普通浏览器里直接打开 → 判「不是」', () => {
    const e = run({ self: TOP, top: TOP });
    assert.equal(e.verdict, 'no');
  });

  await t.test('飞书客户端里的插件（UA 带 Lark，无 SDK）→ 判「是」', () => {
    const e = run({ ...FRAME, userAgent: 'Mozilla/5.0 Lark/7.0 Electron' });
    assert.equal(e.verdict, 'yes');
  });

  /* 这条就是第二版误判的那个环境：浏览器里开飞书网页版，
     UA 是普通 Chrome，SDK 没引，唯一的痕迹在父级源上。 */
  await t.test('浏览器里的飞书网页版插件（只有父级源指向飞书）→ 判「是」，不是「不是」', () => {
    const e = run({ ...FRAME, ancestorOrigins: ['https://feishu.cn'] });
    assert.equal(e.verdict, 'yes');
  });

  await t.test('referrer 指向飞书也算数', () => {
    const e = run({ ...FRAME, referrer: 'https://example.feishu.cn/base/BZHJbRYP9a' });
    assert.equal(e.verdict, 'yes');
  });

  /* 拿不到任何痕迹时必须是「说不准」。
     判成 'no' 就回到第二版的假失败；判成 'yes' 就回到第一版的假通过。
     这一格的正确答案是**不下结论**。 */
  await t.test('在 iframe 里但毫无飞书痕迹 → 判「说不准」，既不判是也不判不是', () => {
    const e = run(FRAME);
    assert.equal(e.verdict, 'unsure');
  });

  await t.test('SDK 缺失本身不构成否定证据', () => {
    const withSdk = run({ ...FRAME, bitable: {}, ancestorOrigins: ['https://feishu.cn'] });
    const noSdk = run({ ...FRAME, ancestorOrigins: ['https://feishu.cn'] });
    assert.equal(withSdk.verdict, noSdk.verdict,
      '有没有引 SDK 不应该改变判定 —— 容器不会注入它，引不引是页面自己的事');
  });
});
