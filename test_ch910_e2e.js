// Ch09 (Unity - 段值全相同 + max-min ≤ 4) / Ch10 (Cohesiveness - 秒针 + 段首张卡递增) e2e test

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://127.0.0.1:3001';
const client = () => io(URL, { reconnection: false, transports: ['websocket'] });
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function attachState(s) { s._lastState = null; s.on('state_update', msg => { s._lastState = msg; }); }
const latest = (s) => s._lastState;
async function waitState(s, predicate, timeoutMs = 5000) {
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
async function setupGame(socks, chapterId, clockId, nPlayers) {
  const r = await emit(socks[0], 'create_room', {
    nickname: 'P0', chapter_id: chapterId, clock_id: clockId, max_players: nPlayers, color: 'gold',
  });
  if (r?.error) throw new Error('create_room: ' + r.error);
  const colors = ['azure', 'rose', 'jade'];
  for (let i = 1; i < nPlayers; i++) {
    await emit(socks[i], 'join_room', { room_id: r.room_id, nickname: 'P' + i, color: colors[i - 1] });
  }
  await emit(socks[0], 'start_game');
  for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
}
async function declareAndPlay(socks) {
  for (const s of socks) await emit(s, 'i_am_ready');
  for (const s of socks) await waitState(s, m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  for (const s of socks) await waitState(s, m => m.public.state === 'playing');
}

function pickSegment(publicState) {
  const rotation = publicState.rotation || 0;
  const n = publicState.chapter.n_segments || 6;
  const forbidden = new Set();
  // Ch08 forbidden
  for (const f of (publicState.forbidden_segments || [])) {
    const abs = ((f - 1 + rotation) % n + n) % n + 1;
    forbidden.add(abs);
  }
  // Ch10 second hand
  if (publicState.second_hand != null) {
    forbidden.add(publicState.second_hand);
    forbidden.add(((publicState.second_hand - 1 + 3) % n) + 1);
  }
  let best = 1;
  let minCount = Infinity;
  for (let s = 1; s <= n; s++) {
    if (forbidden.has(s)) continue;
    const cnt = (publicState.segments[s - 1] || []).length;
    if (cnt < minCount) { minCount = cnt; best = s; }
  }
  return best;
}

async function playOne(socks) {
  let curIdx = -1;
  for (let i = 0; i < socks.length; i++) {
    const st = socks[i]._lastState;
    if (st && st.public.current_player_idx === i) { curIdx = i; break; }
  }
  if (curIdx === -1) return false;
  const st = socks[curIdx]._lastState;
  if (!st || !st.view || !st.view.hand || st.view.hand.length === 0) return false;
  let bestIdx = 0;
  for (let i = 1; i < st.view.hand.length; i++) {
    if (st.view.hand[i].v < st.view.hand[bestIdx].v) bestIdx = i;
  }
  const seg = pickSegment(st.public);
  await emit(socks[curIdx], 'play_card', { card_idx: bestIdx, segment: seg, face_up: false });
  return true;
}

async function runGameToEnd(socks, maxTurns = 80) {
  for (let t = 0; t < maxTurns; t++) {
    const st = socks[0]._lastState;
    if (!st) { await delay(100); continue; }
    if (st.public.state === 'finished') return;
    if (st.public.state !== 'playing') { await delay(100); continue; }
    const played = await playOne(socks);
    if (!played) await delay(100);
    else await delay(60);
  }
}

async function runChapter(chapterId, clockId = 'c1', nPlayers = 4) {
  console.log(`\n=== ${chapterId} (${clockId}, ${nPlayers}P) ===`);
  const socks = await newSocks(nPlayers);
  await setupGame(socks, chapterId, clockId, nPlayers);
  await declareAndPlay(socks);

  const ch0 = latest(socks[0]).public.chapter;
  const std = ch0.standard_rules;
  console.log(`  chapter: ${ch0.name}  adjacent_eq=${!!std.adjacent_segments_equal}  max_min_diff=${std.overall_max_min_diff}  second_hand=${!!std.second_hand}  asc_first=${!!std.adjacent_strict_ascending_first}`);

  // 跟踪 second hand 旋转 (Ch10)
  const secondHandHistory = [];
  const checkInterval = setInterval(() => {
    const st = socks[0]._lastState;
    if (st && st.public.state === 'playing') {
      const last = secondHandHistory[secondHandHistory.length - 1];
      if (!last || last.turn !== st.public.turn_number) {
        secondHandHistory.push({ turn: st.public.turn_number, sh: st.public.second_hand, history: st.public.history.length });
      }
    }
  }, 30);

  await runGameToEnd(socks);
  clearInterval(checkInterval);

  const final = latest(socks[0]).public;
  console.log(`  终局: state=${final.state}  second_hand=${final.second_hand}  history=${final.history.length}`);

  let pass = true;

  if (chapterId === 'ch09_unity') {
    if (final.state !== 'finished') {
      console.log('  ✕ 80 回合后仍未结束');
      pass = false;
    } else {
      // 验证 detail 中有 "相邻段值相等" 和 "整体差值 ≤ 4"
      const detail = final.game_result.detail;
      const eqRule = detail.find(d => d.name === '相邻段值相等');
      const rangeRule = detail.find(d => d.name.startsWith('整体差值'));
      if (eqRule) console.log(`  ✓ 章节级规则 "相邻段值相等" 在 detail 中, actual=${eqRule.actual}`);
      else { console.log('  ✕ 章节级规则 "相邻段值相等" 缺失'); pass = false; }
      if (rangeRule) console.log(`  ✓ 章节级规则 "${rangeRule.name}" 在 detail 中, actual=${rangeRule.actual}`);
      else { console.log('  ✕ 章节级规则 "整体差值" 缺失'); pass = false; }
    }
  }

  if (chapterId === 'ch10_cohesiveness') {
    if (final.state !== 'finished') {
      console.log('  ✕ 80 回合后仍未结束');
      pass = false;
    } else {
      // 验证 second_hand 字段暴露
      if (final.second_hand != null) console.log(`  ✓ second_hand 暴露: ${final.second_hand}`);
      else { console.log('  ✕ second_hand 未暴露'); pass = false; }

      // 验证秒针在游戏中确实变化
      const uniqueSh = new Set(secondHandHistory.map(r => r.sh));
      if (uniqueSh.size > 1) {
        console.log(`  ✓ 游戏中秒针经历了 ${uniqueSh.size} 个不同位置: ${JSON.stringify([...uniqueSh])}`);
      } else {
        console.log(`  ✕ 秒针始终 = ${[...uniqueSh][0]}, 没有递增`);
        pass = false;
      }

      // 验证章节级 "每段首张卡递增" 规则在 detail 中
      const detail = final.game_result.detail;
      const ascRule = detail.find(d => d.name.includes('首张卡'));
      if (ascRule) console.log(`  ✓ 章节级规则 "${ascRule.name}" 在 detail 中, actual=${ascRule.actual}`);
      else { console.log('  ✕ 章节级规则 "每段首张卡递增" 缺失'); pass = false; }
    }
  }

  socks.forEach(s => s.close());
  await delay(300);
  return pass;
}

async function runSecondHandRejectTest() {
  console.log('\n=== ch10 second_hand 拒绝 ===');
  const socks = await newSocks(2);
  await setupGame(socks, 'ch10_cohesiveness', 'c1', 2);
  await declareAndPlay(socks);
  await delay(200);

  const st0 = latest(socks[0]);
  if (st0.public.second_hand == null) {
    console.log('  ✕ second_hand 未初始化');
    socks.forEach(s => s.close());
    return false;
  }
  const sh = st0.public.second_hand;
  const n = st0.public.chapter.n_segments;
  const opp = ((sh - 1 + 3) % n) + 1;
  console.log(`  ✓ 初始 second_hand = ${sh}, 对向段 = ${opp}`);

  let pass = true;
  for (let i = 0; i < 20; i++) {
    const st = socks[0]._lastState;
    if (st.public.current_player_idx === 0 && st.view.hand.length > 0) {
      // 尝试放在秒针指段, 应被拒
      const r = await emit(socks[0], 'play_card', { card_idx: 0, segment: sh, face_up: false });
      if (r.error && /秒针/.test(r.error)) {
        console.log(`  ✓ 秒针段 ${sh} 被拒: "${r.error}"`);
      } else if (r.error) {
        console.log(`  ? 秒针段被拒但理由不同: "${r.error}"`);
      } else {
        console.log('  ✕ 秒针段应被拒但成功了 (秒针机制失效)');
        pass = false;
      }
      break;
    }
    await delay(80);
  }
  socks.forEach(s => s.close());
  return pass;
}

(async () => {
  let allPass = true;
  for (const ch of ['ch09_unity', 'ch10_cohesiveness']) {
    const ok = await runChapter(ch, 'c1', 4);
    if (!ok) allPass = false;
  }
  const okR = await runSecondHandRejectTest();
  if (!okR) allPass = false;

  console.log('\n=== CH9-10 E2E DONE ===');
  if (allPass) console.log('✓ ALL PASSED');
  else console.log('✕ SOME FAILED');
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
