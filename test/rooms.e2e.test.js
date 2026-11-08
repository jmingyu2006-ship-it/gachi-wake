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
  const st = { wakes: new Map(), rooms: new Map(), members: [], starts: new Map(), targets: new Map(), owners: new Map(), bans: new Set(), accounts: new Map(), reports: [], rc: 0, noFeatures: false, n: 0, calls: [] };
  const newCode = () => { const c = ('RCVY' + String(++st.rc).padStart(8, '7')); return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8); };
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
      return st.rooms.has(c) ? json({ name: st.rooms.get(c), members: active(c).length, lit: active(c).filter(m => [...st.starts.keys()].some(k => k.startsWith(m.anon))).length }) : json({ error: 'room_not_found' });
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
    if (fn === 'app_info') return st.noFeatures ? json({ message: 'unknown' }, 404) : json({ v: 9, features: ['report', 'recovery', 'erase', 'rests', 'cheer', 'funnel', 'days'] });
    if (fn === 'bump_funnel') { st.funnel = st.funnel || []; st.funnel.push(body.p_step); return json(true); }
    if (fn === 'send_cheer') {
      const c = body.p_code;
      if (!isMember(c, body.p_anon)) return json({ error: 'not_member' });
      const t = active(c).find(m => mkey(m.anon, c) === body.p_key);
      if (!t) return json({ error: 'member_not_found' });
      if (t.anon === body.p_anon) return json({ error: 'cannot_cheer_self' });
      if (!st.starts.has(t.anon + body.today_hint) && ![...st.starts.keys()].some(k => k.startsWith(t.anon))) return json({ error: 'not_lit' });
      st.cheers = st.cheers || new Map(); st.cheers.set(c + body.p_anon + t.anon, { from: body.p_anon, to: t.anon, code: c, kind: body.p_kind }); return json({ ok: true });
    }
    if (fn === 'cheers_today') {
      const c = body.p_code; if (!isMember(c, body.p_anon)) return json(null);
      const all = [...(st.cheers || new Map()).values()].filter(x => x.code === c);
      const nick = (a) => (st.members.find(m => m.code === c && m.anon === a) || {}).nick;
      return json({ got: all.filter(x => x.to === body.p_anon).map(x => ({ name: nick(x.from), kind: x.kind, key: mkey(x.from, c) })),
        sent: Object.fromEntries(all.filter(x => x.from === body.p_anon).map(x => [mkey(x.to, c), x.kind])) });
    }
    if (fn === 'sync_rests') {
      if (!st.members.some(m => m.anon === body.p_anon && !banned(m.code, m.anon))) return json(false);
      st.rests = st.rests || new Set(); body.p_days.forEach(d => { if (!st.starts.has(body.p_anon + d)) st.rests.add(body.p_anon + d); }); return json(true);
    }
    if (fn === 'send_report') {
      if (!['feedback', 'report', 'error'].includes(body.p_kind)) return json({ error: 'bad_request' });
      if (body.p_kind === 'feedback' && !String(body.p_body || '').trim()) return json({ error: 'empty' });
      let tname = null;
      if (body.p_kind === 'report') {
        if (!isMember(body.p_room, body.p_anon)) return json({ error: 'not_member' });
        const t = active(body.p_room).find(m => mkey(m.anon, body.p_room) === body.p_target);
        if (!t) return json({ error: 'member_not_found' });
        tname = t.nick;
      }
      st.reports.push({ ...body, target_name: tname }); return json({ ok: true });
    }
    if (fn === 'set_recovery_code') {
      for (const a of st.accounts.values()) if (a.anon === body.p_anon) {
        if (a.pw !== body.p_password) return json({ error: 'wrong_credentials' });
        const c = newCode(); a.rec = c.replace(/-/g, ''); return json({ ok: true, recovery_code: c });
      }
      return json({ error: 'not_linked' });
    }
    if (fn === 'reset_password') {
      const u = String(body.p_username).trim().toLowerCase(), a = st.accounts.get(u), code = String(body.p_code).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!a || !a.rec || a.rec !== code) return json({ error: 'wrong_code' });
      a.pw = body.p_new_password; const c = newCode(); a.rec = c.replace(/-/g, '');
      return json({ ok: true, username: u, anon_id: a.anon, data: a.data, recovery_code: c });
    }
    if (fn === 'delete_my_data') {
      const before = st.members.length;
      st.members = st.members.filter(m => m.anon !== body.p_anon);
      for (const k of [...st.starts.keys()]) if (k.startsWith(body.p_anon)) st.starts.delete(k);
      st.targets.delete(body.p_anon);
      return json({ ok: true, rooms_left: before - st.members.length });
    }
    if (fn === 'set_nickname') {
      const nk = String(body.p_nickname).trim();
      if (!nk || nk.length > 10 || /[<>]/.test(nk)) return json({ message: 'bad_nickname' }, 400);
      if (!body.p_all && !isMember(body.p_code, body.p_anon)) return json({ error: 'not_member' });
      let n = 0;
      for (const m of st.members) if (m.anon === body.p_anon && isMember(m.code, m.anon) && (body.p_all || m.code === body.p_code)) { m.nick = nk; n++; }
      return json({ ok: true, nickname: nk, rooms: n });
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
          const rest = (d) => !!(st.rests && st.rests.has(m.anon + d));
          const week = [0, 1, 2, 3, 4, 5, 6].map(k => has(addDay(day, k - 6)) ? st.starts.get(m.anon + addDay(day, k - 6)) : (rest(addDay(day, k - 6)) ? -1 : null));
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

// 하루 시작 → 불 켜기 연출이 뜨면 '확인'으로 닫기
async function startDay(page) {
  await page.getByRole('button', { name: '하루 시작하기' }).click();
  await page.clock.runFor(400);
  const cer = page.locator('#cer');
  if (await cer.count()) await cer.getByRole('button', { name: '확인' }).click();
}

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
  await startDay(fr);
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
  await startDay(me);
  await me.clock.runFor(1600);
  await me.getByText('모두 켜졌어요! 오늘 2명 전원 하루를 시작했어요').waitFor();
  await fr.clock.runFor(21000);
  await fr.getByText('모두 켜졌어요! 오늘 2명 전원 하루를 시작했어요').waitFor();
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
  await startDay(b);      // 먼저 시작
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
  await startDay(fr);
  await fr.clock.runFor(1600);
  await me.clock.runFor(21000);
  await me.locator('.unit', { hasText: '민수' }).click();
  await me.getByText('오늘 06:50에 시작했어요').waitFor();
  assert.equal(await me.locator('.pstats .stat-num').first().textContent(), '6일');

  // 내 프로필: 기록 없음 → 0일, 오늘 시작하면 1일
  await me.getByRole('button', { name: '닫기' }).click();
  await me.locator('.unit.me').click();
  await me.getByText('오늘 시작하면 1일').waitFor();
  assert.equal(await me.locator('.pstats .stat-num').nth(1).textContent(), '07:45', '내 목표도 올라감 (지금 단계 목표)');
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
  await startDay(a);
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
  await a.getByText('만 14세 이상만 가입할 수 있어요. 약관과 처리방침에 동의해 주세요.').waitFor();
  await a.getByLabel(/만 14세 이상이고/).check();
  await a.locator('#accGo').click();
  await a.getByText('가입했어요 · 복구 코드').waitFor();
  await a.getByRole('button', { name: '저장했어요' }).click();
  await a.getByText('가입했어요. 이제 기록이 계정에 보관돼요.').waitFor();
  const acc = srv.st.accounts.get('minkyu_01');
  assert.ok(acc, '계정 생성');
  assert.equal(acc.data.records.length, 1);
  assert.equal(acc.data.rooms[0].name, '새벽반');
  assert.equal(acc.data.settings.targetMin, 420);
  assert.equal(acc.data.consent.v, 1, '동의 기록이 계정에 남음');

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
  await b.getByText('1 / 66', { exact: true }).waitFor();
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

test('내 이름 바꾸기: 모든 방에 / 이 방에서만, 친구 화면에도 바뀐 이름', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  for (const name of ['새벽반', '스터디']) {
    await me.getByRole('button', { name: '+ 방 만들기' }).click();
    await me.getByLabel('방 이름 (20자까지)').fill(name);
    await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
    await me.getByRole('button', { name: '방 만들기', exact: true }).click();
    await me.getByText("'" + name + "' 방을 만들었어요").waitFor();
    await me.getByRole('button', { name: '닫기' }).click();
  }
  const code1 = [...srv.st.rooms.entries()].find(([, n]) => n === '새벽반')[0];
  const fr = await person('2026-11-09T06:40:00', srv, BASE + '?room=' + code1);
  await onboard(fr);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  // 친구 프로필에는 이름 바꾸기 없음
  await unit(fr, '민규').click();
  assert.equal(await fr.getByRole('button', { name: '이름 바꾸기' }).count(), 0);
  await fr.getByRole('button', { name: '닫기' }).click();

  // 나: 새벽반에서 내 창문 → 이름 바꾸기 (모든 방)
  await me.getByRole('button', { name: '새벽반' }).click();
  await me.clock.runFor(21000);
  await unit(me, '민규').click();
  await me.getByRole('button', { name: '이름 바꾸기' }).click();
  const input = me.getByLabel('새 이름 (10자까지)');
  assert.equal(await input.inputValue(), '민규');
  await input.fill('<>');
  await me.getByRole('button', { name: '이름 저장' }).click();
  await me.getByText('이름은 1~10자로 적어 주세요. < > 는 쓸 수 없어요.').waitFor();
  await input.fill('일찍새');
  assert.equal(await me.getByLabel(/모든 방\(2개\)/).isChecked(), true);
  await me.getByRole('button', { name: '이름 저장' }).click();
  await me.getByText("이름을 '일찍새'(으)로 바꿨어요. 모든 방에 적용됐어요.").waitFor();
  await unit(me, '일찍새 (나)').waitFor();
  assert.deepEqual(srv.st.members.filter(m => m.nick === '일찍새').length, 2);
  // 친구 화면: 다음 새로 고침에 바뀐 이름
  await fr.clock.runFor(21000);
  await unit(fr, '일찍새').waitFor();

  // 이 방에서만
  await unit(me, '일찍새').click();
  await me.getByRole('button', { name: '이름 바꾸기' }).click();
  await me.getByLabel('새 이름 (10자까지)').fill('민규');
  await me.getByLabel(/모든 방/).uncheck();
  await me.getByLabel('새 이름 (10자까지)').press('Enter');
  await me.getByText("이름을 '민규'(으)로 바꿨어요.").waitFor();
  assert.deepEqual(srv.st.members.map(m => [srv.st.rooms.get(m.code), m.nick]).sort(), [['새벽반', '민규'], ['새벽반', '민수'], ['스터디', '일찍새']].sort());
  // 새로 만드는 방에는 마지막 이름이 미리 채워짐
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  assert.equal(await me.getByLabel('방에서 보일 내 이름 (10자까지)').inputValue(), '민규');
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('10대: 방은 만 14세 이상 확인 후에만 만들 수 있고, 한 번 확인하면 다시 묻지 않는다', async () => {
  const srv = mockServer();
  const p = await person('2026-11-09T07:00:00', srv);
  await p.getByRole('button', { name: '목표 정하기' }).click();
  await p.getByRole('button', { name: '다음' }).click();
  await p.getByRole('button', { name: '다음' }).click();
  await p.getByRole('button', { name: '10대' }).click();
  await p.getByRole('button', { name: '시작하기' }).click();
  await p.getByRole('button', { name: '+ 방 만들기' }).click();
  await p.getByLabel('방에서 보일 내 이름 (10자까지)').fill('지우');
  await p.getByRole('button', { name: '방 만들기', exact: true }).click();
  await p.getByText('방은 만 14세 이상만 만들거나 들어갈 수 있어요.').waitFor();
  assert.equal(srv.st.rooms.size, 0, '확인 전엔 서버에 안 감');
  await p.getByLabel(/만 14세 이상이에요/).check();
  await p.getByRole('button', { name: '방 만들기', exact: true }).click();
  await p.getByText("'우리 방' 방을 만들었어요").waitFor();
  await p.getByRole('button', { name: '닫기' }).click();
  await p.getByRole('button', { name: '코드로 들어가기' }).click();
  await p.getByLabel('초대 코드 (6자리)').fill('zzzzzz');
  await p.getByRole('button', { name: '닫기' }).click();
  await p.getByRole('button', { name: '+ 방 만들기' }).click();
  assert.equal(await p.getByLabel(/만 14세 이상이에요/).count(), 0, '다시 묻지 않음');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

const featuresReady = (page) => page.waitForFunction(() => window.__wakeApp && window.__wakeApp.state.features.length > 0);

test('도움: 친구 신고(운영자에게만), 의견 보내기, 서버의 내 기록 지우기', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방 이름 (20자까지)').fill('새벽반');
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText("'새벽반' 방을 만들었어요").waitFor();
  await me.getByRole('button', { name: '닫기' }).click();
  const code = [...srv.st.rooms.keys()][0];
  const fr = await person('2026-11-09T06:40:00', srv, BASE + '?room=' + code);
  await onboard(fr);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  await featuresReady(fr);
  // 친구가 방장(민규)을 신고
  await unit(fr, '민규').click();
  await fr.getByRole('button', { name: '신고하기' }).click();
  await fr.getByRole('button', { name: '신고 보내기' }).click();
  await fr.getByText('신고 이유를 골라 주세요.').waitFor();
  await fr.getByRole('button', { name: '부적절한 이름' }).click();
  await fr.getByLabel('자세한 내용 (선택, 500자까지)').fill('테스트 신고');
  await fr.screenshot({ path: path.join(SHOTS, 'care-report.png') });
  await fr.getByRole('button', { name: '신고 보내기' }).click();
  await fr.getByText('신고를 보냈어요. 확인해 볼게요.').waitFor();
  const rp = srv.st.reports.find(r => r.p_kind === 'report');
  assert.equal(rp.target_name, '민규'); assert.equal(rp.p_reason, '부적절한 이름'); assert.equal(rp.p_room, code); assert.match(rp.p_meta, /^v0\.9\.0 · web · /);
  // 내 프로필에는 신고 버튼 없음
  await unit(fr, '민수').click();
  assert.equal(await fr.locator('#sheetBody').getByRole('button', { name: '신고하기' }).count(), 0);
  await fr.getByRole('button', { name: '닫기' }).click();
  // 의견 보내기
  await featuresReady(me);
  await me.getByRole('button', { name: '목표 설정 열기' }).click();
  await me.getByRole('button', { name: '의견·문의 보내기' }).click();
  await me.getByRole('button', { name: '보내기', exact: true }).click();
  await me.getByText('내용을 적어 주세요.').waitFor();
  await me.getByLabel('내용 (1000자까지)').fill('알림 기능이 있으면 좋겠어요');
  await me.getByRole('button', { name: '보내기', exact: true }).click();
  await me.getByText('보냈어요. 고마워요!').waitFor();
  assert.equal(srv.st.reports.find(r => r.p_kind === 'feedback').p_body, '알림 기능이 있으면 좋겠어요');
  // 친구: 서버의 내 기록 지우기 → 방에서 나감
  await fr.getByRole('button', { name: '목표 설정 열기' }).click();
  await fr.getByRole('button', { name: '서버에 있는 내 기록 지우기' }).click();
  await fr.getByRole('button', { name: '한 번 더 누르면 서버의 내 기록을 지워요' }).click();
  await fr.getByText('서버에 있는 내 기록을 지웠어요. 방에서도 모두 나갔어요.').waitFor();
  assert.equal(await fr.getByRole('button', { name: '새벽반' }).count(), 0);
  assert.equal(srv.st.members.filter(m => m.code === code).length, 1);
  await me.clock.runFor(21000);
  await me.getByText('0명 / 1명이 하루를 시작했어요').waitFor();
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('복구 코드: 가입 때 한 번 보여주고, 다른 기기에서 비밀번호를 잊어도 코드로 새 비밀번호 → 기록이 이어진다', async () => {
  const srv = mockServer();
  const a = await person('2026-11-09T07:05:00', srv);
  await onboard(a);
  await startDay(a);
  await a.clock.runFor(1600);
  await featuresReady(a);
  await a.getByRole('button', { name: '목표 설정 열기' }).click();
  await a.getByRole('button', { name: '가입하기' }).click();
  await a.getByLabel(/^아이디/).fill('minkyu_01');
  await a.getByLabel('비밀번호 (8자 이상)').fill('pass1234');
  await a.getByLabel('비밀번호 확인').fill('pass1234');
  await a.getByLabel(/만 14세 이상이고/).check();
  await a.locator('#accGo').click();
  await a.getByText('가입했어요 · 복구 코드').waitFor();
  const code = await a.locator('#recCode').textContent();
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await a.screenshot({ path: path.join(SHOTS, 'care-recovery.png') });
  await a.getByRole('button', { name: '저장했어요' }).click();
  await a.getByText('가입했어요. 이제 기록이 계정에 보관돼요.').waitFor();

  const b = await person('2026-11-09T08:00:00', srv);
  await featuresReady(b);
  await b.getByRole('button', { name: '이미 계정이 있어요 · 로그인' }).click();
  await b.getByRole('button', { name: '비밀번호를 잊었어요' }).click();
  await b.getByLabel('아이디').fill('minkyu_01');
  await b.getByLabel('복구 코드 (12자리)').fill('WRON-GCOD-EXXX');
  await b.getByLabel('새 비밀번호 (8자 이상)').fill('newpass99');
  await b.getByLabel('새 비밀번호 확인').fill('newpass99');
  await b.locator('#accGo').click();
  await b.getByText('아이디나 복구 코드가 맞지 않아요.').waitFor();
  await b.getByLabel('복구 코드 (12자리)').fill(code.toLowerCase().replace(/-/g, ' '));
  await b.locator('#accGo').click();
  await b.getByText('새 비밀번호로 바꿨어요').waitFor();
  const code2 = await b.locator('#recCode').textContent();
  assert.notEqual(code2, code, '코드는 한 번 쓰면 바뀜');
  await Promise.all([b.waitForEvent('load'), b.getByRole('button', { name: '저장했어요' }).click()]);
  await b.getByRole('button', { name: '습관' }).click();
  await b.getByText('1 / 66', { exact: true }).waitFor();
  assert.equal(srv.st.accounts.get('minkyu_01').pw, 'newpass99');
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  await a.context().close(); await b.context().close();
});

test('서버에 새 기능이 아직 없으면 버튼이 숨고, 화면 오류는 하루 3건까지만 운영자에게 간다', async () => {
  const off = mockServer(); off.st.noFeatures = true;
  const p = await person('2026-11-09T07:05:00', off);
  await onboard(p);
  await p.clock.runFor(1000);
  await p.getByRole('button', { name: '목표 설정 열기' }).click();
  await p.getByRole('button', { name: '저장', exact: true }).waitFor();
  assert.equal(await p.getByRole('button', { name: '의견·문의 보내기' }).count(), 0);
  assert.equal(await p.getByRole('button', { name: '서버에 있는 내 기록 지우기' }).count(), 0);
  await p.context().close();

  const on = mockServer();
  const q = await person('2026-11-09T07:05:00', on);
  await onboard(q);
  await featuresReady(q);
  await q.evaluate(() => {
    for (const m of ['boom-0', 'boom-0', 'Script error.', 'boom-1', 'boom-2', 'boom-3', 'boom-4']) window.dispatchEvent(new ErrorEvent('error', { message: m, error: new Error(m) }));
  });
  for (let i = 0; i < 20 && on.st.reports.filter(r => r.p_kind === 'error').length < 3; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  const errs = on.st.reports.filter(r => r.p_kind === 'error');
  assert.deepEqual(errs.map(e => e.p_body), ['boom-0', 'boom-1', 'boom-2']);
  assert.match(errs[0].p_meta, /v0\.9\.0/);
  await q.context().close();
});

test('보호권으로 쉰 날이 방에도 올라가 친구 프로필에서 방패 칸으로 보이고, 연속이 이어진다', async () => {
  const srv = mockServer();
  // 친구: 11/1~11/7 기록(보호권 1개), 11/8 빠짐(보호), 11/9 기록 예정
  const fr = await person('2026-11-09T06:50:00', srv);
  await fr.evaluate(() => {
    const p2 = (n) => String(n).padStart(2, '0');
    const recs = [1, 2, 3, 4, 5, 6, 7].map(d => { const k = '2026-11-' + p2(d); return { id: 'w-' + k, date: k, wokeAt: k + 'T07:00:00+09:00', minuteOfDay: 420, cohort: '07:00', dayTarget: 420, actionDoneAt: null, greetedAt: null }; });
    localStorage.setItem('gachi-v2-settings', JSON.stringify({ version: 2, baselineMin: 420, targetMin: 420, planStart: '2026-10-01', sleepNeedH: 8, firstAction: '물 한 잔 마시기', age: '20' }));
    localStorage.setItem('gachi-v2-records', JSON.stringify(recs));
  });
  await fr.reload();
  await featuresReady(fr);
  await fr.getByRole('button', { name: '+ 방 만들기' }).click();
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '방 만들기', exact: true }).click();
  await fr.getByText("'우리 방' 방을 만들었어요").waitFor();
  await fr.getByRole('button', { name: '닫기' }).click();
  for (let i = 0; i < 30 && !(srv.st.rests && srv.st.rests.size); i++) await fr.clock.runFor(200);
  assert.equal(srv.st.rests.size, 1, '쉰 날 하루가 서버로');
  const code = [...srv.st.rooms.keys()][0];
  const me = await person('2026-11-09T07:10:00', srv, BASE + '?room=' + code);
  await onboard(me);
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '들어가기', exact: true }).click();
  await me.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  await unit(me, '민수').click();
  assert.equal(await me.locator('#sheetBody .cell.rest').count(), 1, '11/8 칸이 방패');
  assert.equal(await me.locator('#sheetBody .cell.hit').count(), 5, '11/3~11/7');
  await me.getByRole('button', { name: '닫기' }).click();
  // 친구 쪽: 내 프로필 연속 7일(오늘 아직) · 방패 칸
  await unit(fr, '민수').click();
  await fr.locator('#sheetBody .stat-num').first().waitFor();
  assert.equal(await fr.locator('#sheetBody .stat-num').first().textContent(), '7일', '보호권 덕에 연속 7일 (11/8은 세지 않고 이어짐)');
  assert.equal(await fr.locator('#sheetBody .cell.rest').count(), 1);
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('방을 보고 있을 때 친구가 불을 켜면 알려 준다', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText("'우리 방' 방을 만들었어요").waitFor();
  await me.getByRole('button', { name: '닫기' }).click();
  const code = [...srv.st.rooms.keys()][0];
  const fr = await person('2026-11-09T06:40:00', srv, BASE + '?room=' + code);
  await onboard(fr);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  await me.clock.runFor(21000);
  await me.getByText('0명 / 2명이 하루를 시작했어요').waitFor();
  await startDay(fr);
  await me.clock.runFor(21000);
  await me.getByText('민수 님이 불을 켰어요 · 06:40').waitFor();
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});

test('초대받은 사람: 첫 화면에서 방 미리보기(오늘 켜진 수) → 목표 정하고 들어가기 / 응원 주고받기 / 이번 주 함께 켜기', async () => {
  const srv = mockServer();
  const me = await person('2026-11-09T06:30:00', srv);
  await onboard(me);
  await me.getByRole('button', { name: '+ 방 만들기' }).click();
  await me.getByLabel('방 이름 (20자까지)').fill('새벽반');
  await me.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민규');
  await me.getByRole('button', { name: '방 만들기', exact: true }).click();
  await me.getByText("'새벽반' 방을 만들었어요").waitFor();
  await me.getByRole('button', { name: '닫기' }).click();
  await startDay(me);
  const code = [...srv.st.rooms.keys()][0];
  for (let i = 0; i < 20 && !srv.st.starts.size; i++) await me.clock.runFor(200);
  // 친구: 초대 링크로 처음 방문 → 설정 전에 방 미리보기
  const fr = await person('2026-11-09T06:40:00', srv, BASE + '?room=' + code);
  await fr.getByText("'새벽반' 방에 초대받았어요.").waitFor();
  await fr.getByText('지금 1명 중 1명이 오늘 불을 켰어요', { exact: false }).waitFor();
  await fr.screenshot({ path: path.join(SHOTS, 'v09-invite-preview.png') });
  await onboard(fr);
  await fr.getByLabel('방에서 보일 내 이름 (10자까지)').fill('민수');
  await fr.getByRole('button', { name: '들어가기', exact: true }).click();
  await fr.getByText('1명 / 2명이 하루를 시작했어요').waitFor();
  await featuresReady(fr);
  // 이번 주 함께 켜기: 2명 × 4 = 8, 지금 1
  await fr.locator('#roomGoal').getByText('1 / 8').waitFor();
  // 친구가 켜기 전엔 나에게 응원 버튼 대신 안내 (민규는 켰으니 응원 가능)
  await unit(fr, '민규').click();
  await fr.getByRole('button', { name: '☀️ 좋은 아침' }).click();
  await fr.getByText('민규 님에게 ☀️ 좋은 아침을 보냈어요').waitFor();
  assert.equal(await fr.getByRole('button', { name: '☀️ 좋은 아침' }).getAttribute('aria-pressed'), 'true');
  await fr.screenshot({ path: path.join(SHOTS, 'v09-cheer.png') });
  await fr.getByRole('button', { name: '닫기' }).click();
  assert.match(await unit(fr, '민규').textContent(), /☀️/, '내가 보낸 응원 표시');
  // 나: 다음 새로 고침에 응원 도착
  await featuresReady(me);
  await me.clock.runFor(21000);
  await me.clock.runFor(21000);
  await me.getByText('받은 응원 ☀️민수', { exact: false }).waitFor();
  assert.ok(srv.st.funnel.includes('room'), '단계 집계: 방');
  assert.ok(srv.st.funnel.includes('invite_visit') && srv.st.funnel.includes('cheer'));
  assert.deepEqual(me.errors, []); assert.deepEqual(fr.errors, []);
  await me.context().close(); await fr.context().close();
});
