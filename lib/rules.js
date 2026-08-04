/**
 * 规则校验层 —— 确定性代码，不依赖模型。
 *
 * 职责（对齐蓝图 §17.2、§18.8）：
 *   1. 把 Agent 的输出规整成表单可直接绑定的结构
 *   2. 清洗噪声、纠正类型（合作码务必是字符串）
 *   3. 检出「商务肉眼看不出来」的四类静默错误
 *   4. 生成校验提示（一律不阻断提交）
 */

const PHONE_RE = /^1[3-9]\d{9}$/;
const DIGITS_11 = /^\d{11}$/;
const VIDEO_ACCOUNT_HINT = /^sph[A-Za-z0-9]{8,}$/;   // 微信视频号 id 的典型形态

const FULLWIDTH = { '０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9' };

/** 去噪 + 全角转半角。刻意不做语义纠正。 */
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

/**
 * 把 Agent 输出规整为表单结构 + 校验提示。
 * @returns {{form:object, fieldMeta:object, warnings:Array, ignored:Array}}
 */
export function normalize(extracted) {
  const e = extracted || {};
  const warnings = [];

  /* ---- 账号 ---- */
  const rawAccounts = Array.isArray(e.accounts) && e.accounts.length ? e.accounts : [{}];
  const accounts = [];
  const accountMeta = [];

  for (const a of rawAccounts) {
    const nickname = meta(a?.nickname);
    const douyinId = meta(a?.douyin_id ?? a?.douyinId);
    const uid = meta(a?.uid);
    const cooperationCode = meta(a?.cooperation_code ?? a?.cooperationCode);
    const profileUrl = meta(a?.profile_url ?? a?.profileUrl);

    // 静默错误 ①：其他平台 ID 漏进了抖音字段。模型偶尔会犯，这里兜一道。
    if (VIDEO_ACCOUNT_HINT.test(douyinId.value)) {
      warnings.push({
        level: 'error',
        code: 'CROSS_PLATFORM_LEAK',
        title: '疑似视频号 ID 被填入了抖音号',
        detail: `「${douyinId.value}」符合微信视频号 ID 的形态，已自动清空该抖音号并转存到其他平台账号。`,
      });
      if (!Array.isArray(e.other_platform_accounts)) e.other_platform_accounts = [];
      e.other_platform_accounts.push({ platform: '微信视频号', account_id: douyinId.value, source_text: douyinId.source });
      douyinId.value = '';
    }
    // UID 必须是纯数字
    if (uid.value && !/^\d{6,20}$/.test(uid.value)) {
      warnings.push({
        level: 'warn', code: 'UID_NOT_NUMERIC',
        title: 'UID 不是纯数字', detail: `「${uid.value}」不像 UID，请核对是否与抖音号填反。`,
      });
    }

    accounts.push({
      nickname: nickname.value,
      douyinId: douyinId.value,
      // 合作码与 UID 一律以字符串保存，避免前导零丢失
      uid: uid.value,
      cooperationCode: cooperationCode.value,
      profileUrl: profileUrl.value,
    });
    accountMeta.push({ nickname, douyinId, uid, cooperationCode, profileUrl });
  }

  // 静默错误 ②：UID 与合作码同为 11 位纯数字，商务肉眼无法判断是否填反
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

  // 静默错误 ③：合作码前导零。提醒界面不要当数字处理。
  accounts.forEach((a, i) => {
    if (/^0\d+$/.test(a.cooperationCode)) {
      warnings.push({
        level: 'info', code: 'COOP_LEADING_ZERO', accountIndex: i,
        title: `账号 ${i + 1}：合作码以 0 开头`,
        detail: `「${a.cooperationCode}」已按字符串保存，前导零不会丢失。`,
      });
    }
  });

  /* ---- 收件信息 ---- */
  const r = e.recipient || {};
  const rName = meta(r.name);
  const rPhone = meta(r.phone);
  const rAddr = meta(r.address);
  const rNote = meta(r.delivery_note ?? r.deliveryNote);

  if (rPhone.value && !PHONE_RE.test(rPhone.value)) {
    warnings.push({
      level: 'warn', code: 'PHONE_INVALID',
      title: '手机号格式不正确', detail: `「${rPhone.value}」不符合国内手机号规则，请核对。`,
    });
  }

  // 多个手机号 —— 商务需要选一个，系统不替他决定
  const candidates = [...new Set((e.phone_candidates || []).map(val).filter((v) => PHONE_RE.test(v)))];
  if (candidates.length > 1) {
    warnings.push({
      level: 'warn', code: 'MULTI_PHONE',
      title: `识别到 ${candidates.length} 个手机号`,
      detail: '原文中出现多个手机号且不一致，请确认哪个是收件手机。',
      candidates,
    });
  }

  /* ---- 其他平台 ---- */
  const otherAccounts = (e.other_platform_accounts || [])
    .map((o) => ({
      platform: cleanValue(o?.platform) || '其他',
      accountId: cleanValue(o?.account_id ?? o?.accountId),
      sourceText: String(o?.source_text ?? o?.sourceText ?? ''),
    }))
    .filter((o) => o.accountId);

  if (otherAccounts.length) {
    warnings.push({
      level: 'info', code: 'CROSS_PLATFORM_ISOLATED',
      title: `已隔离 ${otherAccounts.length} 个非抖音平台账号`,
      detail: '这些 ID 不会写入抖音账号字段，仅存档备查。',
      items: otherAccounts.map((o) => `${o.platform} ${o.accountId}`),
    });
  }

  /* ---- 模型自报的歧义 ---- */
  for (const am of e.ambiguities || []) {
    warnings.push({
      level: 'warn', code: 'AGENT_AMBIGUITY',
      title: `字段存在歧义：${am?.field || '未知'}`,
      detail: am?.reason || '模型无法确定该字段取值，请人工判断。',
      candidates: am?.candidates || [],
    });
  }

  /* ---- 合作类型 ---- */
  const cooperationType = e.cooperation_type === '直播定向' ? '直播定向' : '寄样合作';
  if (cooperationType === '直播定向') {
    warnings.push({
      level: 'info', code: 'LIVE_TARGETING',
      title: '识别为直播定向合作',
      detail: '该类型不寄样、不走视频审核，收件信息可以为空。',
    });
  }

  const creatorName = meta(e.creator_name ?? e.creatorName);
  const petCategory = meta(e.pet_category ?? e.petCategory);
  const salesChannel = meta(e.sales_channel ?? e.salesChannel);

  const form = {
    name: creatorName.value || accounts[0]?.nickname || '',
    cooperationType,
    petCategory: petCategory.value,
    salesChannel: salesChannel.value,
    accounts,
    otherAccounts,
    recipient: {
      name: rName.value,
      phone: rPhone.value,
      address: rAddr.value,
      deliveryNote: rNote.value,
    },
    phoneCandidates: candidates,
  };

  const fieldMeta = {
    name: creatorName, petCategory, salesChannel,
    accounts: accountMeta,
    recipient: { name: rName, phone: rPhone, address: rAddr, deliveryNote: rNote },
  };

  return { form, fieldMeta, warnings, ignored: e.ignored_text || [] };
}

/**
 * 提交前的完整性检查。
 * 只有两类真正阻断：完全没有账号标识、寄样合作缺收件信息。其余一律放行。
 */
export function validateForSubmit(form) {
  const blocking = [];
  const soft = [];

  const usable = (form.accounts || []).filter((a) => a.douyinId || a.uid);
  if (!usable.length) blocking.push('至少需要一个账号填写抖音号或 UID');

  if (form.cooperationType !== '直播定向') {
    const r = form.recipient || {};
    if (!r.name) soft.push('缺收件人');
    if (!r.phone) soft.push('缺手机号');
    if (!r.address) soft.push('缺地址');
  }

  (form.accounts || []).forEach((a, i) => {
    if (!a.cooperationCode) soft.push(`账号 ${i + 1} 缺合作码`);
  });
  if (!form.petCategory) soft.push('缺宠物类别（影响仓库发什么样品）');

  return { ok: blocking.length === 0, blocking, soft };
}

/** 入库前统一整理，确保类型正确 */
export function sanitizeForStore(form) {
  return {
    name: cleanValue(form.name),
    cooperationType: form.cooperationType === '直播定向' ? '直播定向' : '寄样合作',
    petCategory: cleanValue(form.petCategory),
    salesChannel: cleanValue(form.salesChannel),
    remark: cleanValue(form.remark),
    contactPhone: cleanValue(form.contactPhone),
    recipient: {
      name: cleanValue(form.recipient?.name),
      phone: cleanValue(form.recipient?.phone),
      address: cleanValue(form.recipient?.address),
      deliveryNote: cleanValue(form.recipient?.deliveryNote),
    },
    accounts: (form.accounts || [])
      .map((a) => ({
        nickname: cleanValue(a.nickname),
        douyinId: cleanValue(a.douyinId),
        uid: String(cleanValue(a.uid)),                 // 字符串
        cooperationCode: String(cleanValue(a.cooperationCode)), // 字符串，保前导零
        profileUrl: cleanValue(a.profileUrl),
      }))
      .filter((a) => a.nickname || a.douyinId || a.uid || a.cooperationCode),
    otherAccounts: (form.otherAccounts || [])
      .map((o) => ({
        platform: cleanValue(o.platform) || '其他',
        accountId: String(cleanValue(o.accountId)),
        sourceText: String(o.sourceText || ''),
      }))
      .filter((o) => o.accountId),
  };
}
