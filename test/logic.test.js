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

test('단계 목표: 평소 08:00 → 목표 07:00이면 3일마다 15분씩 당겨 07:00에서 멈춘다', () => {
  const s = S().settings;
  assert.equal(L.planTargetFor(s, '2026-11-09'), 465); // 07:45
  assert.equal(L.planTargetFor(s, '2026-11-11'), 465);
  assert.equal(L.planTargetFor(s, '2026-11-12'), 450); // 07:30
  assert.equal(L.planTargetFor(s, '2026-11-18'), 420); // 07:00
  assert.equal(L.planTargetFor(s, '2026-12-30'), 420);
  const info = L.planInfo(s, '2026-11-09');
  assert.equal(info.stepping, true);
  assert.equal(info.daysLeft, 9);
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

test('판정 경계: +15분 달성, +16~60분 아쉬움, +61분 늦음', () => {
  const s = S({ baselineMin: 420 }).settings; // 목표 07:00 바로
  const ev = (h, m) => L.evaluate(L.createStartRecord([], at(2026, 11, 9, h, m), s).record).status;
  assert.equal(ev(6, 10), 'hit');
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

test('창문: 날짜마다 같은 배치, 내 창문은 다른 사람 불에 쓰이지 않고, 인원이 많으면 1칸 = N명', () => {
  const a = L.litWindows(40, '2026-11-09', 5);
  assert.deepEqual(a, L.litWindows(40, '2026-11-09', 5));
  assert.equal(a.lit.length, 40);
  assert.ok(!a.lit.includes(5));
  assert.equal(new Set(a.lit).size, 40);
  const b = L.litWindows(5000, '2026-11-09', 5);
  assert.ok(b.per > 1);
  assert.ok(b.lit.length <= 95);
  assert.equal(L.litWindows(0, '2026-11-09', 5).lit.length, 0);
  // 하루 예상 5,000명 기준: 절반이 시작하면 창문도 절반쯤
  const half = L.litWindows(2500, '2026-11-09', 5, 96, 5000);
  assert.ok(half.lit.length >= 40 && half.lit.length <= 50, 'lit=' + half.lit.length);
  // 실제 서버 초기(예상 인원 모름): 소수일 땐 1칸 = 1명, 많아지면 깔끔한 단위로
  assert.equal(L.windowScale(30).per, 1);
  assert.equal(L.windowScale(300).per, 5);
  assert.ok(L.windowScale(300).lit <= 72);
  assert.ok(L.myWindow('abc') >= 0 && L.myWindow('abc') < 96);
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

test('예시 군중: 날짜 고정, 합계 약 5,000명, 시간이 갈수록 줄지 않음', () => {
  const c = L.crowdForDay('2026-11-09');
  assert.deepEqual(c, L.crowdForDay('2026-11-09'));
  assert.ok(Math.abs(c.reduce((x, y) => x + y, 0) - 5000) <= 20);
  let prev = -1;
  for (let m = 200; m <= 900; m += 7) { const v = L.awakeUntil(c, m); assert.ok(v >= prev); prev = v; }
});
