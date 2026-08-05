// test_change_level.js — Phase 4: 终局后房主选其他关卡 (整个 squad 一起换)
//
// Coverage:
//   1. Host emits change_level after finished → room state = 'lobby', new chapter/clock
//   2. All players stay in room (squad preserved)
//   3. Both players get state_update, public.chapter/clock changed
//   4. After change_level, host can start new game (rules_intro)
//   5. Non-host cannot change_level → rejected
//   6. change_level in non-finished state (lobby/playing) → rejected
//   7. New chapter/clock affects validator (different chapter has different validators)
//   8. Player hands/segments/history all reset

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://127.0.0.1:3001';
const RUN_TAG = '_r' + Date.now().toString(36);
const PP = (s) => s + RUN_TAG;
const client = (token) => io(URL, { reconnection: false, transports: ['websocket'], auth: token ? { token } : {} });
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function attachState(s) { s._lastState = null; s.on('state_update', msg => { s._lastState = msg; }); }
const latest = (s) => s._lastState;
async function waitState(s, predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (s._lastState && predicate(s._lastState)) return s._lastState;
    await delay(50);
  }
  throw new Error(`waitState timeout: last=${s._lastState?.public?.state}`);
}
async function newSocks(n) {
  const socks = [];
  for (let i = 0; i < n; i++) {
    const s = client();
    socks.push(s);
    await new Promise(r => s.on('connect', r));
    attachState(s);
  }
  return socks;
}

let passed = 0;
let failed = 0;
function check(label, cond = true, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✕ ${label} ${extra}`); failed++; }
}

async function playToEnd(socks, maxTurns = 80) {
  for (let t = 0; t < maxTurns; t++) {
    const st = latest(socks[0]);
    if (!st) { await delay(100); continue; }
    if (st.public.state === 'finished') return;
    if (st.public.state !== 'playing') { await delay(100); continue; }
    const prevTurn = st.public.turn_number;
    const curIdx = st.public.current_player_idx;
    const curSockState = socks[curIdx]?._lastState;
    if (!curSockState || !curSockState.view || !curSockState.view.hand || curSockState.view.hand.length === 0) {
      return;  // 没法再出牌了
    }
    const played = await playOneFromState(socks, curIdx, curSockState);
    if (!played) return;
    // 等 turn_number 真的增加 (server 广播的 state_update 到了)
    try {
      await waitState(socks[0], m => m.public.state === 'finished' || m.public.turn_number > prevTurn, 3000);
    } catch (e) {
      return;  // 超时 (可能没卡能出了)
    }
  }
}
// 改用传进来的 state (避免 _lastState 在调用瞬间被覆盖)
async function playOneFromState(socks, curIdx, sockState) {
  if (!sockState || !sockState.view || !sockState.view.hand || sockState.view.hand.length === 0) return false;
  let bestIdx = 0;
  for (let i = 1; i < sockState.view.hand.length; i++) {
    if (sockState.view.hand[i].v < sockState.view.hand[bestIdx].v) bestIdx = i;
  }
  const segs = sockState.public.segments;
  let targetSeg = 1, minCount = Infinity;
  for (let s = 1; s <= 6; s++) {
    const c = (segs[s - 1] || []).length;
    if (c < minCount) { minCount = c; targetSeg = s; }
  }
  const r = await emit(socks[curIdx], 'play_card', { card_idx: bestIdx, segment: targetSeg, face_up: false });
  if (r?.error) return false;  // 出牌失败, 让 playToEnd 退出
  return true;
}

async function test1HostChangeLevel() {
  console.log('\n=== Test 1: host change_level after finished → squad stays, chapter/clock change ===');
  const socks = await newSocks(2);
  // 创房 + 进房 + 开局 + 玩到底
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostA', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  if (cr?.error) { console.log(`  ✕ setup: ${cr.error}`); failed++; socks.forEach(s => s.close()); return; }
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestA' });
  await emit(socks[0], 'start_game');
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  await waitState(socks[0], m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  await waitState(socks[0], m => m.public.state === 'playing');
  await playToEnd(socks);
  if (latest(socks[0]).public.state !== 'finished') {
    console.log('  ✕ game did not finish'); failed++; socks.forEach(s => s.close()); return;
  }
  check('game finished on c1');

  // 房主换关: c1 → c2 (同章节下一关)
  const r = await emit(socks[0], 'change_level', { chapter_id: 'ch01_awakening', clock_id: 'c2' });
  check('change_level ok', r?.ok === true, `(${r?.error})`);

  // 等 state_update
  await waitState(socks[0], m => m.public.state === 'lobby' && m.public.clock.id === 'c2');
  const st0 = latest(socks[0]);
  const st1 = latest(socks[1]);
  check('P0 sees state=lobby', st0.public.state === 'lobby');
  check('P0 sees new clock c2', st0.public.clock?.id === 'c2');
  check('P1 also sees state=lobby', st1.public.state === 'lobby');
  check('P1 also sees new clock c2', st1.public.clock?.id === 'c2');
  check('P0 still in room (2 players)', st0.public.players.length === 2);
  check('P1 still in room (2 players)', st1.public.players.length === 2);
  check('P0 still host (idx 0)', st0.public.players[0].is_host === true);
  check('P0 ready=false (reset)', st0.public.players[0].ready === false);
  check('hand reset to empty', Array.isArray(st0.view?.hand) && st0.view.hand.length === 0);
  check('segments reset empty', st0.public.segments.every(s => s.length === 0));
  check('history reset', st0.public.history.length === 0);
  check('game_result null', st0.public.game_result === null);
  socks.forEach(s => s.close());
}

async function test2NonHostRejected() {
  console.log('\n=== Test 2: non-host change_level → rejected ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostB', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestB' });
  await emit(socks[0], 'start_game');
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  await waitState(socks[0], m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  await waitState(socks[0], m => m.public.state === 'playing');
  await playToEnd(socks);

  // P1 (非房主) 试 change_level
  const r = await emit(socks[1], 'change_level', { chapter_id: 'ch01_awakening', clock_id: 'c2' });
  check('non-host rejected', r?.error && /房主/.test(r.error), `(${r?.error})`);
  socks.forEach(s => s.close());
}

async function test3ChangeLevelInLobbyRejected() {
  console.log('\n=== Test 3: change_level in lobby state → rejected ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostC', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestC' });
  // 没开局, 房主在 lobby 状态
  const r = await emit(socks[0], 'change_level', { chapter_id: 'ch01_awakening', clock_id: 'c2' });
  check('change_level in lobby rejected', r?.error && /未结束/.test(r.error), `(${r?.error})`);
  socks.forEach(s => s.close());
}

async function test4ChangeLevelInPlayingRejected() {
  console.log('\n=== Test 4: change_level in playing state → rejected ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostD', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestD' });
  await emit(socks[0], 'start_game');
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  await waitState(socks[0], m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  await waitState(socks[0], m => m.public.state === 'playing');
  // 正在玩, 房主试 change_level
  const r = await emit(socks[0], 'change_level', { chapter_id: 'ch01_awakening', clock_id: 'c2' });
  check('change_level in playing rejected', r?.error && /未结束/.test(r.error), `(${r?.error})`);
  socks.forEach(s => s.close());
}

async function test5ChangeChapter() {
  console.log('\n=== Test 5: change_level can switch chapter (ch01 → ch02) ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostE', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestE' });
  await emit(socks[0], 'start_game');
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  await waitState(socks[0], m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  await waitState(socks[0], m => m.public.state === 'playing');
  await playToEnd(socks);

  // 切到 ch02_limitation c1
  const r = await emit(socks[0], 'change_level', { chapter_id: 'ch02_limitation', clock_id: 'c1' });
  check('change chapter ok', r?.ok === true, `(${r?.error})`);
  await waitState(socks[0], m => m.public.chapter?.id === 'ch02_limitation');
  const st = latest(socks[0]);
  check('new chapter ch02_limitation', st.public.chapter.id === 'ch02_limitation');
  check('no_faceup_plays applied (ch02 rule)', st.public.chapter.no_faceup_plays === true);
  check('face_up_remaining reset to 0', st.public.face_up_remaining === 0);
  socks.forEach(s => s.close());
}

async function test6InvalidChapter() {
  console.log('\n=== Test 6: change_level with invalid chapter → rejected ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostF', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestF' });
  await emit(socks[0], 'start_game');
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  await waitState(socks[0], m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  await waitState(socks[0], m => m.public.state === 'playing');
  await playToEnd(socks);

  const r = await emit(socks[0], 'change_level', { chapter_id: 'ch99_nonexistent', clock_id: 'c1' });
  check('invalid chapter rejected', r?.error && /章节/.test(r.error), `(${r?.error})`);
  socks.forEach(s => s.close());
}

async function test7CanStartNewGameAfterChange() {
  console.log('\n=== Test 7: after change_level, host can start new game (rules_intro) ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'HostG', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'GuestG' });
  await emit(socks[0], 'start_game');
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  await waitState(socks[0], m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  await waitState(socks[0], m => m.public.state === 'playing');
  await playToEnd(socks);

  // 换关 c1 → c2
  await emit(socks[0], 'change_level', { chapter_id: 'ch01_awakening', clock_id: 'c2' });
  await waitState(socks[0], m => m.public.state === 'lobby' && m.public.clock.id === 'c2');
  // 房主开新局
  const r = await emit(socks[0], 'start_game');
  check('start_game after change ok', !r?.error, `(${r?.error})`);
  await waitState(socks[0], m => m.public.state === 'rules_intro');
  const st = latest(socks[0]);
  check('new game uses c2', st.public.clock.id === 'c2');
  check('hand dealt (6 cards for 2P)', st.view?.hand?.length === 6);
  socks.forEach(s => s.close());
}

(async () => {
  for (const fn of [
    test1HostChangeLevel, test2NonHostRejected, test3ChangeLevelInLobbyRejected,
    test4ChangeLevelInPlayingRejected, test5ChangeChapter, test6InvalidChapter,
    test7CanStartNewGameAfterChange,
  ]) {
    try { await fn(); } catch (e) { console.log(`  ✕ EXCEPTION: ${e.message}`); failed++; }
    await delay(500);
  }
  console.log(`\n=== CHANGE_LEVEL E2E DONE ===`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
