/**
 * 前端不变量。
 *
 * 这些约束活在浏览器里，零依赖又不想引 jsdom，所以退一步：对源码本身做断言。
 * 覆盖不了渲染效果，但能挡住「改着改着又退回去」——
 * 下面每一条都对应一个真实发生过、并且被误诊过的 bug，或一条明确的设计决策。
 *
 * 前端已按《前端重构设计稿 v1》重排：两个入口、一个确认容器、取消完成页。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'public/app.js'), 'utf8');

/* 只看 <style> 里的内容，避免注释和正文里的字样干扰 */
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]
  .replace(/\/\*[\s\S]*?\*\//g, '');

const fn = (name) => {
  const m = app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n}`));
  assert.ok(m, `源码里找不到函数 ${name}`);
  return m[0];
};

/* ================================================================ */

describe('信息架构：两个入口，一个确认容器', () => {
  test('顶部只有工作台和合作记录两个 tab', () => {
    const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, ['desk', 'records'],
      '「我的待办」应并入工作台的需要处理，不再是独立 tab');
  });

  test('只有一个抽屉容器，建档 / 视频 / 快递单 / 详情共用', () => {
    assert.equal((html.match(/id="drawer"/g) || []).length, 1);
    for (const f of ['openIntakeDrawer', 'openVideoDrawer', 'openShipment', 'openCollaboration']) {
      assert.match(fn(f), /openDrawer\(/, `${f} 没有走统一容器，会退回三种布局各学一遍`);
    }
  });

  test('抽屉右栏恒为证据 —— 商务只要学一次「往右看」', () => {
    for (const f of ['openIntakeDrawer', 'openVideoDrawer', 'openShipment']) {
      assert.match(fn(f), /#drRight/, `${f} 没有填充右栏`);
    }
  });

  test('取消完成页，改用 toast', () => {
    assert.ok(!/donepane|id="s3"/.test(html), '完成页应已移除');
    assert.match(fn('submitCollaboration'), /closeDrawer\(\);[\s\S]{0,200}toast\(/,
      '提交后应关抽屉 + toast，而不是跳一个打断节奏的完成页');
    assert.match(fn('submitVideo'), /closeDrawer\(\);[\s\S]{0,200}toast\(/);
  });
});

/* ================================================================ */

describe('CSS 类名不撞车', () => {
  test('不存在裸 .done 选择器 —— 它会把 padding 污染到状态胶囊上', () => {
    // 曾经的 .done{padding:44px}（完成页）和 .st.done（胶囊）同特异性，
    // 后者被污染成 22px 高、左右各撑 44px 的绿色椭圆。完成页没了，但这条守卫要留着。
    const bare = css.match(/(^|[\s,}])\.done\s*[{,\s]/g) || [];
    assert.deepEqual(bare, [], '状态胶囊的绿色变体请写 .st.done，不要定义裸 .done');
  });

  test('状态胶囊的绿色变体还在', () => {
    assert.match(css, /\.st\.done\s*\{/);
  });
});

/* ================================================================ */

describe('选填字段不算缺失', () => {
  test('配送备注声明为 optional', () => {
    const call = app.match(/fld\('配送备注'[\s\S]{0,220}?\)\)/);
    assert.ok(call, '没找到配送备注字段');
    assert.match(call[0], /optional:\s*true/,
      'placeholder 写着「无则留空」，就不能又把它算进待补充');
  });

  test('fld 对 optional 字段不挂「待补充」标签', () => {
    assert.match(app, /if \(!has && !opt\.optional\) lab\.append/);
  });

  test('recount 跳过空的 optional 字段', () => {
    assert.match(fn('recount'), /f\.dataset\.optional === '1'/);
  });

  test('Alt+N 只在 miss / chk 之间跳，且限定在抽屉内', () => {
    const j = fn('jumpNext');
    assert.match(j, /\.f\.miss input, #drLeft \.f\.chk input/);
    assert.ok(!/\$\$\('#drLeft \.f input'\)/.test(j), '不能退化成选中所有字段');
  });

  test('recount 与 jumpNext 都作用于抽屉，不会误伤页面上其他表单', () => {
    for (const f of ['recount', 'jumpNext']) {
      assert.match(fn(f), /#drLeft/, `${f} 没有限定作用域`);
    }
  });
});

/* ================================================================ */

describe('裸链接不能再变成死路', () => {
  test('renderVideo 没有任何提前 return', () => {
    // 断言的是性质而不是某个具体写法：只要函数中途能退出，
    // 搜索框和候选卡片就可能被整段吞掉，而页面还在提示「请手动选择」。
    const early = [...fn('renderVideo').matchAll(/^\s*return[;\s]/gm)];
    assert.equal(early.length, 0,
      `renderVideo 里有 ${early.length} 处提前 return，控件可能渲染不出来`);
  });

  test('renderVideo 内部真的调用了搜索框，而不是只定义不用', () => {
    assert.match(fn('renderVideo'), /videoSearchBox\(\)/, '定义了却没在渲染路径上调用等于没有');
    assert.match(app, /\/api\/fulfillments\/search/);
  });

  test('搜索框节点被复用，重绘不丢焦点和已输入内容', () => {
    assert.match(fn('videoSearchBox'), /if \(!V\.searchEl\)/,
      'renderVideo 是整块重绘的，每次新建输入框会把焦点打掉');
  });

  test('确认回传按钮建在抽屉页脚，不随候选列表重绘而消失', () => {
    // 按钮现在归 openVideoDrawer 的 foot 管，renderVideo 只改它的 disabled。
    // 这样即使一条候选都没有，按钮依然在，不会出现「提示手动选却没有确认入口」。
    assert.match(fn('openVideoDrawer'), /确认回传/);
    assert.ok(!/确认回传/.test(fn('renderVideo')), '按钮不该在每次重绘时重建');
    assert.match(fn('renderVideo'), /vSubmit[\s\S]{0,80}disabled/);
  });
});

/* ================================================================ */

describe('需要处理：队列与待办合并', () => {
  test('工作台同时拉取识别任务和待办', () => {
    const d = fn('loadDesk');
    assert.match(d, /\/api\/jobs/);
    assert.match(d, /\/api\/todos/);
  });

  test('不再存在独立的待办渲染入口', () => {
    assert.ok(!/function loadTodos\b/.test(app), '待办应并入 loadDesk，不再单独成页');
  });

  test('记录表把「需要处理」做成筛选而不是页面', () => {
    assert.match(html, /data-status="__todo"/);
    assert.match(fn('loadRecords'), /__todo/);
  });
});

/* ================================================================ */

describe('身份由服务端签发，前端碰不到', () => {
  test('前端不再自报身份', () => {
    /* 改造前是把 userId 存 localStorage 再塞进 X-User-Id，
       任何人改个请求头就能变成别人 —— 局域网上线后那些按归属拦截的
       403 会形同虚设。这两样东西必须从前端彻底消失。 */
    assert.ok(!/X-User-Id/.test(app.replace(/\/\*[\s\S]*?\*\//g, '')),
      'app.js 里还在发 X-User-Id 请求头');
    assert.ok(!/localStorage\.(get|set)Item\(\s*UID_KEY/.test(app),
      '身份不该再存在 localStorage 里');
  });

  test('请求带上同源 cookie', () => {
    assert.match(fn('api'), /credentials:\s*'same-origin'/);
  });

  test('会话失效时回登录屏，而不是抛一堆看不懂的错', () => {
    assert.match(fn('api'), /401[\s\S]{0,120}showLogin\(\)/);
  });

  test('登录屏存在且覆盖三种情形：初始化、输口令、选身份', () => {
    for (const id of ['login', 'lPass', 'lPick', 'lBoot']) {
      assert.ok(html.includes(`id="${id}"`), `登录屏缺少 #${id}`);
    }
    assert.match(app, /\/api\/auth\/bootstrap/);
    assert.match(app, /\/api\/auth\/login/);
  });

  test('口令验过之前不显示成员名单', () => {
    // 名单由 /api/auth/login 在口令正确后返回，不是页面里写死的
    assert.match(fn('enterWith'), /needPick/);
    assert.ok(!/lUsers[\s\S]{0,60}innerHTML\s*=\s*['"`]<button/.test(html),
      '成员名单不该硬编码在页面里');
  });
});

/* ================================================================ */

describe('角色裁剪', () => {
  test('非商务看不到模型与 API Key 设置', () => {
    const r = fn('applyRole');
    assert.match(r, /data-panel === 'model'|panel === 'model'/);
    assert.match(r, /canConfigModel\(\)/);
  });

  test('运营看不到粘贴框', () => {
    assert.match(fn('applyRole'), /operations/);
  });
});

/* ================================================================ */

describe('飞书同步设置', () => {
  test('列映射区块不能默认隐藏', () => {
    /* 这是真实踩过的坑：映射区块默认 display:none，只有测试连接成功才出现，
       而「必须把系统ID映射到一列」这条提示却一直显示 ——
       等于让人去做一件界面上根本看不到的事。
       提示指向的控件必须一直在；连不上时在原地说明原因，而不是整块藏起来。 */
    const box = html.match(/<div id="fsTableBox"[^>]*>/);
    assert.ok(box, '找不到映射区块');
    assert.ok(!/display\s*:\s*none/.test(box[0]),
      '映射区块默认隐藏了，用户看不到提示要他做的事');
  });

  test('读不到飞书列时，在映射区原地说明原因', () => {
    assert.match(app, /function blockMap\(/);
    assert.match(fn('loadFeishu'), /blockMap\(/);
    assert.ok(html.includes('id="fsMapBlocked"'), '缺少说明位');
  });

  test('系统ID 没映射时提供「去飞书建这一列」', () => {
    // 手工加列很容易加错类型（选成自动编号就不可写），
    // 而界面上只表现为「下拉里没有这一列」，没人猜得到原因
    assert.match(app, /\/api\/feishu\/create-field/);
    assert.match(fn('renderFeishuMap'), /sf\.required && !sel\.value/);
  });

  test('问题清单只提示当前这一步，不一次甩出全部', () => {
    assert.match(fn('loadFeishu'), /FS\.problems\[0\]/);
  });
});

describe('源码卫生', () => {
  test('没有控制字符混进源码', () => {
    for (const [name, text] of [['public/app.js', app], ['public/index.html', html]]) {
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[ ]/.test(text), `${name} 含控制字符，会被 grep / diff 判成二进制`);
    }
  });

  test('状态由动作驱动：状态接口只被用来置「已终止」', () => {
    /* 「已终止」是唯一的手动状态，且走确认对话框而不是下拉。
       断言的是调用点而不是字符串出现与否 —— 代码里会有
       ['待寄样','已寄样'].includes(...) 这样的合法过滤（筛哪些合作能回填快递单），
       按字面量去禁反而会误伤它。真正要守住的是：没有任何路径能把状态改成别的值。 */
    const calls = [...app.matchAll(/\/status`[^)]*\{\s*status:\s*([^}]+)\}/g)].map((m) => m[1].trim());
    assert.ok(calls.length > 0, '没找到状态接口的调用点，断言可能已失效');
    for (const c of calls) {
      assert.match(c, /'已终止'/, `状态被置成了「已终止」以外的值：${c}`);
    }
    assert.ok(!/<select[^>]*id="[^"]*status/i.test(html), 'index.html 里出现了状态下拉框');
  });
});

/* ================================================================ */

describe('记录表的飞书同步列', () => {
  test('表头有「飞书同步」，且每行渲染一个胶囊', () => {
    const f = fn('loadRecords');
    assert.match(f, /飞书同步/, '表头缺这一列');
    assert.match(f, /syncPill\(states\[cb\.id\]\)/, '行里没渲染状态');
  });

  test('胶囊用的类名在 CSS 里真实存在', () => {
    /* 写一个不存在的 .st 变体不会报错，只会渲染成没有颜色的胶囊 ——
       而「颜色没了」这种问题没人会去查 CSS，只会以为设计就是这样。 */
    const block = app.match(/const SYNC_LABEL = \{[\s\S]*?\n\};/);
    assert.ok(block, '找不到 SYNC_LABEL');
    const used = [...block[0].matchAll(/cls:\s*'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(used.length >= 5, '状态种类少了');
    for (const c of new Set(used)) {
      assert.match(css, new RegExp(`\\.st\\.${c}\\s*[,{]`), `CSS 里没有 .st.${c}`);
    }
  });

  test('「未同步」和「同步失败」不是同一个样子', () => {
    /* 混成一个的话，表里几十条灰的会把真正坏掉的那条淹没。 */
    const block = app.match(/const SYNC_LABEL = \{[\s\S]*?\n\};/)[0];
    const pick = (k) => block.match(new RegExp(`${k}:\\s*\\{[^}]*\\}`))[0];
    assert.notEqual(pick('never').match(/cls:\s*'(\w+)'/)[1],
                    pick('failed').match(/cls:\s*'(\w+)'/)[1]);
  });

  test('手动同步走单条接口，失败时把原因显示出来', () => {
    assert.match(app, /\/api\/feishu\/sync-one/);
    const f = fn('openCollaboration');
    assert.match(f, /同步失败[\s\S]{0,40}esc\(e\.message\)/,
      '只说「同步失败」对排查毫无帮助，必须显示飞书返回的原因');
  });
});

/* ================================================================ */

describe('不寄样合作的录入界面', () => {
  test('前端的类型列表和 rules.js 不分叉', () => {
    /* 两份列表各写一遍的话，后端加了类型前端选不到，或者前端能选一个
       后端不认的值 —— 后者会被白名单静默改回「寄样合作」，
       表现是「我明明选了不寄样，存进去还是寄样」。 */
    const rules = readFileSync(join(ROOT, 'lib/rules.js'), 'utf8');
    const back = rules.match(/COLLAB_TYPES = (\[[^\]]*\])/)[1];
    const front = app.match(/COLLAB_TYPES = (\[[^\]]*\])/)[1];
    assert.equal(front.replace(/\s/g, ''), back.replace(/\s/g, ''));
  });

  test('有类型选择器，且切换会重渲染', () => {
    // 抽屉骨架是 openIntakeDrawer 里拼的，不在 index.html
    assert.ok(app.includes('id="typeSeg"'), '缺类型选择器');
    assert.match(fn('renderTypeSeg'), /S\.form\.type = t/);
    assert.match(fn('renderTypeSeg'), /renderForm\(\)/);
  });

  test('切回寄样时强制展开 —— 折着的必填项等于不存在', () => {
    /* 折叠状态下提交会被拦下并说「缺收件人」，
       而那个输入框在屏幕上根本看不见，人只会一头雾水。 */
    assert.match(fn('renderTypeSeg'), /uiNeedsSample\(t\)[\s\S]{0,40}shipUnfolded = true/);
  });

  test('折叠的字段不计入待补充，Alt+N 也不往那儿跳', () => {
    const r = fn('recount');
    assert.match(r, /display:\s*none|display: none/, 'recount 没有排除隐藏字段');
    assert.match(r, /if \(!visible\(f\)\)/);
  });

  test('不寄样时不提示「未选寄样产品」「收件信息不全」', () => {
    const r = fn('recount');
    assert.match(r, /ship && !hasItems/);
    assert.match(r, /ship && \(!r\.name/);
  });

  test('不寄样时藏掉「提交寄样」按钮', () => {
    // 留一个按不动的按钮比藏起来更让人困惑
    assert.match(fn('renderForm'), /submitSample[\s\S]{0,160}uiNeedsSample\(F\.type\)/);
  });

  test('记录表能筛「进行中」，且它和已完成不是一个颜色', () => {
    assert.match(html, /data-status="进行中"/);
    // 状态胶囊已抽成 statusPill，不再内联在 loadRecords 里
    const f = fn('statusPill');
    assert.match(f, /进行中[\s\S]{0,20}running/);
    assert.match(f, /已完成[\s\S]{0,20}done/);
  });
});

/* ================================================================ */

describe('我的资料：只改当前登录的人', () => {
  test('表单绑的是服务端按会话回的资料，不是全局设置', () => {
    /* 曾经 settings.user 是一份全局的「当前用户」，谁保存谁覆盖：
       商务甲打开设置页看到的是商务乙的姓名和角色，
       一点保存还会按姓名去 users 表匹配、改到商务乙的记录上。 */
    const f = fn('fillSettings');
    assert.match(f, /s\.user\.name/);
    assert.match(f, /CFG\.me/, '没有把当前登录者显示出来');
  });

  test('保存时不传 id —— 改谁由服务端按会话决定', () => {
    const block = app.match(/\$\('#saveUser'\)\.onclick[\s\S]*?\n\};/)[0];
    assert.match(block, /\/api\/settings/);
    assert.ok(!/\bid:/.test(block),
      '请求体里带了 id，等于把「改谁」做成一个客户端可控的参数');
  });

  test('面板叫「我的资料」，并写明改的是当前登录的人', () => {
    assert.match(html, /data-panel="user"[^>]*>我的资料</);
    assert.ok(html.includes('id="selfOnly"'), '缺少「改的永远是当前登录的人」的说明');
  });
});

describe('源码里不能有调用不存在的函数', () => {
  test('所有 loadXxx / renderXxx 调用点都有对应定义', () => {
    /* 这条是踩出来的：待办并入工作台时 loadTodos 被删了，
       但流程设置的保存回调里还留着一句 loadTodos()。
       结果是保存其实成功了，却抛 ReferenceError 让「已保存」永远不显示 ——
       用户只会觉得「点了没反应」，而控制台没人看。 */
    const defined = new Set(
      [...app.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1])
        .concat([...app.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1])));
    const called = [...app.matchAll(/\b((?:load|render|refresh|open|close)[A-Z]\w*)\s*\(/g)]
      .map((m) => m[1]);
    const missing = [...new Set(called)].filter((n) => !defined.has(n));
    assert.deepEqual(missing, [], `这些函数被调用但没有定义：${missing.join('、')}`);
  });
});

/* ================================================================ */

describe('合作记录列表：八列', () => {
  test('表头就是约定的那八列，顺序也对', () => {
    const head = fn('loadRecords').match(/<thead>[\s\S]*?<\/thead>/)[0];
    const cols = [...head.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim());
    assert.deepEqual(cols,
      ['达人 / 账号', '状态', '寄样', '快递', '视频', '飞书同步', '建档', '更新']);
  });

  test('多账号一行一个，不是「、」拼在一格里', () => {
    /* 矩阵号一多，拼在一格里就看不清哪个昵称对应哪个抖音号。 */
    const f = fn('loadRecords');
    assert.match(f, /fulfillments\.map\([\s\S]{0,300}<div>/);
    assert.ok(!/fulfillments[\s\S]{0,120}join\('、'\)/.test(f), '账号还在用「、」拼接');
  });

  test('「快递状态」只说有没有发货，不编造物流轨迹', () => {
    /* 系统里没有物流数据源 —— 快递公司和单号都是人填的，到哪了没人知道。
       写「运输中」「已签收」就是在编，而且没人能发现它是编的。 */
    const f = fn('shipmentCell');
    assert.match(f, /待发货/);
    assert.match(f, /已发货/);
    for (const fake of ['运输中', '已签收', '派送中', '已揽收']) {
      assert.ok(!f.includes(fake), `编造了物流状态「${fake}」，系统根本不知道`);
    }
  });

  test('视频发布进度按「要出片的账号」算分母', () => {
    /* 标了「本次不出片」的号算进分母，这条就永远凑不齐，
       看起来像一直没做完。 */
    assert.match(fn('videoCell'), /filter\(\(f\) => f\.expectVideo\)/);
  });
});

/* ================================================================ */

describe('合作详情：五张卡片', () => {
  test('五张卡片都在，顺序按信息的使用顺序', () => {
    const f = fn('openCollaboration');
    const cards = [...f.matchAll(/dcard\(\s*[`'"]([^`'"]*?)(?:\s*·|[`'"])/g)].map((m) => m[1].trim());
    assert.deepEqual(cards.slice(0, 5),
      ['达人档案', '寄样信息', '视频信息', '商务信息', '系统信息']);
  });

  test('标题给出建档日期 + 达人 + 状态', () => {
    /* 同一个达人可能有很多次合作，日期是唯一能一眼分开它们的东西。 */
    const f = fn('openCollaboration');
    assert.match(f, /title:\s*`\$\{fmtDate\(cb\.createdAt\)\}[\s\S]{0,60}creatorName/);
    assert.match(f, /tags:\s*\[\{\s*text:\s*cb\.status/);
  });

  test('底部只放终止和删除，日常操作在各自卡片里', () => {
    /* 底部混进日常操作，「这一排都是危险动作」这条规律就失效了。 */
    const f = fn('openCollaboration');
    const footBlock = f.match(/const foot = \[\][\s\S]*?foot\.push\(del\);/)[0];
    assert.match(footBlock, /终止合作/);
    assert.match(footBlock, /删除合作/);
    for (const daily of ['回填快递', '复制', '记录回访', '查看达人']) {
      assert.ok(!footBlock.includes(daily), `日常操作「${daily}」跑到底部去了`);
    }
  });

  test('删除要两道确认，第二道得手打达人名字', () => {
    /* 不可逆的操作不该只隔着一次「确定」—— 那个按钮人是会顺手点的。 */
    const f = fn('openCollaboration');
    assert.match(f, /confirm\([\s\S]{0,200}不可恢复/);
    assert.match(f, /prompt\([\s\S]{0,80}输入达人名称/);
    assert.match(f, /typed\.trim\(\) !== name/);
  });

  test('非归属人的删除按钮是禁用的，不是藏起来', () => {
    // 藏起来会让人以为「没有这个功能」，禁用+提示才说得清为什么不能点
    const f = fn('openCollaboration');
    assert.match(f, /del\.disabled = !mine/);
    assert.match(f, /只有归属商务能删/);
  });

  test('每条信息可点击复制，口令复制的是原文不是截断版', () => {
    /* 口令逐字节保存是硬要求 —— 抖音跳转和千川加载都依赖它。
       显示可以截断，复制绝不能。 */
    assert.match(fn('cpRow'), /copy\(copyAs \|\| v\)/);
    assert.match(fn('openCollaboration'), /copyAs: f\.shareToken/);
  });

  test('有无快递单号时给的是不同的操作', () => {
    // 同一个位置只放当前这一步真正要做的事
    const f = fn('openCollaboration');
    assert.match(f, /!cb\.packages\.length[\s\S]{0,200}回填快递单号/);
    assert.match(f, /复制完整物流信息/);
  });

  test('没视频链接时能填，有链接时能复制整段', () => {
    const f = fn('openCollaboration');
    assert.match(f, /填写视频链接/);
    assert.match(f, /复制完整视频信息/);
    // 填写走的是正式弹窗，不是 prompt()
    assert.match(f, /openVideoLinkModal\(cb\.id, f\)/);
    assert.match(fn('openVideoLinkModal'), /\/api\/fulfillments\/\$\{f\.id\}/);
  });

  test('转交走达人，并说清会连带转走名下所有合作', () => {
    assert.match(fn('openCollaboration'), /openTransferModal\(cb\.creatorId/);
    assert.match(fn('openTransferModal'), /名下的所有合作会一起转/);
  });
});

/* ================================================================ */

describe('详情的四项精简', () => {
  test('达人档案里没有「查看达人」，openCreator 整个删掉', () => {
    /* 留一个只定义不调用的函数比删掉更糟 —— 下一个人会以为它还在用，
       改别处时还得顺带维护它。 */
    assert.ok(!/查看达人/.test(app), '按钮还在');
    assert.ok(!/function openCreator\b/.test(app), 'openCreator 没删干净');
    assert.ok(!/openCreator\(/.test(app), '还有地方在调 openCreator');
  });

  test('寄样信息里没有「标记已告知」按钮，改为复制即标记', () => {
    /* 这个按钮存在的唯一目的就是把物流信息粘给达人。
       复制完还要再点一下「我复制了」，是让人做一件系统已经知道的事。 */
    const f = fn('openCollaboration');
    assert.ok(!/标记已告知达人|取消已告知/.test(f), '按钮还在');
    assert.match(f, /复制完整物流信息/);
    /* 断言的是**条件本身**，不只是那行调用在不在 ——
       把守卫改成 if (false) 时调用还在，只是永远不执行，
       只搜字符串的断言照样绿。 */
    assert.match(f, /copy\(notifyText\)[\s\S]{0,200}if \(!cb\.notifiedAt\)[\s\S]{0,200}\/notified`/,
      '复制之后没有顺手标记已告知，那条待办会永远清不掉');
  });

  test('视频信息里没有「记录回访」，填写走正式弹窗不是 prompt', () => {
    const f = fn('openCollaboration');
    assert.ok(!/记录回访/.test(f), '按钮还在');
    /* prompt() 没法校验、没法给第二个选项、粘长链接看不全，
       Safari 上还会被当成弹窗拦掉。 */
    assert.ok(!/prompt\(/.test(fn('openVideoLinkModal')), '弹窗里还在用 prompt');
  });

  test('填写视频链接的弹窗里能选「本次不出片」', () => {
    /* 打开它的时机是一样的（问完达人有了结果），结果无非这两种。
       分成两个入口会让人先想「我该点哪个」。 */
    const f = fn('openVideoLinkModal');
    assert.match(f, /本次不出片/);
    assert.match(f, /filmingProgress: '本次不出片'/);
    assert.match(f, /url\.disabled = none\.checked/,
      '勾了不出片，链接框该变灰 —— 留着一个能填但会被忽略的框是骗人');
  });

  test('粘完整口令时自动抠出链接', () => {
    assert.match(fn('openVideoLinkModal'), /match\(\/https\?:/);
  });

  test('时间线不再有「告知达人」这一项', () => {
    const f = fn('timeline');
    assert.ok(!/已告知达人|该告知达人/.test(f), '时间线还在讲告知');
  });

  test('建档节点可点开原始识别记录，没记录的节点不做成可点', () => {
    /* 点了什么都不弹，比不能点更让人困惑。 */
    const f = fn('timeline');
    assert.match(f, /add\('done', '建档'[\s\S]{0,140}, true\)/);
    assert.match(f, /openLogsModal\(/);
    const calls = [...f.matchAll(/add\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0]);
    const clickable = calls.filter((c) => /,\s*true\)$/.test(c));
    assert.equal(clickable.length, 1, '只有建档有完整识别记录，其余节点不该可点');
  });

  test('没有识别记录时说清为什么，而不是给一个空框', () => {
    // 同样断言条件，不只断言那句话在源码里
    assert.match(fn('openLogsModal'), /if \(!logs\.length\)[\s\S]{0,240}手工建档或从旧数据迁移/);
  });

  test('原始记录展示的是 diff —— 模型抽出什么、人改成什么', () => {
    const f = fn('openLogsModal');
    assert.match(f, /l\.rawText/);
    assert.match(f, /l\.diff/);
    assert.match(f, /人工修改/);
  });
});

/* ================================================================ */

describe('发货截图预览', () => {
  test('确认页显示原图，不再是一句「已清掉」', () => {
    /* 核对的全部意义就在这张图上：识别出来的单号和图里对不对得上，
       只有并排看才知道。之前识别完就把图丢了，这一栏永远是空的。 */
    const f = fn('openShipment');
    assert.match(f, /shotImg\(SB\.shotId\)/);
    assert.ok(!/已从库里清掉/.test(f), '还在显示那句占位文案');
  });

  test('缩略图可点开放大 —— 不能放大的预览等于没有预览', () => {
    // 快递单号在截图里往往很小，缩略图上根本认不出
    assert.match(fn('shotImg'), /openShotViewer\(shotId\)/);
    assert.match(fn('openShotViewer'), /max-height:80vh/);
  });

  test('原图走接口，不放静态目录', () => {
    /* 放静态目录等于同网段谁都能按 id 猜着看。 */
    assert.match(fn('shotImg'), /\/api\/shots\/\$\{encodeURIComponent\(shotId\)\}/);
    const html2 = html;
    assert.ok(!/src="\/shots\//.test(html2) && !/src="\/data\//.test(app),
      '有地方直接引静态路径');
  });

  test('图被清理时给一句人话，不留破图框', () => {
    assert.match(fn('shotImg'), /img\.onerror/);
    assert.match(fn('shotImg'), /原图已清理/);
  });

  test('合作详情里，截图来的包裹能点开原图；手填的不给这个入口', () => {
    const f = fn('openCollaboration');
    assert.match(f, /if \(p\.shotId\)/, '没有按来源区分');
    assert.match(f, /openShotViewer\(p\.shotId\)/);
  });

  test('Esc 能关掉看图弹窗', () => {
    // 全屏看图时鼠标多半在图上，找关闭按钮要移半屏
    assert.match(fn('openShotViewer'), /Escape/);
  });
});

/* ================================================================ */

describe('清理与统一', () => {
  test('「标记已告知」在工作台和详情里是同一套做法', () => {
    /* 之前工作台是「复制文案」+「标记已告知」两个按钮，详情里是一步。
       同一个动作两个界面两种语义，用哪边的人都会觉得另一边不对劲。 */
    /* 只禁「按钮」，不禁字符串 —— 日志的动作名映射表里有一条
       'POST /api/collaborations/:id/notified': '标记已告知'，那是合法的。
       按字面量一刀切会误伤它。 */
    assert.ok(!/el\('button'[^)]*'标记已告知'/.test(app), '工作台还留着独立的标记按钮');
    const desk = app.match(/if \(t\.type === 'notify_creator'\)[\s\S]*?\n  \}/)[0];
    assert.match(desk, /copy\(notifyText\)[\s\S]{0,160}\/notified`/,
      '工作台复制之后没有顺手标记');
  });

  test('.ov* 那套死 CSS 已清掉', () => {
    // 全屏确认页被抽屉取代后留下的，14 行，零引用
    assert.ok(!/^\.ov[.{\s-]/m.test(css), '.ov* 还在');
  });

  test('其他平台账号在达人档案里有出口', () => {
    /* 模型一直在抽、库里一直在存，之前界面上零渲染 ——
       花了 token 又占了库，还让人以为「系统记着呢」。 */
    /* 断言条件本身，不只断言那段代码在源码里 ——
       把守卫改成 if (false) 时代码还在，只是永远不执行，
       只搜字符串的断言照样绿。这个坑这个项目里踩过三次了。 */
    const f = fn('openCollaboration');
    assert.match(f, /if \(cb\.otherAccounts\?\.length\)[\s\S]{0,400}仅存档/,
      '其他平台账号那块要么没渲染，要么守卫被改死了');
  });
});
