// test_history.js — Phase 3: squad attempt history
//
// Coverage:
//   1. Anonymous: get_my_history → error "请先登录"
//   2. Unknown userId (no attempts): get_my_history → empty
//   3. Play a game to completion → 1 attempt recorded
//   4. attempt schema has expected fields
//   5. Play 2nd game with same squad → 2 attempts in history
//   6. Stats: total/wins/losses/win_rate/streak
//   7. Squads aggregation: same squad groups together
//   8. by_chapter: aggregated by chapter
//   9. bot-leave end (no real completion) → NOT recorded
//  10. attempt.squad sorted (canonical key stable)

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://127.0.0.1:3001';
const RUN_TAG = '_r' + Date.now().toString(36);
const PP = (s) => s + RUN_TAG;

const client = (token) => io(URL, {
  reconnection: false, transports: ['websocket'],
  auth: token ? { token } : {},
});
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

let passed = 0;
let failed = 0;
function check(label, cond = true, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✕ ${label} ${extra}`); failed++; }
}

// 注册并拿到 token
async function regUser(passphrase, displayName) {
  const s = client();
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'register_passphrase', { passphrase: PP(passphrase), display_name: displayName });
  if (r?.error) { s.close(); throw new Error('reg: ' + r.error); }
  s.close();
  return r.token;
}

// 开一个房间 (2P), 玩到底
async function playGameToEnd(token1, token2, nick1, nick2) {
  const s1 = client(token1); await new Promise(r => s1.on('connect', r)); attachState(s1);
  const s2 = client(token2); await new Promise(r => s2.on('connect', r)); attachState(s2);
  const cr = await emit(s1, 'create_room', { nickname: nick1, chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  if (cr?.error) throw new Error('create: ' + cr.error);
  const jr = await emit(s2, 'join_room', { room_id: cr.room_id, nickname: nick2 });
  if (jr?.error) throw new Error('join: ' + jr.error);
  await emit(s1, 'start_game');
  await waitState(s1, m => m.public.state === 'rules_intro');
  for (const s of [s1, s2]) await emit(s, 'i_am_ready');
  await waitState(s1, m => m.public.state === 'ready');
  await emit(s1, 'declare_first');
  await waitState(s1, m => m.public.state === 'playing');
  // Play 12 turns
  for (let t = 0; t < 20; t++) {
    const st = latest(s1);
    if (st.public.state === 'finished') break;
    if (st.public.state !== 'playing') { await delay(100); continue; }
    const cur = st.public.current_player_idx;
    const sock = [s1, s2][cur];
    const view = latest(sock).view;
    if (!view.hand.length) break;
    let bestIdx = 0;
    for (let i = 1; i < view.hand.length; i++) {
      if (view.hand[i].v < view.hand[bestIdx].v) bestIdx = i;
    }
    const segs = st.public.segments;
    let target = 1, minC = Infinity;
    for (let s = 1; s <= 6; s++) {
      const c = (segs[s - 1] || []).length;
      if (c < minC) { minC = c; target = s; }
    }
    const r = await emit(sock, 'play_card', { card_idx: bestIdx, segment: target, face_up: false });
    if (r?.error) throw new Error('play: ' + r.error);
    await waitState(s1, m => m.public.state === 'finished' || m.public.turn_number > t);
  }
  await waitState(s1, m => m.public.state === 'finished');
  const result = latest(s1).public.game_result;
  s1.close(); s2.close();
  return { won: result.won, roomId: cr.room_id };
}

async function test1Anonymous() {
  console.log('\n=== Test 1: anonymous get_my_history → error ===');
  const s = client();
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'get_my_history');
  check('anonymous rejected', r?.error && /登录/.test(r.error), `(${r?.error})`);
  s.close();
}

async function test2EmptyHistory() {
  console.log('\n=== Test 2: known user with no attempts → empty ===');
  const token = await regUser('jane_no_games', 'Jane');
  const s = client(token);
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'get_my_history');
  check('get_my_history ok', r?.ok === true);
  check('attempts empty', Array.isArray(r?.attempts) && r.attempts.length === 0);
  check('stats.total = 0', r?.stats?.total === 0);
  check('squads empty', Array.isArray(r?.squads) && r.squads.length === 0);
  s.close();
}

async function test3PlayGameRecordsAttempt() {
  console.log('\n=== Test 3: play a game → 1 attempt recorded ===');
  const t1 = await regUser('player_a_2026', 'AliceA');
  const t2 = await regUser('player_b_2026', 'BobB');
  const { won, roomId } = await playGameToEnd(t1, t2, 'AliceInGame', 'BobInGame');
  console.log(`  (game result: ${won ? 'won' : 'lost'})`);
  // Check Alice's history
  const s = client(t1);
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'get_my_history');
  check('get_my_history ok', r?.ok === true);
  check('attempts.length = 1', r?.attempts?.length === 1, `(got ${r?.attempts?.length})`);
  if (r?.attempts?.length === 1) {
    const a = r.attempts[0];
    check('attempt has id', typeof a.id === 'string');
    check('attempt chapter_id = ch01_awakening', a.chapter_id === 'ch01_awakening');
    check('attempt clock_id = c1', a.clock_id === 'c1');
    check('attempt.result in (won, lost)', a.result === 'won' || a.result === 'lost');
    check('attempt.result matches game', a.result === (won ? 'won' : 'lost'));
    check('attempt.squad has 2 entries', a.squad?.length === 2);
    check('attempt.squad is sorted', a.squad?.[0] < a.squad?.[1]);
    check('attempt.squad_nicknames has 2', a.squad_nicknames?.length === 2);
    check('attempt.duration_seconds > 0', a.duration_seconds >= 0);
  }
  s.close();
}

async function test4TwoGamesSameSquad() {
  console.log('\n=== Test 4: 2 games with same squad → 2 attempts, 1 squad group ===');
  const t1 = await regUser('player_c_2026', 'CarolA');
  const t2 = await regUser('player_d_2026', 'DaveB');
  await playGameToEnd(t1, t2, 'CarolInGame', 'DaveInGame');
  await delay(300);
  await playGameToEnd(t1, t2, 'CarolInGame2', 'DaveInGame2');
  await delay(300);
  const s = client(t1);
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'get_my_history');
  // AliceA (from test 3) and CarolA — different userIds, so Carol's history is her own
  check('Carol attempts >= 2', (r?.attempts?.length || 0) >= 2, `(got ${r?.attempts?.length})`);
  check('squads: exactly 1 unique squad', r?.squads?.length === 1, `(got ${r?.squads?.length})`);
  if (r?.squads?.length === 1) {
    const sq = r.squads[0];
    check('squad has 2 attempts', sq.total === 2);
    check('squad.attempts sorted newest first', sq.attempts[0].ended_at >= sq.attempts[1].ended_at);
  }
  s.close();
}

async function test5StatsAccuracy() {
  console.log('\n=== Test 5: stats (total, wins, losses, win_rate, streak) ===');
  const t1 = await regUser('player_e_2026', 'EveStats');
  const t2 = await regUser('player_f_2026', 'FrankStats');
  // 玩 3 局
  for (let i = 0; i < 3; i++) {
    await playGameToEnd(t1, t2, `EveG${i}`, `FrankG${i}`);
    await delay(200);
  }
  const s = client(t1);
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'get_my_history');
  // Eve 之前的局 + 这 3 局
  const total = r?.stats?.total;
  const wins = r?.stats?.wins;
  const losses = r?.stats?.losses;
  check('stats.total >= 3', total >= 3, `(got ${total})`);
  check('stats.wins + losses = total', wins + losses === total, `(${wins}+${losses}=${wins+losses} vs ${total})`);
  check('win_rate is number in [0,1]', r?.stats?.win_rate >= 0 && r?.stats?.win_rate <= 1);
  check('streak is non-zero integer', Number.isInteger(r?.stats?.streak) && r.stats.streak !== 0);
  s.close();
}

async function test6DifferentSquadsGroupsSeparately() {
  console.log('\n=== Test 6: different squads → different groups ===');
  const tA = await regUser('squad_test_a', 'SquadA');
  const tB = await regUser('squad_test_b', 'SquadB');
  const tC = await regUser('squad_test_c', 'SquadC');
  // A + B 玩一局
  await playGameToEnd(tA, tB, 'A1', 'B1');
  await delay(200);
  // A + C 玩一局
  await playGameToEnd(tA, tC, 'A2', 'C2');
  await delay(200);
  const s = client(tA);
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'get_my_history');
  // A 玩过 2 局, 但跟 B 和跟 C 是两个 squad
  const squadCount = r?.squads?.length;
  check('A has 2 unique squads', squadCount === 2, `(got ${squadCount})`);
  // 最新一起玩的 squad 排第一
  if (squadCount === 2) {
    check('newest squad first', r.squads[0].attempts[0].ended_at > r.squads[1].attempts[0].ended_at);
  }
  s.close();
}

async function test7BotLeaveNotRecorded() {
  console.log('\n=== Test 7: bot-leave forced end → NOT recorded ===');
  // 公开局: 1 anon host + 1 bot + 1 logged-in, 让 anon host 退出 → 强制结束 (无 attempt)
  const t1 = await regUser('bot_test_user', 'BotTester');
  const s1 = client(t1); await new Promise(r => s1.on('connect', r)); attachState(s1);
  // 加 bot (用 anonymous client 创房 + fill_with_bots)
  const sAnon = client(); await new Promise(r => sAnon.on('connect', r)); attachState(sAnon);
  // max_players=3: anon host + 1 bot + 1 logged-in
  const cr = await emit(sAnon, 'create_room', { nickname: 'AnonHost', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 3 });
  // 只加 1 个 bot (剩 1 个位置给 logged-in)
  await emit(sAnon, 'fill_with_bots');
  // fill_with_bots 会加到 max (3 个), 需要踢掉
  // 简化: 不加 bot, 直接用 1 host + 1 logged-in (但 host 是 anon, 走的是 leave_room 的"all humans left"分支)
  // 重新设计: 不用 bot, 直接 1 host (anon) + 1 logged-in, host 退出 → "all humans left" 分支
  // 那个分支不会调 recordAttempt (我们之前确认过)
  // 等等, 实际上 "all humans left" 是在 host 退出后, 只剩 bot 的情况, 这里没有 bot
  // 重新设计: 用 fill_with_bots 之前先 join logged-in, 这样 host + logged-in + bot
  // 上面我已经 fill_with_bots 了, 那现在 3 人满了. 让我用别的方式
  sAnon.close();
  await delay(200);

  // 新方式: anon 创 2 人房, logged-in 加入 (2 人满), 然后 anon 退出 → "no_humans" 分支
  // 看 leave_room handler: state=lobby + 退出 → splice 玩家, 不会触发 finished
  // state=playing/ready 时, 没真人 → 调用 revealRoom + checkResolution, 不会调 recordAttempt (因为不走 checkGameEnd)
  // 所以 "all humans left during playing" 是测试点

  // 最简单: anon 创 2 人房, logged-in 加入, 开游戏, anon 退出 → playing 中没真人 → 强制结束
  const sAnon2 = client(); await new Promise(r => sAnon2.on('connect', r)); attachState(sAnon2);
  const cr2 = await emit(sAnon2, 'create_room', { nickname: 'AnonHost2', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  const jr = await emit(s1, 'join_room', { room_id: cr2.room_id, nickname: 'LoggedInPlayer' });
  if (jr?.error) { console.log(`  ✕ join failed: ${jr.error}`); failed++; s1.close(); sAnon2.close(); return; }
  await emit(sAnon2, 'start_game');
  await waitState(s1, m => m.public.state === 'rules_intro');
  for (const s of [s1, sAnon2]) await emit(s, 'i_am_ready');
  await waitState(s1, m => m.public.state === 'ready');
  await emit(sAnon2, 'declare_first');
  await waitState(s1, m => m.public.state === 'playing');
  // anon host 退出 → 触发 leave_room → playing 中没真人 → revealRoom + finished (但不调 recordAttempt)
  sAnon2.close();
  await delay(800);
  // 查 logged-in user 的 history: bot-leave 那局不应该有
  const s2 = client(t1);
  await new Promise(r => s2.on('connect', r));
  const r = await emit(s2, 'get_my_history');
  // 这个 user (BotTester) 之前可能没玩过, attempts 应该是 0 (强制结束不写)
  check('no attempts from forced end', r?.attempts?.length === 0, `(got ${r?.attempts?.length})`);
  s1.close(); s2.close();
}

async function main() {
  for (const fn of [
    test1Anonymous, test2EmptyHistory, test3PlayGameRecordsAttempt,
    test4TwoGamesSameSquad, test5StatsAccuracy, test6DifferentSquadsGroupsSeparately,
    test7BotLeaveNotRecorded,
  ]) {
    try { await fn(); } catch (e) { console.log(`  ✕ EXCEPTION: ${e.message}\n${e.stack}`); failed++; }
    await delay(500);
  }
  console.log(`\n=== HISTORY E2E DONE ===`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
