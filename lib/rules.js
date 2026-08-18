/**
 * 规则层 —— 确定性代码，不依赖模型，全部是纯函数。
 *
 * 职责（对齐蓝图 §17.2）：
 *   1. 输入路由：判断粘进来的是达人资料、视频口令还是发货截图
 *   2. 视频口令解析：正则即可，不必调 LLM
 *   3. 把 Agent 输出规整成表单结构
 *   4. 检出「商务肉眼看不出来」的静默错误
 *   5. 按动作分级校验
 *   6. 待办推导、告知话术渲染
 */

const PHONE_RE = /^1[3-9]\d{9}$/;
const DIGITS_11 = /^\d{11}$/;
const VIDEO_ACCOUNT_HINT = /^sph[A-Za-z0-9]{8,}$/;   // 微信视频号 id 的典型形态

const FULLWIDTH = { '０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9' };

export function cleanValue(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/[０-９]/g, (c) => FULLWIDTH[c])
    .replace(/^[\s:：]+/, '')
    .replace(/[|｜·～~\s.．]+$/, '')
    .trim();
}

const val = (f) => (f && typeof f === 'object' ? cleanValue(f.v) : cleanValue(f));
const conf = (f) => (f && typeof f === 'object' && typeof f.c === 'number' ? f.c : (val(f) ? 0.9 : 0));
const src  = (f) => (f && typeof f === 'object' ? String(f.s || '') : '');
const meta = (f) => ({ value: val(f), confidence: conf(f), source: src(f) });

/* ================================================================ 输入路由 */

/**
 * 判断一段输入该走哪条链路。全靠规则，不花钱不延迟。
 *
 * 关键保险是第 2 条：只要出现 UID / 合作码 / 手机号，一律判为建档。
 * 因为达人资料里常夹带抖音「主页口令」（含 v.douyin.com 链接），
 * 只看有没有链接会把建档资料误判成视频回传。
 */
export function routeInput(text, { hasImage = false } = {}) {
  if (hasImage) return { kind: 'shipment', confidence: 'high', reason: '输入是图片，按发货截图处理' };

  const t = String(text || '');
  if (!t.trim()) return { kind: 'unknown', confidence: 'low', reason: '输入为空' };

  const hasUid   = /(?:账号\s*uid|抖音\s*uid|UserId|User\s*Id|UID|uid)\s*[:：]?\s*\d{9,20}/i.test(t);
  const hasCode  = /(?:抖音)?合作码\s*[:：]?\s*\d{6,20}/.test(t);
  const hasPhone = /1[3-9]\d{9}/.test(t);
  const hasLink  = /v\.douyin\.com\//i.test(t);
  const hasNick  = /【[^】]{1,40}】/.test(t);
  const hasIntakeField = /(抖音号|账号\s*id|账号ID|昵称|抖音名|收件人|收货人|收件地址|详细地址|寄样)/i.test(t);

  const strongIntake = [hasUid && 'UID', hasCode && '合作码', hasPhone && '手机号'].filter(Boolean);
  if (strongIntake.length) {
    return { kind: 'intake', confidence: 'high', reason: `含 ${strongIntake.join('、')}`,
      note: hasLink ? '同时含抖音链接，但按建档处理（多半是主页口令）' : '' };
  }
  if (hasLink && hasNick) {
    return { kind: 'video', confidence: 'high', reason: '含抖音短链和【昵称】，无 UID/合作码/手机号' };
  }
  if (hasLink) {
    return { kind: 'video', confidence: 'medium', reason: '含抖音短链，但没识别到【昵称】，需手动选账号' };
  }
  if (hasIntakeField) {
    return { kind: 'intake', confidence: 'medium', reason: '含达人资料字段名，但缺 UID/合作码/手机号' };
  }
  return { kind: 'unknown', confidence: 'low', reason: '证据不足，请手动选择这段内容属于哪一类' };
}

/* ================================================================ 视频口令 */

/**
 * 解析抖音分享口令。只用正则，0 延迟 0 成本。
 *
 * shareToken 必须逐字节保存：完整口令是交接载荷 —— 复制整段打开抖音会自动跳转，
 * 投流时粘贴完整内容会自动加载素材。清洗掉尾串（如 ":9pm KWM:/ 01/13 z@T.Lw"）就会失效。
 * videoUrl 只是给界面做可点击预览用的，交接一律用 shareToken。
 */
export function parseVideoToken(text) {
  const shareToken = String(text ?? '');            // 原样，不 trim 不清洗
  const urlMatch = shareToken.match(/https?:\/\/v\.douyin\.com\/\S+/i);
  const nickMatch = shareToken.match(/【\s*([^】]+?)\s*】/);
  const nickname = nickMatch ? nickMatch[1].replace(/的作品$/, '').trim() : '';
  return {
    ok: Boolean(urlMatch),
    shareToken,
    videoUrl: urlMatch ? urlMatch[0] : '',
    nickname,
    error: urlMatch ? '' : '没找到 v.douyin.com 链接，这段可能不是视频口令',
  };
}

/**
 * 渲染告知达人的微信文案。
 *
 * 多包裹时 {快递公司} 和 {快递单号} 分别拼接会错位（「申通 / 申通」配两行单号），
 * 所以主占位符用 {物流} —— 每个包裹渲染成独立一行「承运商 单号」。
 * 另两个保留作兼容，取第一个包裹。
 */
export function renderNotifyText(template, collaboration) {
  const cb = collaboration || {};
  const pkgs = (cb.packages || []).filter((p) => p.trackingNo);
  const vars = {
    '{物流}': pkgs.map((p) => [p.carrier, p.trackingNo].filter(Boolean).join(' ')).join('\n'),
    '{达人}': cb.creatorName || '',
    '{收件人}': cb.recipient?.name || '',
    '{快递公司}': pkgs[0]?.carrier || '',
    '{快递单号}': pkgs.map((p) => p.trackingNo).join('、'),
    '{商品}': (cb.items || []).map((i) => `${i.productName} ×${i.quantity}`).join('\n'),
  };

  const out = [];
  for (const line of String(template || '').split('\n')) {
    const hadPlaceholder = /\{[^}]+\}/.test(line);
    let rendered = line;
    for (const [k, v] of Object.entries(vars)) rendered = rendered.split(k).join(v);
    // 整行只有占位符且全渲染为空 → 丢掉这行，避免留空行；
    // 模板里刻意写的空行不含占位符，会被保留
    if (hadPlaceholder && !rendered.trim()) continue;
    out.push(rendered);
  }
  return out.join('\n').trim();
}

/* ================================================================ 规整 */

export function normalize(extracted) {
  const e = extracted || {};
  const warnings = [];

  const rawAccounts = Array.isArray(e.accounts) && e.accounts.length ? e.accounts : [{}];
  const accounts = [];
  const accountMeta = [];

  for (const a of rawAccounts) {
    const nickname = meta(a?.nickname);
    const douyinId = meta(a?.douyin_id ?? a?.douyinId);
    const uid = meta(a?.uid);
    const cooperationCode = meta(a?.cooperation_code ?? a?.cooperationCode);
    const profileUrl = meta(a?.profile_url ?? a?.profileUrl);

    // 静默错误①：其他平台 ID 漏进抖音字段。模型偶尔会犯，这里兜一道
    if (VIDEO_ACCOUNT_HINT.test(douyinId.value)) {
      warnings.push({
        level: 'error', code: 'CROSS_PLATFORM_LEAK',
        title: '疑似视频号 ID 被填入了抖音号',
        detail: `「${douyinId.value}」符合微信视频号 ID 的形态，已清空该抖音号并转存到其他平台账号。`,
      });
      if (!Array.isArray(e.other_platform_accounts)) e.other_platform_accounts = [];
      e.other_platform_accounts.push({ platform: '微信视频号', account_id: douyinId.value, source_text: douyinId.source });
      douyinId.value = '';
    }
    if (uid.value && !/^\d{6,20}$/.test(uid.value)) {
      warnings.push({ level: 'warn', code: 'UID_NOT_NUMERIC',
        title: 'UID 不是纯数字', detail: `「${uid.value}」不像 UID，请核对是否与抖音号填反。` });
    }

    accounts.push({
      nickname: nickname.value, douyinId: douyinId.value,
      uid: uid.value,                       // 字符串
      cooperationCode: cooperationCode.value, // 字符串，保前导零
      profileUrl: profileUrl.value,
    });
    accountMeta.push({ nickname, douyinId, uid, cooperationCode, profileUrl });
  }

  // 静默错误②：UID 与合作码同为 11 位纯数字，商务肉眼判断不出是否填反
  accounts.forEach((a, i) => {
    if (DIGITS_11.test(a.uid) && DIGITS_11.test(a.cooperationCode)) {
      warnings.push({
        level: 'warn', code: 'UID_COOP_SAME_SHAPE', accountIndex: i,
        title: `账号 ${i + 1}：UID 与合作码形态相同`,
        detail: '两者都是 11 位纯数字，系统无法判断是否填反。达人填写时常把这两栏搞混。',
        swap: { uid: a.uid, cooperationCode: a.cooperationCode },
      });
    }
  });

  // 静默错误③：合作码前导零
  accounts.forEach((a, i) => {
    if (/^0\d+$/.test(a.cooperationCode)) {
      warnings.push({ level: 'info', code: 'COOP_LEADING_ZERO', accountIndex: i,
        title: `账号 ${i + 1}：合作码以 0 开头`,
        detail: `「${a.cooperationCode}」已按字符串保存，前导零不会丢失。` });
    }
  });

  const r = e.recipient || {};
  const rName = meta(r.name);
  const rPhone = meta(r.phone);
  const rAddr = meta(r.address);
  const rNote = meta(r.delivery_note ?? r.deliveryNote);

  if (rPhone.value && !PHONE_RE.test(rPhone.value)) {
    warnings.push({ level: 'warn', code: 'PHONE_INVALID',
      title: '手机号格式不正确', detail: `「${rPhone.value}」不符合国内手机号规则，请核对。` });
  }

  const candidates = [...new Set((e.phone_candidates || []).map(val).filter((v) => PHONE_RE.test(v)))];
  if (candidates.length > 1) {
    warnings.push({ level: 'warn', code: 'MULTI_PHONE',
      title: `识别到 ${candidates.length} 个手机号`,
      detail: '原文中出现多个手机号且不一致，请确认哪个是收件手机。', candidates });
  }

  const otherAccounts = (e.other_platform_accounts || [])
    .map((o) => ({
      platform: cleanValue(o?.platform) || '其他',
      accountId: cleanValue(o?.account_id ?? o?.accountId),
      sourceText: String(o?.source_text ?? o?.sourceText ?? ''),
    }))
    .filter((o) => o.accountId);

  if (otherAccounts.length) {
    warnings.push({ level: 'info', code: 'CROSS_PLATFORM_ISOLATED',
      title: `已隔离 ${otherAccounts.length} 个非抖音平台账号`,
      detail: '这些 ID 不会写入抖音账号字段，仅存档备查。',
      items: otherAccounts.map((o) => `${o.platform} ${o.accountId}`) });
  }

  for (const am of e.ambiguities || []) {
    warnings.push({ level: 'warn', code: 'AGENT_AMBIGUITY',
      title: `字段存在歧义：${am?.field || '未知'}`,
      detail: am?.reason || '模型无法确定该字段取值，请人工判断。',
      candidates: am?.candidates || [] });
  }

  const creatorName = meta(e.creator_name ?? e.creatorName);

  // 只有一条业务路径：一次合作 = 若干账号 + 若干产品 + 一个收件地址。
  // 合作类型、宠物类别、带货方式已从模型中移除 —— 前者只有一种，后两者在实际流程里没有分叉作用。
  const form = {
    name: creatorName.value || accounts[0]?.nickname || '',
    accounts,
    otherAccounts,
    recipient: {
      name: rName.value, phone: rPhone.value,
      address: rAddr.value, deliveryNote: rNote.value,
    },
    items: [],          // 商务手选，微信资料里没有
    sampleCost: null,   // 商务手填
    phoneCandidates: candidates,
  };

  const fieldMeta = {
    name: creatorName,
    accounts: accountMeta,
    recipient: { name: rName, phone: rPhone, address: rAddr, deliveryNote: rNote },
  };

  return { form, fieldMeta, warnings, ignored: e.ignored_text || [] };
}

/* ================================================================ 校验分级 */

export const ACTIONS = ['saveDraft', 'createRecord', 'submitSample', 'submitVideo'];

/**
 * 必填不挂在「记录」上，挂在「动作」上 —— 每个字段阻断的是真正需要它的那一步。
 *
 * 依据：27 条真实样本里 4 条完全没有合作码（其中一条一次挂 6 个账号），
 * 3 条只有 UID 没有抖音号。若把三者做成硬性必填，这些资料一条都录不进去，
 * 商务只能绕过系统。但合作码不该拦住寄样 —— 发货不需要它，它该拦的是投流。
 */
export function validateForAction(form, action) {
  const blocking = [];
  const soft = [];
  const f = form || {};
  const accounts = f.accounts || [];
  const usable = accounts.filter((a) => a.douyinId || a.uid);

  if (action === 'saveDraft') return { ok: true, blocking, soft };

  if (action === 'createRecord' || action === 'submitSample') {
    if (!usable.length) blocking.push('至少要有一个账号填了抖音号或 UID');
  }

  if (action === 'submitSample') {
    const r = f.recipient || {};
    if (!r.name) blocking.push('缺收件人');
    if (!r.phone) blocking.push('缺手机号');
    if (!r.address) blocking.push('缺收件地址');
    const items = (f.items || []).filter((i) => (i.productId || i.productName) && Number(i.quantity) > 0);
    if (!items.length) blocking.push('至少选一个寄样产品并填数量');
  }

  // 以下一律不阻断，只提示
  accounts.forEach((a, i) => {
    if (!a.cooperationCode) soft.push(`账号 ${i + 1} 缺合作码（不影响寄样，影响后续开定向）`);
  });
  if (action === 'submitSample' && (f.sampleCost === null || f.sampleCost === undefined || f.sampleCost === '')) {
    soft.push('未填寄样费用');
  }

  return { ok: blocking.length === 0, blocking, soft };
}

/** 视频口令提交校验 */
export function validateVideoSubmit({ shareToken, fulfillmentId }) {
  const blocking = [];
  const parsed = parseVideoToken(shareToken);
  if (!parsed.ok) blocking.push(parsed.error);
  if (!fulfillmentId) blocking.push('还没定位到具体的合作和抖音号');
  return { ok: blocking.length === 0, blocking, parsed };
}

/** 入库前统一整理，确保类型正确 */
export function sanitizeForStore(form) {
  const f = form || {};
  return {
    name: cleanValue(f.name),
    remark: cleanValue(f.remark),
    sampleCost: f.sampleCost === '' || f.sampleCost === null || f.sampleCost === undefined
      ? null : Number(f.sampleCost),
    recipient: {
      name: cleanValue(f.recipient?.name),
      phone: cleanValue(f.recipient?.phone),
      address: cleanValue(f.recipient?.address),
      deliveryNote: cleanValue(f.recipient?.deliveryNote),
    },
    accounts: (f.accounts || [])
      .map((a) => ({
        nickname: cleanValue(a.nickname),
        douyinId: cleanValue(a.douyinId),
        uid: String(cleanValue(a.uid)),                        // 字符串
        cooperationCode: String(cleanValue(a.cooperationCode)), // 字符串，保前导零
        profileUrl: cleanValue(a.profileUrl),
      }))
      .filter((a) => a.nickname || a.douyinId || a.uid || a.cooperationCode),
    otherAccounts: (f.otherAccounts || [])
      .map((o) => ({ platform: cleanValue(o.platform) || '其他',
        accountId: String(cleanValue(o.accountId)), sourceText: String(o.sourceText || '') }))
      .filter((o) => o.accountId),
    items: (f.items || [])
      .map((i) => ({ productId: i.productId || null, productName: cleanValue(i.productName),
        quantity: Number(i.quantity) || 1 }))
      .filter((i) => i.productId || i.productName),
  };
}

/* ================================================================ 发货截图匹配 */

const tidy = (s) => String(s ?? '').replace(/[\s，,。.、·]/g, '');

/** 解析打码手机号 `18*****47` → { pre:'18', suf:'47' } */
export function maskedPhoneParts(masked) {
  const m = String(masked || '').match(/^(\d{2,3})[^\d]+(\d{2,4})$/);
  return m ? { pre: m[1], suf: m[2] } : null;
}

export function normalizeShipmentRows(data) {
  return (data?.rows || []).map((r, i) => ({
    index: i,
    recipientName: cleanValue(r.recipient_name ?? r.recipientName),
    phoneMasked: String(r.phone_masked ?? r.phoneMasked ?? '').trim(),
    address: String(r.address ?? '').trim(),
    products: (r.products || []).map((p) => ({
      name: cleanValue(p?.name), quantity: Number(p?.quantity) || 1,
    })).filter((p) => p.name),
    carrier: cleanValue(r.carrier),
    trackingNo: String(r.tracking_no ?? r.trackingNo ?? '').replace(/\D/g, ''),
    status: cleanValue(r.status),
  })).filter((r) => r.trackingNo || r.recipientName);
}

/**
 * 给一条截图记录和一条合作打匹配分。
 *
 * 截图里手机号和地址门牌都是打码的，**不能做精确匹配**：
 *   18*****47 只剩首尾，南翔镇依仁路88弄**17号2501室 中间被遮。
 * 所以主键是 姓名 + 地址可见片段，手机首尾做消歧，商品仅作佐证
 *（截图里是速店通的 SKU 名，跟系统预置产品名大概率对不上）。
 */
export function scoreShipmentMatch(row, cb) {
  let score = 0;
  const why = [];
  const r = cb.recipient || {};

  const rn = tidy(row.recipientName);
  const cn = tidy(r.name);
  if (rn && cn) {
    if (rn === cn) { score += 50; why.push('姓名一致'); }
    else if (rn.includes(cn) || cn.includes(rn)) { score += 35; why.push('姓名包含'); }
  }

  const mp = maskedPhoneParts(row.phoneMasked);
  const cp = tidy(r.phone);
  if (mp && /^\d{11}$/.test(cp)) {
    if (cp.startsWith(mp.pre) && cp.endsWith(mp.suf)) { score += 25; why.push('手机首尾一致'); }
    else { score -= 30; why.push('手机首尾对不上'); }
  }

  // 地址按打码符号切成可见片段，看有多少能在合作地址里找到
  const frags = row.address.split(/[*＊…]+/).map(tidy).filter((s) => s.length >= 2);
  const ca = tidy(r.address);
  if (frags.length && ca) {
    const hit = frags.filter((f) => ca.includes(f));
    score += Math.round((hit.length / frags.length) * 30);
    if (hit.length) why.push(`地址片段 ${hit.length}/${frags.length}`);
  }

  const rp = row.products.map((p) => tidy(p.name));
  const cpn = (cb.items || []).map((i) => tidy(i.productName));
  if (rp.length && cpn.length && rp.some((a) => cpn.some((b) => a.includes(b) || b.includes(a)))) {
    score += 5; why.push('商品名有交集');
  }

  return { score: Math.max(0, score), why };
}

export const MATCH_HIGH = 60;
export const MATCH_LOW = 40;

/**
 * 把一张截图的所有记录匹配到候选合作。
 * 只在「待寄样 / 已寄样」里找 —— 已完成和已终止的不该再回填。
 * 单号已存在的直接标为已回填，避免重复。
 */
export function matchShipments(rows, collaborations) {
  const candidates = collaborations.filter((c) => ['待寄样', '已寄样'].includes(c.status));
  const known = new Set(collaborations.flatMap((c) => (c.packages || []).map((p) => p.trackingNo)));

  return rows.map((row) => {
    if (row.trackingNo && known.has(row.trackingNo)) {
      return { row, already: true, matches: [], best: null, level: 'already' };
    }
    const matches = candidates
      .map((cb) => ({ collaborationId: cb.id, ...scoreShipmentMatch(row, cb), collaboration: cb }))
      .filter((m) => m.score >= MATCH_LOW)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const best = matches[0] || null;
    // 前两名分差很小时不敢自动选，交人判断
    const ambiguous = matches.length > 1 && matches[0].score - matches[1].score < 10;
    const level = !best ? 'none' : (best.score >= MATCH_HIGH && !ambiguous) ? 'high' : 'low';
    return { row, already: false, matches, best, level, ambiguous };
  });
}

/* ================================================================ 待办 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * 待办全部由状态推导，不单独存表 —— 存了就会和真实状态不一致。
 *
 * 回访从「建档日期」起算（团队现行做法），不依赖发货时间；
 * 语义是回访不只是催拍：先问收没收到，收到了才催。
 */
export function buildTodos({ collaborations = [], drafts = [], jobs = [], followUp = {}, now = Date.now() }) {
  const todos = [];
  const firstDays = Number(followUp.firstDays ?? 7);
  const repeatDays = Number(followUp.repeatDays ?? 5);

  for (const d of drafts) {
    todos.push({ type: 'draft_incomplete', priority: 3,
      title: `草稿未完成：${d.title || '未命名'}`,
      detail: '资料还没提交，继续补完即可入库。',
      draftId: d.id, at: d.updatedAt });
  }

  for (const j of jobs) {
    if (j.status === 'failed') {
      todos.push({ type: 'job_failed', priority: 2,
        title: `识别失败：${j.title || j.id}`, detail: j.error || '可重试或改为手动录入。',
        jobId: j.id, at: j.finishedAt || j.createdAt });
    }
  }

  for (const cb of collaborations) {
    if (cb.status === '已终止') continue;
    const created = new Date(cb.createdAt).getTime();
    const ageDays = Math.floor((now - created) / DAY);
    const hasPackage = (cb.packages || []).length > 0;

    // 迁移来的老记录缺商品/费用
    if ((cb.items || []).length === 0) {
      todos.push({ type: 'complete_info', priority: 2,
        title: `补全合作信息：${cb.creatorName}`,
        detail: '这条合作还没有寄样产品和数量，仓库无法备货。',
        collaborationId: cb.id, at: cb.createdAt });
    }

    if (!hasPackage && cb.status === '待寄样') {
      todos.push({ type: 'fill_tracking', priority: 2,
        title: `等待快递单号：${cb.creatorName}`,
        detail: ageDays >= 3 ? `已提交寄样 ${ageDays} 天仍无单号，建议问一下仓库。` : '仓库发货后回填快递单号。',
        collaborationId: cb.id, overdue: ageDays >= 3, at: cb.createdAt });
    }

    if (hasPackage && !cb.notifiedAt) {
      todos.push({ type: 'notify_creator', priority: 1,
        title: `告知达人物流：${cb.creatorName}`,
        detail: '复制物流信息发微信给达人，发完标记已告知。',
        collaborationId: cb.id, at: cb.updatedAt });
    }

    const pending = (cb.fulfillments || []).filter(
      (f) => f.expectVideo && f.filmingProgress !== '已发布' && f.filmingProgress !== '本次不出片');
    if (pending.length && ageDays >= firstDays) {
      const contacted = pending.every((f) => f.filmingProgress === '已催拍');
      const due = contacted ? ageDays >= firstDays + repeatDays : true;
      if (due) {
        todos.push({ type: 'follow_up', priority: 1,
          title: `${contacted ? '再次催拍' : '回访'}：${cb.creatorName}`,
            detail: contacted
              ? `已催拍但仍未出片，${pending.length} 个账号待发布。`
              : `建档满 ${ageDays} 天，先问是否收到样品，收到了再催拍。${pending.length} 个账号待发布。`,
            collaborationId: cb.id, accountsPending: pending.length, at: cb.createdAt });
        }
      }
  }

  return todos.sort((a, b) => (a.priority - b.priority) || (a.at < b.at ? -1 : 1));
}
