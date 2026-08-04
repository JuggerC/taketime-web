// test_ch345_e2e.js — Chapter III/IV/V 端到端测试
//
// 验证 Ch3 (Clock Hand + lowest_card_at), Ch4 (forced_play = leftmost),
// Ch5 (cards_per_segment = 2) 的章节机制和 per-clock 段规则都生效.

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

async function setupChapter(chapterId, clockId) {
  const nicks = ['A', 'B', 'C', 'D'];
  const socks = [];
  for (let i = 0; i < 4; i++) {
    const s = client();
    socks.push(s);
    await new Promise(r => s.on('connect', r));
    attachState(s);
  }
  const r = await emit(socks[0], 'create_room', {
    nickname: nicks[0], chapter_id: chapterId, clock_id: clockId, max_players: 4,
  });
  if (r?.error) throw new Error('create_room: ' + r.error);
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

async function playFull(socks, decide = (hand, n, isLeftmost) => (n % 6) + 1) {
  for (let turn = 0; turn < 12; turn++) {
    const cur = latest(socks[0]).public.current_player_idx;
    const sock = socks[cur];
    const view = latest(sock).view;
    if (view.hand.length === 0) break;
    const hand = view.hand;
    const isLeftmost = (latest(socks[0]).public.clock.forced_play === 'leftmost');
    // Ch4 forced_play = leftmost: 必须出手牌 [0]
    let cardIdx;
    if (isLeftmost) cardIdx = 0;
    else cardIdx = 0;  // 默认 (手牌是 sorted 后)
    const seg = decide(hand, turn, isLeftmost);
    const r = await emit(sock, 'play_card', { card_idx: cardIdx, segment: seg, face_up: false });
    if (r?.error) throw new Error(`T${turn} P${cur} → seg ${seg}: ${r.error}`);
    await waitState(socks[0], m => m.public.state === 'finished' || m.public.turn_number > turn);
  }
  for (const s of socks) await waitState(s, m => m.public.state === 'finished');
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
  // Ch3 III-1: 章节字段 + per-clock validators
  //   - clock_hand_segment: 1
  //   - lowest_card_at segment 1
  //   - segment_count segment 2 count 1
  //   - segment_closest_to segment 4 value 20
  // ============================================================
  await scenario('Ch3 / III-1: Clock Hand 段=I + lowest_card_at + 段规则在 detail', async () => {
    const { socks } = await setupChapter('ch03_as_within_so_without', 'c1');
    const ck = latest(socks[0]).public.clock;
    if (ck.clock_hand_segment !== 1) throw new Error('Expected clock_hand_segment=1');
    if (ck.forced_play) throw new Error('Expected no forced_play in Ch3');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFull(socks, (hand, n) => (n % 6) + 1);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const lowestAt1 = detail.find(d => /^I\s*含全组最低值卡/.test(d.name));
    const countII = detail.find(d => /^II\s*恰好放\s*1\s*张牌/.test(d.name));
    const closestIV = detail.find(d => /^IV\s*的点数和最接近\s*20/.test(d.name));
    if (!lowestAt1) throw new Error('Expected "I 含全组最低值卡" in detail');
    if (!countII) throw new Error('Expected "II 恰好放 1 张牌" in detail');
    if (!closestIV) throw new Error('Expected "IV 最接近 20" in detail');
    console.log('  ✓ All 3 Ch3 III-1 per-clock rules in detail');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // Ch4 IV-3: forced_play = leftmost (非最左牌被拒)
  // ============================================================
  await scenario('Ch4 / IV-3: forced_play=leftmost, 出非最左牌被拒', async () => {
    const { socks } = await setupChapter('ch04_roar', 'c3');
    const ck = latest(socks[0]).public.clock;
    if (ck.forced_play !== 'leftmost') throw new Error('Expected forced_play=leftmost, got ' + ck.forced_play);
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    // P0 试出 card_idx=1 (非最左) → 应被拒
    const r = await emit(socks[0], 'play_card', { card_idx: 1, segment: 1, face_up: false });
    if (!r?.error) throw new Error('Expected rejection for non-leftmost card, got: ' + JSON.stringify(r));
    if (!/最左/.test(r.error)) throw new Error('Expected "最左" in error: ' + r.error);
    console.log(`  ✓ non-leftmost play rejected: "${r.error}"`);
    // P0 出 card_idx=0 (最左) → 成功
    const ok = await emit(socks[0], 'play_card', { card_idx: 0, segment: 1, face_up: false });
    if (ok?.error) throw new Error('Leftmost play should succeed: ' + ok.error);
    console.log('  ✓ leftmost play accepted');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // Ch4 IV-3: 玩完 + detail 应有 3 条 segment_no_value (I/III/V 禁 1,2,3)
  // ============================================================
  await scenario('Ch4 / IV-3: per-clock 段规则出现在 detail', async () => {
    const { socks } = await setupChapter('ch04_roar', 'c3');
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFull(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const noValRules = detail.filter(d => /不能放值为\s*1\s*\/\s*2\s*\/\s*3/.test(d.name));
    if (noValRules.length !== 3) {
      throw new Error(`Expected 3 no-value rules (I/III/V), got ${noValRules.length}`);
    }
    console.log('  ✓ 3 no-value rules in detail (I/III/V 禁 1/2/3)');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // Ch5 V-2: cards_per_segment=2 + IV 段最接近 15
  // ============================================================
  await scenario('Ch5 / V-2: 每段恰好 2 张 + IV 段最接近 15 在 detail', async () => {
    const { socks } = await setupChapter('ch05_tranquility', 'c2');
    const std = latest(socks[0]).public.chapter.standard_rules;
    if (std.min_per_segment !== 2 || std.max_per_segment !== 2) {
      throw new Error('Expected min=2,max=2 in Ch5');
    }
    await emit(socks[0], 'declare_first');
    for (const s of socks) await waitState(s, m => m.public.state === 'playing');
    await playFull(socks);
    const detail = latest(socks[0]).public.game_result.detail;
    console.log('  Detail:');
    for (const d of detail) {
      console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
    }
    const minRule = detail.find(d => /每段至少\s*2\s*张卡/.test(d.name));
    const maxRule = detail.find(d => /每段最多\s*2\s*张卡/.test(d.name));
    const closestIV = detail.find(d => /^IV\s*的点数和最接近\s*15/.test(d.name));
    if (!minRule) throw new Error('Expected "每段至少 2 张卡" in detail');
    if (!maxRule) throw new Error('Expected "每段最多 2 张卡" in detail');
    if (!closestIV) throw new Error('Expected "IV 最接近 15" in detail');
    console.log('  ✓ Ch5 V-2 章节机制 + 段规则都在 detail');
    socks.forEach(s => s.close());
  });

  // ============================================================
  // 验证 5 章节 (Ch1-Ch5) 都能在 lobby 出现, 8+4+4=16 个钟全部加载
  // ============================================================
  await scenario('Chapters 1-5: 全部 5 章节 20 钟都在 lobby 出现', async () => {
    const s = client();
    await new Promise(r => s.on('connect', r));
    let chs = null;
    s.on('chapters', (l) => { chs = l; });
    await delay(500);
    s.close();
    if (!chs || chs.length < 5) throw new Error('Expected >=5 chapters, got ' + (chs ? chs.length : 'null'));
    for (const ch of chs) {
      console.log(`  ${ch.id}: ${ch.clocks.length} clocks, ${ch.clocks.length * 1}钟面图`);
    }
    const totalClocks = chs.reduce((n, ch) => n + ch.clocks.length, 0);
    if (totalClocks < 20) throw new Error('Expected >=20 total clocks, got ' + totalClocks);
    console.log(`  ✓ ${chs.length} chapters × 4 clocks = ${totalClocks} total`);
  });

  console.log('\n=== ALL CH3-5 TESTS DONE ===');
  process.exit(process.exitCode || 0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
