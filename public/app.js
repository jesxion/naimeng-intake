/**
 * 商务动作入口 —— 前端逻辑。
 *
 * 三个入口：录入（统一输入框，自动路由）、我的待办、记录查询。
 * 状态由动作驱动，界面上没有让人手选状态的下拉框。
 */

/* ================================================================ 基础 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('zh-CN') : '—');
const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN') : '—');

let CFG = null;          // /api/config
let PRODUCTS = [];       // 产品列表
let S = null;            // 当前建档会话
let V = null;            // 当前视频会话
let t0 = 0, draftId = null, jobId = null, poller = null, routeTimer = null, lastRoute = null;

function toast(msg) { const t = el('div', 'toast', esc(msg)); document.body.append(t); setTimeout(() => t.remove(), 2800); }

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: '响应解析失败' }));
  if (!res.ok) { const e = new Error(data.error || '请求失败'); e.data = data; e.status = res.status; throw e; }
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

/* ================================================================ 样例 */

const SAMPLES = [
  { n: '标准资料', t: `账号名称：示例达人甲\n账号id：100000001\n带货方式：短视频\n账号uid20000000001\n合作码：30000000001\n联系方式：13800138000\n详细地址：福建省南安市示范镇示范村1组100号\n收件人:张某某\n-` },
  { n: '一址多号', t: `地址：上海市松江区示范镇示范园区A栋一楼 13800138001 小乙\n示例宠物馆\nUID: 4000000000000001\n示例优选\n抖音号：10000000002\nUID：4000000000000002\n示例铲屎官\n抖音号：K9petlife\nUID：4000000000000003` },
  { n: 'UID/合作码同形', t: `宝子\nid: Demoacct119\nuid: 20000000002\n合作码: 30000000002\n地址: 安徽省淮南市田家庵区示范小区2栋1205 小甲 13800138002` },
  { n: '混入视频号', t: `示例小戏精\n抖音UID4000000000000004\n视频号id sphDemo000000001\n快手号5000000001\n示例小戏精 13800138003 浙江省杭州市临平区示范街道示范小区1-1-101（放菜鸟驿站）` },
  { n: '含分享口令', t: `抖音：示例达人乙\n抖音号：demoacctzhao\n抖音链接：1- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/EXAMPLE01/ 8@9.com :5pm\nUID：20000000003\n合作码：30000000003\n王某某13800138004黑龙江省齐齐哈尔市讷河市示范小区1号楼1单元101` },
  { n: '合作码前导零', t: `抖音名：示例达人丙\n抖音号：10000000003\n合作码：04000000001\nUID：4000000000000005\n收件地址： 李某某，手机号码：13800138007，所在地区：江苏省苏州市吴江区 松陵镇示范小区1幢` },
  { n: '含宠物类别', t: `【寄样资料完善】\n抖音名字：示例达人丁\n抖音号：sample20250101\n抖音uid：4000000000000007\n宠物类别（猫/狗）：狗\n合作码:30000000005\n寄样信息地址： 四川省绵阳市涪城区 示范7组100菜鸟驿站\n收件人：李先生\n手机号码：13800138006` },
  { n: '视频口令', t: `0.58 复制打开抖音，看看【示例达人甲的作品】新品测试内容 https://v.douyin.com/EXAMPLE01/ :9pm KWM:/ 01/13 z@T.Lw` },
];

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
  await refreshConfig();
  await loadProducts();

  $('#chips').append(...SAMPLES.map((s) => {
    const b = el('button', null, esc(s.n));
    b.onclick = () => { $('#raw').value = s.t; $('#raw').focus(); scheduleRoute(); };
    return b;
  }));
  $('#presets').append(...PRESETS.map((p) => mkPreset(p, 'm')));
  $('#vPresets').append(...V_PRESETS.map((p) => mkPreset(p, 'v')));

  loadJobs(); loadTodos(); loadRecords();
  if (CFG.needsSetup) { openSettings('user'); toast('先填一下你的姓名和角色'); }
  else $('#raw').focus();
}

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
    ? `当前身份：<b>${esc(CFG.me.name)}</b> · ${esc(roleName)}`
    : '<b style="color:var(--red)">未设置身份</b>';
  $('#setupNote').style.display = CFG.needsSetup ? 'block' : 'none';
  fillSettings();
}

async function loadProducts() {
  PRODUCTS = (await api('GET', '/api/products?all=1')).products;
  renderProductList();
}

/* ================================================================ 导航 */

$$('.tabs button').forEach((b) => {
  b.onclick = () => {
    $$('.tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    $$('.page').forEach((p) => p.classList.remove('on'));
    $('#p-' + b.dataset.tab).classList.add('on');
    if (b.dataset.tab === 'records') loadRecords();
    if (b.dataset.tab === 'todos') loadTodos();
  };
});
const goTab = (n) => document.querySelector(`.tabs button[data-tab="${n}"]`).click();

/**
 * s2 是覆盖层（confirm overlay），s1/sv/s3 是页面内区块。
 * 打开覆盖层时底层保持 s1，关闭后直接回到队列，不用重新渲染。
 */
const showStage = (n) => {
  $('#s2').classList.toggle('on', n === 's2');
  document.body.style.overflow = n === 's2' ? 'hidden' : '';
  for (const k of ['s1', 'sv', 's3']) {
    $('#' + k).style.display = (k === (n === 's2' ? 's1' : n) ? (k === 's1' ? 'grid' : 'block') : 'none');
  }
};

/* ================================================================ 输入路由 */

const KIND_LABEL = { intake: '建档 / 新合作', video: '视频回传', shipment: '发货截图', unknown: '无法判断' };

$('#raw').addEventListener('input', scheduleRoute);
$('#raw').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitInput(); }
});

function scheduleRoute() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(doRoute, 260);
}

async function doRoute() {
  const text = $('#raw').value;
  const bar = $('#routeBar');
  if (!text.trim()) { bar.classList.add('off'); lastRoute = null; return; }
  try {
    lastRoute = await api('POST', '/api/route', { rawText: text });
    bar.classList.remove('off');
    bar.className = 'routebar' + (lastRoute.confidence === 'low' || lastRoute.kind === 'unknown' ? ' warn' : '');
    $('#routeKind').textContent = KIND_LABEL[lastRoute.kind] || lastRoute.kind;
    $('#routeReason').textContent = [lastRoute.reason, lastRoute.note].filter(Boolean).join(' ｜ ');
  } catch { bar.classList.add('off'); }
}

$('#go').onclick = submitInput;

async function submitInput() {
  const text = $('#raw').value.trim();
  if (!text) { setTip('请先粘贴内容', true); return; }
  const forced = $('#routeOverride').value;
  const kind = forced || lastRoute?.kind || 'intake';

  if (kind === 'shipment') { setTip('发货截图识别还没做，先在待办里手动回填快递单号。', true); return; }
  if (kind === 'unknown') { setTip('判断不出这段内容属于哪一类，请用右上角下拉手动指定。', true); return; }

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
  $('#tip').textContent = msg;
}

async function enqueueIntake(text) {
  await api('POST', '/api/jobs', { rawText: text });
  $('#raw').value = ''; $('#raw').focus();
  $('#routeBar').classList.add('off'); lastRoute = null;
  setTip('已加入队列，识别完成后在右侧确认。可以继续粘下一位。');
  loadJobs();
}

async function submitVideoToken(text) {
  V = await api('POST', '/api/video/parse', { rawText: text });
  V.shareToken = text;
  V.chosen = V.matches.find((m) => !m.alreadyHasVideo)?.fulfillmentId || V.matches[0]?.fulfillmentId || '';
  $('#raw').value = ''; $('#routeBar').classList.add('off'); lastRoute = null;
  showStage('sv'); renderVideo();
  window.scrollTo({ top: 0 });
}

/* ================================================================ 识别队列 */

const ST = { queued: '排队中', running: '识别中', done: '待确认', failed: '失败' };

async function loadJobs() {
  let data; try { data = await api('GET', '/api/jobs'); } catch { return; }
  const jobs = data.jobs;
  const pend = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  const ready = jobs.filter((j) => j.status === 'done').length;
  const dups = jobs.filter((j) => j.summary?.dupInDb || j.summary?.dupInQueue).length;
  $('#qMeta').textContent = `共 ${jobs.length} 条 · 处理中 ${pend} · 待确认 ${ready}`;

  const dup = $('#qDup'); dup.innerHTML = '';
  if (dups) {
    const bar = el('div', 'dupbar');
    bar.append(el('span', null, `<b>${dups} 条与已有记录或队列中其他条目重复</b>，通常直接丢弃即可。`));
    bar.append(el('div', 'grow'));
    const c = el('button', 'btn sm danger', '一键丢弃全部重复');
    c.onclick = async () => {
      const targets = jobs.filter((j) => j.summary?.dupInDb || j.summary?.dupInQueue);
      const keep = new Set(); const drop = [];
      for (const j of [...targets].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
        if (j.summary.dupInDb) { drop.push(j); continue; }
        const k = j.summary.dupInQueue?.key;
        if (k && !keep.has(k)) { keep.add(k); continue; }
        drop.push(j);
      }
      if (!drop.length) { toast('没有可丢弃的条目'); return; }
      if (!confirm(`将丢弃 ${drop.length} 条重复识别（队列内互为重复的保留最早提交的那条）。继续？`)) return;
      for (const j of drop) await api('DELETE', '/api/jobs/' + j.id).catch(() => {});
      toast(`已丢弃 ${drop.length} 条`); loadJobs();
    };
    bar.append(c); dup.append(bar);
  }

  const box = $('#qBody'); box.innerHTML = '';
  if (!jobs.length) { box.append(el('div', 'empty', '还没有粘贴任何内容，先在左侧试试')); stopPoll(); return; }

  // 队列只承担四件事：类型、摘要、状态、操作。细节一律留到确认页说
  jobs.forEach((j) => {
    const s = j.summary;
    const busy = j.status === 'queued' || j.status === 'running';
    const isDup = !!(s?.dupInDb || s?.dupInQueue);
    const it = el('div', 'qitem' + (isDup ? ' dup' : ''));

    const r1 = el('div', 'r1');
    r1.append(el('span', 'badge mock', isDup && s.dupInDb ? '新合作' : '建档'));
    r1.append(el('span', 'nm', esc(s?.name || j.title || '—')));
    r1.append(el('span', 'st ' + j.status, (j.status === 'running' ? '<span class="spin"></span> ' : '') + ST[j.status]));

    const acts = el('div', 'acts');
    if (j.status === 'done') { const b = el('button', 'btn sm primary', '去确认'); b.onclick = () => openJob(j.id); acts.append(b); }
    if (j.status === 'failed') {
      const b = el('button', 'btn sm', '重试');
      b.onclick = async () => { await api('POST', `/api/jobs/${j.id}/retry`); loadJobs(); }; acts.append(b);
    }
    if (!busy) {
      const d = el('button', 'btn sm danger', isDup ? '丢弃' : '移除');
      d.onclick = async () => { await api('DELETE', '/api/jobs/' + j.id); loadJobs(); }; acts.append(d);
    }
    r1.append(acts); it.append(r1);

    // 摘要一行说完
    const r2 = el('div', 'r2');
    if (j.status === 'failed') r2.innerHTML = `<span style="color:var(--red)">${esc(j.error || '识别失败')}</span>`;
    else if (busy) r2.textContent = '识别在后台进行，可以继续粘贴下一位';
    else if (s) {
      const bits = [`${s.accounts} 个账号`];
      if (s.missing) bits.push(`<span style="color:var(--red)">待补充 ${s.missing} 项</span>`);
      if (s.dupInDb) bits.push(`<span style="color:var(--red)">已有达人，将作为新合作</span>`);
      else if (s.dupInQueue) bits.push(`<span style="color:var(--red)">与队列中另一条重复</span>`);
      else if (s.alerts) bits.push(`<span style="color:var(--amber)">${s.alerts} 条需核对</span>`);
      r2.innerHTML = bits.join(' · ');
    }
    it.append(r2);
    if (j.status === 'done') { it.style.cursor = 'pointer'; it.onclick = (e) => { if (e.target.tagName !== 'BUTTON') openJob(j.id); }; }
    box.append(it);
  });
  if (pend) startPoll(); else stopPoll();
}
function startPoll() { if (!poller) poller = setInterval(loadJobs, 1800); }
function stopPoll() { if (poller) { clearInterval(poller); poller = null; } }

async function openJob(id) {
  const { job } = await api('GET', '/api/jobs/' + id);
  if (!job.result) return;
  S = { ...job.result, rawText: job.rawText, creatorId: null };
  // 命中已有达人时，默认走「发起新合作」
  const dup = (S.conflicts?.hard || [])[0];
  if (dup) S.creatorId = dup.existing.creatorId;
  jobId = id; draftId = null; t0 = Date.now();
  showStage('s2'); renderForm();
  setTimeout(() => (document.querySelector('.f.miss input') || document.querySelector('.f input'))?.focus(), 60);
  window.scrollTo({ top: 0 });
}

/* ================================================================ 建档确认页 */

function fld(label, path, value, m, opt = {}) {
  const has = !!(value && String(value).trim());
  const low = has && m && m.confidence && m.confidence < 0.85;
  const w = el('div', 'f' + (has ? (low ? ' chk' : '') : ' miss'));
  const lab = el('label'); lab.append(document.createTextNode(label));
  lab.append(el('span', 'tag ' + (has ? (low ? 'chk' : 'ok') : 'miss'), has ? (low ? '需核对' : '已识别') : '待补充'));
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

function renderForm() {
  const F = S.form, M = S.fieldMeta || {};
  F.items ||= []; if (F.sampleCost === undefined) F.sampleCost = null;

  // 叙事主体是「一次合作」，不是「一个达人」
  const isNew = !S.creatorId;
  $('#confirmTitle').textContent = isNew ? '新建合作' : '新增一次合作';
  const tag = $('#confirmTag');
  tag.className = 'badge ' + (isNew ? 'mock' : 'llm');
  tag.textContent = isNew ? '新达人' : '已有达人';
  $('#creatorNote').textContent = isNew ? '库里没有这个账号，会同时建达人档案' : '账号已存在，本次只新增一条合作记录';

  const gc = $('#gCreator'); gc.innerHTML = '';
  gc.append(fld('达人名称', 'name', F.name, M.name));

  const ga = $('#gAcct'); ga.innerHTML = '';
  F.accounts.forEach((a, i) => {
    const card = el('div', 'acct'), h = el('div', 'acct-h');
    h.append(el('span', null, '账号 ' + (i + 1)));
    if (F.accounts.length > 1) { const d = el('button', 'link red', '移除'); d.onclick = () => { F.accounts.splice(i, 1); renderForm(); }; h.append(d); }
    const g = el('div', 'grid2'), am = (M.accounts && M.accounts[i]) || {};
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
  const r2 = el('div', 'grid2');
  r2.append(fld('收件人', 'recipient.name', F.recipient.name, rm.name),
    fld('手机号', 'recipient.phone', F.recipient.phone, rm.phone));
  gr.append(r2, fld('地址', 'recipient.address', F.recipient.address, rm.address),
    fld('配送备注', 'recipient.deliveryNote', F.recipient.deliveryNote, rm.deliveryNote,
      { ph: '如：放菜鸟驿站 / 送上门（无则留空）' }));

  renderAlerts(); renderSrc(); recount();
  $('#agentInfo').textContent = `${S.mode === 'llm' ? S.model : '本地模拟'} · ${S.elapsedMs || 0}ms`
    + (S.usage ? ` · ${S.usage.total_tokens || 0} tokens` : '');
}

function renderItems() {
  const F = S.form;
  const box = $('#gItems'); box.innerHTML = '';
  const usable = PRODUCTS.filter((p) => p.active !== false);

  $('#itemNote').textContent = '一次合作可以寄多个产品，各自填数量';

  if (!usable.length) {
    box.append(el('div', 'muted', '还没有可选产品，去「设置 → 寄样产品」添加。'));
  }
  F.items.forEach((it, i) => {
    const row = el('div', 'itemrow');
    const sel = el('select');
    sel.append(el('option', null, '— 选择产品 —'));
    usable.forEach((p) => {
      const o = el('option', null, esc(p.name) + (p.spec ? `（${esc(p.spec)}）` : ''));
      o.value = p.id; sel.append(o);
    });
    // 产品已停用但历史选中时，补一个占位项
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
    qty.oninput = () => { it.quantity = Number(qty.value) || 1; recount(); };
    const del = el('button', 'del', '×');
    del.onclick = () => { F.items.splice(i, 1); renderItems(); recount(); };
    row.append(sel, qty, del); box.append(row);
  });

  const gcost = $('#gCost'); gcost.innerHTML = '';
  const cf = el('div', 'f');
  cf.innerHTML = '<label>寄样总费用（元）</label>';
  const ci = el('input'); ci.type = 'number'; ci.step = '0.01'; ci.placeholder = '选填，用于成本统计';
  ci.value = F.sampleCost ?? '';
  ci.oninput = () => { F.sampleCost = ci.value === '' ? null : Number(ci.value); recount(); };
  cf.append(ci); gcost.append(cf);
}

$('#addItem').onclick = () => { S.form.items.push({ productId: null, productName: '', quantity: 1 }); renderItems(); recount(); };
$('#addAcct').onclick = () => { S.form.accounts.push({ nickname: '', douyinId: '', uid: '', cooperationCode: '', profileUrl: '' }); renderForm(); };

function renderAlerts() {
  const box = $('#alerts'); box.innerHTML = '';
  (S.warnings || []).forEach((w) => {
    const a = el('div', 'alert ' + (w.level === 'error' ? 'error' : w.level === 'warn' ? 'warn' : 'info'));
    a.append(el('b', null, esc(w.title)));
    a.append(document.createTextNode(w.detail || ''));

    if (w.code === 'UID_COOP_SAME_SHAPE') {
      const acts = el('div', 'acts');
      acts.innerHTML = `<span>UID</span><code>${esc(w.swap.uid)}</code><span>合作码</span><code>${esc(w.swap.cooperationCode)}</code>`;
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
    if (w.items?.length) a.append(el('div', null, w.items.map((i) => `<code>${esc(i)}</code>`).join(' ')));
    if (w.candidates?.length) a.append(el('div', null, w.candidates.map((i) => `<code>${esc(i)}</code>`).join(' ')));
    if (w.conflicts?.length) {
      const c = w.conflicts[0].existing;
      a.append(el('div', null,
        `<div style="margin-top:6px"><code>${esc(c.douyinId || c.uid)}</code> 属于 <b>${esc(c.creatorName || c.nickname)}</b>（归属 ${esc(c.owner)}，已合作 ${c.collaborationCount} 次）</div>`));
      const acts = el('div', 'acts');
      const useExisting = el('button', 'btn sm primary', '在该达人上发起新合作');
      useExisting.onclick = () => {
        S.creatorId = c.creatorId;
        S.warnings = S.warnings.filter((x) => x !== w);
        renderForm(); toast('已切换为「发起新合作」，不会新建达人');
      };
      const view = el('button', 'btn sm', '查看已有记录');
      view.onclick = () => openCreator(c.creatorId);
      const drop = el('button', 'btn sm danger', '丢弃这条');
      drop.onclick = () => discardCurrent(false);
      acts.append(useExisting, view, drop); a.append(acts);
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
  let ok = 0, miss = 0, chk = 0;
  $$('#s2 .f').forEach((f) => {
    const i = f.querySelector('input'); if (!i || i.type === 'number') return;
    const tag = f.querySelector('.tag'); if (!tag) return;
    if (!i.value.trim()) { f.className = 'f miss'; tag.className = 'tag miss'; tag.textContent = '待补充'; miss++; }
    else if (f.classList.contains('chk')) { chk++; ok++; }
    else { f.className = 'f'; tag.className = 'tag ok'; tag.textContent = '已识别'; ok++; }
  });
  $('#cOk').textContent = ok; $('#cMiss').textContent = miss; $('#cChk').textContent = chk;

  const F = S.form, w = [];
  const r = F.recipient || {};
  const hasItems = F.items.some((i) => i.productId && Number(i.quantity) > 0);
  if (!F.accounts.some((a) => a.douyinId || a.uid)) w.push('每个账号都缺抖音号和 UID，无法入库');
  if (!hasItems) w.push('未选寄样产品');
  if (!r.name || !r.phone || !r.address) w.push('收件信息不全');
  if (F.accounts.some((a) => !a.cooperationCode)) w.push('有账号缺合作码（不影响寄样，影响后续开定向）');
  $('#fWarn').textContent = w.length ? '提示：' + w.join('；') : '信息完整，可以提交寄样';
  $('#submitSample').disabled = !hasItems || !r.name || !r.phone || !r.address;
}

function jumpNext() {
  const list = $$('#s2 .f.miss input, #s2 .f.chk input');
  const i = list.indexOf(document.activeElement);
  (list[i + 1] || list[0])?.focus();
}
$('#jump').onclick = jumpNext;
document.addEventListener('keydown', (e) => { if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); jumpNext(); } });
$('#back').onclick = () => { showStage('s1'); loadJobs(); };
$('#again').onclick = () => { showStage('s1'); draftId = null; jobId = null; $('#raw').focus(); loadJobs(); };
$('#toTodo').onclick = () => { showStage('s1'); goTab('todos'); };
$('#vBack').onclick = () => { showStage('s1'); V = null; };

$('#merge').onclick = async () => {
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
};

async function discardCurrent(silent) {
  if (!silent && !confirm('丢弃这条识别结果？原文和识别结果都会删除，不影响已入库的数据。')) return;
  if (jobId) { await api('DELETE', '/api/jobs/' + jobId).catch(() => {}); jobId = null; }
  if (draftId) { await api('DELETE', '/api/drafts/' + draftId).catch(() => {}); draftId = null; }
  S = null; showStage('s1'); loadJobs(); loadTodos(); toast('已丢弃'); $('#raw').focus();
}
$('#discard').onclick = () => discardCurrent(false);

$('#saveDraft').onclick = async () => {
  try {
    const r = await api('POST', '/api/drafts', { id: draftId, rawText: S.rawText, form: S.form, extracted: S.extracted });
    draftId = r.draft.id;
    if (jobId) { await api('DELETE', '/api/jobs/' + jobId).catch(() => {}); jobId = null; }
    toast('草稿已保存'); loadJobs(); loadTodos();
  } catch (e) { toast(e.message); }
};

$('#submitRecord').onclick = () => submitCollaboration('createRecord');
$('#submitSample').onclick = () => submitCollaboration('submitSample');

async function submitCollaboration(action) {
  const btn = action === 'submitSample' ? $('#submitSample') : $('#submitRecord');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/collaborations', {
      action, creatorId: S.creatorId || null, form: S.form,
      rawText: S.rawText, extracted: S.extracted,
      model: S.model, mode: S.mode, promptVersion: S.promptVersion,
      elapsedMs: Date.now() - t0, draftId, jobId,
    });
    const cb = r.collaboration;
    $('#doneTitle').textContent = action === 'submitSample' ? '已提交寄样' : '已建档';
    $('#doneSub').innerHTML = `本条耗时 <span class="timer">${((Date.now() - t0) / 1000).toFixed(1)} 秒</span>，`
      + (action === 'submitSample' ? '等仓库发货后在待办里回填快递单号。' : '尚未提交寄样，可稍后在记录里补。');
    const box = $('#recap'); box.innerHTML = '';
    const rows = [['达人', cb.creatorName],
      ['抖音账号', cb.fulfillments.map((f) => f.account?.douyinId || f.account?.uid || '（空）').join('、') || '—']];
    if (cb.items.length) rows.push(['寄样产品', cb.items.map((i) => `${i.productName} ×${i.quantity}`).join('、')]);
    if (cb.sampleCost != null) rows.push(['寄样费用', '¥' + cb.sampleCost]);
    if (cb.recipient?.name) rows.push(['收件人', `${cb.recipient.name} / ${cb.recipient.phone || '—'}`]);
    if (cb.recipient?.address) rows.push(['地址', cb.recipient.address]);
    if (cb.recipient?.deliveryNote) rows.push(['配送备注', cb.recipient.deliveryNote]);
    if (r.soft?.length) rows.push(['待完善', r.soft.join('、')]);
    rows.forEach(([k, v]) => box.append(el('div', null, `<span>${esc(k)}</span><b>${esc(v)}</b>`)));

    showStage('s3'); jobId = null; draftId = null;
    loadJobs(); loadTodos(); loadRecords(); window.scrollTo({ top: 0 });
  } catch (e) {
    if (e.data?.conflicts) {
      const c = e.data.conflicts[0].existing;
      S.warnings = [{ level: 'error', code: 'DUPLICATE_ACCOUNT', title: '该账号已属于已有达人，未入库',
        detail: '请改用「在该达人上发起新合作」，或丢弃这条。', conflicts: e.data.conflicts },
        ...(S.warnings || []).filter((w) => w.code !== 'DUPLICATE_ACCOUNT')];
      renderAlerts(); window.scrollTo({ top: 0, behavior: 'smooth' });
      toast(`「${c.creatorName || c.nickname}」已存在，归属 ${c.owner}`);
    } else toast(e.message);
  } finally { btn.disabled = false; }
}

/* ================================================================ 视频确认页 */

function renderVideo() {
  $('#vInfo').textContent = `本地解析 · ${V.elapsedMs}ms · 不调用模型`;
  const box = $('#vAlerts'); box.innerHTML = '';
  (V.warnings || []).forEach((w) => {
    const a = el('div', 'alert ' + (w.level === 'error' ? 'error' : 'warn'));
    a.append(el('b', null, esc(w.title))); a.append(document.createTextNode(w.detail || ''));
    box.append(a);
  });

  const b = $('#vBody'); b.innerHTML = '';

  b.append(el('div', 'group-t', '<span>口令原文</span><span>逐字节保存，交接时整段复制</span>'));
  b.append(el('div', 'tokenbox', esc(V.shareToken)));
  const row = el('div', 'acts'); row.style.cssText = 'display:flex;gap:8px;margin:10px 0 18px';
  const cp = el('button', 'btn sm', '复制口令');
  cp.onclick = async () => toast(await copy(V.shareToken) ? '已复制完整口令' : '复制失败');
  row.append(cp);
  if (V.parsed.videoUrl) {
    const a = el('a', 'btn sm', '打开视频 ↗');
    a.href = V.parsed.videoUrl; a.target = '_blank'; a.rel = 'noreferrer';
    a.style.textDecoration = 'none'; row.append(a);
  }
  b.append(row);

  b.append(el('div', 'group-t', `<span>匹配到的合作</span><span>${V.parsed.nickname ? '按昵称「' + esc(V.parsed.nickname) + '」匹配' : '口令里没有昵称'}</span>`));

  if (!V.matches.length) {
    b.append(el('div', 'empty', '没有匹配到合作。可能是达人改过昵称，或这条视频对应的合作还没建。'));
    return;
  }

  V.matches.forEach((m) => {
    const it = el('div', 'qitem' + (m.fulfillmentId === V.chosen ? ' hot' : ''));
    it.style.cursor = 'pointer';
    it.onclick = () => { V.chosen = m.fulfillmentId; renderVideo(); };
    const r1 = el('div', 'r1');
    r1.append(el('span', 'nm', esc(m.collaboration.creatorName)));
    r1.append(el('span', 'st ' + (m.alreadyHasVideo ? 'done' : 'running'), m.alreadyHasVideo ? '已回传过' : '待回传'));
    r1.append(el('span', 'muted', esc(m.collaboration.status)));
    if (m.fulfillmentId === V.chosen) { const t = el('span', 'st done', '已选中'); r1.append(t); }
    it.append(r1);
    const items = m.collaboration.items.map((i) => `${i.productName} ×${i.quantity}`).join('、') || '未填产品';
    const pkg = m.collaboration.packages.map((p) => p.trackingNo).join('、') || '无单号';
    it.append(el('div', 'r2', `${esc(items)} · 建档 ${fmtDate(m.collaboration.createdAt)} · 快递 ${esc(pkg)}`));
    b.append(it);
  });

  const foot = el('div'); foot.style.cssText = 'display:flex;gap:10px;margin-top:16px';
  const submit = el('button', 'btn primary', '确认回传');
  submit.disabled = !V.chosen;
  submit.onclick = async () => {
    submit.disabled = true;
    try {
      const r = await api('POST', '/api/video/submit', { shareToken: V.shareToken, fulfillmentId: V.chosen });
      $('#doneTitle').textContent = '视频已记录';
      $('#doneSub').textContent = r.collaboration.status === '已完成'
        ? '该合作的所有账号都已回传，合作自动标记为已完成。'
        : '还有账号未回传，会继续出现在待办里。';
      const box = $('#recap'); box.innerHTML = '';
      [['达人', r.collaboration.creatorName], ['账号', r.fulfillment.account?.nickname || '—'],
        ['拍摄进度', r.fulfillment.filmingProgress], ['合作状态', r.collaboration.status]]
        .forEach(([k, v]) => box.append(el('div', null, `<span>${esc(k)}</span><b>${esc(v)}</b>`)));
      showStage('s3'); V = null; loadTodos(); loadRecords(); window.scrollTo({ top: 0 });
    } catch (e) { toast(e.message); submit.disabled = false; }
  };
  const cancel = el('button', 'btn', '取消');
  cancel.onclick = () => { showStage('s1'); V = null; };
  foot.append(submit, cancel); b.append(foot);
}

/* ================================================================ 待办 */

const TODO_META = {
  notify_creator: { label: '告知物流' }, follow_up: { label: '回访催拍' },
  fill_tracking: { label: '等快递单号' }, complete_info: { label: '补全信息' },
  draft_incomplete: { label: '草稿未完成' }, job_failed: { label: '识别失败' },
};

async function loadTodos() {
  let todos = [];
  try { todos = (await api('GET', '/api/todos')).todos; } catch { return; }
  const badge = $('#nTodo');
  badge.textContent = todos.length ? todos.length : '';
  badge.className = todos.some((t) => t.priority === 1) ? 'hot' : '';

  const box = $('#todoBody'); box.innerHTML = '';
  if (!todos.length) { box.append(el('div', 'empty', '没有待办，都处理完了')); return; }

  todos.forEach((t) => {
    const it = el('div', 'qitem' + (t.overdue ? ' hot' : ''));
    const r1 = el('div', 'r1');
    r1.append(el('span', 'st p' + t.priority, TODO_META[t.type]?.label || t.type));
    r1.append(el('span', 'nm', esc(t.title)));
    if (t.overdue) r1.append(el('span', 'st dupt', '逾期'));
    const acts = el('div', 'acts');

    if (t.type === 'notify_creator') {
      const cp = el('button', 'btn sm primary', '复制物流信息');
      cp.onclick = async () => {
        const { notifyText } = await api('GET', '/api/collaborations/' + t.collaborationId);
        toast(await copy(notifyText) ? '已复制，去微信发给达人\n\n' + notifyText : '复制失败');
      };
      const mk = el('button', 'btn sm', '标记已告知');
      mk.onclick = async () => {
        await api('POST', `/api/collaborations/${t.collaborationId}/notified`, { value: true });
        toast('已标记'); loadTodos();
      };
      acts.append(cp, mk);
    }
    if (t.type === 'fill_tracking') {
      const b = el('button', 'btn sm primary', '回填快递');
      b.onclick = () => openTrackingModal(t.collaborationId);
      acts.append(b);
    }
    if (t.type === 'follow_up') {
      const b = el('button', 'btn sm primary', '记录回访结果');
      b.onclick = () => openFollowUpModal(t.collaborationId);
      acts.append(b);
    }
    if (t.type === 'complete_info') {
      const b = el('button', 'btn sm primary', '补全');
      b.onclick = () => openCollaboration(t.collaborationId);
      acts.append(b);
    }
    if (t.type === 'draft_incomplete') {
      const b = el('button', 'btn sm primary', '继续录入');
      b.onclick = async () => {
        const { draft } = await api('GET', '/api/drafts/' + t.draftId);
        S = { form: draft.form, fieldMeta: {}, warnings: [], ignored: [], rawText: draft.rawText,
          extracted: draft.extracted, mode: 'draft', model: '—', elapsedMs: 0, creatorId: null };
        draftId = draft.id; jobId = null; t0 = Date.now();
        goTab('intake'); showStage('s2'); renderForm();
      };
      const d = el('button', 'btn sm danger', '删除');
      d.onclick = async () => { if (!confirm('删除该草稿？')) return; await api('DELETE', '/api/drafts/' + t.draftId); loadTodos(); };
      acts.append(b, d);
    }
    if (t.type === 'job_failed') {
      const b = el('button', 'btn sm', '重试');
      b.onclick = async () => { await api('POST', `/api/jobs/${t.jobId}/retry`); loadTodos(); loadJobs(); };
      const d = el('button', 'btn sm danger', '丢弃');
      d.onclick = async () => { await api('DELETE', '/api/jobs/' + t.jobId); loadTodos(); loadJobs(); };
      acts.append(b, d);
    }
    if (t.collaborationId) {
      const v = el('button', 'btn sm', '详情');
      v.onclick = () => openCollaboration(t.collaborationId);
      acts.append(v);
    }
    r1.append(acts); it.append(r1);
    it.append(el('div', 'r2', esc(t.detail || '')));
    box.append(it);
  });
}

/* ---------- 回填快递 ---------- */

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
  const close = () => m.remove();
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector('#tkCancel').onclick = close;

  const refresh = async () => {
    const { collaboration } = await api('GET', '/api/collaborations/' + collaborationId);
    const list = m.querySelector('#tkList'); list.innerHTML = '';
    if (collaboration.packages.length) {
      list.append(el('div', 'muted', '已有包裹：'));
      collaboration.packages.forEach((p) => {
        const row = el('div', 'mini');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px';
        row.append(el('span', 'mono', `${esc(p.carrier)} ${esc(p.trackingNo)}`));
        const d = el('button', 'link red', '删除');
        d.style.marginLeft = 'auto';
        d.onclick = async () => { await api('DELETE', '/api/packages/' + p.id); refresh(); loadTodos(); };
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
      refresh(); loadTodos(); loadRecords();
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
  const close = () => { m.remove(); loadTodos(); loadRecords(); };
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

/* ================================================================ 记录查询 */

let scope = 'mine';
$$('#scopeSeg button').forEach((b) => {
  b.onclick = () => {
    $$('#scopeSeg button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); scope = b.dataset.scope; loadRecords();
  };
});
$('#doSearch').onclick = loadRecords;
$('#q').onkeydown = (e) => { if (e.key === 'Enter') loadRecords(); };

async function loadRecords() {
  const q = encodeURIComponent($('#q').value.trim());
  let data; try { data = await api('GET', `/api/collaborations?q=${q}&scope=${scope}`); } catch { return; }
  const list = data.collaborations;
  $('#nRec').textContent = data.stats.collaborations || '';

  const box = $('#recBody'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', q ? '没有匹配的记录' : '还没有合作记录，去「录入」创建第一条')); return; }

  const t = el('table');
  t.innerHTML = `<thead><tr><th>达人</th><th>抖音账号</th><th>寄样产品</th><th>快递</th>
    <th>拍摄 / 视频</th><th>状态</th><th>归属</th><th>建档</th></tr></thead>`;
  const tb = el('tbody');
  list.forEach((cb) => {
    const tr = el('tr');
    const accs = cb.fulfillments.map((f) => esc(f.account?.nickname || f.account?.douyinId || '—')).join('<br>') || '—';
    const items = cb.items.map((i) => `${esc(i.productName)} ×${i.quantity}`).join('<br>') || '<span class="muted">未填</span>';
    const pkgs = cb.packages.map((p) => `${esc(p.carrier)} ${esc(p.trackingNo)}`).join('<br>') || '<span class="muted">未回填</span>';
    const vids = cb.fulfillments.map((f) => f.shareToken
      ? '<span style="color:var(--green)">已发布</span>'
      : `<span class="muted">${esc(f.filmingProgress)}</span>`).join('<br>');
    tr.innerHTML = `<td><b>${esc(cb.creatorName)}</b></td>
      <td class="mono">${accs}</td><td>${items}</td><td class="mono">${pkgs}</td><td>${vids}</td>
      <td>${esc(cb.status)}${cb.notifiedAt ? '<div class="muted">已告知</div>' : ''}</td>
      <td>${esc(cb.ownerName)}</td><td class="muted">${fmtDate(cb.createdAt)}</td>`;
    tr.onclick = () => openCollaboration(cb.id);
    tb.append(tr);
  });
  t.append(tb); box.append(t);
}

/* ---------- 合作详情 ---------- */

async function openCollaboration(id) {
  const { collaboration: cb, notifyText } = await api('GET', '/api/collaborations/' + id);
  const mask = el('div', 'mask'), dr = el('div', 'drawer');
  const close = () => { mask.remove(); dr.remove(); };
  mask.onclick = close;

  const h = el('header');
  h.innerHTML = `<h2>${esc(cb.creatorName)} · 合作详情</h2>`;
  const x = el('button', 'icon', '×'); x.onclick = close; h.append(x);

  const b = el('div', 'body');
  b.innerHTML = `
    <dl class="dl">
      <dt>状态</dt><dd><b>${esc(cb.status)}</b>${cb.notifiedAt ? ' · 已告知达人' : ''}</dd>
      <dt>归属</dt><dd>${esc(cb.ownerName)}</dd>
      <dt>寄样费用</dt><dd>${cb.sampleCost != null ? '¥' + cb.sampleCost : '<span class="muted">未填</span>'}</dd>
      <dt>建档时间</dt><dd>${fmtTime(cb.createdAt)}</dd>
    </dl>
    <div class="sec"><h3>寄样产品</h3>${cb.items.length
      ? cb.items.map((i) => `<div class="mini">${esc(i.productName)} × ${i.quantity}</div>`).join('')
      : '<div class="mini muted">还没填产品，仓库无法备货</div>'}</div>
    <div class="sec"><h3>收件信息</h3><div class="mini">${esc(cb.recipient?.name || '—')} ${esc(cb.recipient?.phone || '')}
      <div class="muted">${esc(cb.recipient?.address || '—')}</div>
      ${cb.recipient?.deliveryNote ? `<div class="muted">配送备注：${esc(cb.recipient.deliveryNote)}</div>` : ''}</div></div>
    <div class="sec"><h3>快递包裹</h3>${cb.packages.length
      ? cb.packages.map((p) => `<div class="mini mono">${esc(p.carrier)} ${esc(p.trackingNo)} · ${fmtDate(p.shippedAt)}</div>`).join('')
      : '<div class="mini muted">尚未回填</div>'}</div>`;

  // 履约项
  const fs = el('div', 'sec');
  fs.append(el('h3', null, `履约项（每个账号一条，共 ${cb.fulfillments.length} 个）`));
  cb.fulfillments.forEach((f) => {
    const m = el('div', 'mini');
    m.innerHTML = `<b>${esc(f.account?.nickname || '（无昵称）')}</b>
      <div class="muted mono">抖音号 ${esc(f.account?.douyinId || '—')} · UID ${esc(f.account?.uid || '—')} · 合作码 ${esc(f.account?.cooperationCode || '—')}</div>
      <div style="margin-top:6px">拍摄进度：<b>${esc(f.filmingProgress)}</b>${f.publishedAt ? ' · ' + fmtDate(f.publishedAt) : ''}</div>`;
    if (f.shareToken) {
      const row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
      const cp = el('button', 'btn sm', '复制口令');
      cp.onclick = async () => toast(await copy(f.shareToken) ? '已复制完整口令，可直接发给运营或粘进千川' : '复制失败');
      row.append(cp);
      if (f.videoUrl) { const a = el('a', 'btn sm', '打开视频 ↗'); a.href = f.videoUrl; a.target = '_blank'; a.rel = 'noreferrer'; a.style.textDecoration = 'none'; row.append(a); }
      m.append(row);
    }
    fs.append(m);
  });
  b.append(fs);

  // 操作
  const ops = el('div', 'sec');
  ops.append(el('h3', null, '操作'));
  const row = el('div'); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  const tk = el('button', 'btn sm', '回填快递');
  tk.onclick = () => { close(); openTrackingModal(cb.id); };
  const cp = el('button', 'btn sm', '复制物流信息');
  cp.onclick = async () => toast(await copy(notifyText) ? '已复制\n\n' + notifyText : '复制失败');
  const nt = el('button', 'btn sm', cb.notifiedAt ? '取消已告知' : '标记已告知');
  nt.onclick = async () => { await api('POST', `/api/collaborations/${cb.id}/notified`, { value: !cb.notifiedAt }); close(); loadTodos(); loadRecords(); };
  const fu = el('button', 'btn sm', '记录回访');
  fu.onclick = () => { close(); openFollowUpModal(cb.id); };
  const cr = el('button', 'btn sm', '查看达人');
  cr.onclick = () => { close(); openCreator(cb.creatorId); };
  row.append(tk, cp, nt, fu, cr);
  if (cb.status !== '已终止') {
    const stop = el('button', 'btn sm danger', '终止合作');
    stop.onclick = async () => {
      if (!confirm('终止后不再产生待办，历史记录保留。确定？')) return;
      await api('POST', `/api/collaborations/${cb.id}/status`, { status: '已终止' });
      close(); loadTodos(); loadRecords(); toast('已终止');
    };
    row.append(stop);
  }
  ops.append(row); b.append(ops);

  dr.append(h, b); document.body.append(mask, dr);
}

/* ---------- 达人详情 ---------- */

async function openCreator(id) {
  const { creator: c, logs } = await api('GET', '/api/creators/' + id);
  const mask = el('div', 'mask'), dr = el('div', 'drawer');
  const close = () => { mask.remove(); dr.remove(); };
  mask.onclick = close;

  const h = el('header');
  h.innerHTML = `<h2>${esc(c.name || '达人详情')}</h2>`;
  const x = el('button', 'icon', '×'); x.onclick = close; h.append(x);

  const b = el('div', 'body');
  b.innerHTML = `
    <dl class="dl">
      <dt>归属</dt><dd>${esc(c.ownerName)}</dd>
      <dt>渠道来源</dt><dd>${esc(c.channel || '抖音达人广场')}</dd>
      <dt>建档时间</dt><dd>${fmtTime(c.createdAt)}</dd>
      <dt>默认收件</dt><dd>${esc(c.defaultRecipient?.name || '—')} ${esc(c.defaultRecipient?.phone || '')}
        <div class="muted">${esc(c.defaultRecipient?.address || '')}</div></dd>
    </dl>
    <div class="sec"><h3>抖音账号（${c.accounts.length}）</h3>
      ${c.accounts.map((a) => `<div class="mini"><b>${esc(a.nickname || '（无昵称）')}</b>
        <div class="muted mono">抖音号 ${esc(a.douyinId || '—')} · UID ${esc(a.uid || '—')} · 合作码 ${esc(a.cooperationCode || '—')}</div></div>`).join('') || '<div class="muted">无</div>'}
    </div>
    ${c.otherAccounts.length ? `<div class="sec"><h3>其他平台账号（仅存档，不参与业务）</h3>
      ${c.otherAccounts.map((o) => `<div class="mini mono">${esc(o.platform)} · ${esc(o.accountId)}</div>`).join('')}</div>` : ''}
    <div class="sec"><h3>合作历史（${c.collaborations.length}）</h3>
      ${c.collaborations.map((cb) => `<div class="mini"><b>${esc(cb.status)}</b>
        <div class="muted">${cb.items.map((i) => esc(i.productName) + ' ×' + i.quantity).join('、') || '未填产品'} · ${fmtDate(cb.createdAt)}</div></div>`).join('') || '<div class="muted">无</div>'}
    </div>
    <div class="sec"><h3>识别留痕</h3>
      ${(logs || []).map((l) => `<div class="mini">
        <div>确认人 <b>${esc(l.confirmedByName || '—')}</b> · ${fmtTime(l.confirmedAt)}${l.elapsedMs ? ` · 耗时 ${(l.elapsedMs / 1000).toFixed(1)}s` : ''}</div>
        <div class="muted mono">${l.mode === 'llm' ? esc(l.model) : '本地模拟'} · ${esc(l.promptVersion)}</div>
        ${l.diff?.length ? `<div class="muted" style="margin-top:6px">人工修改 ${l.diff.length} 处：${
          l.diff.map((d) => `${esc(d.field)}「${esc(d.before || '空')}」→「${esc(d.after || '空')}」`).join('；')}</div>`
          : '<div class="muted" style="margin-top:6px">未修改任何字段</div>'}
      </div>`).join('') || '<div class="muted">无</div>'}
    </div>`;

  // 归属转交
  const tr = el('div', 'sec');
  tr.append(el('h3', null, '归属转交'));
  const trRow = el('div'); trRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const sel = el('select'); sel.style.cssText = 'padding:7px 10px;border:1px solid var(--line);border-radius:7px';
  (CFG.users || []).forEach((u) => { const o = el('option', null, `${esc(u.name)}`); o.value = u.id; sel.append(o); });
  sel.value = c.ownerUserId;
  const btn = el('button', 'btn sm', '转交');
  btn.onclick = async () => {
    if (sel.value === c.ownerUserId) { toast('归属没有变化'); return; }
    const reason = prompt('转交原因（会留痕）', '人员调整') || '';
    await api('POST', `/api/creators/${c.id}/transfer`, { toUserId: sel.value, reason });
    close(); loadRecords(); loadTodos(); toast('已转交');
  };
  trRow.append(sel, btn);
  trRow.append(el('span', 'muted', '归属人是责任人，待办发给他。人员变动时在这里转交，会留痕。'));
  tr.append(trRow); b.append(tr);

  dr.append(h, b); document.body.append(mask, dr);
}

/* ================================================================ 设置 */

let curRole = 'business', curStyle = { m: 'chat', v: 'chat' };

function openSettings(panel) { $('#settings').classList.add('on'); if (panel) switchPanel(panel); }
function switchPanel(name) {
  $$('.settings nav button').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  $$('.spanel').forEach((p) => p.classList.toggle('on', p.id === 'sp-' + name));
}
$('#openSettings').onclick = () => openSettings();
$('#closeSettings').onclick = () => {
  if (CFG.needsSetup) { toast('请先填写姓名和角色'); return; }
  $('#settings').classList.remove('on');
};
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
  setRole(s.user.role || 'business');
  $('#uName').value = s.user.name || ''; $('#uPhone').value = s.user.phone || '';

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
    await api('PUT', '/api/settings', { user: { name, role: curRole, phone: $('#uPhone').value.trim() } });
    await refreshConfig(); loadJobs(); loadTodos(); loadRecords();
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
    await refreshConfig(); loadTodos(); msg('#wfMsg', '已保存');
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
