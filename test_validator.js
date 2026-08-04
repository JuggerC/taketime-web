// test_validator.js — Verify per-clock placement validators are enforced
// (e.g. Clock I-3: 1st card must go to seg 3, 2nd card to seg 2)
// Plus verify per-clock resolution rules appear in the end detail.

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3001';
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

async function setupGame(clockId = 'c1') {
  const nicks = ['A', 'B', 'C', 'D'];
  const socks = [];
  for (let i = 0; i < 4; i++) {
    const s = client();
    socks.push(s);
    await new Promise(r => s.on('connect', r));
    attachState(s);
  }
  const r = await emit(socks[0], 'create_room', {
    nickname: nicks[0], chapter_id: 'ch01_awakening', clock_id: clockId, max_players: 4,
  });
  const roomId = r.room_id;
  for (let i = 1; i < 4; i++) {
    await emit(socks[i], 'join_room', { room_id: roomId, nickname: nicks[i] });
  }
  await emit(socks[0], 'start_game');
  for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
  for (const s of socks) await emit(s, 'i_am_ready');
  for (const s of socks) await waitState(s, m => m.public.state === 'ready');
  return { socks, roomId };
}

async function playTurn(socks, chooseSeg) {
  const cur = latest(socks[0]).public.current_player_idx;
  if (cur == null) return;
  const sock = socks[cur];
  const view = latest(sock).view;
  if (!view.hand.length) return;
  const turn = latest(socks[0]).public.turn_number;
  const seg = chooseSeg(view.hand, turn);
  const r = await emit(sock, 'play_card', { card_idx: 0, segment: seg, face_up: false });
  if (r?.error) throw new Error(`Turn ${turn} P${cur} → seg ${seg}: ${r.error}`);
  await waitState(socks[0], m => m.public.state === 'finished' || m.public.turn_number > turn);
}

async function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    console.log('  ✓ SCENARIO PASSED');
  } catch (e) {
    console.log('  ✕ SCENARIO FAILED:', e.message);
    process.exitCode = 1;
  }
}

(async () => {
  // ============================================================
  // Clock I-3: 1st card → seg 3, 2nd card → seg 2 (table face icons)
  // ============================================================
  await scenario('Clock I-3: 1st card → seg 3 required (placement reject)', async () => {
    const { socks } = await setupGame('c3');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    const hand = latest(socks[0]).view.hand;
    console.log('  P0 hand:', hand.map(c => `${c.v}${c.c===1?'S':'L'}`).join(' '));
    // Try 1st card at seg 1 (wrong)
    const wrong1 = await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: false });
    if (!wrong1?.error) throw new Error('Expected rejection for 1st card at seg 1, got: ' + JSON.stringify(wrong1));
    if (!/第\s*1\s*张牌/.test(wrong1.error)) throw new Error('Expected "第 1 张牌" in error: ' + wrong1.error);
    console.log(`  ✓ 1st card at seg 1 rejected: "${wrong1.error}"`);
    // Try 1st card at seg 2 (wrong)
    const wrong2 = await emit(socks[0], 'play_card', { card_idx: 0, segment: 2, face_up: false });
    if (!wrong2?.error) throw new Error('Expected rejection for 1st card at seg 2, got: ' + JSON.stringify(wrong2));
    console.log(`  ✓ 1st card at seg 2 rejected: "${wrong2.error}"`);
    // Try 1st card at seg 4 (wrong)
    const wrong4 = await emit(socks[0], 'play_card', { card_idx: 0, segment: 4, face_up: false });
    if (!wrong4?.error) throw new Error('Expected rejection for 1st card at seg 4, got: ' + JSON.stringify(wrong4));
    console.log(`  ✓ 1st card at seg 4 rejected: "${wrong4.error}"`);
    // 1st card at seg 3 (right — the "1" icon at 4 o'clock on the clock face)
    const right = await emit(socks[0], 'play_card', { card_idx: 0, segment: 3, face_up: false });
    if (right?.error) throw new Error('Expected 1st card at seg 3 to succeed: ' + right.error);
    console.log('  ✓ 1st card at seg 3 accepted');
    socks.forEach(s => s.close());
  });

  await scenario('Clock I-3: 2nd card → seg 2 required (placement reject)', async () => {
    const { socks } = await setupGame('c3');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    // P0 plays 1st card at seg 3 (legal)
    let r = await emit(socks[0], 'play_card', { card_idx: 0, segment: 3, face_up: false });
    if (r?.error) throw new Error('1st card at seg 3 should succeed: ' + r.error);
    await waitState(socks[0], m => m.public.turn_number > 0);
    if (latest(socks[0]).public.current_player_idx !== 1) {
      throw new Error('Expected P1 to be current, got ' + latest(socks[0]).public.current_player_idx);
    }
    // P1 tries 2nd card at seg 1 (wrong)
    const wrong1 = await emit(socks[1], 'play_card', { card_idx: 0, segment: 1, face_up: false });
    if (!wrong1?.error) throw new Error('Expected rejection for 2nd card at seg 1, got: ' + JSON.stringify(wrong1));
    if (!/第\s*2\s*张牌/.test(wrong1.error)) throw new Error('Expected "第 2 张牌" in error: ' + wrong1.error);
    console.log(`  ✓ 2nd card at seg 1 rejected: "${wrong1.error}"`);
    // P1 tries 2nd card at seg 3 (wrong)
    const wrong3 = await emit(socks[1], 'play_card', { card_idx: 0, segment: 3, face_up: false });
    if (!wrong3?.error) throw new Error('Expected rejection for 2nd card at seg 3, got: ' + JSON.stringify(wrong3));
    console.log(`  ✓ 2nd card at seg 3 rejected: "${wrong3.error}"`);
    // P1 plays 2nd card at seg 2 (right — the "2" icon at 2 o'clock)
    const right = await emit(socks[1], 'play_card', { card_idx: 0, segment: 2, face_up: false });
    if (right?.error) throw new Error('2nd card at seg 2 should succeed: ' + right.error);
    console.log('  ✓ 2nd card at seg 2 accepted');
    socks.forEach(s => s.close());
  });

  // Helper: play 12 cards honoring Clock I-3 placement rules
  const playFullClockI3 = async (socks) => {
    for (let turn = 0; turn < 12; turn++) {
      await playTurn(socks, (hand, n) => {
        if (n === 0) return 3;   // 1st → seg 3 (III, "1" icon at 4 o'clock)
        if (n === 1) return 2;   // 2nd → seg 2 (II,  "2" icon at 2 o'clock)
        return (n % 6) + 1;
      });
    }
    for (const s of socks) await waitState(s, m => m.public.state === 'finished');
  };

  // Helper: play 12 cards freely (any clock without placement constraints)
  const playFullFree = async (socks) => {
    for (let turn = 0; turn < 12; turn++) {
      await playTurn(socks, (hand, n) => (n % 6) + 1);
    }
    for (const s of socks) await waitState(s, m => m.public.state === 'finished');
  };

  // ============================================================
  // Clock I-3: per-clock rules checked at resolution
  //   - 1st card at III (passed: rule was satisfied)
  //   - 2nd card at II
  //   - VI sum ∈ [20, 30]
  // ============================================================
  await scenario('Clock I-3: per-clock rules checked at resolution', async () => {
    const { socks } = await setupGame('c3');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullClockI3(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const fcRule = detail.find(d => {
      const m = d.name.match(/第\s*1\s*张牌放在\s*(\S+)/);
      return m && m[1] === 'III';
    });
    const scRule = detail.find(d => {
      const m = d.name.match(/第\s*2\s*张牌放在\s*(\S+)/);
      return m && m[1] === 'II';
    });
    const viRange = detail.find(d => /VI\s*的点数和在\s*\[20,\s*30\]/.test(d.name));
    if (!fcRule) throw new Error('Expected 1st-card rule in detail (placed at III)');
    if (!scRule) throw new Error('Expected 2nd-card rule in detail (placed at II)');
    if (!viRange) throw new Error('Expected VI [20, 30] range rule in detail');
    if (!fcRule.passed || !scRule.passed) {
      throw new Error('Expected placement rules to pass: ' + JSON.stringify({fcRule, scRule}));
    }
    console.log('  ✓ All 3 per-clock rules present in resolution detail');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // Clock I-1: per-clock rules (seg 1 count 1 + seg 6 count 3)
  // ============================================================
  await scenario('Clock I-1: per-clock rules in detail', async () => {
    const { socks } = await setupGame('c1');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullFree(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const handRule = detail.find(d => /^I\s*恰好\s*1\s*张白牌/.test(d.name));
    const viRule = detail.find(d => /^VI\s*恰好放\s*3\s*张牌/.test(d.name));
    if (!handRule) throw new Error('Expected Hand (I) "1 张白牌" rule in detail');
    if (!viRule) throw new Error('Expected VI count-3 rule in detail');
    console.log('  ✓ Both I-1 per-clock rules present in resolution detail (I = 1 张白牌, VI = 3 张)');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // Clock I-2: per-clock rules (seg 3 [8, 12] + seg 4 count 3)
  // ============================================================
  await scenario('Clock I-2: per-clock rules in detail', async () => {
    const { socks } = await setupGame('c2');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullFree(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const segRange = detail.find(d => /III\s*的点数和在\s*\[8,\s*12\]/.test(d.name));
    const segCount = detail.find(d => /^IV\s*恰好放\s*3\s*张牌/.test(d.name));
    if (!segRange) throw new Error('Expected III [8, 12] value-range rule in detail');
    if (!segCount) throw new Error('Expected IV count-3 rule in detail');
    console.log('  ✓ Both I-2 per-clock rules present in resolution detail');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // Clock I-4: per-clock rules (seg 1 closest to 9 + seg 4 color combo 1S+1L)
  // + ≤24 enforced
  // ============================================================
  await scenario('Clock I-4: per-clock rules in detail', async () => {
    const { socks } = await setupGame('c4');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullFree(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const closestRule = detail.find(d => /^I\s*的点数和最接近\s*6/.test(d.name));
    const colorRule = detail.find(d => /^IV\s*恰好\s*1\s*太阳\s*\+\s*1\s*月亮/.test(d.name));
    const maxValRule = detail.find(d => /每段.+和\s*≤\s*24/.test(d.name));
    if (!closestRule) throw new Error('Expected I closest-to-9 rule in detail');
    if (!colorRule) throw new Error('Expected IV color-combo (1S+1L) rule in detail');
    if (!maxValRule) throw new Error('Expected ≤24 rule in detail');
    if (maxValRule.skipped) throw new Error('Expected ≤24 rule to NOT be skipped for Clock I-4');
    console.log('  ✓ All 3 I-4 per-clock rules present in resolution detail');
    socks.forEach(s => s.close());
  });

  // =====================================================================
  // Chapter II (Limitation) — 全章禁明牌 + 每段 segment_no_value
  // =====================================================================

  // setupGame 的 helper 复用不了: Ch02 章节不同, 重新写一个
  async function setupCh02Game(clockId = 'c1') {
    const nicks = ['A', 'B', 'C', 'D'];
    const socks = [];
    for (let i = 0; i < 4; i++) {
      const s = client();
      socks.push(s);
      await new Promise(r => s.on('connect', r));
      attachState(s);
    }
    const r = await emit(socks[0], 'create_room', {
      nickname: nicks[0], chapter_id: 'ch02_limitation', clock_id: clockId, max_players: 4,
    });
    if (r?.error) throw new Error('create_room failed: ' + r.error);
    const roomId = r.room_id;
    for (let i = 1; i < 4; i++) {
      await emit(socks[i], 'join_room', { room_id: roomId, nickname: nicks[i] });
    }
    await emit(socks[0], 'start_game');
    for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');
    // 验证 chapter 的 no_faceup_plays 标志已下发
    const ch = latest(socks[0]).public.chapter;
    if (ch.id !== 'ch02_limitation') throw new Error('Expected ch02_limitation chapter, got ' + ch.id);
    if (!ch.no_faceup_plays) throw new Error('Expected chapter.no_faceup_plays=true');
    if (latest(socks[0]).public.face_up_remaining !== 0) {
      throw new Error('Expected face_up_remaining=0 in Ch02, got ' + latest(socks[0]).public.face_up_remaining);
    }
    for (const s of socks) await emit(s, 'i_am_ready');
    for (const s of socks) await waitState(s, m => m.public.state === 'ready');
    return { socks, roomId };
  }

  // Ch02 helper: 玩完 12 张. 牌先按 (v, c) 升序排, 然后 bot 避开
  // segment_no_value, 所以正常情况下能跑完; 测试只关心能不能跑完
  // + 结算时各段规则在 detail 里.
  const playFullCh02 = async (socks) => {
    for (let turn = 0; turn < 12; turn++) {
      await playTurn(socks, (hand, n) => (n % 6) + 1);
    }
    for (const s of socks) await waitState(s, m => m.public.state === 'finished');
  };

  await scenario('Ch02 / II-1: 全章 no_faceup_plays=true, 明牌被拒', async () => {
    const { socks } = await setupCh02Game('c1');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    // 试图明牌: 应被服务器拒
    const r = await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: true });
    if (!r?.error) throw new Error('Expected face-up play rejected, got: ' + JSON.stringify(r));
    if (!/本章节禁止明牌/.test(r.error)) {
      throw new Error('Expected "本章节禁止明牌" error, got: ' + r.error);
    }
    console.log(`  ✓ face-up play rejected: "${r.error}"`);
    // 盖牌正常
    const ok = await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: false });
    if (ok?.error) throw new Error('Face-down play should succeed: ' + ok.error);
    console.log('  ✓ face-down play accepted');
    socks.forEach(s => s.close());
  });

  await scenario('Ch02 / II-1: 3 条 segment_no_value 规则出现在 detail', async () => {
    const { socks } = await setupCh02Game('c1');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullCh02(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const iRule = detail.find(d => /^I\s*不能放值为\s*1\s*\/\s*2\s*\/\s*3/.test(d.name));
    const iiRule = detail.find(d => /^II\s*不能放值为\s*1\s*\/\s*2\s*\/\s*3/.test(d.name));
    const iiiRule = detail.find(d => /^III\s*不能放值为\s*1\s*\/\s*2\s*\/\s*3/.test(d.name));
    if (!iRule) throw new Error('Expected I no-value rule in detail');
    if (!iiRule) throw new Error('Expected II no-value rule in detail');
    if (!iiiRule) throw new Error('Expected III no-value rule in detail');
    console.log('  ✓ All 3 II-1 no-value rules present in detail');
    socks.forEach(s => s.close());
  });

  await scenario('Ch02 / II-2: 2 条 segment_no_value 规则出现在 detail (I 段无规则)', async () => {
    const { socks } = await setupCh02Game('c2');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullCh02(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    // 用户纠正: II-2 12点(I) 没有徽章, 所以 I 段没 no-value 规则
    const iRule = detail.find(d => /^I\s*不能放值/.test(d.name));
    if (iRule) throw new Error('II-2 I 段不应该有 no-value 规则, got: ' + iRule.name);
    const iiiRule = detail.find(d => /^III\s*不能放值为\s*7\s*\/\s*8\s*\/\s*9/.test(d.name));
    const ivRule = detail.find(d => /^IV\s*不能放值为\s*7\s*\/\s*8\s*\/\s*9/.test(d.name));
    if (!iiiRule) throw new Error('Expected III no-value rule (7/8/9) in detail');
    if (!ivRule) throw new Error('Expected IV no-value rule (7/8/9) in detail');
    const noValCount = detail.filter(d => /不能放值/.test(d.name)).length;
    if (noValCount !== 2) throw new Error(`Expected 2 no-value rules, got ${noValCount}`);
    console.log('  ✓ Exactly 2 II-2 no-value rules (III + IV), I 段无规则');
    socks.forEach(s => s.close());
  });

  await scenario('Ch02 / II-3: 4 条 segment_no_value 规则出现在 detail (VI 段含 10/11/12)', async () => {
    const { socks } = await setupCh02Game('c3');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFullCh02(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Resolution detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const iRule = detail.find(d => /^I\s*不能放值为\s*1\s*\/\s*2\s*\/\s*3/.test(d.name));
    const iiiRule = detail.find(d => /^III\s*不能放值为\s*4\s*\/\s*5\s*\/\s*6/.test(d.name));
    const ivRule = detail.find(d => /^IV\s*不能放值为\s*7\s*\/\s*8\s*\/\s*9/.test(d.name));
    // 用户纠正: {10,11,12} 徽章在 10点位置 → seg 6 (VI), 不是 seg 5 (V)
    const vRule = detail.find(d => /^V\s*不能放值为\s*10\s*\/\s*11\s*\/\s*12/.test(d.name));
    if (vRule) throw new Error('II-3 V 段不应该有 {10,11,12} 规则, got: ' + vRule.name);
    const viRule = detail.find(d => /^VI\s*不能放值为\s*10\s*\/\s*11\s*\/\s*12/.test(d.name));
    if (!iRule) throw new Error('Expected I no-value rule (1/2/3) in detail');
    if (!iiiRule) throw new Error('Expected III no-value rule (4/5/6) in detail');
    if (!ivRule) throw new Error('Expected IV no-value rule (7/8/9) in detail');
    if (!viRule) throw new Error('Expected VI no-value rule (10/11/12) in detail');
    console.log('  ✓ All 4 II-3 no-value rules present (I, III, IV, VI — NOT V)');
    socks.forEach(s => s.close());
  });

  await scenario('Ch02 / II-4: 无 per-clock validator, 只有章节规则', async () => {
    const { socks } = await setupCh02Game('c4');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    // 章节没段规则, 所以纯按 bot 策略跑完就行
    await playFullCh02(socks);
    const ck = latest(socks[0]).public.clock;
    if (ck.id !== 'c4') throw new Error('Expected II-4 clock');
    if ((ck.validators || []).length !== 0) {
      throw new Error('Expected II-4 to have NO per-clock validators, got: ' + JSON.stringify(ck.validators));
    }
    console.log('  ✓ II-4 has 0 per-clock validators (chapter rule only)');
    socks.forEach(s => s.close());
  });

  console.log('\n=== ALL TESTS DONE ===');
  process.exit(process.exitCode || 0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
