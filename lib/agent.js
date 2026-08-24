/**
 * Agent 抽取层 —— 通过 OpenAI Compatible 接口调用大模型。
 *
 * 分工（对齐蓝图 §17.2）：
 *   本文件只负责「把非结构化文本变成结构化候选值」。
 *   校验、清洗、消歧、查重一律在 rules.js 用确定性代码完成，不交给模型。
 *
 * 未配置 LLM_API_KEY 时自动降级为本地模拟解析，保证开箱可跑。
 */

import * as db from './db.js';

export const PROMPT_VERSION = 'intake-2026-08-03.1';

const SYSTEM_PROMPT = `你是宠物食品公司的达人寄样资料抽取器。商务会把微信聊天里的内容整段粘贴给你，你从中抽取结构化信息。

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。

# 输出结构

{
  "cooperation_type": "寄样合作" 或 "直播定向",
  "creator_name":  {"v": "", "c": 0.9} 或 null,
  "pet_category":  同上 或 null,
  "sales_channel": 同上 或 null,
  "accounts": [
    {
      "nickname":         对象或 null,
      "douyin_id":        对象或 null,
      "uid":              对象或 null,
      "cooperation_code": 对象或 null,
      "profile_url":      对象或 null
    }
  ],
  "recipient": {
    "name":          对象或 null,
    "phone":         对象或 null,
    "address":       对象或 null,
    "delivery_note": 对象或 null
  },
  "phone_candidates": [对象],
  "other_platform_accounts": [{"platform": "", "account_id": "", "source_text": ""}],
  "ambiguities": [{"field": "", "reason": "", "candidates": []}],
  "ignored_text": [""]
}

字段值统一为 {"v": 值, "c": 置信度 0~1}。
未在原文出现的字段一律输出 null。

输出务必紧凑：不要缩进、不要多余空格与换行。ignored_text 最多 5 条，每条不超过 15 字的概括，禁止原样复制长段文本。

# 铁律

1. 只抽取原文出现的内容。没有就是 null，禁止推断、补全、纠正错别字。
2. 所有值一律输出为 JSON 字符串，禁止输出为数字。合作码可能以 0 开头（如 "04000000001"），转成数字会丢失前导零。
3. 抖音号可以是纯数字、纯字母、字母数字混合，可以含下划线、点号、大小写字母。例如 "K9petlife"、"miaomiaodiary"、"Abc.0000"、"demo_acct01"、"sample20250101"、"10000000001" 都是合法抖音号。不要因为不像数字就丢弃。
4. UID 是纯数字，长度 9 到 19 位都可能出现。
5. 抖音号和 UID 都可能是 11 位数字，无法靠长度或字符集区分，一律以字段名为准。字段名缺失且无法判断时，写入 ambiguities，不要猜。
6. 视频号 id、快手号、小红书号、微信号属于其他平台，放入 other_platform_accounts，**绝对禁止**写入 douyin_id 或 uid。视频号 id 常形如 "sphDemo000000001"。
7. 一段文本常出现多个抖音账号共用一个收件地址。逐个抽到 accounts 数组。账号字段残缺是正常现象（可能只有 UID 没有抖音号，也可能全部没有合作码），缺就填 null，不要用别的账号的值补。
8. 出现多个手机号且不一致时：与收件人姓名相邻的那个填入 recipient.phone，所有手机号都放进 phone_candidates，并在 ambiguities 记一条。
9. 地址尾部的配送说明抽到 delivery_note，不要留在 address 里。例如「（送上门）」「放菜鸟驿站」「放鲜荟多超市」「放驿站别打电话」「（送货上门）」。
10. 抖音分享口令（含「长按复制」「打开抖音搜索」或 v.douyin.com 链接）：只提取其中的 https://v.douyin.com/xxx 短链填入该账号的 profile_url，口令里的其余字符（如 "8@9.com"、":5pm"、"1-"）全部忽略并记入 ignored_text。
11. 忽略寒暄、商品介绍、催单、表情、时间戳等无关对话，记入 ignored_text。
12. 若文本表明这是直播间账号，或诉求是「开定向」「定向高佣」，把 cooperation_type 设为 "直播定向"，此时 recipient 各项可以全为 null。
13. 收件人可能是单字（"孙"）、称谓（"李先生"、"王女士"）、网名（"萝卜"、"旺仔"）或店铺名（"示例童装馆"）。不要因为不像姓名就丢弃。
14. 姓名、手机号、地址常常粘连在一行且顺序不定，例如「张女士13800138001，示例省示例市…」或「…示范小区1栋22号202室 李某某13800138002」。要正确拆开。

# 字段名同义词

昵称：抖音名称 / 抖音昵称 / 抖音名 / 抖音名字 / 账号名称 / 账号昵称 / 昵称 / 抖音
抖音号：抖音号 / 账号id / 账号ID / ID / id / 抖音账号 / 账号
UID：UID / Uid / uid / 账号uid / 抖音uid / 抖音UID / UserId / User Id / UserID
合作码：合作码 / 抖音合作码
手机号：手机号 / 手机号码 / 联系方式 / 联系电话 / 电话 / 手机
收件人：收件人 / 收货人 / 姓名
地址：地址 / 详细地址 / 收件地址 / 收货地址 / 收样地址 / 寄样信息地址 / 所在地区

注意：分隔符可能是全角冒号、半角冒号，也可能完全没有（如 "账号uid20000000001"、"合作码30000000006"）。字段名内部可能有空格（如 "抖音 id"）。整段资料也可能一个冒号都没有，全靠空格分隔。`;

/* ---------------------------------------------------------------- few-shot */

const FEWSHOT = [
  {
    in: `账号名称：示例达人甲
账号id：100000001
带货方式：短视频
账号uid20000000001
合作码：30000000001
联系方式：13800138000
详细地址：福建省南安市示范镇示范村1组100号
收件人:黄某某
-`,
    out: {
      cooperation_type: '寄样合作',
      creator_name: { v: '示例达人甲', c: 0.95, s: '账号名称：示例达人甲' },
      pet_category: null,
      sales_channel: { v: '短视频', c: 0.98, s: '带货方式：短视频' },
      accounts: [{
        nickname: { v: '示例达人甲', c: 0.95, s: '账号名称：示例达人甲' },
        douyin_id: { v: '100000001', c: 0.96, s: '账号id：100000001' },
        uid: { v: '20000000001', c: 0.92, s: '账号uid20000000001' },
        cooperation_code: { v: '30000000001', c: 0.97, s: '合作码：30000000001' },
        profile_url: null,
      }],
      recipient: {
        name: { v: '黄某某', c: 0.95, s: '收件人:黄某某' },
        phone: { v: '13800138000', c: 0.97, s: '联系方式：13800138000' },
        address: { v: '福建省南安市示范镇示范村1组100号', c: 0.95, s: '详细地址：福建省南安市示范镇示范村1组100号' },
        delivery_note: null,
      },
      phone_candidates: [{ v: '13800138000', c: 0.97, s: '联系方式：13800138000' }],
      other_platform_accounts: [],
      ambiguities: [],
      ignored_text: ['-'],
    },
  },
  {
    in: `地址：上海市松江区示范镇示范园区A栋一楼 13800138001 小乙
示例宠物馆
UID: 4000000000000001
示例优选
抖音号：10000000002
UID：4000000000000002
示例铲屎官
抖音号：K9petlife
UID：4000000000000003`,
    out: {
      cooperation_type: '寄样合作',
      creator_name: { v: '示例宠物馆', c: 0.75, s: '示例宠物馆' },
      pet_category: null,
      sales_channel: null,
      accounts: [
        { nickname: { v: '示例宠物馆', c: 0.9, s: '示例宠物馆' }, douyin_id: null, uid: { v: '4000000000000001', c: 0.97, s: 'UID: 4000000000000001' }, cooperation_code: null, profile_url: null },
        { nickname: { v: '示例优选', c: 0.9, s: '示例优选' }, douyin_id: { v: '10000000002', c: 0.96, s: '抖音号：10000000002' }, uid: { v: '4000000000000002', c: 0.97, s: 'UID：4000000000000002' }, cooperation_code: null, profile_url: null },
        { nickname: { v: '示例铲屎官', c: 0.9, s: '示例铲屎官' }, douyin_id: { v: 'K9petlife', c: 0.96, s: '抖音号：K9petlife' }, uid: { v: '4000000000000003', c: 0.97, s: 'UID：4000000000000003' }, cooperation_code: null, profile_url: null },
      ],
      recipient: {
        name: { v: '小乙', c: 0.8, s: '13800138001 小乙' },
        phone: { v: '13800138001', c: 0.95, s: '13800138001 小乙' },
        address: { v: '上海市松江区示范镇示范园区A栋一楼', c: 0.93, s: '地址：上海市松江区示范镇示范园区A栋一楼' },
        delivery_note: null,
      },
      phone_candidates: [{ v: '13800138001', c: 0.95, s: '13800138001 小乙' }],
      other_platform_accounts: [],
      ambiguities: [],
      ignored_text: [],
    },
  },
  {
    in: `示例小戏精
抖音UID4000000000000004
示例小戏精
视频号id sphDemo000000001
示例小戏精
快手号5000000001
抖音链接：1- 长按复制此条消息，打开抖音搜索。 https://v.douyin.com/EXAMPLE01/ 8@9.com :5pm
示例小戏精 13800138003 浙江省杭州市临平区示范街道示范小区1-1-101（放菜鸟驿站）`,
    out: {
      cooperation_type: '寄样合作',
      creator_name: { v: '示例小戏精', c: 0.9, s: '示例小戏精' },
      pet_category: null,
      sales_channel: null,
      accounts: [{
        nickname: { v: '示例小戏精', c: 0.9, s: '示例小戏精' },
        douyin_id: null,
        uid: { v: '4000000000000004', c: 0.93, s: '抖音UID4000000000000004' },
        cooperation_code: null,
        profile_url: { v: 'https://v.douyin.com/EXAMPLE01/', c: 0.95, s: 'https://v.douyin.com/EXAMPLE01/' },
      }],
      recipient: {
        name: { v: '示例小戏精', c: 0.7, s: '示例小戏精 13800138003' },
        phone: { v: '13800138003', c: 0.95, s: '示例小戏精 13800138003' },
        address: { v: '浙江省杭州市临平区示范街道示范小区1-1-101', c: 0.93, s: '浙江省杭州市临平区示范街道示范小区1-1-101（放菜鸟驿站）' },
        delivery_note: { v: '放菜鸟驿站', c: 0.95, s: '（放菜鸟驿站）' },
      },
      phone_candidates: [{ v: '13800138003', c: 0.95, s: '示例小戏精 13800138003' }],
      other_platform_accounts: [
        { platform: '微信视频号', account_id: 'sphDemo000000001', source_text: '视频号id sphDemo000000001' },
        { platform: '快手', account_id: '5000000001', source_text: '快手号5000000001' },
      ],
      ambiguities: [],
      ignored_text: ['1- 长按复制此条消息，打开抖音搜索。', '8@9.com', ':5pm'],
    },
  },
];

/* ---------------------------------------------------------------- 调用 */

/** few-shot 示例里的 s（原文出处）不发给模型 —— 出处在本地定位，省一半输出 token */
function stripEvidence(node) {
  if (Array.isArray(node)) return node.map(stripEvidence);
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 's') continue;
      o[k] = stripEvidence(v);
    }
    return o;
  }
  return node;
}

function buildMessages(rawText, previous) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const ex of FEWSHOT) {
    msgs.push({ role: 'user', content: ex.in });
    msgs.push({ role: 'assistant', content: JSON.stringify(stripEvidence(ex.out)) });
  }
  if (previous) {
    msgs.push({
      role: 'user',
      content:
        '以下是同一个达人此前已经抽取到的结果，本次是补充的新片段。请把新片段的信息与已有结果合并后输出完整 JSON：' +
        '已有结果=' + JSON.stringify(previous) + '\n\n新片段：\n' + rawText,
    });
  } else {
    msgs.push({ role: 'user', content: rawText });
  }
  return msgs;
}

/**
 * 模型配置来源优先级：界面设置 > .env 环境变量。
 * 界面里改完立即生效，不用重启服务。
 */
/**
 * @param {'model'|'vision'} which  文本抽取用 model，发货截图识别用 vision。
 *   分开配的理由：文本高频（每条资料一次），用便宜模型即可；
 *   视觉低频（只在回填发货时），且 deepseek-chat 之类不支持视觉。
 */
export async function agentConfig(which = 'model') {
  // 必须 await。db 层已整体异步化，漏掉 await 时 all 是个 Promise，
  // all.model 恒为 undefined —— 配置会静默回落到环境变量，
  // 界面上「已保存」照常显示，但识别永远走本地模拟。这个坑踩过一次。
  const all = await db.getSettings();
  const s = (which === 'vision' ? all.vision : all.model) || {};
  const envPrefix = which === 'vision' ? 'VISION' : 'LLM';
  return {
    provider: s.provider || '',
    baseUrl: String(s.baseUrl || process.env[`${envPrefix}_BASE_URL`] || '').replace(/\/+$/, ''),
    model: s.model || process.env[`${envPrefix}_MODEL`] || '',
    apiKey: s.apiKey || process.env[`${envPrefix}_API_KEY`] || '',
    apiStyle: s.apiStyle === 'responses' ? 'responses' : 'chat',
    timeout: Number(all.model?.timeoutMs || process.env.LLM_TIMEOUT_MS || 60000),
    concurrency: Number(all.model?.concurrency || process.env.LLM_CONCURRENCY || 3),
  };
}

const ready = async (which) => {
  const c = await agentConfig(which);
  return Boolean(c.baseUrl && c.model && c.apiKey);
};

export async function agentReady() { return ready('model'); }

/** 未配置视觉模型时，前端禁用截图上传 */
export async function visionReady() { return ready('vision'); }

/** 把 Node fetch 的 "fetch failed" 翻译成能照着排查的说法 */
function describeNetworkError(e) {
  const code = e.cause?.code || e.code || '';
  const map = {
    ENOTFOUND: 'DNS 解析失败，检查 Base URL 域名是否写对',
    EAI_AGAIN: 'DNS 暂时不可用，检查网络',
    ECONNREFUSED: '连接被拒绝，服务未启动或端口不对（本地模型常见）',
    ECONNRESET: '连接被重置，可能是防火墙或代理拦截',
    ETIMEDOUT: '连接超时，检查网络或是否需要代理',
    CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书校验失败，可能被中间设备拦截',
    DEPTH_ZERO_SELF_SIGNED_CERT: '对方使用自签名证书',
  };
  const detail = map[code] || e.cause?.message || e.message || '未知网络错误';
  return `${detail}${code ? `（${code}）` : ''}。若公司网络需要代理，Node 不会自动读取系统代理设置`;
}

/** 调用模型，返回文本内容与用量。兼容 chat/completions 与 responses 两种接口形态。 */
async function callModel(cfg, messages, signal) {
  const isResponses = cfg.apiStyle === 'responses';
  const url = `${cfg.baseUrl}/${isResponses ? 'responses' : 'chat/completions'}`;

  const body = isResponses
    ? {
        model: cfg.model,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0,
        text: { format: { type: 'json_object' } },
      }
    : {
        model: cfg.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Node 的 fetch 失败只说 "fetch failed"，真正原因在 e.cause 里
    throw new Error(`无法连接 ${url} —— ${describeNetworkError(e)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 404 && isResponses) {
      hint = '。该服务可能不支持 responses 接口，把「接口形态」改成 chat 再试';
    } else if (res.status === 401 || res.status === 403) {
      hint = '。多半是 API Key 不对或没有该模型的权限';
    } else if (res.status === 400 && /model/i.test(text)) {
      hint = `。检查模型名称「${cfg.model}」是否存在`;
    } else if (res.status === 429) {
      hint = '。触发限流，可把「并发识别数」调小';
    }
    throw new Error(`模型接口返回 ${res.status}${hint}：${text.slice(0, 200)}`);
  }

  const json = await res.json();

  // responses 接口的返回结构在各家实现里略有出入，逐个兜底
  let content = '';
  if (isResponses) {
    content =
      json?.output_text ||
      json?.output?.[0]?.content?.[0]?.text ||
      json?.content?.[0]?.text ||
      json?.choices?.[0]?.message?.content ||
      '';
  } else {
    content = json?.choices?.[0]?.message?.content || '';
  }

  return { content, usage: json?.usage || null };
}

export async function extract(rawText, previous = null) {
  const cfg = await agentConfig();
  if (!agentReady()) {
    return { mode: 'mock', model: 'local-mock', promptVersion: PROMPT_VERSION, data: mockExtract(rawText), raw: null };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout);
  const started = Date.now();

  try {
    const { content, usage } = await callModel(cfg, buildMessages(rawText, previous), ctrl.signal);
    const data = safeParseJson(content);
    if (!data) throw new Error('模型返回内容不是合法 JSON：' + String(content).slice(0, 300));

    locateSources(data, rawText);

    return {
      mode: 'llm',
      model: cfg.model,
      promptVersion: PROMPT_VERSION,
      elapsedMs: Date.now() - started,
      usage,
      data,
      raw: content,
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`识别超时（${cfg.timeout / 1000}s），可在设置里调大超时时间`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 设置页的「测试连接」：发一条极短请求，验证 baseURL / key / 模型名 / 接口形态是否可用 */
export async function testConnection(which = 'model', override = null) {
  const cfg = override ? { ...await agentConfig(which), ...override } : await agentConfig(which);
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    return { ok: false, error: '请先填写 Base URL、模型名称和 API Key' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const started = Date.now();
  const url = `${cfg.baseUrl}/${cfg.apiStyle === 'responses' ? 'responses' : 'chat/completions'}`;
  try {
    const { content, usage } = await callModel(
      cfg,
      [
        { role: 'system', content: '只输出 JSON。' },
        { role: 'user', content: '返回 {"ok":true}' },
      ],
      ctrl.signal,
    );
    return {
      ok: true,
      url,
      elapsedMs: Date.now() - started,
      sample: String(content).slice(0, 120),
      usage,
      apiStyle: cfg.apiStyle,
    };
  } catch (e) {
    return {
      ok: false,
      url,
      elapsedMs: Date.now() - started,
      error: e.name === 'AbortError' ? '连接超时（20 秒）' : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================ 发货截图 */

export const SHIPMENT_PROMPT = `你从电商发货列表的截图中逐行提取发货记录。只输出 JSON，不要解释。

# 输出结构
{"rows":[{
  "recipient_name": "收件人姓名，原样照抄，可能是店铺名或带称谓",
  "phone_masked": "手机号，保持截图里的打码形式，如 18*****47",
  "address": "完整地址，把省市区和详细地址按截图顺序拼起来，保留其中的 ** 打码符号",
  "products": [{"name":"商品名","quantity":1}],
  "carrier": "快递公司，如 申通",
  "tracking_no": "快递单号，纯数字",
  "status": "如 待揽件"
}]}

# 铁律
1. 逐行提取，一行一条。同一行有多个商品就都放进 products 数组。
2. **同一个收件人可能出现多行**（一次发货拆成多个包裹），每行单独一条，不要合并。
3. 姓名、手机、地址一律照抄，**不要补全打码的部分**，不要猜测被 * 遮住的内容。
4. 单号是纯数字，去掉空格。
5. 商品名照抄。截图里常重复两遍（如「嗷哩嗷一桶，嗷哩嗷一桶」），取一遍即可。
6. 看不清或被截断的字段留空字符串，不要编造。
7. 只提取发货记录行，忽略表头、按钮、页签等界面元素。`;

/** 发货截图识别。用视觉模型，与文本模型分开配。 */
export async function extractShipment(imageBase64) {
  const cfg = await agentConfig('vision');
  if (!visionReady()) {
    const e = new Error('未配置视觉模型，请到「设置 → 视觉模型」填写后再上传截图');
    e.code = 'NO_VISION';
    throw e;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout);
  const started = Date.now();
  try {
    const { content, usage } = await callModel(cfg, [
      { role: 'system', content: SHIPMENT_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: '提取这张发货列表截图里的所有发货记录。' },
        { type: 'image_url', image_url: { url: imageBase64 } },
      ] },
    ], ctrl.signal);

    const data = safeParseJson(content);
    if (!data || !Array.isArray(data.rows)) {
      throw new Error('模型返回的不是预期结构：' + String(content).slice(0, 200));
    }
    return { mode: 'llm', model: cfg.model, elapsedMs: Date.now() - started, usage, data, raw: content };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`截图识别超时（${cfg.timeout / 1000} 秒）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在原文中回填每个字段的出处片段。
 * 模型不再返回 s，改由本地按值反查所在行 —— 输出 token 减半，且定位更可靠。
 */
export function locateSources(data, rawText) {
  const lines = String(rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const find = (v) => {
    const s = String(v ?? '').trim();
    if (s.length < 2) return '';
    return lines.find((l) => l.includes(s)) || '';
  };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if ('v' in node && !node.s) { node.s = find(node.v); return; }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return data;
}

function safeParseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* 继续尝试 */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* 放弃 */ } }
  return null;
}

/* ---------------------------------------------------------------- 本地降级 */

const PHONE_RE = /1[3-9]\d{9}/;
const CHATTY_RE = /(这两个|辛苦|谢谢|麻烦|可以吗|好的|宝子|开定向|高佣|直播间|吗[？?]?$|呢[？?]?$|[！!]$)/;
const NOTE_RE = /(菜鸟驿站|驿站|送上门|送货上门|别打电话|放[一-龥]{2,8}(超市|驿站|店|快递))/;
const F = (v, s, c) => ({ v: String(v).replace(/[|·～~\s]+$/, '').trim(), c, s: String(s).trim() });

/** 无 API key 时的兜底解析。覆盖常见格式，效果弱于 LLM，仅用于本地试跑。 */
export function mockExtract(text) {
  const out = {
    cooperation_type: /直播间|开定向|定向高佣/.test(text) ? '直播定向' : '寄样合作',
    creator_name: null, pet_category: null, sales_channel: null,
    accounts: [], recipient: { name: null, phone: null, address: null, delivery_note: null },
    phone_candidates: [], other_platform_accounts: [], ambiguities: [], ignored_text: [],
  };
  let cur = null;
  const ensure = () => cur || (cur = { nickname: null, douyin_id: null, uid: null, cooperation_code: null, profile_url: null });
  const push = () => { if (cur && Object.values(cur).some(Boolean)) out.accounts.push(cur); cur = null; };
  const bump = (k) => { if (ensure()[k]) push(); return ensure(); };

  for (const line of text.split('\n')) {
    const L = line.trim();
    if (!L || L === '-') { if (L) out.ignored_text.push(L); continue; }
    if (/^【.*】$/.test(L)) { out.ignored_text.push(L); continue; }

    if (/长按复制|打开抖音搜索|v\.douyin\.com/.test(L)) {
      const m = L.match(/https?:\/\/v\.douyin\.com\/\S+/);
      if (m) ensure().profile_url = F(m[0].replace(/[,，]$/, ''), m[0], 0.9);
      out.ignored_text.push(L);
      continue;
    }
    let m;
    if ((m = L.match(/(视频号\s*id|视频号|快手号|快手|小红书号?|微信号)\s*[:：]?\s*(\S+)/i))) {
      out.other_platform_accounts.push({
        platform: /视频号/.test(m[1]) ? '微信视频号' : /快手/.test(m[1]) ? '快手' : /小红书/.test(m[1]) ? '小红书' : '微信',
        account_id: m[2].trim(), source_text: L,
      });
      continue;
    }
    if ((m = L.match(/(?:账号\s*uid|抖音\s*uid|UserId|User\s*Id|UID|uid)\s*[:：]?\s*(\d{9,20})/i))) { bump('uid').uid = F(m[1], L, 0.93); continue; }
    if ((m = L.match(/(?:抖音)?合作码\s*[:：]?\s*(\d{6,20})/)))                                    { bump('cooperation_code').cooperation_code = F(m[1], L, 0.93); continue; }
    if ((m = L.match(/(?:抖音号码|抖音号|账号\s*id|抖音\s*id|抖音账号|账号ID|账号|^id)\s*[:：]?\s*([A-Za-z0-9._-]{4,30})/i))) { bump('douyin_id').douyin_id = F(m[1], L, 0.9); continue; }
    if ((m = L.match(/宠物类别[^:：]*[:：]\s*(\S+)/)))       { out.pet_category = F(m[1], L, 0.95); continue; }
    if ((m = L.match(/带货方式\s*[:：]?\s*(\S+)/)))          { out.sales_channel = F(m[1], L, 0.95); continue; }
    if ((m = L.match(/(?:抖音名称|抖音昵称|抖音名字|抖音名|账号名称|账号昵称|昵称|抖音)\s*[:：]?\s*(.+)/))) {
      const v = m[1].trim();
      if (v && !/^https?:/.test(v)) {
        bump('nickname').nickname = F(v, L, 0.9);
        if (!out.creator_name) out.creator_name = F(v, L, 0.85);
        continue;
      }
    }
    // 地址行必须先于手机、收件人判断：真实资料常把三者塞在同一行
    if ((m = L.match(/(?:收件地址|收货地址|收样地址|寄样信息地址|详细地址|所在地区|地址)\s*[:：]?\s*(.+)/))) { absorb(m[1], L, out); continue; }
    if ((m = L.match(/(?:手机号码|手机号|联系方式|联系电话|电话|手机)\s*[:：]?\s*(1[3-9]\d{9})/))) {
      const f = F(m[1], L, 0.95);
      out.phone_candidates.push(f);
      if (!out.recipient.phone) out.recipient.phone = f;
      continue;
    }
    if ((m = L.match(/(?:收件人|收货人|姓名)\s*[:：]?\s*(.+)/)))  { out.recipient.name = F(m[1], L, 0.92); continue; }

    const ph = L.match(PHONE_RE);
    if (ph && /[一-龥]{2,}(省|市|区|县|镇|村|街|路)/.test(L)) { absorb(L, L, out); continue; }
    if (ph) {
      const f = F(ph[0], L, 0.9);
      out.phone_candidates.push(f);
      if (!out.recipient.phone) out.recipient.phone = f;
      const nm = L.replace(ph[0], '').replace(/[，,\s]/g, '');
      if (nm && !out.recipient.name) out.recipient.name = F(nm, L, 0.7);
      continue;
    }
    // 裸行地址推断：必须含行政区划层级词，且不能像聊天句（避免「这两个号…」被当成地址）
    if (/[一-龥]{2,}(省|市|区|县|镇|村|街道)/.test(L) && L.length > 8 && !CHATTY_RE.test(L)) { absorb(L, L, out); continue; }
    if (/^[一-龥A-Za-z0-9]{2,18}$/.test(L)) {
      bump('nickname').nickname = F(L, L, 0.7);
      if (!out.creator_name) out.creator_name = F(L, L, 0.65);
      continue;
    }
    out.ignored_text.push(L);
  }
  push();
  if (!out.accounts.length) out.accounts.push({ nickname: null, douyin_id: null, uid: null, cooperation_code: null, profile_url: null });
  if (!out.creator_name && out.accounts[0]?.nickname) out.creator_name = { ...out.accounts[0].nickname, c: 0.8 };
  return out;
}

function absorb(raw, src, out) {
  // 行内可能还嵌着子字段名，先去掉，避免被当成姓名或地址的一部分
  let s = String(raw)
    .replace(/(?:手机号码|手机号|联系方式|联系电话|电话|收件人|收货人|姓名|所在地区|详细地址)\s*[:：]/g, ' ')
    .trim();
  const note = s.match(NOTE_RE) || s.match(/[（(]([^）)]{2,20})[）)]/);
  if (note) { out.recipient.delivery_note = F(note[0].replace(/[（()）]/g, ''), src, 0.9); s = s.replace(note[0], ' '); }
  const ph = s.match(PHONE_RE);
  if (ph) {
    const f = F(ph[0], src, 0.93);
    out.phone_candidates.push(f);
    if (!out.recipient.phone) out.recipient.phone = f;
    s = s.replace(ph[0], '|N|');
  }
  if (s.includes('|N|')) {
    const [a, b] = s.split('|N|');
    // 姓名可能在手机号前也可能在后；可能是网名或店铺名，放宽到 1-10 字
    const cand = [a.trim().split(/[，,、\s]/).filter(Boolean).pop() || '', b.trim().split(/[，,、\s]/).filter(Boolean)[0] || ''];
    const nm = cand.find((c) => /^[一-龥A-Za-z]{1,10}$/.test(c) && !/(省|市|区|县|镇|村|路|号|室|栋|楼|街|道|苑|园|小区)$/.test(c));
    if (nm && !out.recipient.name) out.recipient.name = F(nm, src, 0.72);
    // 姓名摘出来后要从串里去掉，否则下一步会把它当成地址的一部分。
    // 原来写的是 replace(nm || '\0', '') —— 拿 NUL 当「永不匹配」的哨兵，
    // 语义是对的，但那个字节留在源码里会让 grep / diff 把整个文件判成二进制。
    s = s.replace('|N|', ' ');
    if (nm) s = s.replace(nm, '');
  }
  s = s
    .replace(/[（(]\s*[）)]/g, ' ')
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > 4) {
    if (out.recipient.address) out.recipient.address.v = (out.recipient.address.v + ' ' + s).trim();
    else out.recipient.address = F(s, src, 0.88);
  }
}
