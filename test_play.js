// test_play.js — v4 End-to-end with realistic play
//
// 4 human-mimicking clients: each plays the lowest card to the segment that
// will best satisfy Ch1 Awakening rules (ascending, ≥1 per segment, ≤24).
// We use a simple strategy:
//   - Sort hand ascending
//   - Round-robin: place card i on segment ((i % 6) + 1)
//   - Face-up only if needed to signal
// Verifies the game can complete with the real game logic.

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
async function waitState(s, predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (s._lastState && predicate(s._lastState)) return s._lastState;
    await delay(50);
  }
  throw new Error(`waitState timeout: last=${s._lastState?.public?.state}`);
}

async function main() {
  console.log('=== Take Time v4 — Realistic Play E2E ===\n');
  const nicks = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  const sockets = [];
  for (let i = 0; i < 4; i++) {
    const s = client();
    sockets.push(s);
    await new Promise(r => s.on('connect', r));
    attachState(s);
  }
  console.log('4 players connected');

  let r = await emit(sockets[0], 'create_room', {
    nickname: nicks[0], chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 4,
  });
  if (r?.error) { console.error(r.error); process.exit(1); }
  const roomId = r.room_id;
  console.log(`Room ${roomId} created`);

  for (let i = 1; i < 4; i++) {
    r = await emit(sockets[i], 'join_room', { room_id: roomId, nickname: nicks[i] });
    if (r?.error) { console.error(r.error); process.exit(1); }
  }
  console.log('4 players in lobby');

  r = await emit(sockets[0], 'start_game');
  if (r?.error) { console.error(r.error); process.exit(1); }
  for (const s of sockets) await waitState(s, m => m.public.state === 'rules_intro');

  for (const s of sockets) {
    r = await emit(s, 'i_am_ready');
  }
  for (const s of sockets) await waitState(s, m => m.public.state === 'ready');

  r = await emit(sockets[0], 'declare_first');
  if (r?.error) { console.error(r.error); process.exit(1); }
  for (const s of sockets) await waitState(s, m => m.public.state === 'playing');
  console.log('Game started (Ch1 Clock I-1)');

  // Play 12 turns with round-robin segment placement, smallest card first
  for (let turn = 0; turn < 12; turn++) {
    const cur = latest(sockets[0]).public.current_player_idx;
    if (cur == null) break;
    const sock = sockets[cur];
    const view = latest(sock).view;
    if (!view.hand.length) break;

    // Strategy: place smallest card on segment (turn % 6) + 1
    const sortedIdx = view.hand.map((c, i) => ({ c, i })).sort((a, b) => a.c.v - b.c.v);
    const cardIdx = sortedIdx[0].i;
    const seg = (turn % 6) + 1;
    r = await emit(sock, 'play_card', { card_idx: cardIdx, segment: seg, face_up: false });
    if (r?.error) { console.error(`Turn ${turn} P${cur}:`, r.error); process.exit(1); }
    const prevTurn = latest(sockets[0]).public.turn_number;
    await waitState(sockets[0], m => m.public.state === 'finished' || m.public.turn_number > prevTurn);
    const cur2 = latest(sockets[0]).public.current_player_idx;
    const segs = latest(sockets[0]).public.segments;
    process.stdout.write(`T${turn} P${cur}→P${cur2}: card v${sortedIdx[0].c.v}${sortedIdx[0].c.c===1?'S':'L'} → seg${seg} | sums: [${segs.map(s=>s.reduce((a,c)=>a+c.v,0)).join(',')}]\n`);
  }

  for (const s of sockets) await waitState(s, m => m.public.state === 'finished');
  const pub = latest(sockets[0]).public;
  console.log(`\n=== RESULT ===`);
  console.log(`${pub.game_result.won ? 'WON' : 'LOST'}`);
  console.log(`Sums: ${pub.game_result.sums.join(', ')}`);
  for (const d of pub.game_result.detail) {
    console.log(`  ${d.passed ? '✓' : '✕'} ${d.name}${d.skipped ? ' (skipped)' : ''}`);
  }

  for (const s of sockets) s.close();
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
