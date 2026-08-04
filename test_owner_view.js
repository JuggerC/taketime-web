// 验证 "出牌人自己看自己出的牌正脸, 其他人看不到" 的规则
// 端到端: 4 个 socket 玩一局, 出 1 张牌后比对每个玩家收到的 segments 数据

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

(async () => {
  let allPass = true;

  // Test 1: Ch01 (有明牌机制, 但默认 face-down 出的牌) — owner 看到自己牌有 v
  console.log('\n=== Test 1: ch01 owner view ===');
  {
    const socks = await newSocks(4);
    const r = await emit(socks[0], 'create_room', {
      nickname: 'P0', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 4, color: 'gold',
    });
    if (r?.error) throw new Error(r.error);
    const colors = ['azure', 'rose', 'jade'];
    for (let i = 1; i < 4; i++) {
      await emit(socks[i], 'join_room', { room_id: r.room_id, nickname: 'P' + i, color: colors[i - 1] });
    }
    await emit(socks[0], 'start_game');
    for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
    for (const s of socks) await emit(s, 'i_am_ready');
    for (const s of socks) await waitState(s, m => m.public.state === 'ready');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');

    // P0 出一张牌, 默认 face-up = false (盖牌)
    const hand0 = latest(socks[0]).view.hand;
    const card0 = hand0[0];
    await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: false });
    await delay(300);

    // 4 个玩家都收到 state 后, 检查 seg 1
    const segByPlayer = socks.map(s => {
      const seg = latest(s).public.segments[0] || [];
      return seg[0] || null;  // 第一张牌
    });
    for (let i = 0; i < 4; i++) {
      const c = segByPlayer[i];
      if (i === 0) {
        // P0 是出牌人: 应该看到 v
        if (!c || c.v !== card0.v) {
          console.log(`  ✕ P0 (出牌人) 应该看到自己出牌 v=${card0.v}, 实际 c.v=${c?.v}`);
          allPass = false;
        } else {
          console.log(`  ✓ P0 (出牌人) 看到自己出牌 v=${c.v} (face_up=${c.face_up})`);
        }
      } else {
        // P1/P2/P3 不是出牌人: 不应该看到 v
        if (c && c.v !== undefined) {
          console.log(`  ✕ P${i} (非出牌人) 不应看到 v, 实际 c.v=${c.v}`);
          allPass = false;
        } else {
          console.log(`  ✓ P${i} (非出牌人) 看不到 v (face_up=${c?.face_up})`);
        }
      }
    }
    socks.forEach(s => s.close());
    await delay(200);
  }

  // Test 2: 明牌出的牌 (face_up=true) — 所有人都看 v
  console.log('\n=== Test 2: face-up play — everyone sees v ===');
  {
    const socks = await newSocks(4);
    const r = await emit(socks[0], 'create_room', {
      nickname: 'P0', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 4, color: 'gold',
    });
    if (r?.error) throw new Error(r.error);
    const colors = ['azure', 'rose', 'jade'];
    for (let i = 1; i < 4; i++) {
      await emit(socks[i], 'join_room', { room_id: r.room_id, nickname: 'P' + i, color: colors[i - 1] });
    }
    await emit(socks[0], 'start_game');
    for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
    for (const s of socks) await emit(s, 'i_am_ready');
    for (const s of socks) await waitState(s, m => m.public.state === 'ready');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');

    // P0 明牌出
    const hand0 = latest(socks[0]).view.hand;
    const card0 = hand0[0];
    await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: true });
    await delay(300);

    for (let i = 0; i < 4; i++) {
      const seg = latest(socks[i]).public.segments[0] || [];
      const c = seg[0];
      if (!c || c.v !== card0.v) {
        console.log(`  ✕ P${i} 应该看到 v=${card0.v}, 实际 c.v=${c?.v}`);
        allPass = false;
      } else {
        console.log(`  ✓ P${i} 看到 v=${c.v} (face_up=${c.face_up})`);
      }
    }
    socks.forEach(s => s.close());
    await delay(200);
  }

  // Test 3: Ch02 no_faceup_plays — 强制盖牌, owner 仍能看自己
  console.log('\n=== Test 3: ch02 no_faceup — owner still sees own ===');
  {
    const socks = await newSocks(4);
    const r = await emit(socks[0], 'create_room', {
      nickname: 'P0', chapter_id: 'ch02_limitation', clock_id: 'c1', max_players: 4, color: 'gold',
    });
    if (r?.error) throw new Error(r.error);
    const colors = ['azure', 'rose', 'jade'];
    for (let i = 1; i < 4; i++) {
      await emit(socks[i], 'join_room', { room_id: r.room_id, nickname: 'P' + i, color: colors[i - 1] });
    }
    await emit(socks[0], 'start_game');
    for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
    for (const s of socks) await emit(s, 'i_am_ready');
    for (const s of socks) await waitState(s, m => m.public.state === 'ready');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');

    const hand0 = latest(socks[0]).view.hand;
    const card0 = hand0[0];
    // Ch02 禁止 face_up
    await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: false });
    await delay(300);

    const c0 = latest(socks[0]).public.segments[0]?.[0];
    const c1 = latest(socks[1]).public.segments[0]?.[0];
    if (c0?.v !== card0.v) {
      console.log(`  ✕ P0 (ch02 owner) 看不到自己出牌 v, 实际 c0.v=${c0?.v}`);
      allPass = false;
    } else {
      console.log(`  ✓ P0 (ch02 owner) 看到自己 v=${c0.v} 即使 Ch02 禁止明牌`);
    }
    if (c1 && c1.v !== undefined) {
      console.log(`  ✕ P1 (ch02) 不应看到 v, 实际 c1.v=${c1.v}`);
      allPass = false;
    } else {
      console.log(`  ✓ P1 (ch02) 看不到 v`);
    }
    socks.forEach(s => s.close());
    await delay(200);
  }

  // Test 4: 终局 revealAll — 所有人都看到所有 v
  console.log('\n=== Test 4: game end revealAll — everyone sees all v ===');
  {
    const socks = await newSocks(2);
    await setup2p(socks, 'ch01_awakening', 'c1');
    // 跑完一局
    for (let t = 0; t < 40; t++) {
      if (latest(socks[0]).public.state === 'finished') break;
      const st = latest(socks[0]);
      if (st.public.current_player_idx === 0) {
        await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: false });
      } else if (st.public.current_player_idx === 1) {
        await emit(socks[1], 'play_card', { card_idx: 0, segment: 2, face_up: false });
      }
      await delay(80);
    }
    if (latest(socks[0]).public.state !== 'finished') {
      console.log('  ✕ 游戏未结束'); allPass = false;
    } else {
      // 终局: revealAll, 所有人都看到 v
      const seg0ByP0 = latest(socks[0]).public.segments[0]?.[0];
      const seg0ByP1 = latest(socks[1]).public.segments[0]?.[0];
      if (seg0ByP0?.v != null && seg0ByP1?.v != null && seg0ByP0.v === seg0ByP1.v) {
        console.log(`  ✓ 终局 P0/P1 都看到段 1 第一张牌 v=${seg0ByP0.v}`);
      } else {
        console.log(`  ✕ 终局 segment 0: P0.v=${seg0ByP0?.v}, P1.v=${seg0ByP1?.v}`);
        allPass = false;
      }
    }
    socks.forEach(s => s.close());
  }

  console.log('\n=== OWNER VIEW E2E DONE ===');
  if (allPass) console.log('✓ ALL PASSED');
  else console.log('✕ SOME FAILED');
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

async function setup2p(socks, chapterId, clockId) {
  const r = await emit(socks[0], 'create_room', {
    nickname: 'P0', chapter_id: chapterId, clock_id: clockId, max_players: 2, color: 'gold',
  });
  await emit(socks[1], 'join_room', { room_id: r.room_id, nickname: 'P1', color: 'azure' });
  await emit(socks[0], 'start_game');
  for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  for (const s of socks) await waitState(s, m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  for (const s of socks) await waitState(s, m => m.public.state === 'playing');
}
