// 05 Test Engineer: '우리 방' 두 사람 흐름 (나·친구 브라우저 2개가 같은 모의 서버를 공유)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_PATH || '/opt/npm-tools/node_modules/playwright');

const WEB = path.join(__dirname, '../dist/web');
const SHOTS = path.join(__dirname, '../shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
let browser, server, BASE;

test.before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(WEB, p);
    if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
});
test.after(async () => { await browser.close(); server.close(); });

// Supabase 함수들을 흉내 내는 모의 서버 (실제 SQL 규칙과 같은 동작만)
const crypto = require('crypto');
const mkey = (anon, code) => crypto.createHash('md5').update(anon + code).digest('hex').slice(0, 12);
const addDay = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function mockServer() {
  const st = { wakes: new Map(), rooms: new Map(), members: [], starts: new Map(), targets: new Map(), owners: new Map(), bans: new Set(), accounts: new Map(), n: 0, calls: [] };
  const banned = (code, anon) => st.bans.has(code + anon);
  const active = (code) => st.members.filter(m => m.code === code && !banned(code, m.anon)).sort((a, b) => a.t - b.t);
  const isMember = (code, anon) => active(code).some(m => m.anon === anon);
  const ownerOf = (code) => { const o = st.owners.get(code); return isMember(code, o) ? o : (active(code)[0] || {}).anon; };
  const handler = async (route) => {
    const req = route.request(), url = req.url();
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.endsWith('/rest/v1/wake_events')) {
      const k = body.anon_id + body.day;
      if (st.wakes.has(k)) return json({ code: '23505' }, 409);
      st.wakes.set(k, body); return route.fulfill({ status: 201, body: '' });
    }
    const fn = url.split('/rpc/')[1];
    st.calls.push(fn);
    if (fn === 'day_counts') {
      const by = {};
      for (const w of st.wakes.values()) if (w.day === body.p_day) by[w.bucket] = (by[w.bucket] || 0) + 1;
      return json(Object.entries(by).map(([b, n]) => ({ bucket: +b, n })));
    }
    if (fn === 'create_room') {
      const code = 'abc' + String(++st.n).padStart(3, '2').replace(/[01]/g, '9');
      st.rooms.set(code, body.p_name);
      st.owners.set(code, body.p_anon);
      st.members.push({ code, anon: body.p_anon, nick: body.p_nickname, t: st.n });
      return json(code);
    }
    if (fn === 'room_preview') {
      const c = body.p_code.toLowerCase();
      return st.rooms.has(c) ? json({ name: st.rooms.get(c), members: active(c).length }) : json({ error: 'room_not_found' });
    }
    if (fn === 'join_room') {
      const c = body.p_code.toLowerCase();
      if (/[<>]/.test(body.p_nickname) || !body.p_nickname.trim() || [...body.p_nickname].length > 10) return json({ message: 'bad_nickname' }, 400);
      if (!st.rooms.has(c)) return json({ error: 'room_not_found' });
      if (banned(c, body.p_anon)) return json({ error: 'banned' });
      const ex = st.members.find(m => m.code === c && m.anon === body.p_anon);
      if (ex) ex.nick = body.p_nickname; else st.members.push({ code: c, anon: body.p_anon, nick: body.p_nickname, t: ++st.n });
      return json({ code: c, name: st.rooms.get(c) });
    }
    if (fn === 'leave_room') { st.members = st.members.filter(m => !(m.code === body.p_code && m.anon === body.p_anon)); return json(true); }
    if (fn === 'room_start') {
      if (!st.members.some(m => m.anon === body.p_anon && !banned(m.code, m.anon))) return json(false);
      const k = body.p_anon + body.p_day;
      if (!st.starts.has(k)) st.starts.set(k, body.p_min);
      return json(true);
    }
    if (fn === 'kick_member') {
      const c = body.p_code;
      if (ownerOf(c) !== body.p_anon) return json({ error: 'not_owner' });
      const t = active(c).find(m => mkey(m.anon, c) === body.p_key);
      if (!t) return json({ error: 'member_not_found' });
      if (t.anon === body.p_anon) return json({ error: 'cannot_kick_self' });
      st.bans.add(c + t.anon); return json({ ok: true });
    }
    if (fn === 'sign_up') {
      const u = String(body.p_username).trim().toLowerCase();
      if (!/^[a-z0-9_.]{4,20}$/.test(u)) return json({ error: 'bad_username' });
      if (String(body.p_password).length < 8) return json({ error: 'bad_password' });
      if (st.accounts.has(u)) return json({ error: 'username_taken' });
      st.accounts.set(u, { pw: body.p_password, anon: body.p_anon, data: body.p_data }); return json({ ok: true, username: u });
    }
    if (fn === 'sign_in') {
      const u = String(body.p_username).trim().toLowerCase(), a = st.accounts.get(u);
      if (!a || a.pw !== body.p_password) return json({ error: 'wrong_credentials' });
      return json({ ok: true, username: u, anon_id: a.anon, data: a.data });
    }
    if (fn === 'save_account') {
      for (const a of st.accounts.values()) if (a.anon === body.p_anon) { a.data = body.p_data; return json(true); }
      return json(false);
    }
    if (fn === 'close_account') {
      for (const [u, a] of st.accounts) if (a.anon === body.p_anon) { if (a.pw !== body.p_password) return json({ error: 'wrong_credentials' }); st.accounts.delete(u); return json({ ok: true }); }
      return json({ error: 'not_linked' });
    }
    if (fn === 'sync_profile') {
      if (!st.members.some(m => m.anon === body.p_anon)) return json(false);
      if (body.p_target != null) st.targets.set(body.p_anon, body.p_target);
      for (const it of body.p_starts || []) if (!st.starts.has(body.p_anon + it.d)) st.starts.set(body.p_anon + it.d, it.m);
      return json(true);
    }
    if (fn === 'room_view') {
      const c = body.p_code.toLowerCase();
      if (!isMember(c, body.p_anon)) return json(null);
      const members = active(c)
        .map(m => {
          const day = body.p_day, has = (d) => st.starts.has(m.anon + d);
          let a = has(day) ? day : addDay(day, -1), streak = 0;
          while (has(a)) { streak++; a = addDay(a, -1); }
          const week = [0, 1, 2, 3, 4, 5, 6].map(k => has(addDay(day, k - 6)) ? st.starts.get(m.anon + addDay(day, k - 6)) : null);
          let days30 = 0; for (let k = 0; k < 30; k++) if (has(addDay(day, -k))) days30++;
          return { key: mkey(m.anon, c), owner: m.anon === ownerOf(c), nickname: m.nick, me: m.anon === body.p_anon, start_min: has(day) ? st.starts.get(m.anon + day) : null,
            target_min: st.targets.has(m.anon) ? st.targets.get(m.anon) : null, joined: day, week, days30, streak };
        });
      return json({ code: c, name: st.rooms.get(c), owner_me: ownerOf(c) === body.p_anon, members });
    }
    return json({ message: 'unknown' }, 404);
  };
  return { st, attach: async (page) => {
    await page.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.GACHI_CONFIG={supabaseUrl:'https://mock.supabase.test',supabaseAnonKey:'k'};" }));
    await page.route('https://mock.supabase.test/**', handler);
  } };
}

async function person(isoLocal, srv, url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR', serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE.replace(/\/$/, '') });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await srv.attach(page);
  await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
  await page.clock.install({ time: new Date(isoLocal + '+09:00') });
  await page.goto(url || BASE);
  return page;
}
async function onboard(page) {
  await page.getByRole('button', { name: '목표 정하기' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '20대' }).click();
  await page.getByRole('button', { name: '시작하기' }).click();
}
const unit = (page, name) => page.locator('.unit', { hasText: name });

test('나와 친구: 방 만들기 → 초대 링크 → 친구 참여 → 서로의 창문이 이름·시각과 함께 켜진다', async () => {
  const srv = mockServer();
  // 나: 06:30에 방을 만든다
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방 이름 (20자까지)').fill('새벽반');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText('방에서 보일 이름을 적어 주세요.').waitFor();       // 빈 이름 막힘
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText("'새벽반' 방을 만들었어요").waitFor();
  await me.getByRole('button', { name: '초대 링크 보내기' }).click();
  await me.getByText('링크를 복사했어요').waitFor();
  const clip = await me.evaluate(() => navigator.clipboard.readText());
  const invite = clip.match(/https:\/\/\S+/)[0];
  assert.match(invite, /^https:\/\/jmingyu2006-ship-it\.github\.io\/gachi-wake\/\?room=[a-z2-9]{6}$/);
  const code = invite.split('room=')[1];
  await me.getByRole('button', { name: '닫기' }).click();
  await me.getByRole('button', { name: '새벽반' }).waitFor();
  await me.getByText('0명 / 1명이 하루를 시작했어요').waitFor();
  assert.match(await unit(me, '민규').textContent(), /민규 \(나\)아직/);

  // 친구: 초대 링크(공개 주소 대신 테스트 서버 주소 + 같은 코드)를 06:42에 연다
  const fr = await person('2026-11-09T06:42:00', srv, BASE + '?room=' + code.toUpperCase());
  await onboard(fr);
  await fr.getByText("'새벽반' 방에 초대됐어요").waitFor();
  await fr.getByText('지금 1명이 있어요').waitFor();
  assert.equal(await fr.evaluate(() => location.search), '', '주소창에서 초대 코드는 지움');
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText("'새벽반' 방에 들어왔어요.").waitFor();
  await fr.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  await fr.getByRole('button', { name: '하루 시작하기' }).click();
  await fr.clock.runFor(1600);
  await fr.getByText('1명 / 2명이 하루를 시작했어요').waitFor();
  assert.match(await unit(fr, '민수').textContent(), /06:42/);
  assert.ok(await unit(fr, '민수').evaluate(e => e.classList.contains('on') && e.classList.contains('me')));

  // 나: 20초 뒤 새로 고침되면 친구 창문이 "민수 06:42"로 켜져 있다
  await me.clock.runFor(21000);
  await me.getByText('1명 / 2명이 하루를 시작했어요').waitFor();
  assert.match(await unit(me, '민수').textContent(), /민수06:42/);
  assert.ok(await unit(me, '민수').evaluate(e => e.classList.contains('on') && !e.classList.contains('me')));
  await me.clock.runFor(1500);
  await me.screenshot({ path: path.join(SHOTS, '10-room-me-before.png') });

  // 나도 시작 → 친구 화면에 "민규" 켜짐
  await me.getByRole('button', { name: '하루 시작하기' }).click();
  await me.clock.runFor(1600);
  await me.getByText('2명 / 2명이 하루를 시작했어요').waitFor();
  await fr.clock.runFor(21000);
  await fr.getByText('2명 / 2명이 하루를 시작했어요').waitFor();
  assert.match(await unit(fr, '민규').textContent(), /민규06:3\d/);
  await fr.clock.runFor(1500);
  await fr.screenshot({ path: path.join(SHOTS, '11-room-friend.png') });

  // 전체 사용자 건물: 이름 없이 2명
  await me.getByRole('button', { name: '전체 사용자' }).click();
  await me.clock.runFor(31000);
  await me.getByText('2명').first().waitFor();
  assert.equal(await me.locator('.unit').count(), 0, '전체 건물에는 이름이 없음');

  // 친구가 방을 나가면 내 방 건물에서 빠진다
  await fr.getByRole('button', { name: '이 방 나가기' }).click();
  await fr.getByRole('button', { name: '한 번 더 누르면 이 방에서 나가요' }).click();
  await fr.getByText("'새벽반' 방에서 나왔어요.").waitFor();
  assert.equal(await fr.getByRole('button', { name: '새벽반' }).count(), 0);
  await me.getByRole('button', { name: '새벽반' }).click();
  await me.clock.runFor(21000);
  await me.getByText('1명 / 1명이 하루를 시작했어요').waitFor();

  // 서버로 보낸 값: 전체 건물엔 익명 id·날짜·구간만
  for (const w of srv.st.wakes.values()) assert.deepEqual(Object.keys(w).sort(), ['anon_id', 'bucket', 'day']);
  assert.deepEqual(me.errors, []);
  assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('이미 하루를 시작한 뒤에 방에 들어가도 내 시각이 방에 올라간다', async () => {
  const srv = mockServer();
  const a = await person('2026-11-09T06:00:00', srv);
  await onboard(a);
  await a.getByRole('button', { name: '+ 방 만들기' }).click();
  await a.getByLabel('방에서 보일 내 이름 (10자까지)').fill('지원');
  await a.getByRole('button', { name: '방 만들기', exact: true }).click();
  await a.getByText('방을 만들었어요').waitFor();
  const code = [...srv.st.rooms.keys()][0];
  const b = await person('2026-11-09T07:05:00', srv);
  await onboard(b);
  await b.getByRole('button', { name: '하루 시작하기' }).click();      // 먼저 시작
  await b.clock.runFor(1600);
  await b.goto(BASE + '?room=' + code);                                 // 그다음 초대 링크
  await b.getByLabel('방에서 보일 내 이름 (10자까지)').fill('하준');
  await b.getByRole('button', { name: '들어가기', exact: true }).click();
  await b.getByText('1명 / 2명이 하루를 시작했어요').waitFor();
  await b.clock.runFor(1500);
  assert.equal(srv.st.starts.size, 1, '들어오자마자 오늘 시작 시각을 방에 보냄');
  await a.clock.runFor(21000);
  await a.locator('.unit.on', { hasText: '하준' }).waitFor();
  await a.context().close(); await b.context().close();
});

test('프로필: 친구 창문을 누르면 연속 기상·목표·최근 7일이 보인다 (방에 들어오기 전 기록 포함)', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText('방을 만들었어요').waitFor();
  await me.getByRole('button', { name: '닫기' }).click();
  const code = [...srv.st.rooms.keys()][0];
  // 친구: 지난 5일(11/4~11/8) 기록이 폰에 있음, 목표 07:00
  const fr = await person('2026-11-09T06:50:00', srv, BASE + '?room=' + code);
  await fr.evaluate(() => {
    const s = { version: 2, baselineMin: 420, targetMin: 420, planStart: '2026-11-01', sleepNeedH: 8, firstAction: '물 한 잔 마시기', age: '20' };
    const mk = (d, m) => ({ id: 'w-' + d, date: d, wokeAt: d + 'T07:00:00+09:00', minuteOfDay: m, cohort: String(Math.floor(m / 60)).padStart(2, '0') + ':' + (m % 60 >= 30 ? '30' : '00'), dayTarget: 420, actionDoneAt: null, greetedAt: null });
    localStorage.setItem('gachi-v2-settings', JSON.stringify(s));
    localStorage.setItem('gachi-v2-records', JSON.stringify([['2026-11-01', 470], ['2026-11-04', 420], ['2026-11-05', 425], ['2026-11-06', 410], ['2026-11-07', 500], ['2026-11-08', 415]].map(x => mk(x[0], x[1]))));
  });
  await fr.goto(BASE + '?room=' + code);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText("'새벽반' 방에 들어왔어요.").waitFor().catch(() => {});
  await fr.getByText(/방에 들어왔어요/).waitFor();
  await fr.clock.runFor(1500);
  assert.ok(srv.st.calls.includes('sync_profile'), '들어가자마자 기록을 올림');

  await me.clock.runFor(21000);
  await me.locator('.unit', { hasText: '민수' }).click();
  await me.getByRole('heading', { name: '민수' }).waitFor();
  const stats = await me.locator('.pstats .stat-num').allTextContents();
  assert.deepEqual(stats, ['5일', '07:00', '6일']);
  await me.getByText('어제까지 · 오늘 하면 6일').waitFor();
  await me.getByText('오늘은 아직이에요').waitFor();
  assert.equal(await me.locator('#sheetBody .cell.hit').count(), 4);   // 11/4·5·6·8
  assert.equal(await me.locator('#sheetBody .cell.late').count(), 1);  // 11/7 08:20
  await me.getByText('목표 달성 4일').waitFor();
  await me.clock.runFor(600);
  await me.screenshot({ path: path.join(SHOTS, '12-profile.png') });
  await me.getByRole('button', { name: '닫기' }).click();

  // 친구가 오늘 시작하면 연속 6일
  await fr.getByRole('button', { name: '하루 시작하기' }).click();
  await fr.clock.runFor(1600);
  await me.clock.runFor(21000);
  await me.locator('.unit', { hasText: '민수' }).click();
  await me.getByText('오늘 06:50에 시작했어요').waitFor();
  assert.equal(await me.locator('.pstats .stat-num').first().textContent(), '6일');

  // 내 프로필: 기록 없음 → 0일, 오늘 시작하면 1일
  await me.getByRole('button', { name: '닫기' }).click();
  await me.locator('.unit.me').click();
  await me.getByText('오늘 시작하면 1일').waitFor();
  assert.equal(await me.locator('.pstats .stat-num').nth(1).textContent(), '07:00', '내 목표도 올라감');
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('잘못된 초대 링크·이름 오류 안내', async () => {
  const srv = mockServer();
  const p = await person('2026-11-09T07:00:00', srv, BASE + '?room=zzzzzz');
  await onboard(p);
  await p.getByText('방을 찾을 수 없어요').waitFor();
  await p.getByRole('button', { name: '+ 방 만들기' }).click();
  await p.getByLabel('방에서 보일 내 이름 (10자까지)').fill('<b>');
  await p.getByLabel('방 이름 (20자까지)').fill('   ');
  await p.getByRole('button', { name: '방 만들기', exact: true }).click();
  await p.getByText('방 이름은 1~20자로 적어 주세요.').waitFor();
  assert.equal(await p.getByLabel('방 이름 (20자까지)').getAttribute('maxlength'), '20');
  assert.equal(await p.getByLabel('방에서 보일 내 이름 (10자까지)').getAttribute('maxlength'), '10');
  await p.context().close();
});

test('서버 없는 미리보기에서는 방 버튼이 보이지 않는다', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.clock.install({ time: new Date('2026-11-09T07:00:00+09:00') });
  await page.goto('file://' + path.join(__dirname, '../dist/artifact/index.html'));
  await onboard(page);
  await page.getByRole('button', { name: '하루 시작하기' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '+ 방 만들기' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '코드로 들어가기' }).count(), 0);
  await context.close();
});

test('방장: 친구를 내보내면 친구 화면에서 방이 사라지고 다시 못 들어온다, 방장 아닌 사람에겐 내보내기 버튼이 없다', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방 이름 (20자까지)').fill('새벽반');
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText('방을 만들었어요').waitFor();
  await me.getByRole('button', { name: '닫기' }).click();
  const code = [...srv.st.rooms.keys()][0];
  const fr = await person('2026-11-09T06:40:00', srv, BASE + '?room=' + code);
  await onboard(fr);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  // 친구가 보는 방장 표시, 내보내기 버튼 없음
  await fr.locator('.unit', { hasText: '민규' }).click();
  await fr.locator('#sheetBody .tag', { hasText: '방장' }).waitFor();
  assert.equal(await fr.getByRole('button', { name: '이 방에서 내보내기' }).count(), 0);
  await fr.getByRole('button', { name: '닫기' }).click();
  // 방장이 내보내기 (두 번 눌러야)
  await me.clock.runFor(21000);
  await me.locator('.unit', { hasText: '민수' }).click();
  await me.getByRole('button', { name: '이 방에서 내보내기' }).click();
  await me.getByRole('button', { name: '한 번 더 누르면 민수 님을 내보내요' }).click();
  await me.getByText('민수 님을 내보냈어요.').waitFor();
  await me.getByText('0명 / 1명이 하루를 시작했어요').waitFor();
  // 친구 화면: 다음 새로 고침에 방이 사라짐
  await fr.clock.runFor(21000);
  await fr.getByText("'새벽반' 방에서 나가게 됐어요.").waitFor();
  assert.equal(await fr.getByRole('button', { name: '새벽반' }).count(), 0);
  // 같은 초대 링크로 다시 들어가기 → 막힘
  await fr.goto(BASE + '?room=' + code);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText('이 방에는 다시 들어갈 수 없어요.').waitFor();
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('계정: 한 기기에서 가입 → 다른 기기에서 로그인하면 기록·목표·방이 이어지고, 로그아웃하면 처음 화면', async () => {
  const srv = mockServer();
  const a = await person('2026-11-09T07:05:00', srv);
  await onboard(a);
  await a.getByRole('button', { name: '하루 시작하기' }).click();
  await a.clock.runFor(1600);
  await a.getByRole('button', { name: '+ 방 만들기' }).click();
  await a.getByLabel('방 이름 (20자까지)').fill('새벽반');
  await a.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await a.getByRole('button', { name: '방 만들기', exact: true }).click();
  await a.getByText('방을 만들었어요').waitFor();
  await a.getByRole('button', { name: '닫기' }).click();
  // 가입 (오류 먼저)
  await a.getByRole('button', { name: '목표 설정 열기' }).click();
  await a.getByRole('button', { name: '가입하기' }).click();
  await a.getByLabel(/^아이디/).fill('ab');
  await a.getByLabel('비밀번호 (8자 이상)').fill('pass1234');
  await a.getByLabel('비밀번호 확인').fill('pass1234');
  await a.locator('#accGo').click();
  await a.getByText('아이디는 영문 소문자·숫자·_ . 로 4~20자예요.').waitFor();
  await a.getByLabel(/^아이디/).fill('Minkyu_01');
  await a.getByLabel('비밀번호 확인').fill('pass1235');
  await a.locator('#accGo').click();
  await a.getByText('비밀번호 확인이 달라요.').waitFor();
  await a.getByLabel('비밀번호 확인').fill('pass1234');
  await a.locator('#accGo').click();
  await a.getByText('가입했어요. 이제 기록이 계정에 보관돼요.').waitFor();
  const acc = srv.st.accounts.get('minkyu_01');
  assert.ok(acc, '계정 생성');
  assert.equal(acc.data.records.length, 1);
  assert.equal(acc.data.rooms[0].name, '새벽반');
  assert.equal(acc.data.settings.targetMin, 420);

  // 다른 기기: 처음 화면에서 로그인
  const b = await person('2026-11-09T08:00:00', srv);
  await b.getByRole('button', { name: '이미 계정이 있어요 · 로그인' }).click();
  await b.getByLabel(/^아이디/).fill('minkyu_01');
  await b.getByLabel('비밀번호 (8자 이상)').fill('wrongpass');
  await b.locator('#accGo').click();
  await b.getByText('아이디나 비밀번호가 맞지 않아요.').waitFor();
  await b.getByLabel('비밀번호 (8자 이상)').fill('pass1234');
  await b.locator('#accGo').click();
  await b.waitForLoadState('load');
  await b.getByRole('button', { name: '새벽반' }).waitFor();
  assert.equal(await b.locator('#ob').isVisible(), false, '다시 목표를 정하지 않아도 됨');
  await b.getByRole('button', { name: '새벽반' }).click();
  await b.getByText('1명 / 1명이 하루를 시작했어요').waitFor();
  assert.equal(await b.locator('.unit.me.on').count(), 1, '같은 사람으로 이어짐');
  await b.getByRole('button', { name: '습관' }).click();
  await b.getByText('1 / 66일').waitFor();
  // 로그아웃 → 처음 화면
  await b.getByRole('button', { name: '목표 설정 열기' }).click();
  await b.getByText('@minkyu_01').waitFor();
  await b.getByRole('button', { name: '로그아웃' }).click();
  await b.getByRole('button', { name: '한 번 더 누르면 로그아웃' }).click();
  await b.waitForLoadState('load');
  await b.getByRole('button', { name: '목표 정하기' }).waitFor();
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  await a.context().close(); await b.context().close();
});

test('초대 코드만 쳐서 들어가기: 틀린 코드 안내 → 대문자·띄어쓰기로 쳐도 들어가짐, 이미 있는 방은 그 방으로', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방 이름 (20자까지)').fill('새벽반');
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText("'새벽반' 방을 만들었어요").waitFor();
  const code = await me.locator('#sheetBody .code').textContent();
  assert.match(code, /^[a-z2-9]{6}$/);
  await me.getByRole('button', { name: '닫기' }).click();

  // 친구: 링크 없이 사이트만 열고 코드를 친다
  const fr = await person('2026-11-09T06:40:00', srv);
  await onboard(fr);
  await fr.getByRole('button', { name: '코드로 들어가기' }).click();
  const input = fr.getByLabel('초대 코드 (6자리)');
  await input.fill('abc');
  await fr.getByRole('button', { name: '다음' }).click();
  await fr.getByText('초대 코드는 영문 소문자와 숫자 6자리예요.').waitFor();
  await input.fill('zzzzzz');
  await input.press('Enter');
  await fr.getByText('방을 찾을 수 없어요. 초대 코드나 링크를 다시 확인해 주세요.').waitFor();
  assert.equal(await fr.locator('#sheetTitle').textContent(), '초대 코드로 들어가기', '틀리면 입력 화면에 그대로');
  await input.fill(' ' + code.toUpperCase().slice(0, 3) + ' ' + code.toUpperCase().slice(3) + ' ');
  await fr.screenshot({ path: path.join(SHOTS, 'code-join.png') });
  await fr.getByRole('button', { name: '다음' }).click();
  await fr.getByText("'새벽반' 방에 초대됐어요").waitFor();
  await fr.getByText('지금 1명이 있어요').waitFor();
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText("'새벽반' 방에 들어왔어요.").waitFor();
  await fr.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  assert.equal(srv.st.members.filter(m => m.code === code).length, 2);

  // 이미 들어와 있는 방 코드 → 그 방으로 이동
  await fr.getByRole('button', { name: '전체 사용자' }).click();
  await fr.getByRole('button', { name: '코드로 들어가기' }).click();
  await fr.getByLabel('초대 코드 (6자리)').fill(code);
  await fr.getByRole('button', { name: '다음' }).click();
  await fr.getByText('이미 들어와 있는 방이에요.').waitFor();
  assert.equal(await fr.getByRole('button', { name: '새벽반' }).getAttribute('aria-pressed'), 'true');
  assert.equal(srv.st.members.filter(m => m.code === code).length, 2, '두 번 들어가지 않음');
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});
