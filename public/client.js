// client.js — Take Time v4 (Web Edition) · 全中文版
//
// 视觉：钟面 + 6 段 + Solar/Lunar 牌
// 流程：大厅 → 等待 → 规则 → 准备 → 游戏 → 终局（翻牌）

// Socket.IO 连接 URL (前后端分离部署用):
//   1. <body data-server-url="https://xxx">  (CF Pages + 远端后端场景)
//   2. window.SERVER_URL = '...'              (运行时动态注入)
//   3. 当前 host 是 localhost/127.0.0.1       (本地开发 → 走 3001)
//   4. 空字符串 = 同源                        (前后端同一域名, 如全 Render 部署)
const SERVER_URL = (() => {
  const fromBody = document.body && document.body.dataset && document.body.dataset.serverUrl;
  if (fromBody) return fromBody.replace(/\/+$/, '');  // 去尾部斜杠
  if (typeof window.SERVER_URL === 'string' && window.SERVER_URL) {
    return window.SERVER_URL.replace(/\/+$/, '');
  }
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:3001';
  return '';  // 同源
})();
// 本地存储的登录 token (Phase 1: 账号系统)
const TT_TOKEN_KEY = 'tt_token';
function getStoredToken() {
  try { return localStorage.getItem(TT_TOKEN_KEY) || null; } catch (_) { return null; }
}
function setStoredToken(t) {
  try {
    if (t) localStorage.setItem(TT_TOKEN_KEY, t);
    else localStorage.removeItem(TT_TOKEN_KEY);
  } catch (_) {}
}
const socket = io(SERVER_URL || '/', {
  reconnection: true,
  reconnectionAttempts: Infinity,
  auth: { token: getStoredToken() },  // 连接时带 token, 服务端 middleware 验证
});

// ---------- 常量 ----------

// 6 段在钟表盘外圈的位置（百分比，距离中心约 38% 半径）
// 钟表盘置于中心，外圈卡牌不覆盖钟面 —— 类似桌游模拟器 MOD 的排版
// 编号：从正上方顺时针排，I(指针段) 在 12 点方向
//   I   = 12 点（指针段，最低点数）
//   II  = 2 点
//   III = 4 点
//   IV  = 6 点
//   V   = 8 点
//   VI  = 10 点
const SEGMENT_POS = [
  { left: '50%', top: '11%' },   // I   12 点（指针段）
  { left: '83%', top: '30%' },   // II  2 点（右上）
  { left: '83%', top: '70%' },   // III 4 点（右下）
  { left: '50%', top: '89%' },   // IV  6 点（正下方）
  { left: '17%', top: '70%' },   // V   8 点（左下）
  { left: '17%', top: '30%' },   // VI  10 点（左上）
];

const COLOR = { SOLAR: 1, LUNAR: 2 };

// 玩家颜色（与 server.js PLAYER_COLORS 对应）
const PLAYER_COLORS = [
  { id: 'gold',  name: '金',  hex: '#d4af37' },
  { id: 'azure', name: '青',  hex: '#60a5fa' },
  { id: 'rose',  name: '玫',  hex: '#f472b6' },
  { id: 'jade',  name: '翠',  hex: '#34d399' },
];
const COLOR_HEX = Object.fromEntries(PLAYER_COLORS.map(c => [c.id, c.hex]));

// ---------- 状态 ----------

const state = {
  nickname: '',
  roomId: null,
  playerIdx: null,
  myColor: null,
  chapters: [],
  selectedChapterId: null,
  selectedClockId: null,
  maxPlayers: 4,
  view: null,
  public: null,
  myView: null,
  selectedCard: null,
  roomList: [],
  playerColors: PLAYER_COLORS,  // from server
  // Phase 1: 账号
  account: { logged_in: false, userId: null, display_name: null },
  // Phase 2: 私人房
  isPrivate: false,
  roomPassword: '',
  joinRoomId: '',
  joinRoomPassword: '',
  showAuthPanel: false,
  authMode: 'login',  // 'login' | 'register'
};

const VIEWS = ['lobby', 'waiting', 'rules', 'ready', 'game', 'end', 'history'];
function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(v + '-view');
    if (el) el.classList.toggle('hidden', v !== name);
  }
  if (name !== 'game' && name !== 'end') state.selectedCard = null;
}

// ---------- 工具 ----------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function emit(ev, d) { return new Promise(r => socket.emit(ev, d, r)); }
function colorHexOf(id) { return COLOR_HEX[id] || '#888'; }

// Format a per-clock validator into a Chinese rule sentence.
// Mirrors the server's runValidator() labels.
function formatValidator(v, ch) {
  const segName = (n) => ch.segment_names_zh?.[n - 1] || `段 ${n}`;
  switch (v.type) {
    case 'first_card_at':
      return `第 1 张牌必须放在 ${segName(v.segment)}。`;
    case 'second_card_at':
      return `第 2 张牌必须放在 ${segName(v.segment)}。`;
    case 'segment_count':
      return `${segName(v.segment)} 恰好放 ${v.count} 张牌。`;
    case 'segment_value_range':
      return `${segName(v.segment)} 的点数和须在 [${v.min}, ${v.max}] 区间。`;
    case 'segment_closest_to':
      return `${segName(v.segment)} 的点数和须最接近 ${v.value}。`;
    case 'segment_no_value':
      return `${segName(v.segment)} 不能放值为 ${v.values.join(' / ')} 的牌。`;
    case 'segment_color_count': {
      const parts = [];
      if (v.solar != null) parts.push(`${v.solar} 太阳`);
      if (v.lunar != null) parts.push(`${v.lunar} 月亮`);
      return `${segName(v.segment)} 恰好 ${parts.join(' + ')}。`;
    }
    case 'segment_lunar_count':
      return `${segName(v.segment)} 恰好 ${v.count} 张白牌。`;
    case 'highest_card_at':
      return `${segName(v.segment)} 必须放全组最高值的牌。`;
    case 'lowest_card_at':
      return `${segName(v.segment)} 必须放全组最低值的牌。`;
    case 'solar_lowest_card_at':
      return `${segName(v.segment)} 必须放太阳中最低值的牌。`;
    case 'lunar_highest_card_at':
      return `${segName(v.segment)} 必须放月亮中最高值的牌。`;
    case 'last_card_at':
      return `最后一张牌必须放在 ${segName(v.segment)}。`;
    default:
      return null;
  }
}

// Build a map: segment number (1-indexed) → array of human-readable rule
// sentences. Used to render hover tooltips on segments during gameplay.
function perSegmentRules(clock, chapter) {
  const map = new Map();
  for (const v of (clock.validators || [])) {
    if (!v.segment) continue;
    const txt = formatValidator(v, chapter);
    if (!txt) continue;
    if (!map.has(v.segment)) map.set(v.segment, []);
    map.get(v.segment).push(txt);
  }
  return map;
}

// Show / hide the floating rule tooltip near the cursor.
function showRuleTooltip(text, ev) {
  const tip = document.getElementById('rule-tooltip');
  if (!tip) return;
  tip.textContent = text;
  tip.classList.remove('hidden');
  // Position near the cursor, clamped to viewport.
  const x = ev.clientX + 16;
  const y = ev.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  // After it renders, clamp so it doesn't fly off-screen.
  requestAnimationFrame(() => {
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let nx = x, ny = y;
    if (rect.right > vw - 8) nx = Math.max(8, vw - rect.width - 8) + 0;
    if (rect.bottom > vh - 8) ny = Math.max(8, vh - rect.height - 8) + 0;
    tip.style.left = `${nx}px`;
    tip.style.top = `${ny}px`;
  });
}
function hideRuleTooltip() {
  const tip = document.getElementById('rule-tooltip');
  if (tip) tip.classList.add('hidden');
}

function toast(title, body = '', kind = '') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------- 牌面渲染 ----------

function cardImageSrc(card) {
  const color = card.c === COLOR.SOLAR ? 'solar' : 'lunar';
  return `img/cards/${color}_${String(card.v).padStart(2, '0')}.png`;
}

function cardImageHTML(card, opts = {}) {
  const { mini = false, back = false } = opts;
  const cls = `card-img ${mini ? 'card-img-mini' : ''}`;
  if (back) return `<img class="${cls} card-img-back" src="img/cards/back.png" alt="牌背" />`;
  return `<img class="${cls}" src="${cardImageSrc(card)}" alt="card ${card.v}" />`;
}

function cardBackMiniHTML(solar) {
  // solar=true: dark/gold Solar back; solar=false: inverted (light silver) Lunar back
  const cls = solar ? 'card-back-mini solar' : 'card-back-mini lunar';
  return `<img class="${cls}" src="img/cards/back_mini.png" alt="背" />`;
}

// ---------- 大厅 ----------

function renderLobby() {
  // 账户按钮 + 我的战绩按钮
  const accountBtn = document.getElementById('lobby-account-btn');
  if (accountBtn) {
    accountBtn.textContent = state.account.logged_in
      ? `账户 · ${state.account.display_name || '已登录'}`
      : '账户';
    accountBtn.onclick = () => {
      state.showAuthPanel = !state.showAuthPanel;
      const wrap = document.getElementById('auth-panel-wrap');
      if (wrap) wrap.style.display = state.showAuthPanel ? '' : 'none';
      if (state.showAuthPanel) renderAuthPanel();
    };
  }
  const historyBtn = document.getElementById('lobby-history-btn');
  if (historyBtn) {
    historyBtn.style.display = state.account.logged_in ? '' : 'none';
    historyBtn.onclick = () => {
      if (state.account.logged_in) {
        showHistoryView();
      } else {
        toast('提示', '登录后才能查看战绩', '');
      }
    };
  }
  // Auth 面板展开状态
  const authWrap = document.getElementById('auth-panel-wrap');
  if (authWrap) {
    authWrap.style.display = state.showAuthPanel ? '' : 'none';
    if (state.showAuthPanel) renderAuthPanel();
  }

  const picker = document.getElementById('chapter-picker');
  picker.innerHTML = '';
  if (state.chapters.length === 0) {
    picker.innerHTML = '<p class="muted">加载中…</p>';
    return;
  }
  for (const ch of state.chapters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-btn';
    if (ch.id === state.selectedChapterId) btn.classList.add('active');
    btn.innerHTML = `<strong>${escapeHtml(ch.name)}</strong><br><span class="muted">${escapeHtml(ch.subtitle)}</span>`;
    btn.onclick = () => {
      state.selectedChapterId = ch.id;
      state.selectedClockId = ch.clocks[0]?.id || null;
      renderLobby();
    };
    picker.appendChild(btn);
  }
  const ch = state.chapters.find(c => c.id === state.selectedChapterId) || state.chapters[0];
  if (!ch) return;
  const clockPicker = document.getElementById('clock-picker');
  clockPicker.innerHTML = '';
  for (const ck of ch.clocks) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-btn';
    if (ck.id === state.selectedClockId) btn.classList.add('active');
    btn.innerHTML = `<strong>${escapeHtml(ck.name)}</strong><br><span class="muted">${escapeHtml(ck.subtitle)}</span>`;
    btn.onclick = () => {
      state.selectedClockId = ck.id;
      renderLobby();
    };
    clockPicker.appendChild(btn);
  }
  // 玩家数
  document.querySelectorAll('#player-count-picker button.picker-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.count) === state.maxPlayers);
    b.onclick = () => {
      state.maxPlayers = Number(b.dataset.count);
      if (state.maxPlayers < state.myColorSlot) state.myColorSlot = 0;
      renderLobby();
    };
  });
  // 颜色选择
  renderColorPicker('lobby-color-picker', (colorId) => {
    state.myColor = colorId;
    renderLobby();
  }, state.myColor);

  // 房间列表
  const list = document.getElementById('room-list');
  if (state.roomList.length === 0) {
    list.innerHTML = '<li class="muted lobby-empty-hint">还没有开放的迷局。开启新的迷局吧。</li>';
  } else {
    list.innerHTML = '';
    for (const r of state.roomList) {
      const li = document.createElement('li');
      li.className = 'room-item';
      li.innerHTML = `
        <div class="room-info">
          <strong>${escapeHtml(r.chapter_name || '?')}</strong>
          <span class="dot">·</span>
          <span>${escapeHtml(r.clock_name || '?')}</span>
          <span class="dot">·</span>
          <span class="muted">${r.player_count}/${r.connected_count} 在线</span>
        </div>
        <button class="primary" type="button">加入</button>
      `;
      li.querySelector('button').onclick = async () => {
        const nick = document.getElementById('lobby-nickname').value.trim();
        if (!nick) return toast('请输入昵称', '', 'error');
        const r2 = await emit('join_room', {
          room_id: r.id, nickname: nick, color: state.myColor,
        });
        if (r2?.error) return toast('加入失败', r2.error, 'error');
        state.nickname = nick;
        state.roomId = r2.room_id;
        state.playerIdx = r2.player_idx;
        state.myColor = r2.color;
        showView('waiting');
        renderWaiting();
      };
      list.appendChild(li);
    }
  }
  // 私人房 checkbox 联动密码框
  const privBox = document.getElementById('lobby-private');
  const pwInput = document.getElementById('lobby-password');
  if (privBox && pwInput) {
    privBox.checked = state.isPrivate;
    pwInput.disabled = !state.isPrivate;
    if (state.isPrivate) pwInput.value = state.roomPassword;
    privBox.onchange = () => {
      state.isPrivate = privBox.checked;
      pwInput.disabled = !state.isPrivate;
      if (state.isPrivate) pwInput.focus();
    };
    pwInput.oninput = () => { state.roomPassword = pwInput.value; };
  }

  // 手动加入房间 (输入房间号)
  const joinIdInput = document.getElementById('lobby-join-id');
  const joinPwInput = document.getElementById('lobby-join-password');
  const joinBtn = document.getElementById('lobby-join-btn');
  if (joinIdInput) joinIdInput.value = state.joinRoomId;
  if (joinPwInput) joinPwInput.value = state.joinRoomPassword;
  if (joinBtn) {
    joinBtn.onclick = async () => {
      const rid = joinIdInput.value.trim().toUpperCase();
      const pw = joinPwInput.value;
      if (!rid) return toast('请输入房间号', '', 'error');
      const nick = document.getElementById('lobby-nickname').value.trim();
      if (!nick) return toast('请输入昵称', '', 'error');
      const r = await emit('join_room', {
        room_id: rid, nickname: nick, color: state.myColor, password: pw || undefined,
      });
      if (r?.error) return toast('加入失败', r.error, 'error');
      state.joinRoomId = rid;
      state.joinRoomPassword = pw;
      state.nickname = nick;
      state.roomId = r.room_id;
      state.playerIdx = r.player_idx;
      state.myColor = r.color;
      showView('waiting');
      renderWaiting();
    };
  }

  // 创建按钮
  document.getElementById('lobby-create-btn').onclick = async () => {
    const nick = document.getElementById('lobby-nickname').value.trim();
    if (!nick) return toast('请输入昵称', '', 'error');
    if (!state.selectedChapterId || !state.selectedClockId) return toast('请先选章与局', '', 'error');
    const payload = {
      nickname: nick,
      chapter_id: state.selectedChapterId,
      clock_id: state.selectedClockId,
      max_players: state.maxPlayers,
      color: state.myColor,
    };
    if (state.isPrivate) {
      const pw = (state.roomPassword || '').trim();
      if (pw.length < 4 || pw.length > 12) return toast('私人房密码需 4-12 字符', '', 'error');
      payload.password = pw;
    }
    const r = await emit('create_room', payload);
    if (r?.error) return toast('创建失败', r.error, 'error');
    state.nickname = nick;
    state.roomId = r.room_id;
    state.playerIdx = r.player_idx;
    state.myColor = r.color;
    showView('waiting');
    renderWaiting();
  };
}

function renderColorPicker(containerId, onPick, selectedId) {
  const cp = document.getElementById(containerId);
  if (!cp) return;
  cp.innerHTML = '';
  for (const c of state.playerColors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-dot' + (c.id === selectedId ? ' active' : '');
    btn.style.setProperty('--c', c.hex);
    btn.title = c.name;
    btn.onclick = () => onPick(c.id);
    cp.appendChild(btn);
  }
}

// ---------- 等待 ----------

function renderWaiting() {
  document.getElementById('waiting-room-id').textContent = state.roomId || '???';
  const list = document.getElementById('waiting-players');
  if (!state.public) { list.innerHTML = '<li class="muted">加载中…</li>'; return; }
  list.innerHTML = '';
  state.public.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'player-line';
    const c = colorHexOf(p.color);
    li.innerHTML = `
      <span class="player-color" style="background:${c}"></span>
      <span class="player-name">${escapeHtml(p.nickname)}</span>
      <span class="muted">${p.is_bot ? '(Bot)' : (p.connected ? '' : '(断线)')}</span>
      ${p.color ? `<span class="color-tag" style="--c:${c}">${PLAYER_COLORS.find(x=>x.id===p.color)?.name || ''}</span>` : ''}
    `;
    list.appendChild(li);
  });
  const isHost = state.playerIdx === 0;
  document.getElementById('waiting-host-hint').style.display = isHost ? '' : 'none';
  document.getElementById('waiting-start').style.display = isHost ? '' : 'none';
  document.getElementById('waiting-fill-bots').style.display = isHost ? '' : 'none';
  document.getElementById('waiting-start').disabled = state.public.players.length < 2;
}
document.getElementById('waiting-fill-bots').onclick = async () => {
  const r = await emit('fill_with_bots');
  if (r?.error) return toast('失败', r.error, 'error');
};
document.getElementById('waiting-start').onclick = async () => {
  const r = await emit('start_game');
  if (r?.error) return toast('失败', r.error, 'error');
};
document.getElementById('waiting-leave').onclick = () => location.reload();

// ---------- 规则页 ----------

function renderRules() {
  if (!state.public) return;
  const ch = state.public.chapter;
  const ck = state.public.clock;
  document.getElementById('rules-title').textContent = `${ch.name} — ${ck.name}`;
  document.getElementById('rules-subtitle').textContent = ch.subtitle;
  document.getElementById('rules-chapter-name').textContent = `${ch.name} · ${ck.subtitle}`;
  document.getElementById('rules-chapter-desc').textContent = ch.description;

  const std = ch.standard_rules;
  const stdList = document.getElementById('rules-standard');
  stdList.innerHTML = '';
  stdList.innerHTML += `<li>每段至少放 <b>${std.min_per_segment}</b> 张牌。</li>`;
  if (std.ascending) stdList.innerHTML += `<li>各段点数从 I 段起<b>顺时针非递减</b>。</li>`;
  if (std.max_value) {
    const ckIndex = (Array.isArray(state.public.chapter.clocks)
      ? state.public.chapter.clocks.findIndex(c => c.id === ck.id) + 1 : 0);
    const isRelaxed = (std.max_value_relaxed_clocks || []).includes(ckIndex);
    if (isRelaxed) {
      stdList.innerHTML += `<li>每段点数 ≤ <b>${std.max_value}</b> <span class="muted">（本局不强制）</span></li>`;
    } else {
      stdList.innerHTML += `<li>每段点数 ≤ <b>${std.max_value}</b>。</li>`;
    }
  }
  // 章节级 `no_faceup_plays` (Ch02 Limitation): 整章禁明牌
  if (ch.no_faceup_plays) {
    stdList.innerHTML += `<li class="rules-warning">⚠ 本章节所有牌必须<b>盖牌</b>放置，禁止任何明牌（也不能用 Bonus token 翻牌）。</li>`;
    stdList.innerHTML += `<li>本局可用明牌次数：<b>0</b> <span class="muted">（章节禁用）</span>。</li>`;
  } else {
    stdList.innerHTML += `<li>本局可用明牌次数：<b>${state.public.face_up_limit}</b>（每人 1 次，共用）。</li>`;
  }
  // Ch5 Tranquility: 整章每段恰好 N 张
  if (std.max_per_segment != null && std.max_per_segment === std.min_per_segment) {
    stdList.innerHTML += `<li class="rules-warning">⚠ 本章节每段必须恰好 <b>${std.min_per_segment}</b> 张牌。</li>`;
  }
  // Ch3 As Within: Clock Hand 段（章节默认 + per-clock 覆盖）
  if (ck.clock_hand_segment) {
    const segName = ch.segment_names_zh?.[ck.clock_hand_segment - 1] || `段 ${ck.clock_hand_segment}`;
    stdList.innerHTML += `<li class="rules-warning">🕰 Clock Hand 指向 <b>${segName}</b> 段（该段必须含全组最低/最高值卡）。</li>`;
  }
  // Ch4 Roar: per-clock forced_play（强制出牌顺序）
  if (ck.forced_play) {
    const forcedText = {
      'leftmost': '最左（手牌索引 0）',
      'highest': '最大值',
      'lowest': '最小值',
    }[ck.forced_play] || ck.forced_play;
    stdList.innerHTML += `<li class="rules-warning">⚠ 本局每回合必须出 <b>${forcedText}</b> 的牌。</li>`;
  }
  // Ch06 As Above So Below: 段值 = 段内 max - min (差值)
  if (std.value_mode === 'diff') {
    stdList.innerHTML += `<li class="rules-warning">⟁ 本章节每段点数 = <b>段内最大卡 − 最小卡</b>（差值），不是卡值总和。差值顺时针非递减。</li>`;
  }
  // Ch07 Intrusion: 放 1 张立即从备牌堆抽 1 张
  if (std.draw_on_play) {
    stdList.innerHTML += `<li class="rules-warning">⟁ 本章节每放 1 张牌，立即从备牌堆抽 <b>${std.draw_on_play}</b> 张补入手中。</li>`;
  }
  // Ch08 Revolution: 放 1 张时钟旋转 1 段 + 钟面有禁放段
  if (std.rotate_on_play) {
    stdList.innerHTML += `<li class="rules-warning">⟁ 本章节每放 1 张牌，时钟顺时针旋转 <b>${std.rotate_on_play}</b> 段。卡和钟面一起转动。</li>`;
  }
  if (ck.forbidden_segments && ck.forbidden_segments.length > 0) {
    const segNames = ck.forbidden_segments.map(s => ch.segment_names_zh?.[s - 1] || `段 ${s}`).join(' / ');
    stdList.innerHTML += `<li class="rules-warning">🔒 钟面禁放段：<b>${segNames}</b>（钟面原位，旋转时整圈移位）。</li>`;
  }
  // Ch09 Unity: 相邻段值相等 + 整体 max-min ≤ 4
  if (std.adjacent_segments_equal) {
    stdList.innerHTML += `<li class="rules-warning">⟁ 本章节六段点数必须全部<b>相等</b>（相邻段值相等）。</li>`;
  }
  if (std.overall_max_min_diff != null) {
    stdList.innerHTML += `<li class="rules-warning">⟁ 本章节整体 max段值 − min段值 ≤ <b>${std.overall_max_min_diff}</b>。</li>`;
  }
  // Ch10 Cohesiveness: 秒针 + 段首张卡递增
  if (std.second_hand) {
    const shInit = ck.second_hand_initial || 1;
    const shName = ch.segment_names_zh?.[shInit - 1] || `段 ${shInit}`;
    const oppInit = ((shInit - 1 + 3) % (ch.n_segments || 6)) + 1;
    const oppName = ch.segment_names_zh?.[oppInit - 1] || `段 ${oppInit}`;
    stdList.innerHTML += `<li class="rules-warning">🕰 本章节有<b>秒针</b>，初始指向 <b>${shName}</b> 段和<b>对向</b> <b>${oppName}</b> 段，这两段不可放卡。每回合后秒针顺时针转 1 段。</li>`;
  }
  if (std.adjacent_strict_ascending_first) {
    stdList.innerHTML += `<li class="rules-warning">⟁ 本章节从 Hand 段起，顺时针每段首张卡必须<b>严格递增</b>。</li>`;
  }
  stdList.innerHTML += `<li>你手中有 <b>${state.public.hand_size}</b> 张牌（${state.public.n_players} 人局）。</li>`;

  // Per-clock special rules (rendered from the chapter's `validators` data).
  const special = document.getElementById('rules-clock-special');
  special.innerHTML = '';
  const validators = ck.validators || [];
  if (validators.length === 0) {
    special.innerHTML = '<li class="muted">本局无附加段位规则。</li>';
  } else {
    for (const v of validators) {
      const txt = formatValidator(v, ch);
      if (txt) {
        const li = document.createElement('li');
        li.textContent = txt;
        special.appendChild(li);
      }
    }
  }

  // 规则卡: 优先用每钟自己的钟面图 (ck.rulesheet), 没有再 fallback 到章节的
  document.getElementById('rules-rulesheet').src = ck.rulesheet || ch.rulesheet;

  const myPlayer = state.public.players[state.playerIdx];
  const readyBtn = document.getElementById('rules-ready');
  if (myPlayer?.ready) {
    readyBtn.textContent = `已就位 (${state.public.players.filter(p => p.ready).length}/${state.public.players.length})`;
    readyBtn.disabled = true;
  } else {
    readyBtn.textContent = '我已就位';
    readyBtn.disabled = false;
  }
}
document.getElementById('rules-ready').onclick = async () => {
  const r = await emit('i_am_ready');
  if (r?.error) return toast('失败', r.error, 'error');
};
document.getElementById('rules-leave').onclick = () => location.reload();

// ---------- 准备 / 抢答 ----------

function renderReady() {
  const hand = document.getElementById('ready-hand');
  hand.innerHTML = '';
  if (!state.myView) return;
  for (const card of state.myView.hand) {
    hand.appendChild(el(cardImageHTML(card)));
  }
  const btn = document.getElementById('ready-declare');
  if (state.public.first_player_idx !== null) {
    const first = state.public.players[state.public.first_player_idx];
    btn.textContent = `${first.nickname} 先出`;
    btn.disabled = true;
  } else {
    btn.textContent = '我先出';
    btn.disabled = false;
  }
}
document.getElementById('ready-declare').onclick = async () => {
  const r = await emit('declare_first');
  if (r?.error) return toast('失败', r.error, 'error');
};

// ---------- 游戏页 ----------

function renderGame() {
  if (!state.public || !state.myView) return;
  const ch = state.public.chapter;
  const ck = state.public.clock;
  const std = ch.standard_rules || {};
  document.getElementById('game-chapter').textContent = ch.name;
  document.getElementById('game-clock').textContent = ck.name;
  document.getElementById('game-turn').textContent = state.public.turn_number;
  document.getElementById('game-faceup').textContent = state.public.face_up_remaining;
  document.getElementById('game-hand-size').textContent = state.myView.hand.length;

  document.getElementById('board-clock-img').src = ck.image;

  // Ch08 Revolution: 视觉旋转钟面图 + (rotation === 0 ? 0 : 360/6 * rotation 度)
  //   注意: CSS 已用 `translate(-50%, -50%)` 把图片居中, JS 必须保留这个 translate,
  //   只追加 rotate, 否则图片会跑到右下角
  const isCh08 = !!(std.rotate_on_play);
  const rotDeg = (state.public.rotation || 0) * 60;  // 6 段, 60°/段
  const clockImgEl = document.getElementById('board-clock-img');
  if (clockImgEl) {
    clockImgEl.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg)`;
    clockImgEl.style.transformOrigin = '50% 50%';
    clockImgEl.style.transition = 'transform 0.5s ease-out';
  }
  // Ch08 旋转计数显示 (仅 Ch08 显示)
  const rotationEl = document.getElementById('game-rotation');
  if (rotationEl) {
    rotationEl.textContent = state.public.rotation || 0;
    rotationEl.parentElement.style.display = isCh08 ? '' : 'none';
  }
  // Ch07 备牌堆剩余显示 (仅 Ch07 显示)
  const isCh07 = !!(std.draw_on_play);
  const deckEl = document.getElementById('game-deck');
  if (deckEl) {
    const remaining = state.public.deck_remaining || 0;
    deckEl.textContent = remaining;
    deckEl.parentElement.style.display = isCh07 ? '' : 'none';
  }
  // Ch10 凝聚: 秒针位置 (1..n_segments, 仅 Ch10 显示)
  const isCh10 = !!(std.second_hand);
  const shEl = document.getElementById('game-second-hand');
  if (shEl) {
    shEl.textContent = state.public.second_hand != null ? state.public.second_hand : '—';
    shEl.parentElement.style.display = isCh10 ? '' : 'none';
  }
  // Ch10 视觉: 旋转秒针 SVG 覆盖层
  //   段 N (1-indexed) 对应角度: 从 12 点 (top) 起, 顺时针 (N-1) * 60°
  //   SVG 的 line 初始画在 12 点方向 (y2=10), 用 transform: rotate(角度) 旋转
  const shSvg = document.getElementById('board-second-hand');
  if (shSvg) {
    if (isCh10 && state.public.second_hand != null) {
      shSvg.style.display = '';
      const n = state.public.chapter.n_segments || 6;
      const shAngle = ((state.public.second_hand - 1) % n) * (360 / n);  // 段 N -> 角度
      shSvg.style.transform = `rotate(${shAngle}deg)`;
    } else {
      shSvg.style.display = 'none';
    }
  }

  // 章节级 `no_faceup_plays` (Ch02 Limitation): 禁用明牌 checkbox
  const faceupEl = document.getElementById('action-faceup');
  const faceupLabel = document.getElementById('action-faceup-label');
  if (ch.no_faceup_plays) {
    faceupEl.checked = false;
    faceupEl.disabled = true;
    if (faceupLabel) faceupLabel.classList.add('is-disabled');
    faceupEl.title = '本章节禁止明牌';
  } else {
    faceupEl.disabled = false;
    if (faceupLabel) faceupLabel.classList.remove('is-disabled');
    faceupEl.title = '';
  }

  renderPlayersStrip();
  renderBoard();
  renderHand();
  renderActionHint();
}

function renderPlayersStrip() {
  const strip = document.getElementById('players-strip');
  strip.innerHTML = '';
  state.public.players.forEach((p, i) => {
    const isCurrent = (i === state.public.current_player_idx);
    const me = (i === state.playerIdx);
    const c = colorHexOf(p.color);
    // 决定每个牌背的太阳/月亮颜色
    let backList = [];
    if (me) {
      // 自己的手牌，按实际牌的颜色
      for (const card of state.myView.hand) backList.push(card.c === 1);
    } else {
      // 对手的手牌，按服务器给的 (太阳, 月亮) 计数
      const colors = state.myView.hand_colors_by_idx?.[i] || [0, 0];
      const [solarN, lunarN] = colors;
      for (let k = 0; k < solarN; k++) backList.push(true);
      for (let k = 0; k < lunarN; k++) backList.push(false);
    }
    const backs = backList.map(solar => cardBackMiniHTML(solar)).join('');
    const div = el(`
      <div class="player-card ${isCurrent ? 'is-current' : ''} ${me ? 'is-me' : ''}" style="--pc:${c}">
        <div class="player-color" style="background:${c}"></div>
        <div class="player-info">
          <div class="player-name">${escapeHtml(p.nickname)}${p.is_bot ? ' 🤖' : ''}${me ? ' (你)' : ''}</div>
          <div class="player-backs">${backs}</div>
        </div>
      </div>
    `);
    strip.appendChild(div);
  });
}

function renderBoard() {
  const segs = document.getElementById('board-segments');
  segs.innerHTML = '';
  const isRevealed = state.public.state === 'finished';
  const ruleMap = perSegmentRules(state.public.clock, state.public.chapter);
  // Ch06 As Above So Below: 段值标签是 "差值" 不是 "段和"
  const valueMode = state.public.value_mode || 'sum';
  const valueLabel = (valueMode === 'diff') ? '差值' : '段和';
  // Ch08 Revolution: 计算当前 rotation 下的 absolute forbidden 段
  const rotation = state.public.rotation || 0;
  const forbiddenOrig = state.public.forbidden_segments || [];
  const n = state.public.chapter.n_segments || 6;
  const forbiddenAbs = new Set();
  for (const f of forbiddenOrig) {
    const absPos = ((f - 1 + rotation) % n + n) % n + 1;  // 1-indexed
    forbiddenAbs.add(absPos);
  }
  // Ch10 Cohesiveness: 秒针指的两段 (相隔 3 段) 禁放
  if (state.public.second_hand != null) {
    const sh = state.public.second_hand;
    const opp = ((sh - 1 + 3) % n) + 1;
    forbiddenAbs.add(sh);
    forbiddenAbs.add(opp);
  }
  for (let i = 0; i < state.public.chapter.n_segments; i++) {
    const pos = SEGMENT_POS[i];
    const segCards = state.public.segments[i] || [];
    const segName = state.public.chapter.segment_names_zh[i]
      || state.public.chapter.segment_names_en[i]
      || `段 ${i+1}`;
    const sum = (isRevealed && state.public.game_result?.sums)
      ? state.public.game_result.sums[i] : null;
    const segRules = ruleMap.get(i + 1) || [];
    const hasRule = segRules.length > 0;
    const isForbidden = forbiddenAbs.has(i + 1);

    const segDiv = el(`
      <div class="segment ${hasRule ? 'has-rule' : ''} ${isForbidden ? 'is-forbidden' : ''}" data-seg="${i+1}" style="left:${pos.left}; top:${pos.top}">
        ${isForbidden ? '<span class="rule-lock" title="钟面禁放段（旋转后才能放）">🔒</span>' : ''}
        <div class="seg-numeral">${escapeHtml(segName)}</div>
        <div class="segment-cards"></div>
        ${(sum != null || segCards.length > 0) ? `<div class="segment-meta">${sum != null ? `<b title="${valueLabel}">${sum}</b>` : ''}${segCards.length > 0 ? ` (${segCards.length})` : ''}</div>` : ''}
      </div>
    `);
    if (isRevealed) segDiv.classList.add('is-revealed');
    if (isForbidden && state.public.state === 'playing') segDiv.classList.add('is-locked');

    const cardsDiv = segDiv.querySelector('.segment-cards');
    segCards.forEach((c, idx) => {
      const playerColor = colorHexOf(state.public.players[c.player]?.color);
      // 暗牌需要按 Solar / Lunar 区分牌背 (Solar=原色, Lunar=反色)
      const backColorClass = !c.face_up ? (c.c === 1 ? 'back-solar' : 'back-lunar') : '';
      const cardEl = el(`
        <div class="seg-card ${backColorClass}" style="--i:${idx}; --pc:${playerColor}" title="${state.public.players[c.player]?.nickname || '?'}">
          ${cardImageHTML(c, { mini: true, back: !c.face_up })}
        </div>
      `);
      cardsDiv.appendChild(cardEl);
    });

    if (state.selectedCard != null && !isRevealed && !isForbidden) {
      segDiv.classList.add('is-clickable');
      segDiv.onclick = () => playCard(i + 1);
    } else {
      segDiv.classList.remove('is-clickable');
      segDiv.onclick = null;
    }

    // Hover-to-zoom rule tooltip for segments with per-clock rules
    if (hasRule) {
      const ruleText = segRules.join('\n');
      segDiv.addEventListener('mouseenter', (ev) => showRuleTooltip(ruleText, ev));
      segDiv.addEventListener('mousemove', (ev) => showRuleTooltip(ruleText, ev));
      segDiv.addEventListener('mouseleave', hideRuleTooltip);
    }

    segs.appendChild(segDiv);
  }
}

function renderHand() {
  const hand = document.getElementById('game-hand');
  hand.innerHTML = '';
  if (!state.myView) return;
  const isMyTurn = (state.public.current_player_idx === state.playerIdx);
  // Ch4 Roar: 计算本回合"必须出"的牌索引 (leftmost / highest / lowest)
  let forcedIdx = -1;
  const fp = state.public.clock.forced_play;
  if (fp === 'leftmost') forcedIdx = 0;
  else if (fp === 'highest') {
    let bi = 0;
    for (let i = 1; i < state.myView.hand.length; i++) {
      if (state.myView.hand[i].v > state.myView.hand[bi].v) bi = i;
    }
    forcedIdx = bi;
  } else if (fp === 'lowest') {
    let bi = 0;
    for (let i = 1; i < state.myView.hand.length; i++) {
      if (state.myView.hand[i].v < state.myView.hand[bi].v) bi = i;
    }
    forcedIdx = bi;
  }
  for (let i = 0; i < state.myView.hand.length; i++) {
    const card = state.myView.hand[i];
    const isSel = (state.selectedCard === i);
    const isForced = (forcedIdx === i);
    const cls = [
      'hand-card',
      isSel ? 'is-selected' : '',
      !isMyTurn ? 'is-disabled' : '',
      isForced ? 'is-forced' : '',
    ].filter(Boolean).join(' ');
    const forcedHint = isForced ? `<span class="hand-forced-badge">本回合必出</span>` : '';
    const img = el(`
      <div class="${cls}">
        ${cardImageHTML(card, {})}
        ${forcedHint}
      </div>
    `);
    img.onclick = () => {
      if (!isMyTurn) return;
      state.selectedCard = (state.selectedCard === i) ? null : i;
      renderGame();
    };
    hand.appendChild(img);
  }
}

function renderActionHint() {
  const hint = document.getElementById('action-hint');
  const isMyTurn = (state.public.current_player_idx === state.playerIdx);
  if (state.public.state === 'finished') {
    hint.textContent = '本局已结束，查看上方结果。';
    return;
  }
  if (!isMyTurn) {
    const cur = state.public.players[state.public.current_player_idx];
    hint.textContent = `等待 ${cur ? cur.nickname : '?'} 出牌…`;
    return;
  }
  if (state.selectedCard == null) {
    hint.textContent = '从手牌选一张。';
  } else {
    const card = state.myView.hand[state.selectedCard];
    const colorName = card.c === 1 ? '太阳' : '月亮';
    hint.textContent = `${colorName} ${card.v} — 点击一个段位放置。`;
  }
}

async function playCard(segment) {
  if (state.selectedCard == null) return;
  const faceUp = document.getElementById('action-faceup').checked;
  const r = await emit('play_card', {
    card_idx: state.selectedCard, segment, face_up: faceUp,
  });
  if (r?.error) return toast('出牌失败', r.error, 'error');
  state.selectedCard = null;
  document.getElementById('action-faceup').checked = false;
}

// ---------- 终局（reveal） ----------

function renderEnd() {
  if (!state.public || !state.public.game_result) return;
  const won = state.public.game_result.won;
  const banner = document.getElementById('end-banner');
  banner.className = 'end-banner ' + (won ? 'is-win' : 'is-lose');
  banner.innerHTML = won
    ? '<div class="end-effect end-effect-win"><div class="end-particles"></div></div><h2 class="end-h2">✨ 时序归位</h2><p>所有规则都满足。钟面成象，万物归位。</p>'
    : '<div class="end-effect end-effect-lose"><div class="end-shards"></div></div><h2 class="end-h2">⟁ 时序错乱</h2><p>有规则未满足。讨论后再次尝试。</p>';
  maybeShowEndSaved();

  document.getElementById('end-clock-img').src = state.public.clock.image;
  // Ch08 终局: 视觉旋转对齐最后状态. CSS 已用 translate 居中, JS 必须保留.
  const rotDeg = (state.public.rotation || 0) * 60;
  const endClockImg = document.getElementById('end-clock-img');
  if (endClockImg) {
    endClockImg.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg)`;
    endClockImg.style.transformOrigin = '50% 50%';
  }
  // Ch10 终局: 秒针视觉
  const isCh10End = !!(state.public.chapter.standard_rules && state.public.chapter.standard_rules.second_hand);
  const endShSvg = document.getElementById('end-second-hand');
  if (endShSvg) {
    if (isCh10End && state.public.second_hand != null) {
      endShSvg.style.display = '';
      const nE = state.public.chapter.n_segments || 6;
      const shAngle = ((state.public.second_hand - 1) % nE) * (360 / nE);
      endShSvg.style.transform = `rotate(${shAngle}deg)`;
    } else {
      endShSvg.style.display = 'none';
    }
  }
  const segs = document.getElementById('end-segments');
  segs.innerHTML = '';
  const ruleMap = perSegmentRules(state.public.clock, state.public.chapter);
  const valueMode = state.public.value_mode || 'sum';
  const valueLabel = (valueMode === 'diff') ? '差值' : '段和';
  // Ch10 终局: 计算秒针指的两段 (标 lock 样式)
  const endSh = state.public.second_hand;
  const endN = state.public.chapter.n_segments || 6;
  const endForbidden = new Set();
  if (endSh != null) {
    endForbidden.add(endSh);
    endForbidden.add(((endSh - 1 + 3) % endN) + 1);
  }
  for (let i = 0; i < state.public.chapter.n_segments; i++) {
    const pos = SEGMENT_POS[i];
    const segCards = state.public.segments[i] || [];
    const segName = state.public.chapter.segment_names_zh[i]
      || state.public.chapter.segment_names_en[i] || `段 ${i+1}`;
    const sum = state.public.game_result.sums[i];
    const segRules = ruleMap.get(i + 1) || [];
    const hasRule = segRules.length > 0;
    const isForbidden = endForbidden.has(i + 1);
    const segDiv = el(`
      <div class="segment is-revealed ${hasRule ? 'has-rule' : ''} ${isForbidden ? 'is-forbidden' : ''}" style="left:${pos.left}; top:${pos.top}">
        ${isForbidden ? '<span class="rule-lock" title="秒针指向段（不可放卡）">🔒</span>' : ''}
        <div class="seg-numeral">${escapeHtml(segName)}</div>
        <div class="segment-cards"></div>
        <div class="segment-meta"><b title="${valueLabel}">${sum}</b> (${segCards.length})</div>
      </div>
    `);
    const cardsDiv = segDiv.querySelector('.segment-cards');
    segCards.forEach((c, idx) => {
      const playerColor = colorHexOf(state.public.players[c.player]?.color);
      // 终局时所有牌都已翻开 (face_up=true), 不需要 back-color class
      const cardEl = el(`
        <div class="seg-card" style="--i:${idx}; --pc:${playerColor}" title="${state.public.players[c.player]?.nickname || '?'}">
          ${cardImageHTML(c, { mini: true })}
        </div>
      `);
      cardsDiv.appendChild(cardEl);
    });
    if (hasRule) {
      const ruleText = segRules.join('\n');
      segDiv.addEventListener('mouseenter', (ev) => showRuleTooltip(ruleText, ev));
      segDiv.addEventListener('mousemove', (ev) => showRuleTooltip(ruleText, ev));
      segDiv.addEventListener('mouseleave', hideRuleTooltip);
    }
    segs.appendChild(segDiv);
  }

  const detail = document.getElementById('end-detail');
  detail.innerHTML = '';
  for (const d of state.public.game_result.detail) {
    const li = document.createElement('li');
    li.className = d.passed ? 'pass' : 'fail';
    li.textContent = (d.passed ? '✓ ' : '✕ ') + d.name
      + (d.skipped ? '（不强制）' : '');
    detail.appendChild(li);
  }

  const byPlayer = document.getElementById('end-by-player');
  byPlayer.innerHTML = '';

  // 终局按钮: 4 种场景
  //   赢 + 房主: [下一关 →] [关卡选择]
  //   输 + 房主: [🔄 重新开始] [关卡选择]
  //   赢 + 非房主: [关卡选择]
  //   输 + 非房主: [关卡选择]
  const myPlayer = state.public.players[state.playerIdx];
  const isHost = !!(myPlayer && myPlayer.is_host);
  const restartBtn = document.getElementById('end-restart');
  const nextBtn = document.getElementById('end-next');
  const backBtn = document.getElementById('end-back-lobby');
  if (isHost) {
    if (won) {
      restartBtn.style.display = 'none';
      nextBtn.style.display = '';
      nextBtn.textContent = '下一关 →';
    } else {
      restartBtn.style.display = '';
      nextBtn.style.display = 'none';
      restartBtn.textContent = '重新开始';
    }
  } else {
    restartBtn.style.display = 'none';
    nextBtn.style.display = 'none';
  }
  backBtn.textContent = '关卡选择';

  state.public.players.forEach((p, i) => {
    const myCards = state.public.history.filter(h => h.player === i);
    const c = colorHexOf(p.color);
    const li = document.createElement('li');
    li.className = 'end-player-row';
    li.style.setProperty('--pc', c);
    li.innerHTML = `
      <div class="end-player-head">
        <span class="player-color" style="background:${c}"></span>
        <strong>${escapeHtml(p.nickname)}</strong>
        <span class="muted">${p.is_bot ? 'Bot' : ''}</span>
        <span class="muted">${myCards.length} 张</span>
      </div>
      <div class="end-player-cards"></div>
    `;
    const cardsDiv = li.querySelector('.end-player-cards');
    myCards.forEach(h => {
      const card = { v: h.v, c: h.c };
      const segName = state.public.chapter.segment_names_zh[h.segment - 1]
        || state.public.chapter.segment_names_en[h.segment - 1] || `#${h.segment}`;
      const cardEl = el(`
        <div class="end-card" style="--pc:${c}">
          ${cardImageHTML(card, { mini: true })}
          <span class="end-card-seg">${escapeHtml(segName)}</span>
        </div>
      `);
      cardsDiv.appendChild(cardEl);
    });
    byPlayer.appendChild(li);
  });
}
document.getElementById('end-back-lobby').onclick = () => leaveRoom();

// ---------- 终局: 重新开始 / 下一关 (房主) ----------
async function endAction(action) {
  const r = await emit(action);
  if (r?.error) return toast('失败', r.error, 'error');
}
document.getElementById('end-restart').onclick = () => endAction('restart_game');
document.getElementById('end-next').onclick = () => endAction('next_clock');

// ---------- 主动退出房间 (替代 location.reload, 让服务器清理 slot) ----------
async function leaveRoom() {
  // 终局/规则/等待页都能用, 简单粗暴: 通知服务器, 服务器处理后客户端 reload
  try { await emit('leave_room'); } catch (_) {}
  location.reload();
}
// 老版 location.reload 的 leave 按钮也升级
const _waitingLeave = document.getElementById('waiting-leave');
if (_waitingLeave) _waitingLeave.onclick = () => {
  if (confirm('确定退出当前房间?')) leaveRoom();
};
const _rulesLeave = document.getElementById('rules-leave');
if (_rulesLeave) _rulesLeave.onclick = () => {
  if (confirm('确定退出当前房间?')) leaveRoom();
};

// ---------- Socket 事件 ----------

socket.on('connect', () => console.log('connected', socket.id));
socket.on('disconnect', () => toast('已断开', '正在尝试重连…', 'error'));

// Phase 1: 账号系统
socket.on('account_info', (info) => {
  if (info && info.logged_in) {
    state.account = { logged_in: true, userId: info.userId, display_name: info.display_name };
  } else {
    state.account = { logged_in: false, userId: null, display_name: null };
  }
  renderLobby();
});
async function registerPassphrase(passphrase, displayName) {
  const r = await emit('register_passphrase', { passphrase, display_name: displayName });
  if (r?.error) return { error: r.error };
  setStoredToken(r.token);
  state.account = { logged_in: true, userId: r.userId, display_name: r.display_name };
  return { ok: true, display_name: r.display_name };
}
async function loginPassphrase(passphrase) {
  const r = await emit('login_passphrase', { passphrase });
  if (r?.error) return { error: r.error };
  setStoredToken(r.token);
  state.account = { logged_in: true, userId: r.userId, display_name: r.display_name };
  return { ok: true, display_name: r.display_name };
}
async function logoutAccount() {
  try { await emit('logout'); } catch (_) {}
  setStoredToken(null);
  state.account = { logged_in: false, userId: null, display_name: null };
  renderLobby();
}
socket.on('left_room', (data) => {
  // 服务器主动通知: 房间已清理, 客户端刷新回 lobby
  const reason = data?.reason || 'leave';
  if (reason === 'room_empty' || reason === 'no_humans') {
    toast('房间已关闭', '已无其他真人玩家, 房间清理', 'warn');
  }
  setTimeout(() => location.reload(), 600);
});
socket.on('room_list', (list) => {
  state.roomList = list || [];
  if (state.view === null || !document.getElementById('lobby-view').classList.contains('hidden')) {
    renderLobby();
  }
});
socket.on('chapters', (chs) => {
  state.chapters = chs;
  if (state.chapters.length > 0 && !state.selectedChapterId) {
    state.selectedChapterId = state.chapters[0].id;
    state.selectedClockId = state.chapters[0].clocks[0]?.id || null;
  }
  renderLobby();
});
socket.on('player_colors', (colors) => {
  state.playerColors = colors || PLAYER_COLORS;
  renderLobby();
});
socket.on('state_update', (msg) => {
  state.public = msg.public;
  state.myView = msg.view;
  state.view = msg.public.state;
  switch (msg.public.state) {
    case 'lobby': showView('waiting'); renderWaiting(); break;
    case 'rules_intro': showView('rules'); renderRules(); break;
    case 'ready': showView('ready'); renderReady(); break;
    case 'playing': showView('game'); renderGame(); break;
    case 'finished': showView('end'); renderEnd(); break;
  }
});

// ---------- 启动 ----------

showView('lobby');
renderLobby();

// ---------- 历史战绩 (Phase 3) ----------

async function showHistoryView() {
  if (!state.account.logged_in) {
    toast('请先登录', '登录后才能查看战绩', 'warn');
    return;
  }
  showView('history');
  document.getElementById('history-player-nick').textContent = state.account.display_name || '—';
  // 显示加载占位
  document.getElementById('history-squads').innerHTML = '<p class="muted">加载中…</p>';
  const r = await emit('get_my_history');
  if (r?.error) {
    document.getElementById('history-squads').innerHTML = `<p class="history-empty">${escapeHtml(r.error)}</p>`;
    return;
  }
  state.myHistory = r.attempts || [];
  state.myHistoryStats = r.stats || {};
  state.myHistorySquads = r.squads || [];
  renderHistoryView();
}
function renderHistoryView() {
  const stats = state.myHistoryStats || {};
  const total = stats.total || 0;
  const wins = stats.wins || 0;
  const losses = stats.losses || 0;
  const rate = stats.win_rate;
  const streak = stats.streak;
  document.getElementById('hist-total').textContent = total;
  document.getElementById('hist-wl').textContent = `${wins} / ${losses}`;
  document.getElementById('hist-rate').textContent = rate == null ? '—' : (Math.round(rate * 100) + '%');
  document.getElementById('hist-streak').textContent = streak == null || streak === 0
    ? '—'
    : (streak > 0 ? `胜 ${streak}` : `负 ${-streak}`);

  const wrap = document.getElementById('history-squads');
  if (total === 0) {
    wrap.innerHTML = '<p class="history-empty">还没有尝试记录。登录一局游戏就会出现在这里。</p>';
    return;
  }
  const squads = state.myHistorySquads || [];
  wrap.innerHTML = squads.map(sq => {
    const nicknames = sq.squad_nicknames.join('、');
    return `
      <div class="squad-block">
        <h3>小队: ${escapeHtml(nicknames)} <span class="muted">(${sq.squad.length} 人 · ${sq.total} 局 · ${sq.wins} 胜 ${sq.losses} 负)</span></h3>
        <ul class="attempt-list">
          ${sq.attempts.map(a => `
            <li class="attempt-row">
              <span class="attempt-badge ${a.result}">${a.result === 'won' ? '胜' : '负'}</span>
              <span class="chapter">${escapeHtml(a.chapter_name)} · ${escapeHtml(a.clock_name)}</span>
              <span class="muted">${a.turn_count} 回合 · ${a.duration_seconds}s</span>
              <span class="time">${formatTime(a.ended_at)}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }).join('');
}
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const _historyBack = document.getElementById('history-back');
if (_historyBack) _historyBack.onclick = () => { showView('lobby'); renderLobby(); };

// 终局时显示"已记录"提示 (仅登录玩家)
function maybeShowEndSaved() {
  const el = document.getElementById('end-saved');
  if (!el) return;
  // 有 squad 字段就显示 (有登录玩家时 server 才写 squad)
  const hasSquad = state.public?.players?.some(p => p.userId);
  if (state.account.logged_in && hasSquad) {
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// ---------- 账号面板 (登录 / 注册 / 状态) ----------

function renderAuthPanel() {
  const panel = document.getElementById('auth-panel');
  if (!panel) return;
  if (state.account.logged_in) {
    panel.innerHTML = `
      <h3>已登录</h3>
      <p class="auth-current">
        <span class="auth-name">${escapeHtml(state.account.display_name || '')}</span>
        <span class="muted small">${escapeHtml(state.account.userId || '')}</span>
      </p>
      <div class="actions">
        <button id="auth-logout-btn" class="ghost" type="button">登 出</button>
      </div>
    `;
    const btn = document.getElementById('auth-logout-btn');
    if (btn) btn.onclick = () => {
      if (confirm('确定登出？登出后"我的战绩"将无法查看（直到重新登录）。')) {
        logoutAccount();
      }
    };
  } else {
    const isLogin = state.authMode === 'login';
    panel.innerHTML = `
      <h3>${isLogin ? '登 录' : '注 册'}</h3>
      <div class="auth-tabs">
        <button class="auth-tab ${isLogin ? 'active' : ''}" data-mode="login" type="button">登录</button>
        <button class="auth-tab ${!isLogin ? 'active' : ''}" data-mode="register" type="button">注册</button>
      </div>
      <p class="muted small">${isLogin ? '用暗号登入, 朋友之间用同一个暗号就是同一个人' : '给自己起个暗号, 记住就能跨设备登入'}</p>
      <input id="auth-passphrase" type="password" placeholder="暗号 (≥6 字符)" maxlength="64" autocomplete="off" />
      ${!isLogin ? '<input id="auth-display-name" type="text" placeholder="显示名 (别人看到的名字)" maxlength="20" />' : ''}
      <div class="actions">
        <button id="auth-submit-btn" class="primary" type="button">${isLogin ? '登 录' : '注 册'}</button>
      </div>
    `;
    panel.querySelectorAll('.auth-tab').forEach(t => {
      t.onclick = () => {
        state.authMode = t.dataset.mode;
        renderAuthPanel();
        // 重新聚焦
        const f = document.getElementById('auth-passphrase');
        if (f) f.focus();
      };
    });
    const submit = document.getElementById('auth-submit-btn');
    if (submit) submit.onclick = async () => {
      const pp = document.getElementById('auth-passphrase').value;
      if (!pp || pp.length < 6) return toast('暗号至少 6 个字符', '', 'error');
      if (state.authMode === 'register') {
        const dn = document.getElementById('auth-display-name')?.value?.trim();
        if (!dn) return toast('请输入显示名', '', 'error');
        const r = await registerPassphrase(pp, dn);
        if (r?.error) return toast('注册失败', r.error, 'error');
        toast('注册成功', `欢迎, ${r.display_name}`, 'success');
        renderLobby();
      } else {
        const r = await loginPassphrase(pp);
        if (r?.error) return toast('登录失败', r.error, 'error');
        toast('已登录', r.display_name, 'success');
        renderLobby();
      }
    };
    // Enter 键提交
    panel.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit.click(); });
    });
  }
}
