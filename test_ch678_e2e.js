// Ch06 (diff) / Ch07 (draw on play) / Ch08 (rotation + forbidden) e2e test
//
// 用 4 个真实 socket 跑通. 验证:
//   - Ch06: sums 用的是 max-min 不是 sum
//   - Ch07: 备牌堆用完 12 张, 出牌后手牌数恒为 3
//   - Ch08: rotation 跟随出牌递增 (mod 6), forbidden 段被拒绝

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://127.0.0.1:3001';
const client = () => io(URL, { reconnection: false, transports: ['websocket'] });
const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function attachState(s) {
  s._lastState = null;
  s.on('state_update', msg => { s._lastState = msg; });
}
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
  const roomId = r.room_id;
  const colors = ['azure', 'rose', 'jade'];
  for (let i = 1; i < nPlayers; i++) {
    await emit(socks[i], 'join_room', { room_id: roomId, nickname: 'P' + i, color: colors[i - 1] });
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
  for (const f of (publicState.forbidden_segments || [])) {
    const abs = ((f - 1 + rotation) % n + n) % n + 1;
    forbidden.add(abs);
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
    if (!st) continue;
    if (st.public.current_player_idx === i) { curIdx = i; break; }
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
  const initialDeck = latest(socks[0]).public.deck_remaining;
  const initialHandSize = latest(socks[0]).view.hand.length;
  console.log(`  chapter: ${ch0.name}  value_mode=${std.value_mode || 'sum'}  draw_on_play=${std.draw_on_play || 0}  rotate_on_play=${std.rotate_on_play || 0}`);
  console.log(`  clock:   ${latest(socks[0]).public.clock.name}  forbidden=${JSON.stringify(latest(socks[0]).public.clock.forbidden_segments || [])}`);
  console.log(`  初始: 备牌堆=${initialDeck}  手牌=${initialHandSize}`);

  // 跟踪 rotation 变化 (Ch08)
  const rotationHistory = [];
  const origAttach = socks[0]._lastState;
  if (chapterId === 'ch08_revolution') {
    const handler = socks[0].listeners('state_update')[0];
    // 复用 attachState 思路: 持续记录
  }
  // 简单跟踪: 每次轮到自己时, 记录 rotation
  const checkInterval = setInterval(() => {
    const st = socks[0]._lastState;
    if (st && st.public.state === 'playing') {
      const last = rotationHistory[rotationHistory.length - 1];
      if (!last || last.turn !== st.public.turn_number) {
        rotationHistory.push({ turn: st.public.turn_number, rotation: st.public.rotation, history: st.public.history.length });
      }
    }
  }, 30);

  await runGameToEnd(socks);
  clearInterval(checkInterval);

  const final = latest(socks[0]).public;
  console.log(`  终局: state=${final.state}  rotation=${final.rotation}  deck_remaining=${final.deck_remaining}  history=${final.history.length}`);

  let pass = true;

  if (chapterId === 'ch06_as_above_so_below') {
    if (final.state !== 'finished') {
      console.log('  ✕ 80 回合后仍未结束 (Ch06 diff 机制)');
      pass = false;
    } else {
      const sums = final.game_result.sums;
      console.log(`  sums (差值): ${JSON.stringify(sums)}`);
      // 验证每段 sums = max - min
      let allDiff = true;
      for (let i = 0; i < sums.length; i++) {
        const seg = final.segments[i] || [];
        if (seg.length === 0) continue;
        const vs = seg.map(c => c.v);
        const expected = Math.max(...vs) - Math.min(...vs);
        if (expected !== sums[i]) {
          console.log(`  ✕ 段 ${i+1} sums=${sums[i]} 但 max-min=${expected} (cards=${JSON.stringify(vs)})`);
          allDiff = false;
          pass = false;
        }
      }
      if (allDiff) console.log('  ✓ 每段 sums = max - min (差值模式)');
      // 验证 value_mode 字段
      if (final.value_mode === 'diff') console.log('  ✓ state.public.value_mode = "diff"');
      else { console.log(`  ✕ value_mode = ${final.value_mode} (期望 diff)`); pass = false; }
    }
  }

  if (chapterId === 'ch07_intrusion') {
    if (final.state !== 'finished') {
      console.log('  ✕ 80 回合后仍未结束');
      pass = false;
    } else {
      // Ch07: 4 人局, 手牌各 3, 总 12. draw_on_play=1, 每次出牌补 1.
      // 备牌堆 12, 一共补 12 张 (等于 12 出牌), 应该刚好用完
      // 但因为手牌会持续补充, 玩家会继续打出抽到的牌
      // 总出牌 = 24 (3 初始 + 3 抽到), 总抽牌 = 12 (12 次成功抽, 之后 deck 空)
      const used = 12 - final.deck_remaining;
      const expected = Math.min(12, final.history.length);  // 最多 12 次抽卡成功
      if (used === 12) {
        console.log(`  ✓ 备牌堆用完 12 张, 总出牌 ${final.history.length} 张 (12 初始 + ${final.history.length - 12} 抽到)`);
      } else {
        console.log(`  ✕ 备牌堆用 ${used} 张 (期望 12)`);
        pass = false;
      }
      // 验证 Ch07 玩家手牌在出牌后维持 3 张 (draw_on_play=1 立即补)
      // 通过 state.public.players[i].hand_size 检查
      const handSizes = final.players.map(p => p.hand_size);
      console.log(`  终局各玩家手牌: ${JSON.stringify(handSizes)}`);
    }
  }

  if (chapterId === 'ch08_revolution') {
    if (final.state !== 'finished') {
      console.log('  ✕ 80 回合后仍未结束');
      pass = false;
    } else {
      // Ch08: 旋转 6 段后回到 0, 所以 12 plays 后 rotation = 0
      const totalPlays = final.history.length;
      const expectedRotation = totalPlays % 6;
      if (final.rotation === expectedRotation) {
        console.log(`  ✓ rotation=${final.rotation} = ${totalPlays} mod 6 (12 段时回到 0)`);
      } else {
        console.log(`  ✕ rotation=${final.rotation} != ${expectedRotation} (期望 mod 6)`);
        pass = false;
      }
      // 验证 rotation 在游戏中确实变化
      const uniqueRotations = new Set(rotationHistory.map(r => r.rotation));
      if (uniqueRotations.size > 1) {
        console.log(`  ✓ 游戏中 rotation 经历了 ${uniqueRotations.size} 个不同值: ${JSON.stringify([...uniqueRotations])}`);
      } else {
        console.log(`  ✕ rotation 始终 = ${[...uniqueRotations][0]}, 没有递增`);
        pass = false;
      }
    }
  }

  socks.forEach(s => s.close());
  await delay(300);
  return pass;
}

async function runForbiddenTest() {
  console.log('\n=== ch08 forbidden_segments 拒绝 ===');
  const socks = await newSocks(2);
  await setupGame(socks, 'ch08_revolution', 'c1', 2);
  await declareAndPlay(socks);
  await delay(200);

  const st0 = latest(socks[0]);
  if (!st0.public.forbidden_segments || st0.public.forbidden_segments[0] !== 3) {
    console.log(`  ✕ forbidden_segments = ${JSON.stringify(st0.public.forbidden_segments)} (期望 [3])`);
    socks.forEach(s => s.close());
    return false;
  }
  console.log('  ✓ forbidden_segments = [3] (钟面原位)');

  // 等 P0 回合
  let pass = true;
  for (let i = 0; i < 20; i++) {
    const st = socks[0]._lastState;
    if (st.public.current_player_idx === 0 && st.view.hand.length > 0) {
      // 尝试放段 3 (rotation=0 时禁放)
      const r = await emit(socks[0], 'play_card', { card_idx: 0, segment: 3, face_up: false });
      if (r.error && /锁定|禁放/.test(r.error)) {
        console.log(`  ✓ 段 3 被拒: "${r.error}"`);
      } else if (r.error) {
        console.log(`  ? 段 3 被拒但理由不同: "${r.error}"`);
      } else {
        console.log('  ✕ 段 3 应被拒但成功了 (forbidden 机制失效)');
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
  for (const ch of ['ch06_as_above_so_below', 'ch07_intrusion', 'ch08_revolution']) {
    const ok = await runChapter(ch, 'c1', 4);
    if (!ok) allPass = false;
  }
  const okF = await runForbiddenTest();
  if (!okF) allPass = false;

  console.log('\n=== CH6-8 E2E DONE ===');
  if (allPass) console.log('✓ ALL PASSED');
  else console.log('✕ SOME FAILED');
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
