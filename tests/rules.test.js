/**
 * 规则层回归。
 *
 * 主指标不是识别准确率，而是《改造方案》§6 定的两条：
 *   1. 静默错误 = 0（商务肉眼发现不了的错误）
 *   2. 标准模板误报歧义率 ≤ 5%（规则过严会让商务负担反增）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  routeInput, parseVideoToken, renderNotifyText,
  normalize, validateForAction, validateVideoSubmit, sanitizeForStore, buildTodos, cleanValue,
} from '../lib/rules.js';
import { mockExtract } from '../lib/agent.js';
import { INTAKE_SAMPLES, VIDEO_SAMPLES } from './fixtures/samples.js';

const run = (text) => normalize(mockExtract(text));
const byId = (id) => INTAKE_SAMPLES.find((s) => s.id === id);

/* ================================================================ 输入路由 */

describe('输入路由', () => {
  test('图片一律走发货截图', () => {
    assert.equal(routeInput('', { hasImage: true }).kind, 'shipment');
  });

  test('含 UID / 合作码 / 手机号 → 建档', () => {
    for (const s of INTAKE_SAMPLES) {
      const r = routeInput(s.text);
      assert.equal(r.kind, 'intake', `${s.id} 应判为建档，实际 ${r.kind}`);
    }
  });

  test('关键保险：建档资料夹带主页口令时仍判建档，不被抖音链接带偏', () => {
    const r = routeInput(byId('T21').text);
    assert.equal(r.kind, 'intake');
    assert.equal(r.confidence, 'high');
    assert.match(r.note, /主页口令/);
  });

  test('视频口令 → video；有【昵称】时高置信', () => {
    assert.equal(routeInput(VIDEO_SAMPLES[0].text).kind, 'video');
    assert.equal(routeInput(VIDEO_SAMPLES[0].text).confidence, 'high');
    assert.equal(routeInput(VIDEO_SAMPLES[2].text).confidence, 'medium');   // 裸链接
  });

  test('证据不足时不猜，返回 unknown', () => {
    assert.equal(routeInput('好的 收到 谢谢').kind, 'unknown');
    assert.equal(routeInput('').kind, 'unknown');
  });
});

/* ================================================================ 视频口令 */

describe('视频口令解析', () => {
  for (const s of VIDEO_SAMPLES) {
    test(`${s.id} ${s.name}`, () => {
      const p = parseVideoToken(s.text);
      if (s.expect.ok === false) { assert.equal(p.ok, false); return; }
      assert.equal(p.ok, true);
      assert.equal(p.nickname, s.expect.nickname);
      assert.equal(p.videoUrl, s.expect.url);
    });
  }

  test('口令逐字节保存 —— 尾串是载荷的一部分，改一个字符跳转就可能失效', () => {
    const t = VIDEO_SAMPLES[0].text;
    const p = parseVideoToken(t);
    assert.equal(p.shareToken, t);
    assert.ok(p.shareToken.includes(':9pm KWM:/ 01/13 z@T.Lw'), '尾串必须完整保留');
    assert.ok(p.shareToken.startsWith('0.58 '), '开头口令码必须保留');
  });

  test('昵称去掉「的作品」后缀', () => {
    assert.equal(parseVideoToken('看看【某某某的作品】x https://v.douyin.com/A/').nickname, '某某某');
    assert.equal(parseVideoToken('看看【某某某】x https://v.douyin.com/A/').nickname, '某某某');
  });
});

/* ================================================================ 静默错误 */

describe('静默错误必须为 0（商务肉眼发现不了的）', () => {
  test('跨平台 ID 绝不进入抖音字段', () => {
    const { form, warnings } = run(byId('T13').text);
    for (const a of form.accounts) {
      assert.ok(!/^sph/i.test(a.douyinId), `视频号 ID 混进了抖音号：${a.douyinId}`);
      assert.ok(!/^sph/i.test(a.uid), `视频号 ID 混进了 UID：${a.uid}`);
    }
    assert.ok(form.otherAccounts.length >= 2, '视频号和快手号应被隔离存档');
    assert.ok(warnings.some((w) => w.code === 'CROSS_PLATFORM_ISOLATED'));
  });

  test('rules 层二次拦截：模型把视频号 ID 塞进抖音号也能兜住', () => {
    const { form, warnings } = normalize({
      accounts: [{ douyin_id: { v: 'sphDemo000000001', c: 0.9 }, uid: { v: '4000000000000001', c: 0.9 } }],
    });
    assert.equal(form.accounts[0].douyinId, '', '应被清空');
    assert.ok(warnings.some((w) => w.code === 'CROSS_PLATFORM_LEAK'));
    assert.ok(form.otherAccounts.some((o) => o.accountId === 'sphDemo000000001'));
  });

  test('合作码前导零不丢失，且始终是字符串', () => {
    const { form } = run(byId('T15').text);
    const code = form.accounts.map((a) => a.cooperationCode).find((c) => c.startsWith('0'));
    assert.equal(code, '04000000001');
    const stored = sanitizeForStore(form);
    assert.equal(typeof stored.accounts[0].cooperationCode, 'string');
    assert.ok(stored.accounts.some((a) => a.cooperationCode === '04000000001'));
  });

  test('UID 与合作码同为 11 位纯数字时必须提示', () => {
    const { warnings } = normalize({
      accounts: [{ uid: { v: '20000000002', c: .9 }, cooperation_code: { v: '30000000002', c: .9 } }],
    });
    const w = warnings.find((x) => x.code === 'UID_COOP_SAME_SHAPE');
    assert.ok(w, '同形未触发交叉提示');
    assert.deepEqual(w.swap, { uid: '20000000002', cooperationCode: '30000000002' });
  });

  test('分享口令里的垃圾串不得进入业务字段', () => {
    const { form } = run(byId('T21').text);
    const flat = JSON.stringify(form);
    for (const junk of ['8@9.com', ':5pm', '长按复制']) {
      assert.ok(!flat.includes(junk), `垃圾串「${junk}」混进了业务字段`);
    }
  });

  test('字段残缺不得阻断入库', () => {
    for (const id of ['T08', 'T23']) {
      const { form } = run(byId(id).text);
      const v = validateForAction(form, 'createRecord');
      assert.equal(v.ok, true, `${id} 被硬阻断了：${v.blocking.join('；')}`);
    }
  });
});

/* ================================================================ 误报控制 */

describe('不过度触发歧义', () => {
  test('T27 标准模板不应产生 warn/error 级告警', () => {
    const { warnings } = run(byId('T27').text);
    const noisy = warnings.filter((w) => w.level !== 'info');
    assert.equal(noisy.length, 0, `标准模板误报：${noisy.map((w) => w.code).join(', ')}`);
  });
});

/* ================================================================ 校验分级 */

describe('校验按动作分级', () => {
  const base = {
    accounts: [{ nickname: 'x', douyinId: 'd1', uid: '20000000001', cooperationCode: '' }],
    recipient: {}, items: [],
  };

  test('存草稿任何情况都放行', () => {
    assert.equal(validateForAction({ accounts: [] }, 'saveDraft').ok, true);
  });

  test('建档只要求一个可用账号标识', () => {
    assert.equal(validateForAction(base, 'createRecord').ok, true);
    assert.equal(validateForAction({ ...base, accounts: [{ nickname: '只有昵称' }] }, 'createRecord').ok, false);
  });

  test('提交寄样要求收件信息和产品行', () => {
    const v = validateForAction(base, 'submitSample');
    assert.equal(v.ok, false);
    for (const k of ['缺收件人', '缺手机号', '缺收件地址']) {
      assert.ok(v.blocking.some((b) => b.includes(k.slice(1))), `应阻断：${k}`);
    }
    assert.ok(v.blocking.some((b) => b.includes('产品')));
  });

  test('合作码缺失只提示不阻断 —— 27 条真实样本里 4 条完全没有合作码', () => {
    const full = { ...base,
      recipient: { name: '张', phone: '13800138000', address: '示例省示例市' },
      items: [{ productId: 'p1', quantity: 2 }] };
    const v = validateForAction(full, 'submitSample');
    assert.equal(v.ok, true);
    assert.ok(v.soft.some((s) => s.includes('合作码')));
  });

  test('视频提交要求可解析口令 + 已定位履约项', () => {
    assert.equal(validateVideoSubmit({ shareToken: '随便一段话', fulfillmentId: 'ca-1' }).ok, false);
    assert.equal(validateVideoSubmit({ shareToken: VIDEO_SAMPLES[0].text, fulfillmentId: '' }).ok, false);
    assert.equal(validateVideoSubmit({ shareToken: VIDEO_SAMPLES[0].text, fulfillmentId: 'ca-1' }).ok, true);
  });
});

/* ================================================================ 类型 */

describe('入库前类型整理', () => {
  test('UID 与合作码转字符串，数量与费用转数字', () => {
    const s = sanitizeForStore({
      accounts: [{ douyinId: 'd', uid: 20000000001, cooperationCode: '04000000001' }],
      sampleCost: '128.5', items: [{ productId: 'p', quantity: '3' }],
    });
    assert.equal(typeof s.accounts[0].uid, 'string');
    assert.equal(s.accounts[0].cooperationCode, '04000000001');
    assert.equal(s.sampleCost, 128.5);
    assert.equal(s.items[0].quantity, 3);
  });

  test('清洗只去噪声，不改语义', () => {
    assert.equal(cleanValue('30000000006|'), '30000000006');
    assert.equal(cleanValue('２１３１７８５０２'), '213178502');   // 全角转半角
    assert.equal(cleanValue('  示例达人  '), '示例达人');
  });
});

/* ================================================================ 待办 */

describe('待办推导', () => {
  const DAY = 864e5;
  const NOW = Date.now();
  const ago = (d) => new Date(NOW - d * DAY).toISOString();
  const collab = (o) => ({
    type: '寄样合作', status: '待寄样', items: [{ productName: 'x', quantity: 1 }],
    packages: [], fulfillments: [{ expectVideo: true, filmingProgress: '待拍摄' }],
    createdAt: ago(1), updatedAt: ago(1), ...o,
  });
  const build = (cbs, extra = {}) => buildTodos({
    collaborations: cbs, followUp: { firstDays: 7, repeatDays: 5 }, now: NOW, ...extra });
  const types = (t) => t.map((x) => x.type);

  test('刚提交不标逾期，3 天无单号标逾期', () => {
    assert.equal(build([collab({ id: 'A', creatorName: '甲' })])[0].overdue, false);
    assert.equal(build([collab({ id: 'B', creatorName: '乙', createdAt: ago(5) })])
      .find((t) => t.type === 'fill_tracking').overdue, true);
  });

  test('缺产品行 → 补全合作信息（迁移来的老记录）', () => {
    assert.ok(types(build([collab({ id: 'C', creatorName: '丙', items: [] })])).includes('complete_info'));
  });

  test('有单号未告知 → 告知达人；已告知 → 消失', () => {
    const withPkg = { id: 'D', creatorName: '丁', status: '已寄样', packages: [{ carrier: '申通', trackingNo: 'x' }] };
    assert.ok(types(build([collab(withPkg)])).includes('notify_creator'));
    assert.ok(!types(build([collab({ ...withPkg, notifiedAt: ago(1) })])).includes('notify_creator'));
  });

  test('建档满 7 天且有账号未发布 → 回访；已催拍后再隔 5 天 → 再次催拍', () => {
    const base = { id: 'E', creatorName: '戊', status: '已寄样', notifiedAt: ago(8),
      packages: [{ carrier: '申通', trackingNo: 'x' }] };
    const t1 = build([collab({ ...base, createdAt: ago(9) })]).find((t) => t.type === 'follow_up');
    assert.ok(t1 && t1.title.startsWith('回访'));
    const t2 = build([collab({ ...base, createdAt: ago(14),
      fulfillments: [{ expectVideo: true, filmingProgress: '已催拍' }] })]).find((t) => t.type === 'follow_up');
    assert.ok(t2 && t2.title.startsWith('再次催拍'));
    const t3 = build([collab({ ...base, createdAt: ago(9),
      fulfillments: [{ expectVideo: true, filmingProgress: '已催拍' }] })]).find((t) => t.type === 'follow_up');
    assert.equal(t3, undefined, '刚催过不该立刻再提醒');
  });

  test('本次不出片 / 已发布的账号不产生催拍', () => {
    const c = collab({ id: 'F', creatorName: '己', createdAt: ago(20), status: '已寄样',
      notifiedAt: ago(19), packages: [{ carrier: '申通', trackingNo: 'x' }],
      fulfillments: [{ expectVideo: true, filmingProgress: '已发布' },
        { expectVideo: true, filmingProgress: '本次不出片' }] });
    assert.ok(!types(build([c])).includes('follow_up'));
  });

  test('已终止的合作不产生任何待办', () => {
    assert.equal(build([collab({ id: 'H', creatorName: '辛', status: '已终止', items: [], createdAt: ago(30) })]).length, 0);
  });

  test('草稿与识别失败进入待办', () => {
    const t = build([], { drafts: [{ id: 'df', title: '半截', updatedAt: ago(1) }],
      jobs: [{ id: 'jb', status: 'failed', title: 'x', error: '超时', finishedAt: ago(0) }] });
    assert.deepEqual(types(t).sort(), ['draft_incomplete', 'job_failed']);
  });
});

/* ================================================================ 告知文案 */

describe('告知达人文案', () => {
  const cb = {
    creatorName: '示例达人', recipient: { name: '张某某' },
    items: [{ productName: '洁齿冻干', quantity: 2 }, { productName: '鲜肉猫粮', quantity: 1 }],
    packages: [{ carrier: '申通', trackingNo: '773435035826894' }, { carrier: '圆通', trackingNo: '773435035826882' }],
  };

  test('多包裹时承运商与单号成对，不错位', () => {
    const out = renderNotifyText('{物流}', cb);
    assert.equal(out, '申通 773435035826894\n圆通 773435035826882');
  });

  test('商品逐行展开', () => {
    assert.equal(renderNotifyText('{商品}', cb), '洁齿冻干 ×2\n鲜肉猫粮 ×1');
  });

  test('无包裹时不留下空行', () => {
    assert.equal(renderNotifyText('已寄出\n{物流}\n请查收', { ...cb, packages: [] }), '已寄出\n请查收');
  });
});
