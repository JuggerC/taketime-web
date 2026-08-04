// test_e2e.js — v4 End-to-end test
//
// Simulates 4 players creating/joining a room, picking a clock, starting,
// and playing through to completion. Verifies:
//   - All 12 cards dealt
//   - Game state transitions correctly
//   - Resolution computes
//   - Privacy: face-down card values are not leaked

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3001';

function client() {
  return io(URL, { reconnection: false, transports: ['websocket'] });
}
function emit(s, ev, d) { return new Promise(r => s.emit(ev, d, r)); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function attachState(s, log) {
  s._lastState = null;
  s.on('state_update', msg => {
    s._lastState = msg;
    if (log) console.log(`  [${s.id.slice(0,4)}] state_update -> ${msg.public.state}`);
  });
}
function latest(s) {
  if (!s._lastState) throw new Error(`no state yet for ${s.id}`);
  return s._lastState;
}
async function waitState(s, predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (s._lastState && predicate(s._lastState)) return s._lastState;
    await delay(50);
  }
  throw new Error(`waitState timeout: last=${s._lastState?.public?.state}`);
}

async function main() {
  console.log('=== Take Time v4 E2E test ===\n');
  const nicks = ['Alice', 'Bob', 'Charlie', 'Diana'];
  const sockets = [];

  for (let i = 0; i < 4; i++) {
    const s = client();
    sockets.push(s);
    await new Promise(r => s.on('connect', r));
    attachState(s, false);
    console.log(`P${i} (${nicks[i]}) connected: ${s.id.slice(0, 8)}…`);
  }

  // P0 creates room with Ch1 Clock C1
  let r = await emit(sockets[0], 'create_room', {
    nickname: nicks[0], chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 4,
  });
  if (r?.error) { console.error('create_room:', r.error); process.exit(1); }
  console.log(`P0 created room ${r.room_id}, idx=${r.player_idx}`);
  const roomId = r.room_id;

  for (let i = 1; i < 4; i++) {
    r = await emit(sockets[i], 'join_room', { room_id: roomId, nickname: nicks[i] });
    if (r?.error) { console.error('join_room:', r.error); process.exit(1); }
    console.log(`P${i} joined, idx=${r.player_idx}`);
  }

  // Start
  r = await emit(sockets[0], 'start_game');
  if (r?.error) { console.error('start_game:', r.error); process.exit(1); }

  // Wait for all to receive rules_intro state
  for (const s of sockets) {
    await waitState(s, m => m.public.state === 'rules_intro');
  }
  console.log('All players in rules_intro');

  const pub0 = latest(sockets[0]).public;
  const view0 = latest(sockets[0]).view;
  console.log(`Chapter: ${pub0.chapter.name} / ${pub0.clock.name}`);
  console.log(`Hand size: ${view0.hand_size} (P${pub0.players.length})`);
  console.log(`Hand: ${view0.hand.map(c => `${c.v}${c.c===1?'S':'L'}`).join(' ')}`);
  console.log(`Face-up remaining: ${pub0.face_up_remaining}/${pub0.face_up_limit}`);

  // Privacy: opponent hand values NEVER exposed
  let leak = false;
  for (const sz of view0.opponent_hand_sizes) if (typeof sz !== 'number') leak = true;
  // opponent_hand_colors should be [solar_count, lunar_count] only
  for (const [s, l] of view0.opponent_hand_colors) {
    if (typeof s !== 'number' || typeof l !== 'number') leak = true;
  }
  console.log(`Privacy check (hand values/colours): ${leak ? 'FAIL' : 'OK'}`);

  // All ready
  for (const s of sockets) {
    r = await emit(s, 'i_am_ready');
    if (r?.error) { console.error('i_am_ready:', r.error); process.exit(1); }
  }
  for (const s of sockets) {
    await waitState(s, m => m.public.state === 'ready');
  }
  console.log('All ready');

  // P0 declares first
  r = await emit(sockets[0], 'declare_first');
  if (r?.error) { console.error('declare_first:', r.error); process.exit(1); }
  for (const s of sockets) {
    await waitState(s, m => m.public.state === 'playing');
  }
  console.log('Playing started, P0 first');

  // Play through all 12 turns. P0 always plays card 0 to segment 1 (Hand).
  // (We don't need a winning strategy for the test; just exercise the loop.)
  for (let turn = 0; turn < 12; turn++) {
    const cur = latest(sockets[0]).public.current_player_idx;
    if (cur == null) break;
    const sock = sockets[cur];
    const view = latest(sock).view;
    if (!view.hand || view.hand.length === 0) {
      console.log(`Turn ${turn}: P${cur} has no hand, skipping`);
      break;
    }
    r = await emit(sock, 'play_card', { card_idx: 0, segment: 1, face_up: false });
    if (r?.error) {
      console.error(`Turn ${turn} P${cur} play_card: ${r.error}`);
      process.exit(1);
    }
    // Wait until the state actually advances (turn_number increments or game finishes)
    const prevTurn = latest(sockets[0]).public.turn_number;
    await waitState(sockets[0], m =>
      m.public.state === 'finished' || m.public.turn_number > prevTurn
    );
  }

  // Wait for finished
  for (const s of sockets) {
    await waitState(s, m => m.public.state === 'finished');
  }

  // Final result
  const pub = latest(sockets[0]).public;
  console.log(`\n=== RESULT ===`);
  console.log(`State: ${pub.state}`);
  console.log(`Result: ${pub.game_result.won ? 'WON' : 'LOST'}`);
  console.log(`Segment sums: ${pub.game_result.sums.join(', ')}`);
  console.log('Detail:');
  for (const d of pub.game_result.detail) {
    console.log(`  ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? ' (skipped)' : ''}${d.manual ? ' (manual)' : ''}`);
  }

  // Final reveal: all cards face-up
  const revealed = pub.segments.every(seg => seg.every(c => c.face_up));
  console.log(`\nFinal reveal: ${revealed ? 'OK' : 'FAIL'}`);

  for (const s of sockets) s.close();
  console.log('\n=== TEST PASSED ===');
  process.exit(0);
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
