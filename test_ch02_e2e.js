// test_ch02_e2e.js — Ch02 (Limitation) 端到端测试
// 验证:
//   1. Ch02 能正常开局、抢答、出牌、结束
//   2. 全程无明牌 (face_up_remaining 始终为 0)
//   3. 结算时 detail 包含 segment_no_value 规则

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

(async () => {
  console.log('=== Ch02 (Limitation) E2E ===');
  const nicks = ['A', 'B', 'C', 'D'];
  const socks = [];
  for (let i = 0; i < 4; i++) {
    const s = client();
    socks.push(s);
    await new Promise(r => s.on('connect', r));
    attachState(s);
  }
  const r = await emit(socks[0], 'create_room', {
    nickname: nicks[0], chapter_id: 'ch02_limitation', clock_id: 'c2', max_players: 4,
  });
  if (r?.error) throw new Error('create_room: ' + r.error);
  const roomId = r.room_id;
  console.log(`  room ${roomId} created`);
  for (let i = 1; i < 4; i++) {
    await emit(socks[i], 'join_room', { room_id: roomId, nickname: nicks[i] });
  }
  await emit(socks[0], 'start_game');
  for (const s of socks) await waitState(s, m => m.public.state === 'rules_intro');

  // 验证章节标志
  const ch = latest(socks[0]).public.chapter;
  if (ch.id !== 'ch02_limitation') throw new Error('Wrong chapter: ' + ch.id);
  if (!ch.no_faceup_plays) throw new Error('ch.no_faceup_plays should be true');
  console.log(`  ✓ chapter=${ch.id}, no_faceup_plays=true`);

  for (const s of socks) await emit(s, 'i_am_ready');
  for (const s of socks) await waitState(s, m => m.public.state === 'ready');
  await emit(socks[0], 'declare_first');
  for (const s of socks) await waitState(s, m => m.public.state === 'playing');

  // 玩 12 张, 全程 face_up=false
  for (let turn = 0; turn < 12; turn++) {
    const cur = latest(socks[0]).public.current_player_idx;
    const sock = socks[cur];
    const view = latest(sock).view;
    if (view.hand.length === 0) break;
    // 验证 face_up_remaining 始终为 0
    if (latest(socks[0]).public.face_up_remaining !== 0) {
      throw new Error('face_up_remaining should be 0 in Ch02, got ' +
        latest(socks[0]).public.face_up_remaining);
    }
    const seg = (turn % 6) + 1;
    const r = await emit(sock, 'play_card', { card_idx: 0, segment: seg, face_up: false });
    if (r?.error) throw new Error(`T${turn} P${cur} → seg ${seg}: ${r.error}`);
    await waitState(socks[0], m => m.public.state === 'finished' || m.public.turn_number > turn);
  }
  for (const s of socks) await waitState(s, m => m.public.state === 'finished');
  console.log(`  ✓ 12 cards played, all face-down`);

  const result = latest(socks[0]).public.game_result;
  console.log(`  Game over: ${result.won ? 'WON' : 'LOST'}`);
  console.log(`  Sums: ${result.sums.join(', ')}`);
  console.log('  Detail:');
  for (const d of result.detail) {
    console.log(`     ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? '（不强制）' : ''}`);
  }
  // II-2 实际只有 2 条 no-value 规则 (III + IV, I 段无徽章)
  const noValueRules = result.detail.filter(d => /不能放值/.test(d.name));
  if (noValueRules.length !== 2) {
    throw new Error(`Expected exactly 2 no-value rules in Ch02 II-2 detail, got ${noValueRules.length}`);
  }
  console.log(`  ✓ exactly 2 no-value rules (II-2 I 段无规则)`);
  // 同时验证: 规则卡现在下发的是 II-2 自己的钟面图
  const ck = latest(socks[0]).public.clock;
  if (!ck.rulesheet || !ck.rulesheet.includes('Clock_02_C2_face.png')) {
    throw new Error('Expected clock.rulesheet=Clock_02_C2_face.png, got: ' + ck.rulesheet);
  }
  console.log(`  ✓ clock.rulesheet = ${ck.rulesheet.split('/').pop()}`);

  socks.forEach(s => s.close());
  console.log('=== CH02 E2E PASSED ===');
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
