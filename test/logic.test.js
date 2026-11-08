// 05 Test Engineer: v0.2 완료 조건 로직 테스트 (의존성 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic.js');
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0);
const S = (o = {}) => L.makeSettings(Object.assign({ baselineMin: 480, targetMin: 420, sleepNeedH: 8, firstAction: '커튼 열고 햇빛 보기' }, o), '2026-11-09');

test('목표 설정: 정상 입력은 저장되고, 범위 밖·5분 단위가 아닌 값은 거부된다', () => {
  assert.equal(S().ok, true);
  assert.equal(S({ targetMin: 200 }).ok, false);
  assert.equal(S({ targetMin: 725 }).ok, false);
  assert.equal(S({ targetMin: 421 }).ok, false);
  assert.equal(S({ sleepNeedH: 6 }).ok, false);
  assert.equal(S({ firstAction: '' }).ok, false, '빈 첫 행동');
  assert.equal(S({ firstAction: '   ' }).ok, false, '공백만');
});

test('첫 행동 입력: 20자까지 자르고 태그·제어문자는 지운다', () => {
  assert.equal(L.sanitizeAction('  물   한 잔  '), '물 한 잔');
  assert.equal(L.sanitizeAction('<b>스트레칭</b>'), 'b스트레칭/b');
  assert.equal(Array.from(L.sanitizeAction('가'.repeat(50))).length, 20);
  assert.equal(L.sanitizeAction(null), '');
});

test('단계 목표: 평소 08:00 → 목표 07:00이면 첫 단계 07:45, 기록을 보고 앞당기기 전까지 그대로', () => {
  const s = S().settings;
  assert.equal(s.cur, 465);
  assert.equal(L.planTargetFor(s, '2026-11-09'), 465); // 07:45
  assert.equal(L.planTargetFor(s, '2026-12-30'), 465, '날짜가 지나도 저절로 당겨지지 않음');
  const info = L.planInfo(s, '2026-11-09');
  assert.equal(info.stepping, true); assert.equal(info.stepsLeft, 3);
  assert.equal(L.planTargetFor(L.withStep(s, 450), '2026-11-12'), 450);
  assert.equal(L.planTargetFor(L.withStep(s, 300), '2026-11-12'), 420, '최종 목표보다 앞당기지 않음');
  assert.equal(L.planTargetFor(L.withStep(s, 600), '2026-11-12'), 480, '평소보다 늦추지 않음');
  // 예전 설정(cur 없음)은 날짜 기준 그대로 → 불러올 때 오늘 값으로 고정
  const legacy = { ...s }; delete legacy.cur;
  assert.equal(L.planTargetFor(legacy, '2026-11-12'), 450);
  assert.equal(L.planTargetFor(legacy, '2026-11-18'), 420);
  assert.equal(L.migrateSettings(legacy, '2026-11-12').cur, 450);
  assert.equal(L.migrateSettings(s, '2026-11-12'), s, '이미 cur가 있으면 그대로');
  assert.deepEqual(L.validateSettings(L.withStep(s, 450)), []);
  assert.ok(L.validateSettings({ ...s, cur: 455 + 1 }).length, '5분 단위');
});

test('단계 목표: 차이가 30분 이하이거나 목표가 더 늦으면 바로 최종 목표', () => {
  assert.equal(L.planTargetFor(S({ baselineMin: 450 }).settings, '2026-11-09'), 420);
  assert.equal(L.planTargetFor(S({ baselineMin: 400, targetMin: 480 }).settings, '2026-11-09'), 480);
  assert.equal(L.planInfo(S({ baselineMin: 450 }).settings, '2026-11-09').stepping, false);
});

test('정상 입력: 하루 시작을 누르면 그날의 목표가 함께 저장되고 판정된다', () => {
  const s = S().settings;
  const r = L.createStartRecord([], at(2026, 11, 9, 7, 40), s);
  assert.equal(r.ok, true);
  assert.equal(r.record.dayTarget, 465);
  assert.deepEqual(L.evaluate(r.record), { status: 'hit', diff: -5 });
  assert.deepEqual(L.validateRecord(r.record), []);
});

test('판정 경계: -30분~+15분 달성, 그보다 일찍은 많이 일찍, +16~60분 아쉬움, +61분 늦음', () => {
  const s = S({ baselineMin: 420 }).settings; // 목표 07:00 바로
  const ev = (h, m) => L.evaluate(L.createStartRecord([], at(2026, 11, 9, h, m), s).record).status;
  assert.equal(ev(4, 0), 'early', '목표 07:00인데 04:00은 달성이 아님 (일찍보다 일정하게)');
  assert.equal(ev(6, 29), 'early');
  assert.equal(ev(6, 30), 'hit');
  assert.equal(ev(6, 10), 'early');
  assert.equal(ev(7, 15), 'hit');
  assert.equal(ev(7, 16), 'close');
  assert.equal(ev(8, 0), 'close');
  assert.equal(ev(8, 1), 'late');
});

test('같은 날 두 번 눌러도 1건, 처음 시각 유지 / 인정 시간 밖은 거부', () => {
  const s = S().settings;
  const a = L.createStartRecord([], at(2026, 11, 9, 7, 40), s);
  const b = L.createStartRecord(a.records, at(2026, 11, 9, 7, 55), s);
  assert.equal(b.created, false);
  assert.equal(b.records.length, 1);
  assert.equal(L.createStartRecord([], at(2026, 11, 9, 3, 59), s).reason, 'too-early');
  assert.equal(L.createStartRecord([], at(2026, 11, 9, 14, 0), s).reason, 'too-late');
});

test('첫 행동 체크는 하루 한 번, 원본은 바뀌지 않는다', () => {
  const rec = L.createStartRecord([], at(2026, 11, 9, 7, 40), S().settings).record;
  const m1 = L.markAction(rec, at(2026, 11, 9, 7, 45));
  assert.equal(m1.ok, true);
  assert.equal(rec.actionDoneAt, null);
  assert.equal(L.markAction(m1.record, at(2026, 11, 9, 7, 50)).reason, 'already');
});

test('v0.1 기록(목표 없음)도 읽히고 판정은 none', () => {
  const v1 = { id: 'w-2026-11-08', date: '2026-11-08', wokeAt: '2026-11-08T06:42:00+09:00', minuteOfDay: 402, cohort: '06:30', greetedAt: null };
  const out = L.cleanRecords([v1]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dayTarget, null);
  assert.equal(L.evaluate(out[0]).status, 'none');
});

test('빈 입력·깨진 입력·길이 초과는 걸러진다', () => {
  for (const bad of [null, undefined, '', 'x', 42, {}, [null, 1, {}]]) assert.deepEqual(L.cleanRecords(bad), []);
  const huge = 'x'.repeat(1_000_000);
  const junk = Array.from({ length: 10000 }, () => ({ id: huge, date: huge, wokeAt: huge, minuteOfDay: 400, cohort: '06:30' }));
  const t0 = Date.now();
  assert.deepEqual(L.cleanRecords(junk), []);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(L.validateRecord({ id: 'w-2026-11-09', date: '2026-11-09', wokeAt: '2026-11-09T07:00:00+09:00', minuteOfDay: 420, cohort: '07:00', dayTarget: 9999 }).includes('dayTarget 범위 오류'));
});

test('저장 후 재접속: JSON 왕복 후 같은 기록', () => {
  const s = S().settings;
  let recs = L.createStartRecord([], at(2026, 11, 9, 7, 40), s).records;
  recs = recs.map(r => L.markAction(r, at(2026, 11, 9, 7, 41)).record);
  recs = L.createStartRecord(recs, at(2026, 11, 10, 8, 30), s).records;
  assert.deepEqual(L.cleanRecords(JSON.parse(JSON.stringify(recs))), recs);
});

test('습관 지표: 이번 주 칸, 최근 7일 달성, 흔들림, 주말 차이, 66일 여정', () => {
  const s = L.makeSettings({ baselineMin: 420, targetMin: 420, sleepNeedH: 8, firstAction: '물 한 잔' }, '2026-11-02').settings;
  let recs = [];
  const add = (d, h, m) => { recs = L.createStartRecord(recs, at(2026, 11, d, h, m), s).records; };
  add(2, 7, 0); add(3, 7, 10); add(4, 6, 50); add(5, 7, 5); add(6, 7, 0); add(7, 8, 30); add(8, 8, 50); // 토·일 늦게
  add(9, 7, 0); add(10, 7, 20);
  const st = L.habitStats(recs, '2026-11-11', s);
  assert.deepEqual(st.week.map(d => d.label), ['월', '화', '수', '목', '금', '토', '일']);
  assert.equal(st.week[0].key, '2026-11-09');
  assert.equal(st.week[0].status, 'hit');
  assert.equal(st.week[1].status, 'close');
  assert.equal(st.week[2].isToday, true);
  assert.equal(st.weekCount, 2);
  assert.equal(st.rec7, 6); // 11/5~11/11 중 기록 6일
  assert.equal(st.hit7, 3); // 11/5, 11/6, 11/9
  assert.ok(st.wobble > 0);
  assert.ok(st.weekendGap > 60, 'weekendGap=' + st.weekendGap);
  assert.equal(st.journeyDays, 9);
  assert.equal(st.last14.length, 14);
  assert.equal(st.last14.at(-1).key, '2026-11-11');
  const empty = L.habitStats([], '2026-11-11', s);
  assert.equal(empty.wobble, null);
  assert.equal(empty.weekendGap, null);
  assert.equal(empty.journeyDays, 0);
});

test('취침 권장: 목표 07:00, 8시간 → 23:00 / 목표 05:00, 9시간 → 20:00', () => {
  assert.equal(L.bedtimeFor(420, 8), '23:00');
  assert.equal(L.bedtimeFor(300, 9), '20:00');
  assert.equal(L.bedtimeFor(240, 7), '21:00');
});

test('창문: 1칸 = 1명, 날짜마다 같은 배치, 내 창문은 다른 사람에게 안 쓰임', () => {
  const a = L.litWindows(40, '2026-11-09', 5);
  assert.deepEqual(a, L.litWindows(40, '2026-11-09', 5));
  assert.equal(a.per, 1);
  assert.equal(a.total, 96);
  assert.equal(a.lit.length, 40);
  assert.ok(!a.lit.includes(5));
  assert.equal(new Set(a.lit).size, 40);
  assert.equal(L.litWindows(0, '2026-11-09', 5).lit.length, 0);
  assert.ok(L.myWindow('abc') >= 0 && L.myWindow('abc') < 96);
});

test('창문: 96명을 넘으면 층이 올라가고, 이미 켜진 칸 자리는 그대로, 480칸 넘으면 외 N명', () => {
  assert.equal(L.buildingSize(95), 96);
  assert.equal(L.buildingSize(96), 108);   // 나까지 97명 → 9층
  const before = L.litWindows(90, '2026-11-09', 5);
  const after = L.litWindows(130, '2026-11-09', 5);
  assert.equal(after.total, 132);
  assert.equal(after.lit.length, 130);
  assert.deepEqual(after.lit.slice(0, 90), before.lit, '먼저 켜진 90칸은 같은 자리');
  const big = L.litWindows(1000, '2026-11-09', 5);
  assert.equal(big.total, 480);
  assert.equal(big.lit.length, 479);
  assert.equal(big.overflow, 521);
});

test('우리 방: 초대 코드 읽기, 초대 링크, 닉네임 정리', () => {
  assert.equal(L.parseRoomCode('?room=47SEAY'), '47seay');
  assert.equal(L.parseRoomCode('https://x.github.io/gachi-wake/?a=1&room=47seay#top'), '47seay');
  assert.equal(L.parseRoomCode('47seay'), '47seay');
  assert.equal(L.parseRoomCode('?room=47sea1'), null, '1은 코드에 쓰지 않음');
  assert.equal(L.parseRoomCode('?room=<script>'), null);
  // 직접 친 코드
  assert.equal(L.parseRoomCode('  47S EAY '), '47seay', '대문자·띄어쓰기');
  assert.equal(L.parseRoomCode('47s-eay'), '47seay', '하이픈');
  assert.equal(L.parseRoomCode('47ㄴㄷ묘'), '47seay', '한글 자판: s=ㄴ e=ㄷ a=ㅁ y=ㅛ');
  assert.equal(L.parseRoomCode('아ㅠ2ㅊ3'), 'dkb2c3', '완성된 글자도 자판 위치로 (아=d+k)');
  assert.equal(L.parseRoomCode('ㅏ므ㅔ3ㅔ'), 'kamp3p', '모음으로 시작');
  assert.equal(L.parseRoomCode("'새벽반' 방에서 같이 일어나자! https://x.github.io/gachi-wake/?room=47seay"), '47seay', '공유 문구째 붙여 넣기');
  assert.equal(L.parseRoomCode('47sea'), null, '5자리');
  assert.equal(L.parseRoomCode('?room=%E0%A4%A'), null, '깨진 주소');
  assert.equal(L.parseRoomCode(''), null);
  assert.equal(L.inviteUrl('https://x.github.io/gachi-wake/', '47seay'), 'https://x.github.io/gachi-wake/?room=47seay');
  assert.equal(L.inviteUrl('', '47seay'), '');
  assert.equal(L.sanitizeName('  민<b>수  ', 10), '민b수');
  assert.equal(Array.from(L.sanitizeName('가'.repeat(30), 10)).length, 10);
});

test('우리 방: 서버 결과를 창문 칸으로, 내 기록은 서버에 아직 없어도 켜짐', () => {
  const view = { code: '47seay', name: '우리 방', members: [
    { nickname: '민규', start_min: null, me: true },
    { nickname: '민수', start_min: 402, me: false },
    { nickname: '지원', start_min: null, me: false }] };
  const a = L.roomSlots(view, null);
  assert.deepEqual(a.slots.map(s => [s.name, s.time, s.me]), [['민규', null, true], ['민수', '06:42', false], ['지원', null, false]]);
  assert.equal(a.started, 1);
  const b = L.roomSlots(view, 435);
  assert.equal(b.slots[0].time, '07:15');
  assert.equal(b.started, 2);
  assert.equal(L.roomSlots(null).total, 0);
});

test('방 프로필: 서버 값 → 연속 일수·목표·최근 7일(요일·달성 색)·평균·함께한 날', () => {
  const m = { nickname: '민수', me: false, start_min: 405, target_min: 420, joined: '2026-11-02', streak: 6, days30: 7,
    week: [null, 430, 420, 395, 410, 500, 405] };
  const p = L.profileFromMember(m, '2026-11-08'); // 일요일
  assert.equal(p.name, '민수');
  assert.equal(p.streak, 6);
  assert.equal(p.target, '07:00');
  assert.equal(p.today, '06:45');
  assert.deepEqual(p.week.map(d => d.label), ['월', '화', '수', '목', '금', '토', '일']);
  assert.equal(p.week[0].key, '2026-11-02');
  assert.equal(p.week[6].isToday, true);
  assert.deepEqual(p.week.map(d => d.status), [null, 'hit', 'hit', 'hit', 'hit', 'late', 'hit']);
  assert.equal(p.hits, 5);
  assert.equal(p.weekCount, 6);
  assert.equal(p.avg7, '07:07');
  assert.equal(p.days30, 7);
  assert.equal(p.joinedDays, 7);
  // 목표가 없거나 이상한 값이면 안전하게
  const q = L.profileFromMember({ nickname: '<b>지원', streak: -3, days30: 'x', week: 'oops', joined: 'bad', target_min: null }, '2026-11-08');
  assert.equal(q.name, 'b지원');
  assert.equal(q.streak, 0);
  assert.equal(q.days30, 0);
  assert.equal(q.week.length, 7);
  assert.equal(q.target, null);
  assert.equal(q.avg7, null);
  assert.equal(q.joinedDays, null);
});

test('방에 올릴 기록: 최근 66일만, 날짜·분만', () => {
  const s = L.makeSettings({ baselineMin: 420, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-08-01').settings;
  let recs = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date(2026, 7, 1 + i, 7, 0);
    recs = L.createStartRecord(recs, d, s).records;
  }
  const out = L.recentStarts(recs, '2026-11-08');
  assert.equal(out.length, 67);
  assert.deepEqual(Object.keys(out[0]).sort(), ['d', 'm']);
  assert.equal(out.at(-1).d, '2026-11-08');
  assert.equal(out[0].d, '2026-09-03');
});

test('서버 전송: 익명 id·날짜·30분 구간만 보낸다 (정확한 분·첫 행동은 안 보냄)', () => {
  const rec = L.createStartRecord([], at(2026, 11, 9, 7, 40), S().settings).record;
  const p = L.serverPayload(rec, 'anon-1');
  assert.deepEqual(p, { anon_id: 'anon-1', day: '2026-11-09', bucket: 15 });
  assert.deepEqual(Object.keys(p).sort(), ['anon_id', 'bucket', 'day']);
});

test('서버 응답 해석: 이상한 값은 무시하고 20칸으로 맞춘다', () => {
  const out = L.parseServerCounts([{ bucket: 8, n: 3 }, { bucket: 15, n: '12' }, { bucket: 2, n: 9 }, { bucket: 15.5, n: 1 }, { bucket: 9, n: -4 }, null]);
  assert.equal(out.length, 20);
  assert.equal(out[0], 3);
  assert.equal(out[7], 12);
  assert.equal(out[1], 0);
  assert.deepEqual(L.parseServerCounts('oops'), new Array(20).fill(0));
});

test('예시 군중: 날짜 고정, 합계 약 60명(친구 규모), 시간이 갈수록 줄지 않음', () => {
  const c = L.crowdForDay('2026-11-09');
  assert.deepEqual(c, L.crowdForDay('2026-11-09'));
  assert.ok(Math.abs(c.reduce((x, y) => x + y, 0) - 60) <= 5);
  let prev = -1;
  for (let m = 200; m <= 900; m += 7) { const v = L.awakeUntil(c, m); assert.ok(v >= prev); prev = v; }
});

test('계정: 아이디·비밀번호 규칙', () => {
  assert.equal(L.validUsername(' Minkyu_01 '), true);
  assert.equal(L.normUsername(' Minkyu_01 '), 'minkyu_01');
  assert.equal(L.validUsername('abc'), false);
  assert.equal(L.validUsername('한글아이디'), false);
  assert.equal(L.validUsername('a'.repeat(21)), false);
  assert.equal(L.validPassword('1234567'), false);
  assert.equal(L.validPassword('12345678'), true);
  assert.equal(L.validPassword('x'.repeat(65)), false);
});

test('계정: 로그인 시 계정 기록 + 이 기기 기록을 합치고, 목표는 계정 것 우선', () => {
  const sA = L.makeSettings({ baselineMin: 480, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-11-01').settings;
  const sB = L.makeSettings({ baselineMin: 450, targetMin: 400, sleepNeedH: 9, firstAction: '커튼' }, '2026-11-05').settings;
  const r1 = L.createStartRecord([], new Date(2026, 10, 3, 7, 0), sA).records;
  const r2 = L.createStartRecord([], new Date(2026, 10, 7, 6, 50), sB).records;
  const remote = L.accountData(sA, r1, [{ code: 'abc234', name: '새벽반' }], '민규');
  const local = L.accountData(sB, r2, [{ code: 'xyz789', name: '<b>' }, { code: 'bad!!!', name: 'x' }], '');
  const m = L.mergeAccount(local, remote);
  assert.equal(m.settings.targetMin, 420, '계정 목표 우선');
  assert.deepEqual(m.records.map(r => r.date), ['2026-11-03', '2026-11-07']);
  assert.deepEqual(m.rooms, [{ code: 'abc234', name: '새벽반' }, { code: 'xyz789', name: 'b' }]);
  assert.equal(m.nick, '민규');
  // 계정에 목표가 없으면 기기 것
  assert.equal(L.mergeAccount(local, { records: 'junk', settings: { bad: 1 } }).settings.targetMin, 400);
  // 이상한 서버 데이터에도 안전
  const z = L.mergeAccount(null, { records: [null, 3], rooms: 'x' });
  assert.deepEqual(z.records, []); assert.deepEqual(z.rooms, []); assert.equal(z.settings, null);
});

test('방: 방장 표시와 멤버 키(12자리 16진수만)', () => {
  const v = { members: [{ nickname: '방장', owner: true, me: true, key: 'a1b2c3d4e5f6' }, { nickname: '민수', key: '<script>' }] };
  assert.deepEqual(L.roomSlots(v).slots.map(s => s.owner), [true, false]);
  assert.equal(L.profileFromMember(v.members[0], '2026-11-08').key, 'a1b2c3d4e5f6');
  assert.equal(L.profileFromMember(v.members[1], '2026-11-08').key, null);
});

test('아침 알림: 단계 목표별 일정, 75바이트 줄 접기, 구글 링크', () => {
  const s = L.makeSettings({ baselineMin: 480, targetMin: 420, sleepNeedH: 8, firstAction: '물 한 잔 마시기' }, '2026-11-08').settings;
  assert.deepEqual(L.reminderStages(s, '2026-11-09').map(g => [g.start, g.min, !!g.forever]), [['2026-11-09', 465, true]], '지금 단계 목표로 매일');
  delete s.cur;   // 예전 방식(날짜로 당기기) 설정이면 단계별 일정
  assert.deepEqual(L.reminderStages(s, '2026-11-09').map(g => [g.start, g.min, g.days, !!g.forever]),
    [['2026-11-09', 465, 2, false], ['2026-11-11', 450, 3, false], ['2026-11-14', 435, 3, false], ['2026-11-17', 420, 1, true]]);
  const flat = L.makeSettings({ baselineMin: 440, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-11-08').settings;
  assert.equal(L.reminderStages(flat, '2026-11-09').length, 1, '30분 이내면 바로 매일 반복 하나');
  const ics = L.reminderIcs(s, '2026-11-09', 'https://x.io/', '2026-11-08T05:50:12.345Z');
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75), '모든 줄 75바이트 이하');
  const un = ics.replace(/\r\n /g, '');
  assert.match(un, /^BEGIN:VCALENDAR\r\n/); assert.match(un, /END:VCALENDAR\r\n$/);
  assert.match(un, /DTSTAMP:20261108T055012Z/);
  assert.match(un, /DESCRIPTION:일어났으면 같이 일어나요에서 '하루 시작하기'를 눌러요\./);
  assert.equal((un.match(/BEGIN:VALARM/g) || []).length, 4);
  assert.match(L.googleReminderUrl(flat, '2026-11-09', ''), /dates=20261109T070000\/20261109T071000&ctz=Asia%2FSeoul&recur=RRULE%3AFREQ%3DDAILY/);
  assert.notEqual(L.reminderSig(s), L.reminderSig(flat));
});

test('내 기록: 연속 일수, 최근 n일, CSV (따옴표·쉼표 처리, BOM)', () => {
  const s = L.makeSettings({ baselineMin: 480, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-11-01').settings;
  let recs = [];
  for (const [d, t] of [['2026-11-05', '07:40'], ['2026-11-06', '07:20'], ['2026-11-07', '09:05'], ['2026-11-08', '07:30']]) {
    recs = L.createStartRecord(recs, new Date(d + 'T' + t + ':00+09:00'), s).records;
  }
  assert.equal(L.localStreak(recs, '2026-11-08'), 4, '오늘까지');
  assert.equal(L.localStreak(recs, '2026-11-09'), 4, '오늘 아직이면 어제까지');
  assert.equal(L.localStreak(recs, '2026-11-10'), 0);
  assert.equal(L.localStreak([], '2026-11-10'), 0);
  assert.deepEqual(L.recentDays(recs, '2026-11-08', 5), [false, true, true, true, true]);
  const csv = L.recordsCsv(recs);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  const rows = csv.slice(1).trim().split('\r\n');
  assert.equal(rows.length, 5);
  assert.equal(rows[3], '2026-11-07,토,09:05,07:45,80,늦음,');
  assert.equal(L.recordsCsv([]).slice(1), '날짜,요일,하루 시작,그날 목표,목표와 차이(분),결과,첫 행동\r\n');
});

function buildRecs(startKey, n, skip, timeOf) {
  const s = L.makeSettings({ baselineMin: 440, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, startKey).settings;
  let recs = [];
  for (let i = 0; i < n; i++) {
    if (skip.includes(i)) continue;
    const d = L.addDays(startKey, i);
    recs = L.createStartRecord(recs, new Date(d + 'T' + (timeOf ? timeOf(i) : '07:05') + ':00+09:00'), s).records;
  }
  return recs;
}

test('여정: 첫날은 금빛 아침, 하늘은 날마다 고정, 칭호 날은 드문 하늘 이상', () => {
  const recs = buildRecs('2026-09-01', 40, []);
  const a = L.journeyTimeline(recs, '2026-10-10'), b = L.journeyTimeline(recs, '2026-10-10');
  assert.equal(a.days[0].sky, 'gold');
  assert.deepEqual(a.days.map(d => d.sky), b.days.map(d => d.sky), '다시 계산해도 같은 하늘');
  for (const d of a.days.filter(x => x.milestone)) assert.ok(L.skyById(d.sky).tier >= 2, d.n + '일째 칭호 날은 드묾 이상');
  assert.deepEqual(a.titles.map(t => t.n), [3, 7, 14, 21, 30]);
  assert.equal(a.journeyDays, 40);
  assert.equal(Object.values(a.skyCounts).reduce((x, y) => x + y, 0), 40);
  // 다른 사람(첫 기록 시각이 다름)은 다른 하늘
  const other = buildRecs('2026-09-01', 40, [], () => '07:06');
  assert.notDeepEqual(L.journeyTimeline(other, '2026-10-10').days.map(d => d.sky), a.days.map(d => d.sky));
});

test('보호권: 7일마다 1개(최대 2개), 빠진 날에 자동으로 써서 연속을 지킴, 다 쓰면 끊김', () => {
  // 0~6 기록(보호권 1) → 7 빠짐(보호) → 8~9 기록 → 10,11 빠짐(11에서 끊김)
  const recs = buildRecs('2026-10-01', 12, [7, 10, 11]);
  const tl = L.journeyTimeline(recs, '2026-10-12');
  assert.deepEqual(tl.restDays, ['2026-10-08']);
  assert.equal(tl.streak, 0, '보호권 없이 이틀 빠지면 끊김');
  assert.equal(tl.best, 9, '보호받은 날은 세지 않고 이어짐 (7 + 2)');
  const tl2 = L.journeyTimeline(recs, '2026-10-10');
  assert.equal(tl2.streak, 9, '오늘(10일) 아직 안 눌렀으면 어제까지 이어짐');
  assert.equal(tl2.shields, 0);
  // 보호권 최대 2개
  const long = buildRecs('2026-01-01', 30, []);
  const t3 = L.journeyTimeline(long, '2026-01-30');
  assert.equal(t3.shields, 2); assert.equal(t3.nextShieldIn, null);
  assert.equal(L.journeyTimeline(buildRecs('2026-01-01', 5, []), '2026-01-05').nextShieldIn, 2);
  // 연속이 없을 땐 보호권을 쓰지 않음
  assert.deepEqual(L.journeyTimeline([], '2026-01-05').days, []);
});

test('연출 단계·다음 연출, 하늘 확률(목표 지킨 날이 더 드문 하늘)', () => {
  assert.deepEqual([1, 2, 3, 6, 7, 13, 14, 29, 30, 99].map(L.effectTier), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual(L.nextEffect(5), { at: 7, label: '햇살', left: 2 });
  assert.equal(L.nextEffect(30), null);
  const rate = (hit, streak) => { const r = L.mulberry32(7); let rare = 0; for (let i = 0; i < 20000; i++) if (L.skyById(L.pickSky(r, hit, streak, 0)).tier >= 2) rare++; return rare / 20000; };
  const base = rate(false, 0), good = rate(true, 10);
  assert.ok(base > 0.15 && base < 0.21, '기본 드묾 이상 약 18%: ' + base);
  assert.ok(good > base + 0.08, '목표 지키고 연속이면 더 자주: ' + good);
  assert.equal(L.SKIES.length, 15);
  assert.equal(L.SKIES.filter(k => k.weather).length, 3);
  const r2 = L.mulberry32(3); for (let i = 0; i < 5000; i++) assert.ok(!L.skyById(L.pickSky(r2, true, 20, 0)).weather, '날씨 하늘은 뽑기에 안 나옴');
});

test('주간 리포트(지난 월~일)와 방 함께 켜기', () => {
  const recs = buildRecs('2026-10-26', 14, [3], i => (i < 7 ? '07:30' : '07:10'));   // 10/26(월)~11/8(일)
  const r = L.weekRecap(recs, '2026-11-10', null);   // 11/10(화) → 지난주 11/2~11/8
  assert.equal(r.from, '2026-11-02'); assert.equal(r.to, '2026-11-08');
  assert.equal(r.days, 7); assert.equal(r.prevDays, 6);
  assert.equal(r.avg, 430); assert.equal(r.prevAvg, 450); assert.equal(r.diff, -20);
  assert.equal(r.skies.length, 7);
  assert.equal(L.weekRecap(recs, '2026-11-25', null), null, '지난주 기록 없으면 없음');
  const view = { members: [
    { me: true, start_min: null, joined: '2026-11-01', week: [420, 425, 430, null, 420, 430, null] },
    { me: false, start_min: 450, joined: '2026-11-01', week: [440, 445, 450, 455, -1, 430, 450] },
    { me: false, start_min: null, joined: '2026-11-08', week: [null, null, null, null, null, 470, null] }
  ] };
  const t = L.roomTogether(view, '2026-11-09', 431);
  assert.equal(t.lit, 2); assert.equal(t.total, 3); assert.equal(t.allLitToday, false);
  // 11/3,11/4,11/5: 두 명(셋째는 11/8에 들어옴) 모두 켬 → 3일. 11/7은 쉬는 날(-1)이라 아님. 11/8은 셋 다 켬 → 4일
  assert.equal(t.weekAllDays, 4);
  assert.equal(L.roomTogether({ members: [view.members[0]] }, '2026-11-09', 431).allLitToday, false, '혼자면 축하 없음');
});

test('실제 날씨: 비·눈·뇌우·안개·흐림은 그 하늘, 맑으면 평소 뽑기, 칭호 날 비는 무지개, 기록에 저장', () => {
  assert.deepEqual([0, 2, 3, 45, 53, 63, 81, 73, 86, 95, null].map(L.weatherFamily), [null, null, 'cloudy', 'mist', 'rain', 'rain', 'rain', 'snow', 'snow', 'storm', null]);
  assert.deepEqual([0, 2, 3, 45, 53, 63, 81, 73, 95].map(L.weatherName), ['맑음', '구름 조금', '흐림', '안개', '이슬비', '비', '소나기', '눈', '뇌우']);
  const r = () => 0.5;
  assert.equal(L.skyForDay(r, false, 0, false, 63), 'rain');
  assert.equal(L.skyForDay(r, false, 0, false, 73), 'snow');
  assert.equal(L.skyForDay(r, false, 0, false, 95), 'storm');
  assert.equal(L.skyForDay(r, false, 0, true, 63), 'rainbow', '칭호 날 비 → 무지개');
  assert.ok(L.skyById(L.skyForDay(r, false, 0, true, 3)).tier >= 2, '칭호 날 흐림 → 드묾 이상');
  assert.equal(L.skyForDay(() => 0.05, true, 0, false, 61), 'rainbow', '목표 지킨 비 오는 날 가끔 무지개');
  // 기록: 날씨·기온 저장, 첫날도 비면 비
  const s = L.makeSettings({ baselineMin: 440, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-11-01').settings;
  let recs = L.createStartRecord([], new Date('2026-11-09T07:05:00+09:00'), s, { wx: 63, tc: 7 }).records;
  assert.equal(recs[0].wx, 63); assert.equal(recs[0].tc, 7);
  assert.ok(['rain', 'rainbow'].includes(L.journeyTimeline(recs, '2026-11-09').days[0].sky), '첫날이어도 비 오면 비(가끔 무지개)');
  assert.equal(L.cleanRecords([{ ...recs[0], wx: 300, tc: 99 }])[0].wx, null, '이상한 값은 버림');
  // 기분 저장, 주간 리포트 기분별 평균
  recs = L.setMood(recs, '2026-11-09', 3);
  assert.equal(recs[0].mood, 3);
  assert.equal(L.setMood(recs, '2026-11-09', 9)[0].mood, 3, '1~3만');
  assert.equal(L.weekRecap(recs, '2026-11-17', null).moods['3'].avg, 425);
  // 날씨 주소: 좌표는 소수 첫째 자리로
  assert.equal(L.weatherUrl(37.56789, 126.97812), 'https://api.open-meteo.com/v1/forecast?latitude=37.6&longitude=127&current=temperature_2m,weather_code&timezone=Asia%2FSeoul');
  assert.deepEqual(L.parseWeather({ current: { temperature_2m: 6.6, weather_code: 61 } }), { wx: 61, tc: 7 });
  assert.equal(L.parseWeather({}), null);
  // 달력: 2026년 11월은 일요일 시작, 30일
  const cells = L.monthCells(2026, 11);
  assert.equal(cells[0], '2026-11-01'); assert.equal(cells.length, 30);
  assert.equal(L.monthCells(2026, 12)[2], '2026-12-01', '12월 1일은 화요일');
});

test('목표 제안: 3번 연속 달성이면 앞당기기, 늦은 날이 많으면 유지, 기록이 드물면 횟수부터, 오래 쉬다 오면 복귀 안내', () => {
  const s = L.makeSettings({ baselineMin: 480, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-11-01').settings;   // cur 07:45
  const mk = (pairs) => { let r = []; for (const [d, t] of pairs) r = L.createStartRecord(r, new Date(d + 'T' + t + ':00+09:00'), s).records; return r; };
  const adv = L.stepAdvice(mk([['2026-11-07', '07:40'], ['2026-11-08', '07:50'], ['2026-11-09', '07:45']]), s, '2026-11-09');
  assert.deepEqual(adv, { kind: 'advance', cur: 465, to: 450 });
  const hold = L.stepAdvice(mk([['2026-11-07', '08:30'], ['2026-11-08', '07:40'], ['2026-11-09', '08:40']]), s, '2026-11-09');
  assert.equal(hold.kind, 'hold'); assert.equal(hold.easeTo, 480);
  assert.equal(L.stepAdvice(mk([['2026-11-07', '07:40'], ['2026-11-08', '08:05'], ['2026-11-09', '07:45']]), s, '2026-11-09'), null, '섞여 있으면 제안 없음');
  assert.equal(L.stepAdvice(mk([['2026-10-20', '07:40'], ['2026-10-25', '07:40'], ['2026-11-01', '07:45'], ['2026-11-04', '07:45']]), s, '2026-11-09'), null, '오늘 기록 전엔 없음');
  assert.equal(L.stepAdvice(mk([['2026-10-25', '07:40'], ['2026-10-28', '07:40'], ['2026-11-02', '07:45'], ['2026-11-09', '07:45']]), s, '2026-11-09').kind, 'return');
  const r = L.stepAdvice(mk([['2026-10-25', '07:40'], ['2026-11-09', '07:45']]), s, '2026-11-09');
  assert.equal(r.kind, 'return'); assert.equal(r.gap, 14); assert.equal(r.total, 2);
  assert.equal(L.stepAdvice(mk([['2026-10-24', '07:40'], ['2026-10-28', '07:40'], ['2026-11-01', '07:40'], ['2026-11-05', '07:45'], ['2026-11-09', '07:45']]), s, '2026-11-09').kind, 'count', '4일 간격으로 드문드문');
  // 최종 목표에 도착했으면 앞당기기 제안 없음
  const fin = L.withStep(s, 420);
  const mk2 = (pairs) => { let x = []; for (const [d, t] of pairs) x = L.createStartRecord(x, new Date(d + 'T' + t + ':00+09:00'), fin).records; return x; };
  assert.equal(L.stepAdvice(mk2([['2026-11-07', '07:00'], ['2026-11-08', '07:00'], ['2026-11-09', '07:00']]), fin, '2026-11-09'), null);
});

test('참여 요일: 쉬는 요일은 연속을 끊지 않고 보호권도 안 씀, 정한 날 이전 기록엔 소급 안 함, 캘린더 반복 요일', () => {
  const s = L.makeSettings({ baselineMin: 440, targetMin: 420, sleepNeedH: 8, firstAction: '물', days: [1, 2, 3, 4, 5] }, '2026-11-02').settings;   // 월~금
  assert.equal(s.daysFrom, '2026-11-02');
  assert.equal(L.isOffDay(s, '2026-11-07'), true, '토');
  assert.equal(L.isOffDay(s, '2026-11-06'), false, '금');
  assert.equal(L.isOffDay(s, '2026-11-01'), false, '정하기 전 날은 적용 안 함');
  let recs = [];
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09']) recs = L.createStartRecord(recs, new Date(d + 'T07:00:00+09:00'), s).records;
  const tl = L.journeyTimeline(recs, '2026-11-09', s);
  assert.equal(tl.streak, 6, '주말을 건너뛰고 이어짐');
  assert.deepEqual(tl.offDays, ['2026-11-07', '2026-11-08']);
  assert.deepEqual(tl.restDays, []);
  assert.equal(L.journeyTimeline(recs, '2026-11-09').streak, 1, '참여 요일 없으면 끊김');
  assert.match(L.reminderIcs(s, '2026-11-09', '', '2026-11-08T00:00:00Z'), /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\n/);
  assert.match(L.googleReminderUrl(s, '2026-11-09', ''), /recur=RRULE%3AFREQ%3DWEEKLY%3BBYDAY%3DMO%2CTU%2CWE%2CTH%2CFR/);
  assert.ok(L.validateSettings({ ...s, days: [] }).length);
  assert.ok(L.validateSettings({ ...s, days: [7] }).length);
  // 주간 리포트: 계획한 날 5
  assert.equal(L.weekRecap(recs, '2026-11-10', null, s).planned, 5);
});

test('방 주간 목표(각자 4번), 리포트 흔들림은 표준편차, 그래프 목표선은 그날 목표', () => {
  const view = { members: [
    { me: true, start_min: null, joined: '2026-11-01', week: [420, 425, 430, null, 420, 430, null] },
    { me: false, start_min: 450, joined: '2026-11-01', week: [440, 445, 450, 455, -1, 430, 450] }
  ] };
  // 2026-11-09(월): 이번 주는 오늘 하루 → 나(로컬 431) + 친구(450) = 2
  const t = L.roomTogether(view, '2026-11-09', 431);
  assert.equal(t.weekLit, 2); assert.equal(t.weekGoal, 8);
  // 2026-11-12(목) 기준이면 월~목 4일분
  const t2 = L.roomTogether(view, '2026-11-12', null);
  assert.equal(t2.weekLit, 5, '월~목: 나 2번(420,430) + 친구 3번(455,430,450, 쉬는 날 -1은 안 셈)');
  // 리포트 흔들림 = 표준편차 (습관 탭과 같음)
  const s = L.makeSettings({ baselineMin: 440, targetMin: 420, sleepNeedH: 8, firstAction: '물' }, '2026-10-01').settings;
  let recs = [];
  for (const [d, t] of [['2026-11-02', '07:00'], ['2026-11-03', '07:20'], ['2026-11-04', '07:40']]) recs = L.createStartRecord(recs, new Date(d + 'T' + t + ':00+09:00'), s).records;
  assert.equal(L.weekRecap(recs, '2026-11-10', null, s).wobble, 16, 'sd(420,440,460)=16.3');
  assert.equal(L.habitStats(recs, '2026-11-05', s).wobble, 16);
  // 그래프 목표선: 그날 저장된 목표 (설정을 나중에 바꿔도 지난 선은 그대로), 기록 없는 지난 날은 비움
  const later = L.withStep({ ...s, targetMin: 360, baselineMin: 440 }, 380);
  const st = L.habitStats(recs, '2026-11-05', later);
  assert.equal(st.last14.find(d => d.key === '2026-11-03').target, 420);
  assert.equal(st.last14.find(d => d.key === '2026-11-01').target, null);
  assert.equal(st.last14.find(d => d.key === '2026-11-05').target, 380, '오늘은 지금 목표');
});
