/**
 * 耐萌 · 前端逻辑
 *
 * 两个入口：工作台、合作记录。
 *
 * 三条不动的规则：
 *   叙事主体是「一次合作」，不是一个达人
 *   状态由动作驱动 —— 界面上没有任何让人手选状态的下拉框
 *   视频口令逐字节保存，不 trim 不清洗
 *
 * 界面上只有一个确认容器（#drawer）。建档、视频回传、发货截图、合作详情
 * 全部用它，左边是系统的判断，右边恒为证据。以前这三类各有各的容器和布局，
 * 同样一件事要学三遍。
 */

/* ================================================================ 基础 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
/* 单引号也转。当前所有属性插值都用双引号，所以不转 ' 暂时不可利用 ——
   但那是「下一个人写 attr='${esc(x)}' 时才炸」的坑，而炸的时候
   没人会想到是转义函数少了一个字符。多转一个字符没有代价。 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('zh-CN') : '—');
const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN') : '—');
const daysAgo = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return d <= 0 ? '今天' : `${d} 天前`;
};

let CFG = null;          // /api/config
let PRODUCTS = [];       // 产品列表
let S = null;            // 当前建档会话
let V = null;            // 当前视频会话
let SB = null;           // 当前发货截图会话
let t0 = 0, draftId = null, jobId = null, poller = null, routeTimer = null, lastRoute = null;

function toast(msg) { const t = el('div', 'toast', esc(msg)); document.body.append(t); setTimeout(() => t.remove(), 3200); }

/* 身份不再由前端自报。
   以前是把 userId 存 localStorage 再塞进 X-User-Id，任何人改个请求头
   就能变成别人 —— 局域网上线后那些按归属拦截的 403 会形同虚设。
   现在身份在服务端签名的 HttpOnly cookie 里，前端读不到也改不了，
   请求只要带上 credentials 即可。 */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: '响应解析失败' }));
  if (!res.ok) {
    // 会话过期或被踢下线时直接回登录屏，而不是抛一堆看不懂的错误
    if (res.status === 401 && !path.startsWith('/api/auth/')) { showLogin(); }
    const e = new Error(data.error || '请求失败'); e.data = data; e.status = res.status; throw e;
  }
  return data;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

const PRESETS = [
  { n: 'DeepSeek', p: 'DeepSeek', b: 'https://api.deepseek.com/v1', m: 'deepseek-chat' },
  { n: '通义千问', p: '阿里云百炼', b: 'https://dashscope.aliyuncs.com/compatible-mode/v1', m: 'qwen-plus' },
  { n: '豆包', p: '火山方舟', b: 'https://ark.cn-beijing.volces.com/api/v3', m: 'doubao-pro-32k' },
  { n: 'Kimi', p: 'Moonshot', b: 'https://api.moonshot.cn/v1', m: 'moonshot-v1-8k' },
  { n: '智谱', p: '智谱AI', b: 'https://open.bigmodel.cn/api/paas/v4', m: 'glm-4-flash' },
  { n: '本地 Ollama', p: 'Ollama', b: 'http://127.0.0.1:11434/v1', m: 'qwen2.5:14b' },
];
const V_PRESETS = [
  { n: '通义千问 VL', p: '阿里云百炼', b: 'https://dashscope.aliyuncs.com/compatible-mode/v1', m: 'qwen-vl-max' },
  { n: '豆包 Vision', p: '火山方舟', b: 'https://ark.cn-beijing.volces.com/api/v3', m: 'doubao-vision-pro-32k' },
  { n: '智谱 GLM-4V', p: '智谱AI', b: 'https://open.bigmodel.cn/api/paas/v4', m: 'glm-4v-flash' },
  { n: 'Kimi Vision', p: 'Moonshot', b: 'https://api.moonshot.cn/v1', m: 'moonshot-v1-8k-vision-preview' },
];

/* ================================================================ 启动 */

boot();

async function boot() {
  $('#presets').append(...PRESETS.map((p) => mkPreset(p, 'm')));
  $('#vPresets').append(...V_PRESETS.map((p) => mkPreset(p, 'v')));

  // 先看有没有有效会话；没有就停在登录屏，不去拉任何业务数据
  try {
    await refreshConfig();
  } catch (e) {
    if (e.status === 401) return showLogin();
    throw e;
  }
  await afterLogin();
}

async function afterLogin() {
  $('#login').classList.remove('on');
  await loadProducts();
  loadDesk(); loadRecords();
}

/* ================================================================ 登录 */

const lErr = (msg) => { $('#lErr').textContent = msg || ''; };
const lStep = (id) => $$('.lstep').forEach((s) => s.classList.toggle('on', s.id === id));

async function showLogin() {
  $('#login').classList.add('on');
  lErr('');
  let st;
  try { st = await api('GET', '/api/auth/state'); } catch { st = { needsBootstrap: false }; }
  if (st.needsBootstrap) {
    $('#lSub').textContent = '首次使用 —— 设置团队口令';
    lStep('lBoot');
    $('#bPass').focus();
  } else {
    $('#lSub').textContent = '输入团队口令';
    lStep('lPass');
    $('#lPassInput').focus();
  }
}

async function enterWith(payload) {
  lErr('');
  try {
    const r = await api('POST', '/api/auth/login', payload);
    if (r.needPick) {
      $('#lSub').textContent = '口令正确 —— 选一下你是谁';
      const box = $('#lUsers'); box.innerHTML = '';
      r.users.forEach((u) => {
        const b = el('button', null, `${esc(u.name)} · ${esc((r.roles.find((x) => x.id === u.role) || {}).name || '')}`);
        b.onclick = () => enterWith({ passphrase: passCache, userId: u.id });
        box.append(b);
      });
      if (!r.users.length) box.append(el('div', 'dim', '还没有成员，下面填姓名进入'));
      lStep('lPick');
      return;
    }
    await refreshConfig();
    await afterLogin();
    toast(`欢迎，${r.me.name}`);
  } catch (e) { lErr(e.message); }
}

let passCache = '';

$('#lPassGo').onclick = () => {
  passCache = $('#lPassInput').value;
  if (!passCache) { lErr('请输入团队口令'); return; }
  enterWith({ passphrase: passCache });
};
$('#lPassInput').onkeydown = (e) => { if (e.key === 'Enter') $('#lPassGo').click(); };

$('#lNewGo').onclick = () => {
  const name = $('#lName').value.trim();
  if (!name) { lErr('请填写姓名'); return; }
  enterWith({ passphrase: passCache, name, role: $('#lRole').value });
};

$('#bGo').onclick = async () => {
  lErr('');
  const passphrase = $('#bPass').value;
  const name = $('#bName').value.trim();
  if (passphrase.length < 6) { lErr('团队口令至少 6 位'); return; }
  if (!name) { lErr('请填写你的姓名'); return; }
  try {
    const r = await api('POST', '/api/auth/bootstrap', { passphrase, name, role: $('#bRole').value });
    await refreshConfig();
    await afterLogin();
    toast(`已初始化，欢迎 ${r.me.name}`);
  } catch (e) { lErr(e.message); }
};

function mkPreset(p, prefix) {
  const b = el('button', null, esc(p.n));
  b.onclick = () => {
    $(`#${prefix}Provider`).value = p.p; $(`#${prefix}Base`).value = p.b; $(`#${prefix}Model`).value = p.m;
    setStyle(prefix, 'chat');
  };
  return b;
}

async function refreshConfig() {
  CFG = await api('GET', '/api/config');
  const b = $('#modeBadge');
  if (CFG.agentReady) { b.className = 'badge llm'; b.textContent = CFG.model; }
  else { b.className = 'badge mock'; b.textContent = '本地模拟识别'; }
  const roleName = (CFG.roles.find((r) => r.id === CFG.me?.role) || {}).name || '';
  $('#whoAmI').innerHTML = CFG.me
    ? `${esc(CFG.me.name)} · ${esc(roleName)}`
    : '<b style="color:var(--red)">未设置身份</b>';
  $('#setupNote').style.display = 'none';   // 身份已由登录决定，设置页不再承担初始化
  applyRole();
  fillSettings();
}

async function loadProducts() {
  PRODUCTS = (await api('GET', '/api/products?all=1')).products;
  renderProductList();
}

/**
 * 角色裁剪。
 *
 * 以前四个角色看到的界面完全一样，包括 API Key 设置 —— 仓库不录达人，
 * 运营不寄样，让他们对着一个粘贴框发呆没有意义，把密钥摆在那儿也不合适。
 */
const roleOf = () => CFG?.me?.role || 'business';
const canIntake = () => roleOf() === 'business';
const canConfigModel = () => roleOf() === 'business';

function applyRole() {
  const r = roleOf();
  $('#paster').style.display = (r === 'operations') ? 'none' : '';
  // 仓库只上传发货截图，不录达人资料
  $('#raw').style.display = canIntake() ? '' : 'none';
  $('#go').style.display = canIntake() ? '' : 'none';
  $('#pasteHint').textContent = canIntake()
    ? '粘贴微信内容 —— 达人资料、视频口令、发货截图都往这里放，系统自己分'
    : '上传仓库的发货列表截图，识别后批量回填快递单号';
  $$('.settings nav button').forEach((b) => {
    if (b.dataset.panel === 'model' || b.dataset.panel === 'vision') {
      b.style.display = canConfigModel() ? '' : 'none';
    }
  });
}

/* ================================================================ 导航 */

$$('.tabs button').forEach((b) => {
  b.onclick = () => {
    $$('.tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    $$('.page').forEach((p) => p.classList.remove('on'));
    $('#p-' + b.dataset.tab).classList.add('on');
    if (b.dataset.tab === 'records') loadRecords(); else loadDesk();
  };
});
const goTab = (n) => document.querySelector(`.tabs button[data-tab="${n}"]`).click();

/* ================================================================ 统一抽屉 */

let onDrawerClose = null;

/**
 * 三类确认与合作详情共用这一个容器。
 * left 是系统的判断，right 恒为证据 —— 商务只要学一次「往右看」。
 */
function openDrawer({ title, tags = [], right = null, foot = [], onClose = null }) {
  const h = $('#drHead'); h.innerHTML = '';
  h.append(el('b', null, esc(title)));
  tags.forEach((t) => h.append(el('span', 'st ' + (t.cls || 'queued'), esc(t.text))));
  h.append(el('span', 'grow'));
  const x = el('button', 'btn sm', '关闭');
  x.onclick = closeDrawer;
  h.append(x);

  $('#drLeft').innerHTML = '';
  $('#drRight').innerHTML = '';
  $('#drRight').style.display = right === false ? 'none' : '';
  $('.dr-b').style.gridTemplateColumns = right === false ? '1fr' : '';

  const f = $('#drFoot'); f.innerHTML = '';
  foot.forEach((n) => f.append(n));
  f.style.display = foot.length ? '' : 'none';

  onDrawerClose = onClose;
  $('#drawer').classList.add('on');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  $('#drawer').classList.remove('on');
  document.body.style.overflow = '';
  const cb = onDrawerClose; onDrawerClose = null;
  if (cb) cb();
}
const drawerOpen = () => $('#drawer').classList.contains('on');

$('#drawer').onclick = (e) => { if (e.target.id === 'drawer') closeDrawer(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen()) closeDrawer(); });

/* ================================================================ 粘贴条 */

const KIND_LABEL = { intake: '建档 / 新合作', video: '视频回传', shipment: '发货截图', unknown: '无法判断' };

const expand = () => { $('#paster').classList.add('exp'); $('#raw').focus(); };
$('#pasteHint').onclick = expand;
$('#paster').addEventListener('focusin', () => $('#paster').classList.add('exp'));
$('#clearRaw').onclick = () => {
  $('#raw').value = ''; $('#routeBar').classList.remove('on'); lastRoute = null;
  setTip(''); $('#paster').classList.remove('exp');
};

$('#raw').addEventListener('input', scheduleRoute);
$('#raw').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitInput(); }
});

function scheduleRoute() { clearTimeout(routeTimer); routeTimer = setTimeout(doRoute, 260); }

async function doRoute() {
  const text = $('#raw').value;
  const bar = $('#routeBar');
  if (!text.trim()) { bar.classList.remove('on'); lastRoute = null; return; }
  try {
    lastRoute = await api('POST', '/api/route', { rawText: text });
    bar.className = 'routebar on' + (lastRoute.confidence === 'low' || lastRoute.kind === 'unknown' ? ' warn' : '');
    $('#routeKind').textContent = KIND_LABEL[lastRoute.kind] || lastRoute.kind;
    $('#routeReason').textContent = [lastRoute.reason, lastRoute.note].filter(Boolean).join(' ｜ ');
  } catch { bar.classList.remove('on'); }
}

$('#go').onclick = submitInput;

async function submitInput() {
  const text = $('#raw').value.trim();
  if (!text) { setTip('请先粘贴内容', true); return; }
  const forced = $('#routeOverride').value;
  const kind = forced || lastRoute?.kind || 'intake';
  if (kind === 'unknown') { setTip('判断不出这段内容属于哪一类，请用右边的下拉手动指定。', true); return; }

  $('#go').disabled = true;
  try {
    if (kind === 'video') await submitVideoToken(text);
    else await enqueueIntake(text);
  } catch (e) {
    setTip(e.message, true);
    if (e.status === 428) openSettings('user');
  } finally { $('#go').disabled = false; }
}

function setTip(msg, isErr) {
  $('#tip').className = 'tip' + (isErr ? ' err' : '');
  $('#tip').textContent = msg || '';
}

function resetPaster() {
  $('#raw').value = ''; $('#routeBar').classList.remove('on'); lastRoute = null;
  $('#paster').classList.remove('exp');
}

async function enqueueIntake(text) {
  await api('POST', '/api/jobs', { rawText: text });
  resetPaster();
  setTip('');
  toast('已加入队列，可以继续粘下一位');
  loadDesk();
  $('#raw').focus();
}

async function submitVideoToken(text) {
  V = await api('POST', '/api/video/parse', { rawText: text });
  V.shareToken = text;
  V.chosen = V.matches.find((m) => !m.alreadyHasVideo)?.fulfillmentId || V.matches[0]?.fulfillmentId || '';
  resetPaster();
  openVideoDrawer();
}

/* ---------- 截图 ---------- */

$('#pickImg').onclick = () => {
  if (!CFG?.visionReady) { openSettings('vision'); toast('先配置视觉模型才能识别截图'); return; }
  $('#imgInput').click();
};
$('#imgInput').onchange = (e) => { acceptImage(e.target.files[0]); e.target.value = ''; };

document.addEventListener('paste', (e) => {
  if (drawerOpen() || $('#settings').classList.contains('on')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  acceptImage(item.getAsFile());
});

async function acceptImage(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('只支持 PNG / JPG / WebP'); return; }
  if (!CFG?.visionReady) { openSettings('vision'); toast('先配置视觉模型才能识别截图'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('图片超过 8MB，请压缩后再传'); return; }
  const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  try {
    await api('POST', '/api/jobs', { imageBase64: dataUrl });
    toast('截图已加入队列，识别完成后在下面批量确认');
    loadDesk();
  } catch (e) { setTip(e.message, true); if (e.status === 428) openSettings('user'); }
}

/* ================================================================ 需要处理 */

const ST = { queued: '排队中', running: '识别中', done: '待确认', failed: '识别失败' };
const TODO_LABEL = {
  notify_creator: '告知物流', follow_up: '回访催拍', fill_tracking: '等快递单号',
  complete_info: '补全信息', draft_incomplete: '草稿未完成', job_failed: '识别失败',
};

/**
 * 识别队列和待办本来就是同一件事：等着你动手的东西。
 * 以前拆成两个 tab，商务在待办里看到「该催拍了」，想看详情还得切页面重搜一遍。
 */
async function loadDesk() {
  const box = $('#deskBody');
  let jobs = [], todos = [];
  try { jobs = (await api('GET', '/api/jobs')).jobs; } catch { /* 未设身份时静默 */ }
  try { todos = (await api('GET', '/api/todos')).todos; } catch { /* 同上 */ }

  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const total = jobs.length + todos.length;
  $('#nDesk').textContent = total || '';

  box.innerHTML = '';
  if (!total) {
    box.append(el('div', 'empty', canIntake()
      ? '没有待处理的事。<br>把微信里的达人资料或视频口令粘到上面就行。'
      : '没有待处理的事。'));
    stopPoll(); return;
  }

  const grp = el('div', 'grp');
  const h = el('div', 'grp-h');
  h.append(el('b', null, '需要处理'), el('span', null, `${total} 件`));
  grp.append(h);

  jobs.forEach((j) => grp.append(jobRow(j)));
  todos.forEach((t) => grp.append(todoRow(t)));
  box.append(grp);

  if (pending) startPoll(); else stopPoll();
}

function startPoll() { if (!poller) poller = setInterval(loadDesk, 1800); }
function stopPoll() { if (poller) { clearInterval(poller); poller = null; } }

function jobRow(j) {
  const s = j.summary;
  const busy = j.status === 'queued' || j.status === 'running';
  const isDup = !!(s?.dupInDb || s?.dupInQueue);
  const isShip = j.kind === 'shipment';
  const it = el('div', 'item' + (j.status === 'failed' || isDup ? ' bad' : busy || j.status === 'done' ? ' acc' : ''));

  const info = el('div');
  const t = el('div', 'it-t');
  t.append(el('b', null, esc(s?.name || j.title || (isShip ? '发货截图' : '—'))));
  if (busy) t.append(el('span', 'st running', '<span class="spin"></span> 识别中'));
  else if (j.status === 'done') t.append(el('span', 'st done', '识别完成'));
  else if (j.status === 'failed') t.append(el('span', 'st failed', '识别失败'));
  if (s?.missing) t.append(el('span', 'st p2', `${s.missing} 项待补充`));
  if (s?.dupInDb) t.append(el('span', 'st dupt', '已有达人'));
  else if (s?.dupInQueue) t.append(el('span', 'st dupt', '与队列中另一条重复'));
  info.append(t);

  let sub = '';
  if (j.status === 'failed') sub = j.error || '识别失败';
  else if (busy) sub = isShip ? '截图识别中，一张图可能有十几条记录' : '识别在后台进行，可以继续粘下一条';
  else if (isShip && s?.shipment) {
    const c = s.shipment;
    sub = [`${c.total} 条邮寄记录`,
      c.high ? `${c.high} 条高置信自动匹配` : '',
      c.low ? `${c.low} 条需核对` : '',
      c.none ? `${c.none} 条没匹配上` : ''].filter(Boolean).join(' · ');
  } else if (s) {
    sub = [isDup ? '建档（将作为新合作）' : '建档', `${s.accounts} 个账号`].join(' · ');
  }
  info.append(el('div', 'it-s', esc(sub)));

  const acts = el('div', 'acts');
  if (j.status === 'done') {
    const b = el('button', 'btn primary sm', isShip ? '逐条核对' : '确认');
    b.onclick = () => (isShip ? openShipment(j.id) : openJob(j.id));
    acts.append(b);
  }
  if (j.status === 'failed') {
    const b = el('button', 'btn sm', '重试');
    b.onclick = async () => { await api('POST', `/api/jobs/${j.id}/retry`); loadDesk(); };
    acts.append(b);
  }
  const d = el('button', 'btn sm danger', busy ? '取消' : '丢弃');
  d.onclick = async () => { await api('DELETE', '/api/jobs/' + j.id); loadDesk(); };
  acts.append(d);

  it.append(info, acts);
  return it;
}

function todoRow(t) {
  const it = el('div', 'item' + (t.overdue ? ' bad' : ''));
  const info = el('div');
  const tt = el('div', 'it-t');
  tt.append(el('b', null, esc(t.title)));
  tt.append(el('span', 'st p' + t.priority, TODO_LABEL[t.type] || t.type));
  if (t.overdue) tt.append(el('span', 'st dupt', '逾期'));
  info.append(tt, el('div', 'it-s', esc(t.detail || '')));

  const acts = el('div', 'acts');
  if (t.type === 'notify_creator') {
    /* **复制即视为已告知**，和合作详情里那个按钮同一套语义。
       之前这里是「复制文案」+「标记已告知」两个按钮，而详情里是一步 ——
       同一个动作两个界面两种做法，用哪边的人都会觉得另一边不对劲。

       统一成一步的理由：这个按钮存在的唯一目的就是把物流信息粘给达人，
       复制完再点一下「我复制了」，是让人做一件系统已经知道的事。
       代价（复制了没发出去）在两个界面上现在也是一致的。 */
    const cp = el('button', 'btn primary sm', '复制物流并标记已告知');
    cp.onclick = async () => {
      const { notifyText } = await api('GET', '/api/collaborations/' + t.collaborationId);
      if (!await copy(notifyText)) { toast('复制失败'); return; }
      await api('POST', `/api/collaborations/${t.collaborationId}/notified`, { value: true });
      toast('已复制，去微信发给达人'); loadDesk();
    };
    acts.append(cp);
  }
  if (t.type === 'fill_tracking') {
    const b = el('button', 'btn primary sm', '回填快递');
    b.onclick = () => openTrackingModal(t.collaborationId);
    acts.append(b);
  }
  if (t.type === 'follow_up') {
    const b = el('button', 'btn primary sm', '记录回访');
    b.onclick = () => openFollowUpModal(t.collaborationId);
    acts.append(b);
  }
  if (t.type === 'complete_info') {
    const b = el('button', 'btn primary sm', '补全');
    b.onclick = () => openCollaboration(t.collaborationId);
    acts.append(b);
  }
  if (t.type === 'draft_incomplete') {
    const b = el('button', 'btn primary sm', '继续录入');
    b.onclick = async () => {
      const { draft } = await api('GET', '/api/drafts/' + t.draftId);
      S = { form: draft.form, fieldMeta: {}, warnings: [], ignored: [], rawText: draft.rawText,
        extracted: draft.extracted, mode: 'draft', model: '—', elapsedMs: 0, creatorId: null };
      draftId = draft.id; jobId = null; t0 = Date.now();
      openIntakeDrawer();
    };
    const d = el('button', 'btn sm danger', '删除');
    d.onclick = async () => { if (!confirm('删除该草稿？')) return; await api('DELETE', '/api/drafts/' + t.draftId); loadDesk(); };
    acts.append(b, d);
  }
  if (t.type === 'job_failed') {
    const b = el('button', 'btn sm', '重试');
    b.onclick = async () => { await api('POST', `/api/jobs/${t.jobId}/retry`); loadDesk(); };
    acts.append(b);
  }
  if (t.collaborationId) {
    const v = el('button', 'btn sm', '详情');
    v.onclick = () => openCollaboration(t.collaborationId);
    acts.append(v);
  }
  it.append(info, acts);
  return it;
}

/* ================================================================ 建档确认 */

async function openJob(id) {
  const { job } = await api('GET', '/api/jobs/' + id);
  if (!job.result) return;
  S = { ...job.result, rawText: job.rawText, creatorId: null };
  const dup = (S.conflicts?.hard || [])[0];
  if (dup) S.creatorId = dup.existing.creatorId;   // 命中已有达人时默认走「发起新合作」
  jobId = id; draftId = null; t0 = Date.now();
  openIntakeDrawer();
}

function openIntakeDrawer() {
  const jump = el('button', 'btn sm', '下一个待补充');
  jump.append(el('span', 'kbd', 'Alt+N'));
  jump.id = 'jump';
  jump.onclick = jumpNext;

  const discard = el('button', 'btn danger', '丢弃');
  discard.onclick = () => discardCurrent(false);
  const draft = el('button', 'btn', '存草稿');
  draft.onclick = saveDraft;
  const rec = el('button', 'btn', '仅建档，暂不寄样');
  rec.id = 'recOnly';
  rec.onclick = () => submitCollaboration('createRecord');
  const smp = el('button', 'btn primary', '确认并提交寄样');
  smp.id = 'submitSample';
  smp.onclick = () => submitCollaboration('submitSample');
  const warn = el('span', 'it-s grow'); warn.id = 'fWarn';

  openDrawer({
    title: S.creatorId ? '新增一次合作' : '新建合作',
    tags: [],
    foot: [discard, warn, draft, rec, smp],
    onClose: () => { S = null; loadDesk(); },
  });
  $('#drHead').insertBefore(jump, $('#drHead').lastChild);

  $('#drLeft').innerHTML = `
    <div id="alerts"></div>
    <div class="rh" id="creatorNote"></div>
    <div class="fgrid" id="gCreator"></div>
    <div class="rh">抖音账号 <span id="acctNote"></span></div>
    <div id="gAcct"></div>
    <div style="margin-bottom:12px"><button class="btn sm" id="addAcct">+ 再加一个账号</button></div>
    <div class="rh">合作类型</div>
    <div class="seg" id="typeSeg" style="margin-bottom:12px"></div>
    <div id="shipBlock">
      <div class="rh">寄样产品 <span id="itemNote"></span></div>
      <div id="gItems"></div>
      <div style="margin:8px 0 12px"><button class="btn sm" id="addItem">+ 再加一个产品</button></div>
      <div class="fgrid" id="gCost"></div>
      <div class="rh">收件信息</div>
      <div id="gRecip"></div>
    </div>
    <div id="shipFold" style="display:none;margin-bottom:12px">
      <button class="btn sm" id="unfoldShip">展开产品和收件信息</button>
      <span class="dim" style="margin-left:8px">不寄样合作不需要填，展开只是备用</span>
    </div>`;
  $('#drRight').innerHTML = `
    <div class="rh">原文 · 点字段高亮出处 <span id="srcMeta"></span></div>
    <div class="src" id="srcPre"></div>
    <div class="rh">资料分几条消息发来？</div>
    <textarea id="more" placeholder="继续粘贴新片段…"
      style="width:100%;min-height:70px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font:12.5px/1.6 inherit"></textarea>
    <button class="btn sm" id="merge" style="margin-top:8px">合并识别</button>
    <div class="rh" id="counts" style="margin-top:14px"></div>
    <div class="rh" id="agentInfo"></div>`;

  $('#unfoldShip').onclick = () => { S.shipUnfolded = true; renderForm(); };

  $('#addAcct').onclick = () => { S.form.accounts.push({ nickname: '', douyinId: '', uid: '', cooperationCode: '', profileUrl: '' }); renderForm(); };
  $('#addItem').onclick = () => { S.form.items.push({ productId: null, productName: '', quantity: 1 }); renderItems(); recount(); };
  $('#merge').onclick = mergeMore;

  renderForm();
  setTimeout(() => ($('#drLeft .f.miss input') || $('#drLeft .f input'))?.focus(), 60);
}

function fld(label, path, value, m, opt = {}) {
  const has = !!(value && String(value).trim());
  const low = has && m && m.confidence && m.confidence < 0.85;
  // 选填字段空着是正常状态，不标「待补充」，也不被 Alt+N 跳过去。
  // 配送备注的 placeholder 写着「无则留空」，却又被算进待补充还抢焦点，自相矛盾。
  const w = el('div', 'f' + (has ? (low ? ' chk' : '') : (opt.optional ? '' : ' miss')));
  const lab = el('label'); lab.append(document.createTextNode(label));
  if (!has && !opt.optional) lab.append(el('span', 'tag miss', '待补充'));
  else if (low) lab.append(el('span', 'tag chk', '需核对'));
  else if (opt.optional && !has) lab.append(el('span', 'tag opt', '选填'));
  if (low) w.dataset.low = '1';
  if (opt.optional) w.dataset.optional = '1';
  const inp = el('input');
  inp.value = has ? value : ''; inp.placeholder = opt.ph || '未识别，请补充';
  inp.oninput = (e) => { setPath(path, e.target.value); recount(); };
  inp.onfocus = () => mark(m?.source); inp.onblur = () => mark(null);
  w.append(lab, inp); return w;
}

function setPath(path, v) {
  const seg = path.split('.'); let o = S.form;
  for (let i = 0; i < seg.length - 1; i++) o = o[/^\d+$/.test(seg[i]) ? Number(seg[i]) : seg[i]];
  o[seg[seg.length - 1]] = v;
}

/** 合作类型。和 rules.js 的 COLLAB_TYPES 一致 —— ui.test.js 有断言守着不许分叉 */
const COLLAB_TYPES = ['寄样合作', '不寄样合作', '直播定向'];
const uiNeedsSample = (t) => t === '寄样合作';

function renderTypeSeg() {
  const seg = $('#typeSeg'); if (!seg) return;
  seg.innerHTML = '';
  COLLAB_TYPES.forEach((t) => {
    const b = el('button', S.form.type === t ? 'on' : null, t);
    b.onclick = () => {
      S.form.type = t;
      /* 切回寄样时一定要展开 —— 折着的话必填项在屏幕上根本不存在，
         而提交会被拦下并说「缺收件人」，人只会一头雾水。 */
      if (uiNeedsSample(t)) S.shipUnfolded = true;
      renderForm();
    };
    seg.append(b);
  });
}

function renderForm() {
  const F = S.form, M = S.fieldMeta || {};
  F.items ||= []; if (F.sampleCost === undefined) F.sampleCost = null;
  F.type ||= '寄样合作';
  renderTypeSeg();

  /* 不寄样的合作把产品和收件整块折起来。字段还在（偶尔想顺手记一笔地址），
     只是默认不占地方，也不再算「待补充」。 */
  const fold = !uiNeedsSample(F.type) && !S.shipUnfolded;
  const sb = $('#shipBlock'), sf = $('#shipFold');
  if (sb) sb.style.display = fold ? 'none' : '';
  if (sf) sf.style.display = fold ? '' : 'none';

  const smp = $('#submitSample');
  if (smp) {
    /* 不寄样就没有「提交寄样」这一步。留着一个按不动的按钮比藏起来更让人困惑。 */
    smp.style.display = uiNeedsSample(F.type) ? '' : 'none';
  }
  const rec = $('#recOnly');
  if (rec) rec.textContent = uiNeedsSample(F.type) ? '仅建档，暂不寄样' : '建档';

  $('#creatorNote').textContent = S.creatorId
    ? '账号已存在，本次只新增一条合作记录' : '库里没有这个账号，会同时建达人档案';

  const gc = $('#gCreator'); gc.innerHTML = '';
  gc.append(fld('达人名称', 'name', F.name, M.name, { optional: true }));

  const ga = $('#gAcct'); ga.innerHTML = '';
  F.accounts.forEach((a, i) => {
    const card = el('div'); card.style.cssText = 'border:1px solid var(--line);border-radius:8px;padding:11px 13px;margin-bottom:9px';
    const h = el('div'); h.style.cssText = 'display:flex;align-items:center;margin-bottom:8px;font-size:11.5px;color:var(--ink-300)';
    h.append(el('span', null, '账号 ' + (i + 1)), el('span', 'grow'));
    if (F.accounts.length > 1) {
      const d = el('button', 'btn sm danger', '移除');
      d.onclick = () => { F.accounts.splice(i, 1); renderForm(); }; h.append(d);
    }
    const g = el('div', 'fgrid'), am = (M.accounts && M.accounts[i]) || {};
    g.append(fld('昵称', `accounts.${i}.nickname`, a.nickname, am.nickname),
      fld('抖音号', `accounts.${i}.douyinId`, a.douyinId, am.douyinId),
      fld('UID', `accounts.${i}.uid`, a.uid, am.uid),
      fld('合作码', `accounts.${i}.cooperationCode`, a.cooperationCode, am.cooperationCode));
    card.append(h, g); ga.append(card);
  });
  $('#acctNote').textContent = F.accounts.length > 1 ? `${F.accounts.length} 个账号共用一份样品` : '';

  renderItems();

  const gr = $('#gRecip'); gr.innerHTML = '';
  const rm = M.recipient || {};
  const r2 = el('div', 'fgrid');
  r2.append(fld('收件人', 'recipient.name', F.recipient.name, rm.name),
    fld('手机号', 'recipient.phone', F.recipient.phone, rm.phone));
  const rest = el('div', 'fgrid'); rest.style.marginTop = '11px';
  rest.append(fld('地址', 'recipient.address', F.recipient.address, rm.address, { cls: 'wide' }),
    fld('配送备注', 'recipient.deliveryNote', F.recipient.deliveryNote, rm.deliveryNote,
      { ph: '如：放菜鸟驿站 / 送上门（无则留空）', optional: true }));
  [...rest.children].forEach((c) => c.classList.add('wide'));
  gr.append(r2, rest);

  renderAlerts(); renderSrc(); recount();
  $('#agentInfo').textContent = `${S.mode === 'llm' ? S.model : '本地模拟'} · ${S.elapsedMs || 0}ms`
    + (S.usage ? ` · ${S.usage.total_tokens || 0} tokens` : '');
}

function renderItems() {
  const F = S.form;
  const box = $('#gItems'); box.innerHTML = '';
  const usable = PRODUCTS.filter((p) => p.active !== false);
  $('#itemNote').textContent = F.items.length > 1 ? `${F.items.length} 个产品` : '';

  if (!usable.length) box.append(el('div', 'it-s', '还没有可选产品，去「设置 → 寄样产品」添加。'));

  F.items.forEach((it, i) => {
    const row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-bottom:7px';
    const sel = el('select'); sel.style.flex = '1';
    sel.append(el('option', null, '— 选择产品 —'));
    usable.forEach((p) => {
      const o = el('option', null, esc(p.name) + (p.spec ? `（${esc(p.spec)}）` : ''));
      o.value = p.id; sel.append(o);
    });
    if (it.productId && !usable.some((p) => p.id === it.productId)) {
      const o = el('option', null, esc(it.productName || it.productId) + '（已停用）'); o.value = it.productId; sel.append(o);
    }
    sel.value = it.productId || '';
    sel.onchange = () => {
      it.productId = sel.value || null;
      it.productName = PRODUCTS.find((p) => p.id === sel.value)?.name || '';
      recount();
    };
    const qty = el('input'); qty.type = 'number'; qty.min = '1'; qty.value = it.quantity ?? 1;
    qty.style.width = '78px';
    qty.oninput = () => { it.quantity = Number(qty.value) || 1; recount(); };
    const del = el('button', 'btn sm danger', '×');
    del.onclick = () => { F.items.splice(i, 1); renderItems(); recount(); };
    row.append(sel, qty, del); box.append(row);
  });

  const gcost = $('#gCost'); gcost.innerHTML = '';
  const cf = el('div', 'f');
  cf.innerHTML = '<label>寄样总费用（元）<span class="tag opt">选填</span></label>';
  const ci = el('input'); ci.type = 'number'; ci.step = '0.01'; ci.placeholder = '用于成本统计';
  ci.value = F.sampleCost ?? '';
  ci.oninput = () => { F.sampleCost = ci.value === '' ? null : Number(ci.value); recount(); };
  cf.append(ci); gcost.append(cf);
}

function renderAlerts() {
  const box = $('#alerts'); box.innerHTML = '';
  (S.warnings || []).forEach((w) => {
    const a = el('div', 'alert ' + (w.level === 'error' ? 'error' : w.level === 'warn' ? 'warn' : 'info'));
    a.append(el('b', null, esc(w.title)));
    a.append(document.createTextNode(w.detail || ''));

    if (w.code === 'UID_COOP_SAME_SHAPE') {
      const acts = el('div', 'acts'); acts.style.marginTop = '8px';
      const sw = el('button', 'btn sm', '两者互换');
      sw.onclick = () => {
        const acc = S.form.accounts[w.accountIndex];
        [acc.uid, acc.cooperationCode] = [acc.cooperationCode, acc.uid];
        S.warnings = S.warnings.filter((x) => x !== w); renderForm(); toast('已互换');
      };
      const ok = el('button', 'btn sm', '确认无误');
      ok.onclick = () => { S.warnings = S.warnings.filter((x) => x !== w); renderForm(); };
      acts.append(sw, ok); a.append(acts);
    }
    if (w.conflicts?.length) {
      const c = w.conflicts[0].existing;
      a.append(el('div', null,
        `<div style="margin-top:6px"><code>${esc(c.douyinId || c.uid)}</code> 属于 <b>${esc(c.creatorName || c.nickname)}</b>（归属 ${esc(c.owner)}，已合作 ${c.collaborationCount} 次）</div>`));
      const acts = el('div', 'acts'); acts.style.marginTop = '8px';
      const useExisting = el('button', 'btn sm primary', '在该达人上发起新合作');
      useExisting.onclick = () => {
        S.creatorId = c.creatorId;
        S.warnings = S.warnings.filter((x) => x !== w);
        renderForm(); toast('已切换为「发起新合作」，不会新建达人');
      };
      const drop = el('button', 'btn sm danger', '丢弃这条');
      drop.onclick = () => discardCurrent(false);
      acts.append(useExisting, drop); a.append(acts);
    }
    box.append(a);
  });
}

function renderSrc() {
  const pre = $('#srcPre'); pre.innerHTML = '';
  (S.rawText || '').split('\n').forEach((line) => {
    const d = el('div'); d.dataset.line = line.trim(); d.textContent = line || ' '; pre.append(d);
  });
  $('#srcMeta').textContent = S.ignored?.length ? `已忽略 ${S.ignored.length} 段` : '';
}

function mark(src) {
  $$('#srcPre div').forEach((d) => {
    d.innerHTML = esc(d.textContent);
    if (src && d.dataset.line && src.includes(d.dataset.line) && d.dataset.line.length > 3) {
      d.innerHTML = '<mark>' + esc(d.textContent) + '</mark>'; d.scrollIntoView({ block: 'nearest' });
    }
  });
}

function recount() {
  let miss = 0, chk = 0;
  /* 藏起来的字段不算「待补充」—— 不寄样合作把产品和收件整块折起来了，
     照旧统计的话会一直提示补充几个屏幕上根本看不见的东西，
     而 Alt+N 还会往一个不可见的输入框上跳。 */
  const visible = (node) => !node.closest('[style*="display:none"], [style*="display: none"]');

  $$('#drLeft .f').forEach((f) => {
    const i = f.querySelector('input'); if (!i || i.type === 'number') return;
    if (!visible(f)) { f.className = 'f'; f.querySelector('label .tag')?.remove(); return; }
    const lab = f.querySelector('label'); if (!lab) return;
    const old = lab.querySelector('.tag');
    const empty = !i.value.trim();
    const low = f.dataset.low === '1';
    if (empty && f.dataset.optional === '1') { f.className = 'f'; if (old && !old.classList.contains('opt')) old.remove(); return; }
    if (empty) {
      f.className = 'f miss'; miss++;
      if (!old || !old.classList.contains('miss')) { old?.remove(); lab.append(el('span', 'tag miss', '待补充')); }
    } else if (low) {
      f.className = 'f chk'; chk++;
      if (!old || !old.classList.contains('chk')) { old?.remove(); lab.append(el('span', 'tag chk', '需核对')); }
    } else {
      f.className = 'f'; old?.remove();   // 填好了就把标记去掉，保持安静
    }
  });

  const parts = [];
  if (miss) parts.push(`<span style="color:var(--red)">待补充 ${miss}</span>`);
  if (chk) parts.push(`<span style="color:var(--amber)">需核对 ${chk}</span>`);
  const counts = $('#counts');
  if (counts) counts.innerHTML = parts.join(' · ') || '<span style="color:var(--green)">信息完整</span>';
  const jump = $('#jump'); if (jump) jump.style.display = (miss || chk) ? '' : 'none';

  const F = S.form, w = [];
  const r = F.recipient || {};
  const ship = uiNeedsSample(F.type);
  const hasItems = F.items.some((i) => i.productId && Number(i.quantity) > 0);
  if (!F.accounts.some((a) => a.douyinId || a.uid)) w.push('每个账号都缺抖音号和 UID，无法入库');
  /* 产品和收件只对寄样合作是问题。对不寄样的合作提这两条是噪音，
     而且会让人误以为自己漏填了什么。 */
  if (ship && !hasItems) w.push('未选寄样产品');
  if (ship && (!r.name || !r.phone || !r.address)) w.push('收件信息不全');
  if (F.accounts.some((a) => !a.cooperationCode)) w.push('有账号缺合作码（不影响寄样，影响后续开定向）');
  const fw = $('#fWarn');
  if (fw) {
    fw.textContent = w.length ? w.join('；')
      : ship ? '信息完整，可以提交寄样' : '信息完整，可以建档';
  }
  const ss = $('#submitSample');
  if (ss) ss.disabled = !ship || !hasItems || !r.name || !r.phone || !r.address;
}

function jumpNext() {
  const list = $$('#drLeft .f.miss input, #drLeft .f.chk input');
  const i = list.indexOf(document.activeElement);
  (list[i + 1] || list[0])?.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key.toLowerCase() === 'n' && drawerOpen()) { e.preventDefault(); jumpNext(); }
});

async function mergeMore() {
  const add = $('#more').value.trim(); if (!add) return;
  $('#merge').disabled = true; $('#merge').textContent = '合并中…';
  try {
    const r = await api('POST', '/api/extract', { rawText: add, previousExtracted: S.extracted });
    const keep = { items: S.form.items, sampleCost: S.form.sampleCost };
    S = { ...r, rawText: (S.rawText + '\n' + add).trim(), creatorId: S.creatorId };
    Object.assign(S.form, keep);
    $('#more').value = ''; renderForm(); toast('已合并新片段');
  } catch (e) { toast(e.message); }
  finally { $('#merge').disabled = false; $('#merge').textContent = '合并识别'; }
}

async function saveDraft() {
  try {
    const r = await api('POST', '/api/drafts', { id: draftId, rawText: S.rawText, form: S.form, extracted: S.extracted });
    draftId = r.draft.id;
    if (jobId) { await api('DELETE', '/api/jobs/' + jobId).catch(() => {}); jobId = null; }
    toast('草稿已保存'); closeDrawer();
  } catch (e) { toast(e.message); }
}

async function discardCurrent(silent) {
  if (!silent && !confirm('丢弃这条识别结果？原文和识别结果都会删除，不影响已入库的数据。')) return;
  if (jobId) { await api('DELETE', '/api/jobs/' + jobId).catch(() => {}); jobId = null; }
  if (draftId) { await api('DELETE', '/api/drafts/' + draftId).catch(() => {}); draftId = null; }
  closeDrawer(); toast('已丢弃');
}

/**
 * 提交后不再跳「完成页」。
 * 队列本来就是异步的，完成页硬生生打断了「提交完立刻粘下一条」的节奏，
 * 而它唯一提供的价值 —— 一个「成了」的确认感 —— toast 就够。
 */
async function submitCollaboration(action) {
  const btn = action === 'submitSample' ? $('#submitSample') : null;
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/collaborations', {
      action, creatorId: S.creatorId || null, form: S.form,
      rawText: S.rawText, extracted: S.extracted,
      model: S.model, mode: S.mode, promptVersion: S.promptVersion,
      elapsedMs: Date.now() - t0, draftId, jobId,
    });
    jobId = null; draftId = null;
    closeDrawer();
    toast(`${action === 'submitSample' ? '已提交寄样' : '已建档'} · ${r.collaboration.creatorName || '未命名达人'}`);
    loadRecords();
    $('#raw').focus();
  } catch (e) {
    if (e.data?.conflicts) {
      const c = e.data.conflicts[0].existing;
      S.warnings = [{ level: 'error', code: 'DUPLICATE_ACCOUNT', title: '该账号已属于已有达人，未入库',
        detail: '请改用「在该达人上发起新合作」，或丢弃这条。', conflicts: e.data.conflicts },
        ...(S.warnings || []).filter((w) => w.code !== 'DUPLICATE_ACCOUNT')];
      renderAlerts();
      $('#drLeft').scrollTo({ top: 0, behavior: 'smooth' });
      toast(`「${c.creatorName || c.nickname}」已存在，归属 ${c.owner}`);
    } else toast(e.message);
  } finally { if (btn) btn.disabled = false; }
}

/* ================================================================ 视频回传 */

function openVideoDrawer() {
  const submit = el('button', 'btn primary', '确认回传');
  submit.id = 'vSubmit';
  submit.onclick = () => submitVideo(submit);
  const cancel = el('button', 'btn', '取消');
  cancel.onclick = closeDrawer;

  openDrawer({
    title: '确认视频回传',
    tags: V.matches.length ? [] : [{ text: '没自动匹配上', cls: 'p2' }],
    foot: [cancel, el('span', 'grow'), submit],
    onClose: () => { V = null; loadDesk(); },
  });

  $('#drRight').innerHTML = '<div class="rh">口令原文 · 逐字节保存，交接时整段复制</div>';
  $('#drRight').append(el('div', 'tokenbox', esc(V.shareToken)));
  const row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
  const cp = el('button', 'btn sm', '复制口令');
  cp.onclick = async () => toast(await copy(V.shareToken) ? '已复制完整口令' : '复制失败');
  row.append(cp);
  if (V.parsed.videoUrl) {
    const a = el('a', 'btn sm', '打开视频 ↗');
    a.href = V.parsed.videoUrl; a.target = '_blank'; a.rel = 'noreferrer';
    a.style.textDecoration = 'none'; row.append(a);
  }
  $('#drRight').append(row);
  (V.warnings || []).forEach((w) => {
    const a = el('div', 'alert ' + (w.level === 'error' ? 'error' : 'warn'));
    a.style.marginTop = '12px';
    a.append(el('b', null, esc(w.title))); a.append(document.createTextNode(w.detail || ''));
    $('#drRight').append(a);
  });

  renderVideo();
}

function renderVideo() {
  const b = $('#drLeft'); b.innerHTML = '';
  const auto = V.matches || [];
  const shown = auto.length ? auto : (V.searchResults || []);

  b.append(el('div', 'rh', V.parsed.nickname
    ? `口令里的昵称是「${esc(V.parsed.nickname)}」${auto.length > 1 ? ` · 匹配到 ${auto.length} 条，选一条` : ''}`
    : '这条视频对应哪次合作 —— 搜达人名 / 抖音号 / UID / 合作码'));

  // 昵称匹配不上时（裸链接、达人改名）必须给手动入口，
  // 否则「更新视频」这个动作在这里就断了 —— 只提示「请手动选择」却没有可选的东西。
  if (!auto.length) b.append(videoSearchBox());

  shown.forEach((m) => b.append(matchCard(m)));

  if (!shown.length && V.searchResults) {
    b.append(el('div', 'empty', '没搜到。换个词试试：达人名、抖音号、UID、合作码都能搜。'));
  }

  const sub = $('#vSubmit');
  if (sub) sub.disabled = !V.chosen;
}

/* 搜索框复用同一个 DOM 节点。renderVideo 是整块重绘的，
   每次新建输入框会把焦点和已输入的内容打掉，选一条就得重新打字。 */
function videoSearchBox() {
  if (!V.searchEl) {
    const wrap = el('div', 'vsearch');
    const input = el('input');
    input.type = 'search';
    input.placeholder = '搜达人名 / 抖音号 / UID / 合作码';
    input.value = V.searchQ || '';
    const hint = el('div', 'dim');
    hint.style.cssText = 'font-size:12px;margin-top:6px';

    let timer = null;
    const run = async () => {
      const q = input.value.trim();
      V.searchQ = q;
      if (!q) { V.searchResults = null; hint.textContent = ''; renderVideo(); return; }
      hint.textContent = '搜索中…';
      try {
        const r = await api('GET', `/api/fulfillments/search?q=${encodeURIComponent(q)}`);
        V.searchResults = r.matches;
        hint.textContent = r.matches.length ? `找到 ${r.matches.length} 条` : '';
      } catch (e) { hint.textContent = e.message; V.searchResults = []; }
      renderVideo();
    };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 250); };

    wrap.append(input, hint);
    V.searchEl = wrap;
    queueMicrotask(() => input.focus());
  }
  return V.searchEl;
}

function matchCard(m) {
  const cb = m.collaboration, acc = m.account || {};
  const on = m.fulfillmentId === V.chosen;
  const card = el('div', 'mcard' + (on ? ' on' : '') + (!on && m.alreadyHasVideo ? ' warn' : ''));
  card.onclick = () => { V.chosen = m.fulfillmentId; renderVideo(); };
  card.append(el('div', 'radio'));

  const body = el('div');
  const hd = el('div', 'hd');
  // 达人名可能没填（表单里是选填），空标题的卡片没法认，退回用账号昵称
  hd.append(el('b', null, esc(cb.creatorName || acc.nickname || '未命名达人')));
  hd.append(el('span', 'st ' + (m.alreadyHasVideo ? 'done' : 'running'),
    m.alreadyHasVideo ? '该账号已回传过，会被覆盖' : m.filmingProgress));
  hd.append(el('span', 'st queued', esc(cb.status)));
  if (cb.accountCount > 1) {
    hd.append(el('span', 'it-s', `本次共 ${cb.accountCount} 个账号，已回传 ${cb.publishedCount}`));
  }
  body.append(hd);

  // 一次合作可能挂多个账号，必须让商务看清这条对应的是哪个号
  body.append(el('div', 'sub',
    `抖音号 ${esc(acc.douyinId || '—')} · UID ${esc(acc.uid || '—')} · 合作码 ${esc(acc.cooperationCode || '—')}`));

  const dl = el('dl');
  const add = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)); };
  add('寄样', cb.items.length
    ? cb.items.map((i) => `${esc(i.productName)} ×${i.quantity}`).join('、')
    : '<span class="dim">未填</span>');
  add('收件', cb.recipient?.name
    ? `${esc(cb.recipient.name)} ${esc(cb.recipient.phone || '')}<br><span class="dim">${esc(cb.recipient.address || '')}</span>`
    : '<span class="dim">未填</span>');
  add('快递', cb.packages.length
    ? cb.packages.map((p) => `${esc(p.carrier)} ${esc(p.trackingNo)}`).join('<br>')
    : '<span class="dim">未回填</span>');
  add('建档', `${fmtDate(cb.createdAt)} · ${daysAgo(cb.createdAt)}`
    + (cb.notifiedAt ? ' · 已告知达人' : '') + ` · 归属 ${esc(cb.ownerName)}`);
  body.append(dl);

  card.append(body);
  return card;
}

async function submitVideo(submit) {
  submit.disabled = true;
  try {
    const r = await api('POST', '/api/video/submit', { shareToken: V.shareToken, fulfillmentId: V.chosen });
    closeDrawer();
    toast(r.collaboration.status === '已完成'
      ? `视频已记录 · ${r.collaboration.creatorName} 所有账号都已回传，合作完成`
      : `视频已记录 · ${r.collaboration.creatorName}，还有账号未回传`);
    loadRecords();
  } catch (e) { toast(e.message); submit.disabled = false; }
}

/* ================================================================ 发货截图批量回填 */

/**
 * 发货截图缩略图。点一下全屏看原图。
 *
 * 快递单号在截图里往往很小，缩略图上根本认不出 —— 不能放大的预览
 * 等于没有预览。原图走接口而不是静态目录：静态目录意味着
 * 同网段谁都能按 id 猜着看。
 */
function shotImg(shotId) {
  const wrap = el('div');
  const img = el('img', 'shot');
  img.src = `/api/shots/${encodeURIComponent(shotId)}`;
  img.alt = '发货截图';
  img.style.cursor = 'zoom-in';
  img.onclick = () => openShotViewer(shotId);
  img.onerror = () => {
    /* 已被清理时给一句人话。空白的破图框会让人以为系统坏了。 */
    wrap.innerHTML = '<div class="src">（原图已清理 —— 只保留最近 1000 张）</div>';
  };
  wrap.append(img);
  return wrap;
}

function openShotViewer(shotId) {
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box" style="max-width:min(94vw,1100px);padding:12px">
    <img src="/api/shots/${encodeURIComponent(shotId)}" alt="发货截图"
      style="width:100%;height:auto;max-height:80vh;object-fit:contain;border-radius:6px">
    <div class="acts" style="margin-top:10px">
      <a class="btn" href="/api/shots/${encodeURIComponent(shotId)}" target="_blank"
        rel="noreferrer" style="text-decoration:none">在新标签打开</a>
      <button class="btn primary" id="svClose">关闭</button>
    </div>
  </div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#svClose').onclick = close;
  /* Esc 关闭 —— 全屏看图时鼠标多半在图上，找关闭按钮要移半屏 */
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

async function openShipment(id) {
  const { job } = await api('GET', '/api/jobs/' + id);
  if (!job.result?.matched) return;
  const { collaborations } = await api('GET', '/api/collaborations?scope=mine');
  SB = {
    jobId: id,
    matched: job.result.matched,
    shotId: job.shotId || null,
    candidates: collaborations.filter((c) => ['待寄样', '已寄样'].includes(c.status)),
    picks: new Map(), checked: new Set(),
  };
  SB.matched.forEach((m, i) => {
    SB.picks.set(i, m.best?.collaborationId || '');
    if (m.level === 'high' && !m.already) SB.checked.add(i);   // 高置信默认勾选
  });

  const all = el('button', 'btn sm', '全选高置信');
  all.onclick = () => {
    SB.matched.forEach((m, i) => { if (m.level === 'high' && !m.already && SB.picks.get(i)) SB.checked.add(i); });
    renderShipment();
  };
  const discard = el('button', 'btn danger', '丢弃');
  discard.onclick = async () => {
    if (!confirm('丢弃这张截图的识别结果？已回填的不受影响。')) return;
    await api('DELETE', '/api/jobs/' + SB.jobId).catch(() => {});
    closeDrawer(); toast('已丢弃');
  };
  const confirmBtn = el('button', 'btn primary', '确认回填');
  confirmBtn.id = 'sbConfirm';
  confirmBtn.onclick = confirmShipment;
  const warn = el('span', 'it-s grow'); warn.id = 'sbWarn';

  openDrawer({
    title: '回填快递单号',
    tags: [],
    foot: [discard, warn, confirmBtn],
    onClose: () => { SB = null; loadDesk(); },
  });
  $('#drHead').insertBefore(all, $('#drHead').lastChild);

  $('#drRight').innerHTML = '<div class="rh">截图原件 · 点击放大</div>';
  if (SB.shotId) {
    /* 核对的全部意义就在这张图上：识别出来的单号和图里对不对得上，
       只有并排看才知道。之前识别完就把图丢了，这一栏永远是空的。 */
    $('#drRight').append(shotImg(SB.shotId));
  } else {
    $('#drRight').append(el('div', 'src', '（这张截图没有存档 —— 存档功能上线之前的任务）'));
  }
  $('#drRight').append(el('div', 'alert info',
    '<b>不猜打码内容</b>手机号和门牌在截图里是打码的。两名候选分差过小就标「分不出」交给人判断。'));

  renderShipment();
}

function renderShipment() {
  const box = $('#drLeft'); box.innerHTML = '';
  const c = SB.matched.reduce((a, m) => { a[m.already ? 'already' : m.level]++; return a; },
    { high: 0, low: 0, none: 0, already: 0 });

  const head = $('#drHead');
  [...head.querySelectorAll('.st')].forEach((n) => n.remove());
  const after = head.querySelector('b');
  const addTag = (text, cls) => after.after(el('span', 'st ' + cls, text));
  if (c.already) addTag(`${c.already} 条已回填`, 'queued');
  if (c.none) addTag(`${c.none} 条没匹配上`, 'failed');
  if (c.low) addTag(`${c.low} 条需核对`, 'p2');
  if (c.high) addTag(`${c.high} 条高置信`, 'done');

  SB.matched.forEach((m, i) => {
    const row = m.row;
    const pick = SB.picks.get(i);
    const on = SB.checked.has(i);
    const it = el('div', 'mcard' + (on ? ' on' : m.level === 'none' ? ' warn' : ''));

    const ck = el('input'); ck.type = 'checkbox';
    ck.style.cssText = 'width:16px;height:16px;margin-top:2px';
    ck.checked = on; ck.disabled = m.already || !pick;
    ck.onchange = () => { ck.checked ? SB.checked.add(i) : SB.checked.delete(i); renderShipment(); };
    it.append(ck);

    const body = el('div');
    const hd = el('div', 'hd');
    hd.append(el('b', null, esc(row.recipientName || '（无姓名）')));
    hd.append(el('span', 'it-s', esc(row.phoneMasked || '')));
    if (m.already) hd.append(el('span', 'st done', '已回填过'));
    else if (m.level === 'high') hd.append(el('span', 'st done', '高置信'));
    else if (m.level === 'low') hd.append(el('span', 'st p2', m.ambiguous ? '两个候选分不出' : '低置信'));
    else hd.append(el('span', 'st failed', '没匹配上'));
    body.append(hd);

    const goods = row.products.map((p) => `${esc(p.name)} ×${p.quantity}`).join('、') || '无商品';
    body.append(el('div', 'sub',
      `${esc(row.address || '无地址')}<br>${goods} · ${esc(row.carrier || '')} ${esc(row.trackingNo || '无单号')}`));

    const arrow = el('div'); arrow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px';
    arrow.append(el('span', 'dim', '回填到'));
    const sel = el('select'); sel.style.flex = '1';
    sel.append(el('option', null, '— 不回填 —'));
    const pool = [...SB.candidates];
    (m.matches || []).forEach((x) => { if (!pool.some((p) => p.id === x.collaborationId)) pool.unshift(x.collaboration); });
    pool.forEach((cb) => {
      const hit = (m.matches || []).find((x) => x.collaborationId === cb.id);
      const o = el('option', null,
        `${esc(cb.creatorName)} · ${esc(cb.recipient?.name || '—')} · ${cb.items.map((x) => x.productName).join('/') || '未填产品'}`
        + (hit ? `（${hit.score} 分）` : ''));
      o.value = cb.id; sel.append(o);
    });
    sel.value = pick || '';
    sel.disabled = m.already;
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = () => {
      SB.picks.set(i, sel.value);
      if (!sel.value) SB.checked.delete(i); else SB.checked.add(i);
      renderShipment();
    };
    arrow.append(sel);
    body.append(arrow);
    if (m.best && pick === m.best.collaborationId) {
      body.append(el('div', 'dim', `<span style="font-size:11.5px">${esc(m.best.why.join('、'))}</span>`));
    }

    it.append(body); box.append(it);
  });

  const n = [...SB.checked].filter((i) => SB.picks.get(i)).length;
  $('#sbWarn').textContent = n ? `将回填 ${n} 条快递单号` : '还没有勾选任何记录';
  $('#sbConfirm').disabled = !n;
  $('#sbConfirm').textContent = n ? `确认回填 ${n} 条` : '确认回填';
}

async function confirmShipment() {
  const items = [...SB.checked]
    .filter((i) => SB.picks.get(i))
    .map((i) => ({
      collaborationId: SB.picks.get(i),
      carrier: SB.matched[i].row.carrier,
      trackingNo: SB.matched[i].row.trackingNo,
    }));
  if (!items.length) return;
  $('#sbConfirm').disabled = true;
  try {
    // 全部处理完才删任务，留一条没弄的下次还能进来
    const allDone = items.length === SB.matched.filter((m) => !m.already).length;
    const r = await api('POST', '/api/shipments/confirm', { items, jobId: allDone ? SB.jobId : null });
    closeDrawer();
    toast(r.failed.length
      ? `已回填 ${r.done.length} 条，${r.failed.length} 条失败`
      : `已回填 ${r.done.length} 条，去「需要处理」里把单号发给达人`);
    loadRecords();
  } catch (e) { toast(e.message); $('#sbConfirm').disabled = false; }
}

/* ================================================================ 合作详情 */

/**
 * 时间线不是装饰。每一格都对应一个真实发生过的动作，没有一格是人手选的 ——
 * 它把「状态由动作驱动」这条规则可视化了，顺便让「为什么这条是已寄样」不用解释。
 */
function timeline(cb) {
  const wrap = el('div', 'tl');
  /**
   * @param openLog 有原始识别记录的节点传 true —— 点开能看到
   *   「模型抽出什么、人改成什么」。没有记录的节点不做成可点，
   *   点了什么都不弹比不能点更让人困惑。
   */
  const add = (cls, title, sub, openLog = false) => {
    const i = el('div', 'tl-i' + (cls ? ' ' + cls : ''));
    i.append(el('b', null, esc(title)), el('span', null, esc(sub)));
    if (openLog) {
      i.style.cursor = 'pointer';
      i.title = '查看这一步的原始识别记录';
      i.append(el('span', 'hintcp', ' 查看原文 ›'));
      i.onclick = () => openLogsModal(cb.id, title);
    }
    wrap.append(i);
  };
  const shipped = cb.packages[0];
  const pending = cb.fulfillments.filter((f) => f.expectVideo && f.filmingProgress !== '已发布' && f.filmingProgress !== '本次不出片');
  const done = cb.status === '已完成';
  const published = cb.fulfillments.filter((f) => f.expectVideo && f.filmingProgress === '已发布');

  /* 建档是唯一有完整识别记录的节点（原文 + 模型输出 + 人工修改）。
     快递和视频只有来源标记，够不上「识别记录」，所以不做成可点。 */
  add('done', '建档', `${fmtDate(cb.createdAt)} · ${esc(cb.ownerName)} · ${cb.fulfillments.length} 个抖音账号`, true);

  if (shipped) {
    const bySnap = cb.packages.some((p) => p.source && p.source !== 'manual');
    add('done', '已寄样',
      `${fmtDate(shipped.shippedAt)} · ${esc(shipped.carrier)} ${esc(shipped.trackingNo)}`
      + (bySnap ? ' · 截图识别' : ''));
  } else {
    add(cb.status === '已终止' ? '' : 'now', '等待仓库发货', '仓库回填快递单号后自动变「已寄样」');
  }

  if (published.length) {
    add(done ? 'done' : 'now', '已回传视频',
      `${published.length}/${cb.fulfillments.filter((f) => f.expectVideo).length} 个账号已发布`);
  }

  if (done) add('done', '已完成', '所有账号都已回传视频');
  else if (shipped) add('now', '等待出片', `建档 ${daysAgo(cb.createdAt)} · ${pending.length} 个账号待发布`);
  else add('', '已完成', '所有账号回传视频后自动标记');
  return wrap;
}

/* ---------------- 合作详情：五张卡片 ---------------- */

/** 一行可点击复制的信息。整行都是热区 —— 手机号和长地址用鼠标划选很容易划错。 */
function cpRow(label, value, { copyAs = null, mono = false } = {}) {
  const v = String(value ?? '').trim();
  const row = el('div', 'cp');
  row.innerHTML = `<span>${esc(label)}</span>`
    + `<span${mono ? ' class="mono"' : ''}>${v ? esc(v) : '<span class="dim">—</span>'}</span>`
    + `<span class="hintcp">${v ? '点击复制' : ''}</span>`;
  if (!v) { row.style.cursor = 'default'; row.onmouseenter = null; return row; }
  row.onclick = async () => toast(await copy(copyAs || v) ? `已复制${label}` : '复制失败');
  return row;
}

function dcard(title, extraHead = null) {
  const c = el('div', 'dcard');
  const h = el('h4');
  h.append(el('span', null, esc(title)), el('span', 'grow'));
  if (extraHead) h.append(extraHead);
  c.append(h);
  return c;
}

async function openCollaboration(id) {
  const { collaboration: cb, notifyText } = await api('GET', '/api/collaborations/' + id);
  const mine = CFG?.me?.id && cb.ownerUserId === CFG.me.id;

  /* ── 底部：只放不可逆或改变生命周期的操作 ────────────────────
     日常操作（回填快递、复制、催拍）放在各自的卡片里 ——
     它们属于某一块信息，混进底部会让「这一排都是危险动作」这条规律失效。 */
  const foot = [];
  if (cb.status !== '已终止') {
    const stop = el('button', 'btn', '终止合作');
    stop.onclick = async () => {
      if (!confirm('终止后不再产生待办，历史记录保留。确定？')) return;
      await api('POST', `/api/collaborations/${cb.id}/status`, { status: '已终止' });
      closeDrawer(); toast('已终止'); loadDesk(); loadRecords();
    };
    foot.push(stop);
  }
  foot.push(el('span', 'grow'));
  const del = el('button', 'btn danger', '删除合作');
  del.title = mine ? '' : '只有归属商务能删';
  del.disabled = !mine;
  del.onclick = () => openDeleteModal(cb);
  foot.push(del);

  openDrawer({
    /* 标题给三样东西：什么时候建的、是谁、到哪一步了。
       在一堆同名达人的多次合作里，日期是唯一能分开它们的东西。 */
    title: `${fmtDate(cb.createdAt)} · ${cb.creatorName || '未命名达人'}`,
    tags: [{ text: cb.status, cls: cb.status === '已完成' ? 'done'
      : cb.status === '进行中' ? 'running' : cb.status === '已终止' ? 'failed' : 'queued' }],
    right: false,
    foot,
    onClose: () => { loadDesk(); loadRecords(); },
  });

  const L = $('#drLeft');

  /* ── 1. 达人档案 ─────────────────────────────────────────── */
  const c1 = dcard(`达人档案 · ${cb.fulfillments.length} 个账号`);
  if (!cb.fulfillments.length) {
    c1.append(el('div', 'empty-note', '这条合作没有绑定任何抖音账号'));
  }
  cb.fulfillments.forEach((f) => {
    const a = f.account || {};
    const box = el('div', 'acct');
    box.append(el('div', 'an', esc(a.nickname || '（无昵称）')));
    box.append(cpRow('抖音号', a.douyinId, { mono: true }));
    box.append(cpRow('UID', a.uid, { mono: true }));
    box.append(cpRow('合作码', a.cooperationCode, { mono: true }));
    c1.append(box);
  });

  /* 其他平台账号（视频号 / 快手 / 小红书 / 微信）。
     提示词一直在抽、库里一直在存，之前界面上没有任何出口 ——
     等于花了 token 又占了库，还让人以为「系统记着呢」。
     只存档不参与业务：不寄样、不催拍、不同步到飞书。 */
  if (cb.otherAccounts?.length) {
    const other = el('div', 'acct');
    other.append(el('div', 'an', `其他平台 · ${cb.otherAccounts.length} 个（仅存档）`));
    cb.otherAccounts.forEach((o) => other.append(cpRow(o.platform || '其他', o.accountId, { mono: true })));
    c1.append(other);
  }
  L.append(c1);

  /* ── 2. 寄样信息 ─────────────────────────────────────────── */
  const c2 = dcard('寄样信息');
  if (!uiNeedsSample(cb.type)) {
    c2.append(el('div', 'empty-note', `${cb.type} —— 不寄实物，无需产品和收件信息`));
  } else {
    c2.append(cpRow('产品', cb.items.length
      ? cb.items.map((i) => `${i.productName} ×${i.quantity}`).join('、') : ''));
    c2.append(cpRow('寄样费用', cb.sampleCost != null ? '¥' + cb.sampleCost : ''));
    c2.append(cpRow('收件人', cb.recipient?.name));
    c2.append(cpRow('电话', cb.recipient?.phone, { mono: true }));
    c2.append(cpRow('地址', cb.recipient?.address));
    if (cb.recipient?.deliveryNote) c2.append(cpRow('配送备注', cb.recipient.deliveryNote));

    cb.packages.forEach((p) => {
      c2.append(cpRow('快递', `${p.carrier || ''} ${p.trackingNo}`.trim(), { mono: true }));
      /* 截图识别来的单号附一个原图入口 —— 「这个单号哪来的」
         是回填之后最常被问到的问题。手工填的没有图，也就不放这个入口。 */
      if (p.shotId) {
        const link = el('div', 'cp');
        link.innerHTML = '<span></span><span class="dim" style="font-size:12px">识别自发货截图 · 点击查看原图</span><span class="hintcp"></span>';
        link.onclick = () => openShotViewer(p.shotId);
        c2.append(link);
      }
    });

    const ops = el('div', 'ops');
    if (!cb.packages.length) {
      /* 没单号时给回填；有单号时给复制整段物流信息 ——
         同一个位置只放当前这一步真正要做的事。 */
      const tk = el('button', 'btn sm primary', '回填快递单号');
      tk.onclick = () => openTrackingModal(cb.id);
      ops.append(tk);
    } else {
      const cpAll = el('button', 'btn sm', '复制完整物流信息');
      /* 复制即视为已告知，不再单独一个「标记已告知」按钮。
         这个按钮存在的唯一目的就是把物流信息粘给达人 ——
         复制完了还要再点一下「我复制了」，是让人做一件系统已经知道的事。
         代价：复制完又没发出去时，系统会以为告知过了。
         相比「每次都多点一下、而且经常忘」，这个代价更小。 */
      cpAll.onclick = async () => {
        if (!await copy(notifyText)) { toast('复制失败'); return; }
        if (!cb.notifiedAt) {
          try { await api('POST', `/api/collaborations/${cb.id}/notified`, { value: true }); } catch { /* 标记失败不影响复制 */ }
          toast('已复制，并标记为已告知达人');
          await openCollaboration(cb.id); loadDesk(); loadRecords();
        } else toast('已复制，可直接发给达人');
      };
      const more = el('button', 'btn sm', '再加一个快递单号');
      more.onclick = () => openTrackingModal(cb.id);
      ops.append(cpAll, more);
    }
    c2.append(ops);
  }
  L.append(c2);

  /* ── 3. 视频信息 ─────────────────────────────────────────── */
  const c3 = dcard('视频信息');
  const wantVideo = cb.fulfillments.filter((f) => f.expectVideo);
  if (!wantVideo.length) {
    c3.append(el('div', 'empty-note', '这条合作不要求出片'));
  }
  wantVideo.forEach((f) => {
    const a = f.account || {};
    const box = el('div', 'acct');
    const hd = el('div', 'an');
    hd.innerHTML = `${esc(a.nickname || a.douyinId || '（无昵称）')} `
      + `<span class="st ${f.filmingProgress === '已发布' ? 'done' : 'queued'}" `
      + `style="margin-left:6px">${esc(f.filmingProgress)}</span>`;
    box.append(hd);

    if (f.videoUrl || f.shareToken) {
      if (f.videoUrl) box.append(cpRow('链接', f.videoUrl, { mono: true }));
      /* 口令必须逐字节复制 —— 抖音跳转和千川加载都依赖它，改一个字符就可能失效。
         所以这里复制的是原文，不是显示用的截断版。 */
      if (f.shareToken) box.append(cpRow('口令', f.shareToken.slice(0, 40) + (f.shareToken.length > 40 ? '…' : ''),
        { copyAs: f.shareToken, mono: true }));
      const ops = el('div', 'ops');
      const cpAll = el('button', 'btn sm', '复制完整视频信息');
      cpAll.onclick = async () => {
        const text = [`达人：${a.nickname || a.douyinId || ''}`,
          f.videoUrl ? `链接：${f.videoUrl}` : '',
          f.shareToken ? `口令：${f.shareToken}` : ''].filter(Boolean).join('\n');
        toast(await copy(text) ? '已复制' : '复制失败');
      };
      ops.append(cpAll);
      if (f.videoUrl) {
        const a2 = el('a', 'btn sm', '打开视频 ↗');
        a2.href = f.videoUrl; a2.target = '_blank'; a2.rel = 'noreferrer'; a2.style.textDecoration = 'none';
        ops.append(a2);
      }
      box.append(ops);
    } else {
      const ops = el('div', 'ops');
      const add = el('button', 'btn sm primary', '填写视频链接');
      add.onclick = () => openVideoLinkModal(cb.id, f);
      ops.append(add);
      box.append(ops);
    }
    c3.append(box);
  });
  L.append(c3);

  /* ── 4. 商务信息 ─────────────────────────────────────────── */
  const c4 = dcard('商务信息');
  c4.append(cpRow('归属商务', cb.ownerName));
  c4.append(cpRow('合作类型', cb.type));
  if (cb.salesChannel) c4.append(cpRow('带货方式', cb.salesChannel));
  const ops4 = el('div', 'ops');
  const tr = el('button', 'btn sm', '转交归属');
  /* 转交挂在达人上，不在合作上 —— 合作跟着达人走，
     单独转一条合作会让「这个达人归谁」出现两个答案。 */
  tr.onclick = () => openTransferModal(cb.creatorId, cb.creatorName);
  ops4.append(tr);
  c4.append(ops4);
  L.append(c4);

  /* ── 5. 系统信息 ─────────────────────────────────────────── */
  const c5 = dcard('系统信息');
  c5.append(cpRow('合作ID', cb.id, { mono: true }));
  c5.append(cpRow('建档', fmtTime(cb.createdAt)));
  c5.append(cpRow('最后更新', fmtTime(cb.updatedAt)));
  if (cb.notifiedAt) c5.append(cpRow('告知达人', fmtTime(cb.notifiedAt)));

  const st = (RECORDS_SYNC || {})[cb.id];
  const line = el('div', 'cp'); line.style.cursor = 'default';
  line.innerHTML = `<span>飞书同步</span><span>${syncPill(st)}`
    + (st?.state === 'synced' && st.at ? ` <span class="dim">${fmtTime(st.at)} · ${st.rows} 行</span>` : '')
    + '</span><span class="hintcp"></span>';
  c5.append(line);
  if (st?.error) {
    /* 失败原因原样显示。「同步失败」四个字对排查毫无帮助 ——
       用户需要知道是权限、列名还是类型的问题。 */
    const errBox = el('div', 'dim', esc(st.error));
    errBox.style.cssText = 'white-space:pre-wrap;font-size:12px;padding:4px 0 0';
    c5.append(errBox);
  }
  if (st && st.state !== 'off') {
    const ops5 = el('div', 'ops');
    const sbtn = el('button', 'btn sm', st.state === 'synced' ? '重新同步' : '立即同步');
    sbtn.onclick = async () => {
      sbtn.disabled = true; sbtn.textContent = '同步中…';
      try {
        await api('POST', '/api/feishu/sync-one', { collaborationId: cb.id });
        toast('已同步到飞书');
        await loadRecords();
        await openCollaboration(cb.id);
      } catch (e) {
        sbtn.disabled = false; sbtn.textContent = '重试';
        c5.append(el('div', 'alert warn', `<b>同步失败</b>${esc(e.message)}`));
      }
    };
    ops5.append(sbtn);
    c5.append(ops5);
  }
  L.append(c5);

  /* 时间线放最后 —— 它是「发生过什么」的补充，不是要操作的东西 */
  const c6 = dcard('进展时间线');
  c6.append(timeline(cb));
  L.append(c6);
}

/* ---------- 回填快递 ---------- */

/* ---------- 视频链接 / 本次不出片 ---------- */

/**
 * 填写视频链接。
 *
 * 不用 prompt()：那个框没法校验、没法给第二个选项、粘长链接看不全，
 * 而且在 Safari 上还会被当成弹窗拦掉。
 *
 * 「本次不出片」和填链接放在同一个弹窗里 —— 打开它的时机是一样的
 * （商务问完达人有了结果），结果无非这两种。分成两个入口会让人先想
 * 「我该点哪个」，而那是系统该替他省掉的一步。
 */
function openVideoLinkModal(collaborationId, f) {
  const a = f.account || {};
  const who = a.nickname || a.douyinId || a.uid || '这个账号';
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box">
    <h3>${esc(who)} 的视频</h3>
    <p class="sub">填了链接会自动标记为「已发布」。<b>如果达人这次不出片</b>，
      选下面那一项，这个账号就不再计入待办和进度分母。</p>
    <div class="frow">
      <label>视频链接</label>
      <input id="vlUrl" class="mono" placeholder="https://www.douyin.com/video/…"
        autocomplete="off" spellcheck="false">
      <div class="hint" id="vlHint">抖音分享出来的链接，粘进来即可。也可以粘完整口令，系统会自己抠链接。</div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:12.8px;cursor:pointer;margin-top:4px">
      <input type="checkbox" id="vlNone"> 本次不出片
    </label>
    <div class="acts"><button class="btn" id="vlCancel">取消</button>
      <button class="btn primary" id="vlSave">保存</button></div>
  </div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#vlCancel').onclick = close;

  const url = m.querySelector('#vlUrl');
  const none = m.querySelector('#vlNone');
  const hint = m.querySelector('#vlHint');
  const save = m.querySelector('#vlSave');

  /* 勾了「本次不出片」就没有链接可填了 —— 让输入框自己变灰，
     比留着一个能填但会被忽略的框诚实。 */
  none.onchange = () => {
    url.disabled = none.checked;
    url.style.opacity = none.checked ? '.45' : '';
    hint.textContent = none.checked
      ? '这个账号不再计入待办和进度分母，随时可以改回来'
      : '抖音分享出来的链接，粘进来即可。也可以粘完整口令，系统会自己抠链接。';
  };

  /* 粘完整口令时把链接抠出来 —— 达人发来的常常是一整段口令，
     让人自己从里面找链接是多余的一步。 */
  url.oninput = () => {
    const hit = url.value.match(/https?:\/\/[^\s，,。、]+/);
    if (hit && hit[0] !== url.value.trim()) url.value = hit[0];
  };
  setTimeout(() => url.focus(), 30);
  url.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };

  save.onclick = async () => {
    const patch = none.checked
      ? { filmingProgress: '本次不出片' }
      : { videoUrl: url.value.trim() };
    if (!none.checked && !/^https?:\/\//.test(patch.videoUrl)) {
      hint.textContent = '请填一个 http 开头的链接，或勾选「本次不出片」';
      hint.style.color = 'var(--red)';
      url.focus();
      return;
    }
    save.disabled = true; save.textContent = '保存中…';
    try {
      await api('POST', `/api/fulfillments/${f.id}`, patch);
      close();
      toast(none.checked ? '已标记为本次不出片' : '已保存视频链接');
      await openCollaboration(collaborationId);
      loadDesk(); loadRecords();
    } catch (e) {
      save.disabled = false; save.textContent = '保存';
      hint.textContent = e.message; hint.style.color = 'var(--red)';
    }
  };
}

/* ---------- 原始识别记录 ---------- */

/**
 * 时间线上点开的原文。
 *
 * 显示的是**模型抽出什么、人改成什么**（diff）。
 * 排查「这个字段怎么是错的」时，这是唯一能回答的地方 ——
 * 也是将来调优提示词的语料，每一条 diff 都是一次免费的标注。
 */
async function openLogsModal(collaborationId, title) {
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box" style="max-width:680px">
    <h3>${esc(title || '原始识别记录')}</h3>
    <p class="sub">这条合作建档时的原文、模型输出，以及人工改了哪些字段。</p>
    <div id="lgBody"><div class="dim">加载中…</div></div>
    <div class="acts"><button class="btn" id="lgClose">关闭</button></div>
  </div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#lgClose').onclick = close;

  const body = m.querySelector('#lgBody');
  let logs = [];
  try {
    logs = (await api('GET', `/api/collaborations/${collaborationId}/logs`)).logs || [];
  } catch (e) {
    body.innerHTML = `<div class="alert warn"><b>读取失败</b>${esc(e.message)}</div>`;
    return;
  }
  if (!logs.length) {
    /* 手工建档、或迁移过来的老记录没有识别记录。说清楚为什么没有，
       而不是给一个空白的框让人以为坏了。 */
    body.innerHTML = '<div class="dim">这条合作没有识别记录 —— '
      + '手工建档或从旧数据迁移来的记录不会有原文。</div>';
    return;
  }
  body.innerHTML = logs.map((l) => `<div class="src" style="font-family:inherit;margin-bottom:12px">
    <div class="dim mono" style="margin-bottom:6px">
      ${esc(l.confirmedByName || '—')} · ${fmtTime(l.confirmedAt)}
      · ${l.mode === 'llm' ? esc(l.model) : '本地模拟'} · ${esc(l.promptVersion || '')}
      ${l.elapsedMs ? ` · 耗时 ${(l.elapsedMs / 1000).toFixed(1)}s` : ''}
    </div>
    <div style="white-space:pre-wrap;word-break:break-all;font-size:12.5px;line-height:1.7;
      max-height:220px;overflow:auto;padding:8px;background:var(--line-soft);border-radius:6px">${
        esc(l.rawText || '（无原文）')}</div>
    ${l.diff?.length
      ? `<div style="margin-top:8px;font-size:12.5px"><b>人工修改 ${l.diff.length} 处</b>${
        l.diff.map((d) => `<div class="dim">${esc(d.field)}：「${esc(d.before || '空')}」→「${esc(d.after || '空')}」</div>`).join('')}</div>`
      : '<div class="dim" style="margin-top:8px;font-size:12.5px">模型的输出未被修改</div>'}
  </div>`).join('');
}

/* ================================================================ 运行日志 */

let LOG = { kind: 'ops', offset: 0 };

/**
 * 把 `POST /api/collaborations/:id/packages` 这种路由模板翻成人话。
 *
 * 直接展示方法+路径也能看，但一屏几十行全是 URL，
 * 眼睛得逐个解析 —— 而看日志的人多半是在找某一件具体的事。
 * 翻不出来的就原样显示，不编。
 */
const OP_NAMES = {
  'POST /api/collaborations': '建档',
  'DELETE /api/collaborations/:id': '删除合作',
  'POST /api/collaborations/:id/packages': '回填快递',
  'POST /api/collaborations/:id/notified': '标记已告知',
  'POST /api/collaborations/:id/status': '改状态',
  'POST /api/fulfillments/:id': '更新履约项',
  'POST /api/creators/:id/transfer': '转交归属',
  'POST /api/creators/:id/accounts': '补充账号',
  'POST /api/video/submit': '回传视频',
  'POST /api/shipments/confirm': '批量回填快递',
  'DELETE /api/packages/:id': '删除包裹',
  'POST /api/products': '产品维护',
  'DELETE /api/products/:id': '停用产品',
  'PUT /api/settings': '改设置',
  'POST /api/auth/login': '登录',
  'POST /api/auth/logout': '登出',
  'POST /api/auth/bootstrap': '初始化',
  'POST /api/feishu/sync-one': '手动同步一条',
  'POST /api/feishu/sync-now': '全量同步',
  'POST /api/jobs': '提交识别',
  'DELETE /api/jobs/:id': '移除识别任务',
};
const opName = (a) => OP_NAMES[a] || a;

async function loadLogs(reset = true) {
  if (reset) LOG.offset = 0;
  const body = $('#logBody');
  if (reset) body.innerHTML = '<div class="dim">加载中…</div>';

  const path = LOG.kind === 'errors'
    ? `/api/logs/errors?limit=50&offset=${LOG.offset}`
    : `/api/logs/ops?limit=50&offset=${LOG.offset}${LOG.kind === 'failed' ? '&failed=1' : ''}`;

  let data;
  try { data = await api('GET', path); }
  catch (e) { body.innerHTML = `<div class="alert warn"><b>读取失败</b>${esc(e.message)}</div>`; return; }

  if (reset) body.innerHTML = '';
  if (!data.rows.length && reset) {
    body.innerHTML = `<div class="dim">${LOG.kind === 'errors' ? '没有错误记录 —— 这是好事'
      : LOG.kind === 'failed' ? '没有失败的操作' : '还没有操作记录'}</div>`;
  }

  data.rows.forEach((r) => body.append(LOG.kind === 'errors' ? errRow(r) : opRow(r)));
  LOG.offset += data.rows.length;
  $('#logMore').style.display = LOG.offset < data.total ? '' : 'none';
  msg('#logMsg', `共 ${data.total} 条，已显示 ${LOG.offset}`);
}

function opRow(r) {
  const d = el('div', 'src');
  d.style.cssText = 'font-family:inherit;margin-bottom:6px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap';
  d.innerHTML = `<span class="dim mono" style="flex:none">${esc(fmtTime(r.at))}</span>`
    + `<b style="flex:none">${esc(r.userName || '—')}</b>`
    + `<span style="flex:none">${esc(opName(r.action))}</span>`
    + (r.target ? `<span class="mono dim">${esc(r.target)}</span>` : '')
    + (r.summary ? `<span class="dim">${esc(r.summary)}</span>` : '')
    /* 失败的操作显式标出来。全成功时不加噪声，失败时一眼能挑出来。 */
    + (r.ok ? '' : `<span class="st failed" style="margin-left:auto">失败 ${r.status}</span>`)
    + (r.ms > 1000 ? `<span class="dim" style="margin-left:auto">${(r.ms / 1000).toFixed(1)}s</span>` : '');
  return d;
}

function errRow(r) {
  const d = el('div', 'src');
  d.style.cssText = 'font-family:inherit;margin-bottom:10px';
  d.innerHTML = `<div class="dim mono" style="margin-bottom:4px">${esc(fmtTime(r.at))}`
    + ` · ${esc(r.source || '')}${r.userName ? ` · ${esc(r.userName)}` : ''}`
    + `${r.context ? ` · ${esc(r.context)}` : ''}</div>`
    + `<div style="color:var(--red);font-size:12.8px;word-break:break-all">${esc(r.message)}</div>`;
  if (r.stack) {
    /* 堆栈默认收起 —— 一屏铺满堆栈的话，「有几种错」这个最该先看到的信息就没了。 */
    const tog = el('button', 'btn sm');
    tog.style.marginTop = '6px';
    tog.textContent = '展开堆栈';
    const pre = el('div');
    pre.style.cssText = 'display:none;white-space:pre-wrap;word-break:break-all;font:11.5px/1.6 ui-monospace,monospace;'
      + 'margin-top:6px;padding:8px;background:var(--line-soft);border-radius:6px;max-height:240px;overflow:auto';
    pre.textContent = r.stack;
    tog.onclick = () => {
      const on = pre.style.display === 'none';
      pre.style.display = on ? '' : 'none';
      tog.textContent = on ? '收起堆栈' : '展开堆栈';
    };
    d.append(tog, pre);
  }
  return d;
}

$$('#logSeg button').forEach((b) => {
  b.onclick = () => {
    $$('#logSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); LOG.kind = b.dataset.log; loadLogs(true);
  };
});
$('#logMore').onclick = () => loadLogs(false);

/* ---------- 删除合作 ---------- */

/**
 * 删除确认弹窗。
 *
 * 原来是 `confirm()` + `prompt()` 两个浏览器原生框。功能上够用，但：
 *   · 长文案在原生框里挤成一坨，「哪些会删、哪些保留」这两句最该看清的看不清
 *   · prompt 里要照抄的名字**不在框里**，只在标题上，得记着再敲
 *   · Safari 连着弹两个会被当成弹窗骚扰拦掉第二个 —— 那时候第一道已经点过了
 *
 * 改成一个弹窗：后果列清楚，要抄的名字就摆在输入框上方，
 * 名字对不上时删除按钮是灰的 —— **不让人点了才告诉他不行**。
 */
function openDeleteModal(cb) {
  const name = cb.creatorName || '未命名达人';
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box">
    <h3>删除这条合作</h3>
    <p class="sub"><b style="color:var(--red)">此操作不可恢复。</b></p>
    <div class="alert warn" style="margin-bottom:14px">
      <b>会一起删掉</b>
      ${cb.items.length ? `${cb.items.length} 个产品行 · ` : ''}${cb.fulfillments.length} 个履约项${
        cb.packages.length ? ` · ${cb.packages.length} 条快递记录` : ''}，以及飞书里对应的行。
    </div>
    <div class="alert" style="margin-bottom:14px">
      <b>会保留</b>达人档案（他可能还有别的合作）和录入日志（调优提示词的语料）。
    </div>
    <div class="frow">
      <label>确认请输入达人名称</label>
      <div class="src mono" style="margin-bottom:6px;user-select:all">${esc(name)}</div>
      <input id="dlName" autocomplete="off" spellcheck="false" placeholder="照着上面抄一遍">
      <div class="hint" id="dlHint">名字对上之后「确认删除」才能点。</div>
    </div>
    <div class="acts">
      <button class="btn" id="dlCancel">取消</button>
      <button class="btn danger" id="dlGo" disabled>确认删除</button>
    </div>
  </div>`;
  document.body.append(m);

  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#dlCancel').onclick = close;

  const inp = m.querySelector('#dlName');
  const go = m.querySelector('#dlGo');
  const hint = m.querySelector('#dlHint');

  /* 名字对上之前按钮一直是灰的。原来是点了之后才判断、不匹配就 toast 一句 ——
     那等于让人先把不可逆的按钮按下去，再告诉他「刚才那下不算」。 */
  const check = () => { go.disabled = inp.value.trim() !== name; };
  inp.oninput = check;
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); };
  setTimeout(() => inp.focus(), 30);

  go.onclick = async () => {
    if (inp.value.trim() !== name) return;   // 兜底：按钮理应是灰的
    go.disabled = true; go.textContent = '删除中…';
    try {
      await api('DELETE', `/api/collaborations/${cb.id}`);
      close(); closeDrawer(); toast('已删除'); loadDesk(); loadRecords();
    } catch (e) {
      go.textContent = '确认删除'; check();
      hint.textContent = e.message; hint.style.color = 'var(--red)';
    }
  };
}

/* ---------- 归属转交 ---------- */

/**
 * 转交挂在**达人**上，不在合作上。
 *
 * 合作跟着达人走（transferOwner 会把这个达人名下的合作一起转），
 * 所以「转一条合作」这个动作本身不成立 —— 真做了会让
 * 「这个达人归谁」出现两个互相矛盾的答案。
 */
function openTransferModal(creatorId, creatorName) {
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box">
    <h3>转交归属</h3>
    <p class="sub">归属人是责任人，待办发给他。<b>「${esc(creatorName || '这个达人')}」名下的所有合作会一起转过去</b>，
      不是只转当前这一条。谁转的、为什么转都会留痕。</p>
    <div class="frow"><label>转交给</label><select id="trTo"></select></div>
    <div class="frow"><label>原因</label><input id="trWhy" placeholder="如：人员调整" value="人员调整"></div>
    <div class="acts"><button class="btn" id="trCancel">取消</button><button class="btn primary" id="trGo">转交</button></div>
  </div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#trCancel').onclick = close;

  const sel = m.querySelector('#trTo');
  (CFG.users || []).forEach((u) => {
    const o = el('option', null, u.name); o.value = u.id; sel.append(o);
  });

  m.querySelector('#trGo').onclick = async () => {
    try {
      await api('POST', `/api/creators/${creatorId}/transfer`,
        { toUserId: sel.value, reason: m.querySelector('#trWhy').value.trim() });
      close(); closeDrawer(); toast('已转交'); loadDesk(); loadRecords();
    } catch (e) { toast(e.message); }
  };
}

function openTrackingModal(collaborationId) {
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box">
    <h3>回填快递信息</h3>
    <p class="sub">填完状态自动变「已寄样」，并生成「告知达人」待办。一次合作拆多个包裹就多填几次。</p>
    <div class="frow2">
      <div class="frow"><label>快递公司</label><input id="tkCarrier" placeholder="如 申通" value="申通"></div>
      <div class="frow"><label>快递单号</label><input id="tkNo" class="mono" placeholder="773435035826894"></div>
    </div>
    <div id="tkList"></div>
    <div class="acts"><button class="btn" id="tkCancel">关闭</button><button class="btn primary" id="tkSave">保存</button></div>
  </div>`;
  document.body.append(m);
  const close = () => { m.remove(); loadDesk(); loadRecords(); };
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#tkCancel').onclick = close;

  const refresh = async () => {
    const { collaboration } = await api('GET', '/api/collaborations/' + collaborationId);
    const list = m.querySelector('#tkList'); list.innerHTML = '';
    if (collaboration.packages.length) {
      list.append(el('div', 'dim', '已有包裹：'));
      collaboration.packages.forEach((p) => {
        const row = el('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px';
        row.append(el('span', 'mono', `${esc(p.carrier)} ${esc(p.trackingNo)}`));
        const d = el('button', 'btn sm danger', '删除');
        d.style.marginLeft = 'auto';
        d.onclick = async () => { await api('DELETE', '/api/packages/' + p.id); refresh(); };
        row.append(d); list.append(row);
      });
    }
  };
  refresh();

  m.querySelector('#tkSave').onclick = async () => {
    const carrier = m.querySelector('#tkCarrier').value.trim();
    const trackingNo = m.querySelector('#tkNo').value.trim();
    if (!trackingNo) { toast('请填写快递单号'); return; }
    try {
      const r = await api('POST', `/api/collaborations/${collaborationId}/packages`, { carrier, trackingNo });
      m.querySelector('#tkNo').value = '';
      toast('已回填，状态变为「' + r.collaboration.status + '」');
      refresh();
    } catch (e) { toast(e.message); }
  };
}

/* ---------- 回访结果 ---------- */

async function openFollowUpModal(collaborationId) {
  const { collaboration } = await api('GET', '/api/collaborations/' + collaborationId);
  const m = el('div', 'modal');
  m.innerHTML = `<div class="box">
    <h3>记录回访结果</h3>
    <p class="sub">先问是否收到样品，收到了再催拍。逐个账号记录。</p>
    <div id="fuList"></div>
    <div class="acts"><button class="btn" id="fuClose">完成</button></div>
  </div>`;
  document.body.append(m);
  const close = () => { m.remove(); loadDesk(); loadRecords(); };
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#fuClose').onclick = close;

  const list = m.querySelector('#fuList');
  collaboration.fulfillments.forEach((f) => {
    const row = el('div', 'frow');
    row.innerHTML = `<label>${esc(f.account?.nickname || f.account?.douyinId || '账号')}</label>`;
    const sel = el('select');
    ['待拍摄', '已催拍', '本次不出片'].forEach((o) => { const x = el('option', null, o); x.value = o; sel.append(x); });
    if (f.filmingProgress === '已发布') {
      sel.innerHTML = ''; const x = el('option', null, '已发布（已回传视频）'); sel.append(x); sel.disabled = true;
    } else sel.value = f.filmingProgress;
    sel.onchange = async () => {
      await api('POST', '/api/fulfillments/' + f.id, { filmingProgress: sel.value });
      toast('已记录');
    };
    row.append(sel); list.append(row);
  });
}

/* ---------- 达人详情 ---------- */


/* ================================================================ 合作记录 */

let scope = 'mine', statusFilter = '';

$$('#scopeSeg button').forEach((b) => {
  b.onclick = () => {
    $$('#scopeSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); scope = b.dataset.scope; loadRecords();
  };
});
$$('#statusSeg button').forEach((b) => {
  b.onclick = () => {
    $$('#statusSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); statusFilter = b.dataset.status; loadRecords();
  };
});
let qTimer = null;
$('#q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadRecords, 260); };

/**
 * 飞书同步状态胶囊。
 *
 * 「未同步」和「同步失败」必须能一眼分开 —— 前者多半是同步开启之前的老记录，
 * 不需要做什么；后者是真出了问题，越早看见越好。混成一个灰点的话，
 * 表里几十条都是灰的，真正坏掉的那条就淹没了。
 */
/** 记录表最近一次拉到的同步状态，详情抽屉复用它 */
let RECORDS_SYNC = {};

const SYNC_LABEL = {
  /* cls 只能用 index.html 里真实存在的 .st 变体 ——
     写一个不存在的类名不会报错，只会渲染成没有颜色的胶囊，
     而「颜色没了」这种问题没人会去查 CSS。 */
  off:     { text: '未启用', cls: 'queued',  tip: '飞书同步没开或没配完，去设置里看' },
  never:   { text: '未同步', cls: 'queued',  tip: '这条从没推过，多半是开启同步之前就存在的记录' },
  pending: { text: '待同步', cls: 'running', tip: '在队列里等推送' },
  synced:  { text: '已同步', cls: 'done',    tip: '飞书里有对应的行' },
  failed:  { text: '同步失败', cls: 'failed', tip: '重试到上限了，点开看原因' },
};

function syncPill(st) {
  const d = SYNC_LABEL[st?.state] || SYNC_LABEL.never;
  const tip = st?.error ? `${d.tip}：${st.error}`
            : st?.state === 'synced' && st.at ? `${d.tip}（${daysAgo(st.at)}，${st.rows} 行）`
            : d.tip;
  return `<span class="st ${d.cls}" title="${esc(tip)}">${d.text}</span>`;
}

/**
 * 合作状态胶囊。颜色只用 index.html 里真实存在的 .st 变体。
 */
function statusPill(status) {
  const cls = status === '已完成' ? 'done'
    : status === '进行中' ? 'running'
    : status === '已终止' ? 'failed'
    : 'queued';
  return `<span class="st ${cls}">${esc(status)}</span>`;
}

/**
 * 快递格：单号 + 发货状态。
 *
 * **「发货状态」是从有没有单号推出来的，不是真实物流轨迹。**
 * 系统里没有物流数据源 —— 快递公司和单号是人填的，到哪了没人知道。
 * 所以只说「已发货 / 待发货」这种我们确实知道的事，
 * 不去编一个「运输中」「已签收」出来。真要轨迹得接快递查询 API。
 */
function shipmentCell(cb) {
  if (!uiNeedsSample(cb.type)) return '<span class="dim">—</span>';
  if (!cb.packages.length) {
    return `<span class="st queued">待发货</span>`;
  }
  const lines = cb.packages
    .map((p) => `<div class="mono">${esc(p.carrier || '')} ${esc(p.trackingNo)}</div>`).join('');
  return `<span class="st done">已发货</span>${lines}`;
}

/**
 * 视频格：几个号发布了 / 一共几个要出片。
 *
 * 按「要出片的账号」算分母，不按全部账号 —— 标了「本次不出片」的号
 * 算进分母的话，这条永远凑不齐，看起来像一直没做完。
 */
function videoCell(cb) {
  const want = cb.fulfillments.filter((f) => f.expectVideo);
  if (!want.length) return '<span class="dim">不出片</span>';
  const done = want.filter((f) => f.filmingProgress === '已发布').length;
  const cls = done === want.length ? 'done' : done ? 'running' : 'queued';
  const label = done === want.length ? '已发布' : done ? '部分发布' : '未发布';
  return `<span class="st ${cls}">${label}</span>`
    + `<div class="dim">${done}/${want.length}</div>`;
}

async function loadRecords() {
  const q = encodeURIComponent($('#q').value.trim());
  let data, todos = [];
  try { data = await api('GET', `/api/collaborations?q=${q}&scope=${scope}`); } catch { return; }
  // 「需要处理」不是一个状态，是一个筛选 —— 这就是待办不该做成独立页面的原因
  if (statusFilter === '__todo') {
    try { todos = (await api('GET', '/api/todos')).todos; } catch { /* ignore */ }
  }
  const need = new Set(todos.map((t) => t.collaborationId).filter(Boolean));

  let list = data.collaborations;
  if (statusFilter === '__todo') list = list.filter((cb) => need.has(cb.id));
  else if (statusFilter) list = list.filter((cb) => cb.status === statusFilter);

  const box = $('#recBody'); box.innerHTML = '';
  if (!list.length) {
    box.append(el('div', 'empty', q ? '没有匹配的记录'
      : statusFilter ? '这个筛选下没有记录' : '还没有合作记录'));
    return;
  }

  const states = data.syncStates || {};
  RECORDS_SYNC = states;
  const t = el('table');
  t.innerHTML = `<thead><tr>
    <th style="width:17%">达人 / 账号</th>
    <th style="width:9%">状态</th>
    <th style="width:15%">寄样</th>
    <th style="width:18%">快递</th>
    <th style="width:13%">视频</th>
    <th style="width:10%">飞书同步</th>
    <th style="width:9%">建档</th>
    <th style="width:9%">更新</th></tr></thead>`;
  const tb = el('tbody');
  list.forEach((cb) => {
    const tr = el('tr');

    /* 多账号一行一个。以前是「、」拼在一格里，矩阵号一多就看不清哪个是哪个。 */
    const accs = cb.fulfillments.length
      ? cb.fulfillments.map((f) => {
        const a = f.account || {};
        return `<div>${esc(a.nickname || a.douyinId || a.uid || '—')}</div>`
          + (a.douyinId && a.nickname ? `<div class="mono dim">${esc(a.douyinId)}</div>` : '');
      }).join('')
      : '<span class="dim">无账号</span>';

    const ship = !uiNeedsSample(cb.type)
      ? '<span class="dim">不寄样</span>'
      : cb.items.length
        ? cb.items.map((i) => `${esc(i.productName)} ×${i.quantity}`).join('<br>')
        : '<span class="tag miss">未填</span>';

    tr.innerHTML = `<td><b>${esc(cb.creatorName || '未命名达人')}</b>
        <div style="margin-top:2px">${accs}</div></td>
      <td>${statusPill(cb.status)}</td>
      <td>${ship}</td>
      <td>${shipmentCell(cb)}</td>
      <td>${videoCell(cb)}</td>
      <td>${syncPill(states[cb.id])}</td>
      <td class="dim">${esc(fmtDate(cb.createdAt))}</td>
      <td class="dim">${esc(fmtDate(cb.updatedAt))}</td>`;
    tr.onclick = () => openCollaboration(cb.id);
    tb.append(tr);
  });
  t.append(tb); box.append(t);
}

/* ================================================================ 设置 */

let curRole = 'business', curStyle = { m: 'chat', v: 'chat' };

function openSettings(panel) { $('#settings').classList.add('on'); if (panel) switchPanel(panel); }
function switchPanel(name) {
  $$('.settings nav button').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  $$('.spanel').forEach((p) => p.classList.toggle('on', p.id === 'sp-' + name));
  if (name === 'feishu') loadFeishu();   // 每次进来重新拉状态，队列数要是实时的
  if (name === 'logs') loadLogs(true);   // 同理，日志要是刚发生的那些
}
$('#openSettings').onclick = () => openSettings();
$('#closeSettings').onclick = () => { $('#settings').classList.remove('on'); };
$$('.settings nav button').forEach((b) => { b.onclick = () => switchPanel(b.dataset.panel); });

function setRole(r) { curRole = r; $$('#roleChips button').forEach((b) => b.classList.toggle('on', b.dataset.role === r)); }
function setStyle(prefix, s) {
  curStyle[prefix] = s;
  const segId = prefix === 'm' ? '#styleSeg' : '#vStyleSeg';
  $$(`${segId} button`).forEach((b) => b.classList.toggle('on', b.dataset.style === s));
}
$$('#styleSeg button').forEach((b) => { b.onclick = () => setStyle('m', b.dataset.style); });
$$('#vStyleSeg button').forEach((b) => { b.onclick = () => setStyle('v', b.dataset.style); });

function fillSettings() {
  const rc = $('#roleChips');
  if (!rc.children.length) {
    rc.append(...CFG.roles.map((r) => {
      const b = el('button', null, esc(r.name)); b.dataset.role = r.id;
      b.onclick = () => setRole(r.id); return b;
    }));
  }
  const s = CFG.settings;
  /* 这一块永远是**当前登录者自己**的资料。
     以前绑的是一份全局的 settings.user（谁保存谁覆盖），
     于是商务甲打开设置页看到的是商务乙的姓名和角色，
     一点保存还会按姓名匹配、改到商务乙的记录上去。 */
  setRole(s.user.role || 'business');
  $('#uName').value = s.user.name || ''; $('#uPhone').value = s.user.phone || '';
  const who = $('#whoEditing');
  if (who) who.textContent = CFG.me ? CFG.me.name : '你自己';

  $('#mProvider').value = s.model.provider || ''; $('#mBase').value = s.model.baseUrl || '';
  $('#mModel').value = s.model.model || ''; setStyle('m', s.model.apiStyle || 'chat');
  $('#mConc').value = s.model.concurrency ?? 3; $('#mTimeout').value = Math.round((s.model.timeoutMs ?? 60000) / 1000);
  $('#mKey').value = ''; $('#mKey').placeholder = s.model.hasApiKey ? s.model.apiKeyMasked + '（留空不修改）' : 'sk-…';
  $('#keyHint').textContent = s.model.fromEnv
    ? '当前用的是 .env 里的配置。在这里填写会覆盖它。'
    : '保存在本机 data/settings.json，与业务数据分开存放。留空表示不修改。';

  $('#vProvider').value = s.vision.provider || ''; $('#vBase').value = s.vision.baseUrl || '';
  $('#vModel').value = s.vision.model || ''; setStyle('v', s.vision.apiStyle || 'chat');
  $('#vKey').value = ''; $('#vKey').placeholder = s.vision.hasApiKey ? s.vision.apiKeyMasked + '（留空不修改）' : 'sk-…';
  $('#vKeyHint').textContent = CFG.visionReady ? '已配置，可上传发货截图。' : '未配置，截图上传功能禁用。';

  $('#fFirst').value = s.followUp.firstDays ?? 7;
  $('#fRepeat').value = s.followUp.repeatDays ?? 5;
  $('#tpl').value = s.notifyTemplate || '';
}

const msg = (id, text, ok = true) => {
  const e = $(id); e.style.color = ok ? 'var(--green)' : 'var(--red)'; e.textContent = text;
  if (ok) setTimeout(() => { if (e.textContent === text) e.textContent = ''; }, 2600);
};

$('#saveUser').onclick = async () => {
  const name = $('#uName').value.trim();
  if (!name) { msg('#userMsg', '请填写姓名', false); return; }
  try {
    /* 不传 id：改谁由服务端按会话决定。
       让客户端指定改谁，等于把越权做成一个请求参数。 */
    await api('PUT', '/api/settings', { user: { name, role: curRole, phone: $('#uPhone').value.trim() } });
    await refreshConfig(); loadDesk(); loadRecords();
    msg('#userMsg', '已保存');
  } catch (e) { msg('#userMsg', e.message, false); }
};

$('#saveModel').onclick = async () => {
  try {
    await api('PUT', '/api/settings', { model: {
      provider: $('#mProvider').value.trim(), baseUrl: $('#mBase').value.trim(),
      model: $('#mModel').value.trim(), apiStyle: curStyle.m, apiKey: $('#mKey').value.trim(),
      concurrency: Number($('#mConc').value) || 3, timeoutMs: (Number($('#mTimeout').value) || 60) * 1000,
    } });
    await refreshConfig(); msg('#modelMsg', '已保存，立即生效');
  } catch (e) { msg('#modelMsg', e.message, false); }
};

$('#saveVision').onclick = async () => {
  try {
    await api('PUT', '/api/settings', { vision: {
      provider: $('#vProvider').value.trim(), baseUrl: $('#vBase').value.trim(),
      model: $('#vModel').value.trim(), apiStyle: curStyle.v, apiKey: $('#vKey').value.trim(),
    } });
    await refreshConfig(); msg('#visionMsg', '已保存');
  } catch (e) { msg('#visionMsg', e.message, false); }
};

$('#clearKey').onclick = async () => {
  if (!confirm('清除已保存的 API Key？清除后回落到本地模拟识别。')) return;
  await api('PUT', '/api/settings', { model: { clearApiKey: true } });
  await refreshConfig(); toast('已清除');
};
$('#clearVKey').onclick = async () => {
  if (!confirm('清除视觉模型的 API Key？')) return;
  await api('PUT', '/api/settings', { vision: { clearApiKey: true } });
  await refreshConfig(); toast('已清除');
};

const doTest = async (which, outId, btnId) => {
  const out = $(outId); out.className = 'testout on'; out.textContent = '正在连接…';
  $(btnId).disabled = true;
  const p = which === 'vision' ? 'v' : 'm';
  try {
    const r = await api('POST', '/api/settings/test', {
      which, baseUrl: $(`#${p}Base`).value.trim(), model: $(`#${p}Model`).value.trim(),
      apiStyle: curStyle[p], apiKey: $(`#${p}Key`).value.trim(),
    });
    if (r.ok) {
      out.className = 'testout on ok';
      out.innerHTML = `<b>连接成功</b>（${r.elapsedMs}ms，${esc(r.apiStyle)} 模式）`
        + `<br><span class="mono">${esc(r.url)}</span><br>模型返回：<code>${esc(r.sample)}</code>`;
    } else {
      out.className = 'testout on bad';
      out.innerHTML = `<b>连接失败</b><br><span class="mono">${esc(r.url || '')}</span><br>${esc(r.error)}`;
    }
  } catch (e) { out.className = 'testout on bad'; out.innerHTML = `<b>连接失败</b><br>${esc(e.message)}`; }
  finally { $(btnId).disabled = false; }
};
$('#testModel').onclick = () => doTest('model', '#testOut', '#testModel');
$('#testVision').onclick = () => doTest('vision', '#vTestOut', '#testVision');

$('#saveWorkflow').onclick = async () => {
  try {
    await api('PUT', '/api/settings', {
      followUp: { firstDays: Number($('#fFirst').value) || 7, repeatDays: Number($('#fRepeat').value) || 5 },
      notifyTemplate: $('#tpl').value,
    });
    await refreshConfig(); loadDesk(); msg('#wfMsg', '已保存');
  } catch (e) { msg('#wfMsg', e.message, false); }
};

/* ---------- 产品管理 ---------- */

$('#addProduct').onclick = async () => {
  const name = $('#pName').value.trim();
  if (!name) { msg('#prodMsg', '请填写产品名称', false); return; }
  try {
    await api('POST', '/api/products', { name, petCategory: $('#pCat').value, spec: $('#pSpec').value.trim() });
    $('#pName').value = ''; $('#pSpec').value = '';
    await loadProducts(); msg('#prodMsg', '已添加');
  } catch (e) { msg('#prodMsg', e.message, false); }
};

function renderProductList() {
  const box = $('#prodList'); if (!box) return;
  box.innerHTML = '';
  if (!PRODUCTS.length) { box.append(el('div', 'muted', '还没有产品。录入合作时需要从这里选。')); return; }
  const t = el('table');
  t.innerHTML = '<thead><tr><th>产品</th><th>适用宠物</th><th>规格</th><th>状态</th><th></th></tr></thead>';
  const tb = el('tbody');
  PRODUCTS.forEach((p) => {
    const tr = el('tr'); tr.style.cursor = 'default';
    tr.innerHTML = `<td><b>${esc(p.name)}</b></td><td>${esc(p.petCategory)}</td>
      <td class="muted">${esc(p.spec || '—')}</td>
      <td>${p.active === false ? '<span class="muted">已停用</span>' : '启用中'}</td><td></td>`;
    const td = tr.lastElementChild;
    if (p.active === false) {
      const on = el('button', 'link', '恢复');
      on.onclick = async () => { await api('POST', '/api/products', { id: p.id, active: true }); loadProducts(); };
      td.append(on);
    } else {
      const off = el('button', 'link red', '删除');
      off.onclick = async () => {
        if (!confirm('删除该产品？若已被合作引用，会改为停用而不是删除。')) return;
        const r = await api('DELETE', '/api/products/' + p.id);
        toast(r.softDeleted ? '该产品已被合作引用，已改为停用' : '已删除');
        loadProducts();
      };
      td.append(off);
    }
    tb.append(tr);
  });
  t.append(tb); box.append(t);
}

/* ================================================================ 飞书同步设置 */

let FS = null;      // /api/feishu/state 的结果
let FS_FIELDS = []; // 当前所选表的列

async function loadFeishu() {
  try { FS = await api('GET', '/api/feishu/state'); } catch { return; }

  $('#fsAppId').value = FS.appId || '';
  $('#fsToken').value = FS.appToken || '';
  $('#fsSecret').value = '';
  $('#fsSecret').placeholder = FS.hasSecret ? FS.secretMasked + '（留空不修改）' : 'xxxxxxxxxxxx';
  $('#fsSecretHint').textContent = FS.hasSecret ? '已保存' : '未配置';
  $$('#fsEnable button').forEach((b) => b.classList.toggle('on', (b.dataset.on === '1') === Boolean(FS.enabled)));

  /* 只提示「当前这一步」而不是一次甩出全部问题 ——
     后面几条本来就得等前面做完才可能满足，一起列出来只会让人不知道从哪下手。 */
  const p = $('#fsProblems');
  if (FS.problems?.length) {
    p.style.display = '';
    p.innerHTML = `<b>下一步</b>${esc(FS.problems[0])}`
      + (FS.problems.length > 1 ? `<div class="dim" style="margin-top:4px">之后还需要：${
        FS.problems.slice(1).map(esc).join('；')}</div>` : '');
  } else p.style.display = 'none';

  const q = FS.queue || {};
  $('#fsQueue').innerHTML = q.pending || q.failed
    ? `待推送 ${q.pending}${q.failed ? ` · <span style="color:var(--red)">失败 ${q.failed}</span>` : ''}`
      + (q.lastError ? `<div class="dim" style="margin-top:4px">${esc(q.lastError)}</div>` : '')
    : '队列为空';

  /* 映射区块以前默认隐藏，只有测试连接成功才出现 ——
     而「必须把系统ID映射到一列」这句提示却一直显示，
     等于让人去做一件界面上根本看不到的事。现在改成常显：
     连不上时就在原地说清楚卡在哪、下一步做什么。 */
  if (!FS.appId || !FS.hasSecret || !FS.appToken) {
    blockMap('先在上面填好 App ID、App Secret 和多维表格链接，再点「测试连接」。'
      + '连上之后，这里会列出你飞书表里的列供选择。');
    return;
  }

  let tables = null;
  try {
    const r = await api('POST', '/api/feishu/test', {});
    tables = r.tables || null;
    if (!r.ok) {
      const bad = (r.steps || []).find((x) => !x.ok);
      blockMap(`连不上飞书，所以读不到列：${bad ? bad.detail : '原因未知'}`);
      if (tables?.length) fillTableSelect(tables);
      return;
    }
  } catch (e) {
    blockMap(`连不上飞书，所以读不到列：${e.message}`);
    return;
  }

  if (tables?.length) fillTableSelect(tables);
  if (!FS.tableId) { blockMap('还没选要写入哪张表。在上面的下拉里选一张，这里就会列出它的列。'); return; }
  await loadFeishuFields(FS.tableId);
}

/** 读不到列时，把原因和下一步显示在映射区，而不是让那块空着 */
function blockMap(reason) {
  $('#fsMap').innerHTML = '';
  const b = $('#fsMapBlocked');
  b.style.display = '';
  b.innerHTML = `<b>暂时还列不出飞书的列</b>${esc(reason)}`;
}

function fillTableSelect(tables) {
  const sel = $('#fsTable'); sel.innerHTML = '';
  sel.append(el('option', null, '— 选择数据表 —'));
  tables.forEach((t) => { const o = el('option', null, esc(t.name)); o.value = t.tableId; sel.append(o); });
  sel.value = FS?.tableId || '';
  $('#fsTableBox').style.display = '';
}

async function loadFeishuFields(tableId) {
  try {
    const r = await api('GET', '/api/feishu/fields?tableId=' + encodeURIComponent(tableId));
    FS_FIELDS = r.fields;
    renderFeishuMap(new Set(r.writable));
  } catch (e) { msg('#fsMsg', e.message, false); }
}

/**
 * 列映射。每一行是「本系统字段 → 飞书列」。
 * 只列出可写的列 —— 公式、自动编号、创建时间那些是只读的，选了也写不进去。
 */
function renderFeishuMap(writable) {
  $('#fsMapBlocked').style.display = 'none';
  const box = $('#fsMap'); box.innerHTML = '';
  /* 系统表的列名和字段名是一一对应的（都来自 feishu-schema.js），
     所以首次配置时按同名自动填上 —— 28 个下拉手点一遍，
     既折磨人又容易点错一两个，而点错的表现是「那一列一直是空的」，
     没人会想到回来查映射。
     只在从未设置过时自动填；显式选了「不同步」的（空串）不覆盖。 */
  let auto = 0;
  (FS.sourceFields || []).forEach((sf) => {
    if (FS.mapping?.[sf.id] === undefined) {
      const hit = (FS_FIELDS || []).find((f) => f.name === sf.label && writable.has(f.type));
      if (hit) { FS.mapping = { ...FS.mapping, [sf.id]: hit.name }; auto++; }
    }
  });
  (FS.sourceFields || []).forEach((sf) => {
    const row = el('div');
    row.style.cssText = 'display:grid;grid-template-columns:120px 1fr;gap:10px;align-items:center;margin-bottom:7px';

    const lab = el('div');
    lab.innerHTML = `<span style="font-size:12.5px">${esc(sf.label)}</span>`
      + (sf.required ? '<span class="tag miss" style="margin-left:5px">必填</span>' : '');
    if (sf.hint) lab.title = sf.hint;

    const sel = el('select');
    sel.append(el('option', null, '— 不同步 —'));
    FS_FIELDS.filter((f) => writable.has(f.type)).forEach((f) => {
      const o = el('option', null, `${esc(f.name)}（${esc(f.typeName)}）`);
      o.value = f.name;
      // 类型不在建议范围内时给个提醒，但不禁止 —— 用户可能有自己的理由
      if (sf.suit?.length && !sf.suit.includes(f.type)) o.textContent += ' ⚠ 类型可能不合适';
      sel.append(o);
    });
    sel.value = FS.mapping?.[sf.id] || '';
    sel.onchange = () => { FS.mapping = { ...FS.mapping, [sf.id]: sel.value }; };

    row.append(lab, sel); box.append(row);

    /* 系统ID 是同步的前提，但让用户自己去飞书加列很容易卡住 ——
       加错类型（比如选了「自动编号」）这一列根本不可写，
       而界面上只表现为「下拉里没有它」，没人猜得到原因。
       所以没映射时直接给一个按钮，由系统去建。 */
    if (sf.required && !sel.value) {
      const help = el('div');
      help.style.cssText = 'grid-column:2;margin:-2px 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      const mk = el('button', 'btn sm primary', '在飞书表里创建这一列');
      mk.onclick = async () => {
        mk.disabled = true; mk.textContent = '创建中…';
        try {
          const r = await api('POST', '/api/feishu/create-field', { name: sf.label });
          await loadFeishuFields(FS.tableId);
          FS.mapping = { ...FS.mapping, [sf.id]: r.field.name };
          renderFeishuMap(new Set(writable));
          msg('#fsMsg', r.already ? `「${sf.label}」这一列已经存在，已自动选中`
                                  : `已创建「${sf.label}」列并选中，记得点保存`);
        } catch (e) { msg('#fsMsg', e.message, false); mk.disabled = false; mk.textContent = '在飞书表里创建这一列'; }
      };
      help.append(mk, el('span', 'dim', '会在表末尾加一列多行文本，不影响已有数据'));
      box.append(help);
    }
  });

  if (auto) {
    /* 自动填了但还没保存 —— 不说清楚的话，用户关掉页面就白填了 */
    box.prepend(el('div', 'alert',
      `<b>已按同名自动匹配 ${auto} 项</b>核对一遍，然后点下面的保存 —— 不保存不生效。`));
  }

  if (!FS_FIELDS.length) {
    box.append(el('div', 'dim', '这张表还没有列，或读取失败'));
  } else if (!FS_FIELDS.some((f) => writable.has(f.type))) {
    box.append(el('div', 'alert warn',
      '<b>这张表没有可写入的列</b>公式、自动编号、创建时间这类是只读的，写不进去。请先在飞书里加一列多行文本。'));
  }
}

$$('#fsEnable button').forEach((b) => {
  b.onclick = () => {
    $$('#fsEnable button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  };
});

$('#fsTest').onclick = async () => {
  const out = $('#fsTestOut'); out.className = 'testout on'; out.textContent = '正在连接…';
  $('#fsTest').disabled = true;
  try {
    const r = await api('POST', '/api/feishu/test', {
      appId: $('#fsAppId').value.trim(),
      appSecret: $('#fsSecret').value.trim(),
      appToken: $('#fsToken').value.trim(),
      tableId: FS?.tableId || null,
    });
    out.className = 'testout on ' + (r.ok ? 'ok' : 'bad');
    out.innerHTML = r.steps.map((s) => {
      let h = `<div>${s.ok ? '✓' : '✗'} <b>${esc(s.step)}</b> — ${esc(s.detail)}</div>`;
      // 表名和 table_id 一起列出来，方便和飞书侧边栏逐个对照
      if (s.tables?.length) {
        h += '<div style="margin:6px 0 0 16px;font-size:11.5px;font-family:ui-monospace,monospace">'
          + s.tables.map((t) => `${esc(t.name)}　<span class="dim">${esc(t.tableId)}</span>`).join('<br>')
          + '</div>';
      }
      if (s.note) h += `<div class="dim" style="margin:4px 0 0 16px;font-size:11.5px">${esc(s.note)}</div>`;
      return h;
    }).join('');

    if (r.tables?.length) {
      fillTableSelect(r.tables);
      if ($('#fsTable').value) await loadFeishuFields($('#fsTable').value);
    }
  } catch (e) { out.className = 'testout on bad'; out.textContent = e.message; }
  finally { $('#fsTest').disabled = false; }
};

$('#fsTable').onchange = async () => {
  const sel = $('#fsTable');
  FS.tableId = sel.value;
  FS.tableName = sel.options[sel.selectedIndex]?.textContent || '';
  if (sel.value) await loadFeishuFields(sel.value);
};

$('#fsSave').onclick = async () => {
  try {
    await api('PUT', '/api/settings', { feishu: {
      enabled: $('#fsEnable button.on')?.dataset.on === '1',
      appId: $('#fsAppId').value.trim(),
      appSecret: $('#fsSecret').value.trim(),
      appToken: $('#fsToken').value.trim(),
      tableId: FS?.tableId || '',
      tableName: FS?.tableName || '',
      mapping: FS?.mapping || {},
    } });
    await loadFeishu();
    msg('#fsMsg', '已保存');
  } catch (e) { msg('#fsMsg', e.message, false); }
};

$('#fsSyncNow').onclick = async () => {
  if (!confirm('把所有合作重新推一遍到飞书？已存在的行会被更新，不会重复建行。')) return;
  $('#fsSyncNow').disabled = true;
  msg('#fsMsg', '同步中…');
  try {
    const r = await api('POST', '/api/feishu/sync-now', { all: true, scope: 'all' });
    msg('#fsMsg', `已推送 ${r.done || 0} 条${r.failed ? `，失败 ${r.failed} 条` : ''}`);
    await loadFeishu();
  } catch (e) { msg('#fsMsg', e.message, false); }
  finally { $('#fsSyncNow').disabled = false; }
};
