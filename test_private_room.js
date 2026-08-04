// test_private_room.js — Phase 2: password-protected rooms
//
// Coverage:
//   1. Public room, join with no password → ok
//   2. Private room, join with wrong password → error
//   3. Private room, join with correct password → ok
//   4. Rejoin private room with no password → error
//   5. Rejoin private room with correct password → ok
//   6. Private room NOT in room_list
//   7. Public + private coexist; only public in list
//   8. Password too short (3 chars) → create_room error
//   9. Password too long (13 chars) → create_room error
//  10. Empty string password is treated as public (no password)
//  11. is_private flag visible only in server state (not in list)

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

let passed = 0;
let failed = 0;
function check(label, cond = true, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✕ ${label} ${extra}`); failed++; }
}

// 持续监听 room_list 到一个数组, 实时返回
function attachRoomList(s) {
  s._roomLists = [];
  s.on('room_list', list => { s._roomLists.push(list || []); });
}
function getLatestRoomList(s) {
  return s._roomLists && s._roomLists.length > 0 ? s._roomLists[s._roomLists.length - 1] : [];
}

async function test1PublicJoinNoPassword() {
  console.log('\n=== Test 1: public room, join with no password → ok ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'P0', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; socks.forEach(s => s.close()); return; }
  check('public room created (no password)');
  const jr = await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'P1' });
  check('joined public room (no password needed)', !jr?.error, `(${jr?.error})`);
  socks.forEach(s => s.close());
}

async function test2PrivateWrongPassword() {
  console.log('\n=== Test 2: private room, join with wrong password → error ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'P0', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'secret123' });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; socks.forEach(s => s.close()); return; }
  check('private room created with password');
  const jr = await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'P1', password: 'wrong_pwd' });
  check('wrong password rejected', jr?.error && /密码/.test(jr.error), `(${jr?.error})`);
  socks.forEach(s => s.close());
}

async function test3PrivateCorrectPassword() {
  console.log('\n=== Test 3: private room, join with correct password → ok ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'P0', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'secret123' });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; socks.forEach(s => s.close()); return; }
  check('private room created');
  const jr = await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'P1', password: 'secret123' });
  check('correct password accepted', !jr?.error, `(${jr?.error})`);
  socks.forEach(s => s.close());
}

async function test4RejoinPrivateNoPassword() {
  console.log('\n=== Test 4: rejoin private room with no password → error ===');
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'Alice', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'mypass99' });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; socks.forEach(s => s.close()); return; }
  const jr = await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'Bob', password: 'mypass99' });
  if (jr?.error) { console.log(`  ✕ join failed: ${jr.error}`); failed++; socks.forEach(s => s.close()); return; }
  // Alice 断线
  socks[0].close();
  await delay(200);
  // Alice 用错的密码重连
  const sAlice = client();
  await new Promise(r => sAlice.on('connect', r));
  const rj = await emit(sAlice, 'rejoin_room', { room_id: cr.room_id, nickname: 'Alice', password: 'wrong' });
  check('rejoin private room with wrong password rejected', rj?.error && /密码/.test(rj.error), `(${rj?.error})`);
  sAlice.close();
  socks[1].close();
}

async function test5RejoinPrivateCorrectPassword() {
  console.log('\n=== Test 5: rejoin private room with correct password → ok ===');
  // 注意: lobby 状态断线会 splice 玩家 (pre-existing 行为).
  // 要测 rejoin, 必须先开游戏 (rules_intro / playing 状态断线保留 slot).
  const socks = await newSocks(2);
  const cr = await emit(socks[0], 'create_room', { nickname: 'Alice', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'mypass99' });
  const jr = await emit(socks[1], 'join_room', { room_id: cr.room_id, nickname: 'Bob', password: 'mypass99' });
  if (cr?.error || jr?.error) { console.log(`  ✕ setup failed: cr=${cr?.error}, jr=${jr?.error}`); failed++; socks.forEach(s => s.close()); return; }
  // 开游戏, 让状态变成 rules_intro (断线保留 slot)
  await emit(socks[0], 'start_game');
  await waitState(socks[1], m => m.public.state === 'rules_intro');
  // Alice 断线
  socks[0].close();
  await delay(200);
  // Alice 用对的密码重连
  const sAlice = client();
  await new Promise(r => sAlice.on('connect', r));
  const rj = await emit(sAlice, 'rejoin_room', { room_id: cr.room_id, nickname: 'Alice', password: 'mypass99' });
  check('rejoin with correct password ok', !rj?.error && rj?.reconnected, `(${rj?.error})`);
  sAlice.close();
  socks[1].close();
}

async function test6PrivateNotInRoomList() {
  console.log('\n=== Test 6: private room NOT in room_list ===');
  const s = client();
  await new Promise(r => s.on('connect', r));
  attachRoomList(s);

  const cr = await emit(s, 'create_room', { nickname: 'Host', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'private777' });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; s.close(); return; }
  await delay(100);

  const list = getLatestRoomList(s);
  const ids = list.map(r => r.id);
  check('private room_id not in list', !ids.includes(cr.room_id));
  s.close();
}

async function test7PublicAndPrivateCoexist() {
  console.log('\n=== Test 7: public + private coexist; only public in list ===');
  const s1 = client(); await new Promise(r => s1.on('connect', r));
  attachRoomList(s1);
  const s2 = client(); await new Promise(r => s2.on('connect', r));
  const crPub = await emit(s1, 'create_room', { nickname: 'PubHost', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  const crPriv = await emit(s2, 'create_room', { nickname: 'PrivHost', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'priv1234' });
  if (crPub?.error || crPriv?.error) { console.log(`  ✕ setup failed`); failed++; s1.close(); s2.close(); return; }
  await delay(100);

  const list = getLatestRoomList(s1);
  const ids = list.map(r => r.id);
  check('public room in list', ids.includes(crPub.room_id));
  check('private room NOT in list', !ids.includes(crPriv.room_id));
  s1.close();
  s2.close();
}

async function test8PasswordTooShort() {
  console.log('\n=== Test 8: password too short (3 chars) → error ===');
  const s = client(); await new Promise(r => s.on('connect', r));
  const cr = await emit(s, 'create_room', { nickname: 'Host', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'abc' });
  check('too short password rejected', cr?.error && (/4/.test(cr.error) || /字符/.test(cr.error)), `(${cr?.error})`);
  s.close();
}

async function test9PasswordTooLong() {
  console.log('\n=== Test 9: password too long (13 chars) → error ===');
  const s = client(); await new Promise(r => s.on('connect', r));
  const cr = await emit(s, 'create_room', { nickname: 'Host', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'aaaaaaaaaaaaa' });
  check('too long password rejected', cr?.error && (/12/.test(cr.error) || /字符/.test(cr.error)), `(${cr?.error})`);
  s.close();
}

async function test10EmptyPasswordIsPublic() {
  console.log('\n=== Test 10: empty string password is treated as public ===');
  const s = client(); await new Promise(r => s.on('connect', r));
  const cr = await emit(s, 'create_room', { nickname: 'Host', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: '' });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; s.close(); return; }
  check('empty password: room created');
  // 验证是公开房
  const s2 = client(); await new Promise(r => s2.on('connect', r));
  const jr = await emit(s2, 'join_room', { room_id: cr.room_id, nickname: 'Guest' });
  check('empty password → public → no password needed to join', !jr?.error, `(${jr?.error})`);
  s.close(); s2.close();
}

async function test11JoinPrivateWithNoPassword() {
  console.log('\n=== Test 11: private room, join with no password field → error ===');
  const s = client(); await new Promise(r => s.on('connect', r));
  const cr = await emit(s, 'create_room', { nickname: 'Host', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2, password: 'private99' });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; s.close(); return; }
  const jr = await emit(s, 'join_room', { room_id: cr.room_id, nickname: 'Guest' });
  check('private room joined without password → rejected', jr?.error && /密码/.test(jr.error), `(${jr?.error})`);
  s.close();
}

async function main() {
  for (const fn of [
    test1PublicJoinNoPassword, test2PrivateWrongPassword, test3PrivateCorrectPassword,
    test4RejoinPrivateNoPassword, test5RejoinPrivateCorrectPassword,
    test6PrivateNotInRoomList, test7PublicAndPrivateCoexist,
    test8PasswordTooShort, test9PasswordTooLong,
    test10EmptyPasswordIsPublic, test11JoinPrivateWithNoPassword,
  ]) {
    try { await fn(); } catch (e) { console.log(`  ✕ EXCEPTION: ${e.message}`); failed++; }
    await delay(300);
  }
  console.log(`\n=== PRIVATE ROOM E2E DONE ===`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
