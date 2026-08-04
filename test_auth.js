// test_auth.js — Phase 1: passphrase account system
//
// Coverage:
//   1. Anonymous play still works (no token, no userId)
//   2. Register with valid passphrase returns token + userId
//   3. Login with same passphrase returns same userId
//   4. Login with wrong passphrase fails
//   5. Register with too-short passphrase fails
//   6. Register twice with SAME passphrase → two distinct userIds (display_name not unique)
//   7. Token persists across reconnect → server recognizes userId
//   8. Logout invalidates token
//   9. create_room with token → Player.userId is set
//  10. create_room without token (anonymous) → Player.userId is null
//  11. Two sockets, same token → both recognized as same userId
//  12. get_my_info works for logged-in and anonymous

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://127.0.0.1:3001';
// 每个测试 run 用唯一后缀, 避免多次跑之间 users 累积导致 userId 重复
const RUN_TAG = '_r' + Date.now().toString(36);
const PP = (s) => s + RUN_TAG;  // 加后缀生成 unique passphrase
const client = (token) => io(URL, {
  reconnection: false,
  transports: ['websocket'],
  auth: token ? { token } : {},
});
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
async function newSocks(n, token = null) {
  const socks = [];
  for (let i = 0; i < n; i++) {
    const s = client(token);
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

async function test1Anonymous() {
  console.log('\n=== Test 1: anonymous play (no token) ===');
  const socks = await newSocks(2);
  const r = await emit(socks[0], 'create_room', { nickname: 'Anon1', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  if (r?.error) { console.log(`  ✕ create_room failed: ${r.error}`); failed++; socks.forEach(s => s.close()); return; }
  check('create_room succeeded (anonymous)');
  check('returned userId is null', r.userId === null);
  // wait for state and check player.userId
  const r2 = await emit(socks[1], 'join_room', { room_id: r.room_id, nickname: 'Anon2' });
  if (r2?.error) { console.log(`  ✕ join_room failed: ${r2.error}`); failed++; socks.forEach(s => s.close()); return; }
  await waitState(socks[0], m => m.public.state === 'lobby' && m.public.players.length === 2);
  const st = latest(socks[0]);
  check('both players have userId: null', st.public.players.every(p => p.userId === null));
  socks.forEach(s => s.close());
}

async function test2Register() {
  console.log('\n=== Test 2: register with valid passphrase ===');
  const s = client();
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'register_passphrase', { passphrase: PP('alice_secret_2026'), display_name: 'Alice' });
  if (r?.error) { console.log(`  ✕ register failed: ${r.error}`); failed++; s.close(); return; }
  check('register returned ok', r.ok === true);
  check('register returned token', typeof r.token === 'string' && r.token.length >= 32);
  check('register returned userId (uuid)', /^[0-9a-f-]{36}$/i.test(r.userId || ''));
  check('display_name = "Alice"', r.display_name === 'Alice');
  s.close();
}

async function test3LoginMatch() {
  console.log('\n=== Test 3: login with same passphrase returns same userId ===');
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'register_passphrase', { passphrase: PP('bob_secret_2026'), display_name: 'Bob' });
  if (r1?.error) { console.log(`  ✕ register failed: ${r1.error}`); failed++; s1.close(); return; }
  s1.close();

  const s2 = client();
  await new Promise(r => s2.on('connect', r));
  const r2 = await emit(s2, 'login_passphrase', { passphrase: PP('bob_secret_2026') });
  check('login returned ok', r2?.ok === true);
  check('login returned same userId', r2.userId === r1.userId);
  check('login returned display_name', r2.display_name === 'Bob');
  s2.close();
}

async function test4LoginWrong() {
  console.log('\n=== Test 4: login with wrong passphrase ===');
  const s = client();
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'login_passphrase', { passphrase: PP('totally_wrong_xyz') });
  check('login error', r?.error && /暗号/.test(r.error), `(got: ${JSON.stringify(r)})`);
  s.close();
}

async function test5RegisterTooShort() {
  console.log('\n=== Test 5: register with too-short passphrase ===');
  const s = client();
  await new Promise(r => s.on('connect', r));
  const r = await emit(s, 'register_passphrase', { passphrase: 'abc', display_name: 'X' });
  check('register error', r?.error && /6/.test(r.error), `(got: ${JSON.stringify(r)})`);
  s.close();
}

async function test6RegisterSamePassphrase() {
  console.log('\n=== Test 6: register twice with same passphrase → distinct userIds ===');
  // design: 显示名不强制唯一, 暗号一样也能起两个账号
  // (用户场景: 朋友起名随意)
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'register_passphrase', { passphrase: PP('shared_phrase_2026'), display_name: 'Carol1' });
  s1.close();

  const s2 = client();
  await new Promise(r => s2.on('connect', r));
  const r2 = await emit(s2, 'register_passphrase', { passphrase: PP('shared_phrase_2026'), display_name: 'Carol2' });
  if (r1?.error || r2?.error) {
    console.log(`  ✕ register failed: ${r1?.error || r2?.error}`);
    failed++; s2.close(); return;
  }
  check('two distinct userIds', r1.userId !== r2.userId);
  check('two distinct tokens', r1.token !== r2.token);
  check('display_names preserved', r1.display_name === 'Carol1' && r2.display_name === 'Carol2');
  s2.close();
}

async function test7TokenPersistsReconnect() {
  console.log('\n=== Test 7: token persists across reconnect, server recognizes userId ===');
  // register
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'register_passphrase', { passphrase: PP('dave_pass_2026'), display_name: 'Dave' });
  if (r1?.error) { console.log(`  ✕ register failed: ${r1.error}`); failed++; s1.close(); return; }
  s1.close();
  await delay(100);

  // reconnect with same token
  const s2 = client(r1.token);
  await new Promise(r => s2.on('connect', r));
  // server should emit account_info with logged_in: true
  const accInfo = await new Promise(res => {
    const t = setTimeout(() => res(null), 1000);
    s2.on('account_info', msg => { clearTimeout(t); res(msg); });
  });
  check('account_info received on reconnect', accInfo !== null);
  check('logged_in: true', accInfo?.logged_in === true);
  check('userId preserved', accInfo?.userId === r1.userId);
  s2.close();
}

async function test8Logout() {
  console.log('\n=== Test 8: logout invalidates token ===');
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'register_passphrase', { passphrase: PP('eve_pass_2026'), display_name: 'Eve' });
  if (r1?.error) { console.log(`  ✕ register failed: ${r1.error}`); failed++; s1.close(); return; }
  s1.close();
  await delay(100);

  // reconnect with token, then logout
  const s2 = client(r1.token);
  await new Promise(r => s2.on('connect', r));
  const r2 = await emit(s2, 'logout');
  check('logout ok', r2?.ok === true);
  s2.close();
  await delay(100);

  // reconnect with same (now revoked) token → should be anonymous
  const s3 = client(r1.token);
  await new Promise(r => s3.on('connect', r));
  const accInfo = await new Promise(res => {
    const t = setTimeout(() => res(null), 1000);
    s3.on('account_info', msg => { clearTimeout(t); res(msg); });
  });
  check('after logout, account_info logged_in: false', accInfo?.logged_in === false);
  s3.close();
}

async function test9CreateRoomWithToken() {
  console.log('\n=== Test 9: create_room with token → Player.userId is set ===');
  // register two users
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'register_passphrase', { passphrase: PP('frank_pass_2026'), display_name: 'Frank' });
  s1.close();

  const s2 = client();
  await new Promise(r => s2.on('connect', r));
  const r2 = await emit(s2, 'register_passphrase', { passphrase: PP('gina_pass_2026'), display_name: 'Gina' });
  s2.close();

  // open with Frank's token
  const sFrank = client(r1.token);
  await new Promise(r => sFrank.on('connect', r));
  attachState(sFrank);
  const cr = await emit(sFrank, 'create_room', { nickname: 'FrankInGame', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; sFrank.close(); return; }
  check('create_room userId returned', cr.userId === r1.userId);

  // join with Gina's token
  const sGina = client(r2.token);
  await new Promise(r => sGina.on('connect', r));
  attachState(sGina);
  const jr = await emit(sGina, 'join_room', { room_id: cr.room_id, nickname: 'GinaInGame' });
  if (jr?.error) { console.log(`  ✕ join_room failed: ${jr.error}`); failed++; sFrank.close(); sGina.close(); return; }

  await waitState(sFrank, m => m.public.state === 'lobby' && m.public.players.length === 2);
  const st = latest(sFrank);
  const players = st.public.players;
  check('P0 (Frank) has userId', players[0].userId === r1.userId);
  check('P1 (Gina) has userId', players[1].userId === r2.userId);
  sFrank.close();
  sGina.close();
}

async function test10CreateRoomAnonymous() {
  console.log('\n=== Test 10: create_room without token → Player.userId is null ===');
  const s = client();
  await new Promise(r => s.on('connect', r));
  attachState(s);
  const cr = await emit(s, 'create_room', { nickname: 'Anon', chapter_id: 'ch01_awakening', clock_id: 'c1', max_players: 2 });
  if (cr?.error) { console.log(`  ✕ create_room failed: ${cr.error}`); failed++; s.close(); return; }
  check('create_room userId is null', cr.userId === null);
  // start a 2nd sock to join so we can see the player list
  const s2 = client();
  await new Promise(r => s2.on('connect', r));
  attachState(s2);
  await emit(s2, 'join_room', { room_id: cr.room_id, nickname: 'Anon2' });
  await waitState(s, m => m.public.players.length === 2);
  const st = latest(s);
  check('both players have userId: null', st.public.players.every(p => p.userId === null));
  s.close();
  s2.close();
}

async function test11TwoSocketsSameToken() {
  console.log('\n=== Test 11: two sockets, same token → both same userId ===');
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'register_passphrase', { passphrase: PP('hank_pass_2026'), display_name: 'Hank' });
  s1.close();

  // two sockets both using same token
  const sA = client(r1.token);
  await new Promise(r => sA.on('connect', r));
  const sB = client(r1.token);
  await new Promise(r => sB.on('connect', r));

  // 用 get_my_info 主动取 (account_info 在 connect 时已发, 监听器来不及注册)
  const aInfo = await emit(sA, 'get_my_info');
  const bInfo = await emit(sB, 'get_my_info');
  check('sA: logged_in', aInfo?.logged_in === true);
  check('sB: logged_in', bInfo?.logged_in === true);
  check('same userId on both', aInfo?.userId === bInfo.userId);
  sA.close();
  sB.close();
}

async function test12GetMyInfo() {
  console.log('\n=== Test 12: get_my_info ===');
  // anonymous
  const s1 = client();
  await new Promise(r => s1.on('connect', r));
  const r1 = await emit(s1, 'get_my_info');
  check('anonymous get_my_info: logged_in false', r1?.logged_in === false);

  // register, then get_my_info
  const r2 = await emit(s1, 'register_passphrase', { passphrase: PP('ivy_pass_2026'), display_name: 'Ivy' });
  const r3 = await emit(s1, 'get_my_info');
  check('after register, get_my_info: logged_in true', r3?.logged_in === true);
  check('after register, get_my_info: userId matches', r3?.userId === r2.userId);
  check('after register, get_my_info: display_name matches', r3?.display_name === 'Ivy');
  s1.close();
}

async function main() {
  for (const fn of [
    test1Anonymous, test2Register, test3LoginMatch, test4LoginWrong, test5RegisterTooShort,
    test6RegisterSamePassphrase, test7TokenPersistsReconnect, test8Logout,
    test9CreateRoomWithToken, test10CreateRoomAnonymous, test11TwoSocketsSameToken, test12GetMyInfo,
  ]) {
    try { await fn(); } catch (e) { console.log(`  ✕ EXCEPTION: ${e.message}`); failed++; }
    await delay(300);
  }
  console.log(`\n=== AUTH E2E DONE ===`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
