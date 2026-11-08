/* 같이 일어나요 v0.2 — 순수 로직 (화면·저장소와 분리, Node 테스트 대상) */
(function (root) {
  'use strict';

  var OPEN_MIN = 240;      // 04:00부터 하루 시작 기록 가능
  var CLOSE_MIN = 840;     // 14:00 마감 (13:59까지)
  var TARGET_MIN_LO = 240; // 목표는 04:00~12:00
  var TARGET_MIN_HI = 720;
  var BUCKET = 30;
  var BUCKETS = (CLOSE_MIN - OPEN_MIN) / BUCKET; // 20
  var STEP_MIN = 15;       // 단계 목표: 15분씩
  var STEP_DAYS = 3;       // 3일마다
  var HIT_TOL = 15;        // 목표 +15분까지 달성
  var CLOSE_TOL = 60;      // +60분까지 아쉬움
  var JOURNEY_DAYS = 66;   // Lally 외(2010) 중앙값
  var WINDOWS = 96;        // 기본 건물: 12칸 x 8층
  var COLS = 12;
  var MAX_WINDOWS = 480;   // 40층까지 올라가고, 그 이상은 '외 N명'
  var DEMO_TOTAL = 60;     // 예시 모드: 친구 규모(하루 60명)
  var ACTION_MAX = 20;

  var WEEKDAY_W = [2, 4, 10, 22, 45, 80, 100, 85, 60, 40, 28, 20, 14, 10, 8, 6, 5, 4, 3, 2];
  var WEEKEND_W = [1, 2, 4, 8, 14, 22, 32, 45, 62, 80, 100, 90, 70, 50, 35, 25, 18, 12, 8, 5];
  var DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toDateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function minuteOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
  function formatMinute(min) {
    var m = ((min % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  function toLocalISO(d) {
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    return toDateKey(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }
  function keyToUTC(key) { var p = key.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function utcToKey(t) { var d = new Date(t); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function daysBetween(a, b) { return Math.round((keyToUTC(b) - keyToUTC(a)) / 86400000); }
  function addDays(key, n) { return utcToKey(keyToUTC(key) + n * 86400000); }
  function dayOfWeek(key) { return new Date(keyToUTC(key)).getUTCDay(); } // 0=일
  function isWeekend(key) { var d = dayOfWeek(key); return d === 0 || d === 6; }

  function dayPhase(min) { return min < OPEN_MIN ? 'before' : (min >= CLOSE_MIN ? 'closed' : 'open'); }
  function isStartWindow(min) { return dayPhase(min) === 'open'; }
  function cohortOf(min) { return formatMinute(Math.floor(min / BUCKET) * BUCKET); }
  function bucketIndex(min) { return Math.floor((min - OPEN_MIN) / BUCKET); }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ---------- 설정 ----------
  function sanitizeAction(text) {
    if (typeof text !== 'string') return '';
    var t = text.replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, ACTION_MAX).join('');
  }

  function validateSettings(s) {
    var e = [];
    if (!s || typeof s !== 'object') return ['설정이 없음'];
    if (!isInt(s.targetMin) || s.targetMin < TARGET_MIN_LO || s.targetMin > TARGET_MIN_HI || s.targetMin % 5) e.push('목표 시각은 04:00~12:00, 5분 단위');
    if (!isInt(s.baselineMin) || s.baselineMin < OPEN_MIN || s.baselineMin >= CLOSE_MIN || s.baselineMin % 5) e.push('평소 시각은 04:00~13:55, 5분 단위');
    if (typeof s.planStart !== 'string' || !DATE_RE.test(s.planStart)) e.push('planStart 형식 오류');
    if ([7, 8, 9].indexOf(s.sleepNeedH) < 0) e.push('필요 수면은 7·8·9시간');
    if (typeof s.firstAction !== 'string' || !s.firstAction || s.firstAction !== sanitizeAction(s.firstAction)) e.push('첫 행동 형식 오류');
    return e;
  }

  function makeSettings(input, todayKey) {
    var s = {
      version: 2,
      baselineMin: input.baselineMin,
      targetMin: input.targetMin,
      planStart: todayKey,
      sleepNeedH: input.sleepNeedH,
      firstAction: sanitizeAction(input.firstAction)
    };
    var errors = validateSettings(s);
    return errors.length ? { ok: false, errors: errors } : { ok: true, settings: s };
  }

  // 단계 목표: 평소보다 30분 넘게 당기면 3일마다 15분씩 당긴다
  function planTargetFor(s, key) {
    if (!s) return null;
    var gap = s.baselineMin - s.targetMin;
    if (gap <= 30) return s.targetMin;
    var d = Math.max(0, daysBetween(s.planStart, key));
    var step = s.baselineMin - STEP_MIN * (1 + Math.floor(d / STEP_DAYS));
    return Math.max(s.targetMin, step);
  }

  function planInfo(s, key) {
    var today = planTargetFor(s, key);
    var gap = s.baselineMin - s.targetMin;
    if (gap <= 30) return { today: today, final: s.targetMin, stepping: false, daysLeft: 0 };
    var stepsTotal = Math.ceil(gap / STEP_MIN);
    var arriveDay = (stepsTotal - 1) * STEP_DAYS;
    var d = Math.max(0, daysBetween(s.planStart, key));
    return { today: today, final: s.targetMin, stepping: today > s.targetMin, daysLeft: Math.max(0, arriveDay - d) };
  }

  function bedtimeFor(targetMin, sleepNeedH) { return formatMinute(targetMin - sleepNeedH * 60); }

  // ---------- 기록 ----------
  function validateRecord(r) {
    if (!r || typeof r !== 'object') return ['기록이 객체가 아님'];
    var f = ['id', 'date', 'wokeAt', 'cohort', 'greetedAt', 'actionDoneAt'];
    for (var i = 0; i < f.length; i++) if (typeof r[f[i]] === 'string' && r[f[i]].length > 40) return ['길이 초과: ' + f[i]];
    var e = [];
    if (typeof r.date !== 'string' || !DATE_RE.test(r.date)) e.push('date 형식 오류');
    if (r.id !== 'w-' + r.date) e.push('id는 w-날짜여야 함');
    if (typeof r.wokeAt !== 'string' || r.wokeAt.slice(0, 10) !== r.date) e.push('wokeAt이 date와 다름');
    if (!isInt(r.minuteOfDay)) e.push('minuteOfDay는 정수');
    else if (!isStartWindow(r.minuteOfDay)) e.push('인정 시간 밖');
    if (typeof r.cohort !== 'string' || (isInt(r.minuteOfDay) && r.cohort !== cohortOf(r.minuteOfDay))) e.push('cohort 불일치');
    if (r.dayTarget !== undefined && r.dayTarget !== null &&
        (!isInt(r.dayTarget) || r.dayTarget < TARGET_MIN_LO || r.dayTarget >= CLOSE_MIN)) e.push('dayTarget 범위 오류');
    ['greetedAt', 'actionDoneAt'].forEach(function (k) {
      if (r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string') e.push(k + ' 형식 오류');
    });
    return e;
  }

  function normalize(r) {
    return {
      id: r.id, date: r.date, wokeAt: r.wokeAt, minuteOfDay: r.minuteOfDay, cohort: r.cohort,
      dayTarget: isInt(r.dayTarget) ? r.dayTarget : null,
      actionDoneAt: r.actionDoneAt || null,
      greetedAt: r.greetedAt || null
    };
  }

  function pickBetter(a, b) {
    var first = a.minuteOfDay <= b.minuteOfDay ? a : b;
    var out = normalize(first);
    out.actionDoneAt = a.actionDoneAt || b.actionDoneAt || null;
    out.greetedAt = a.greetedAt || b.greetedAt || null;
    if (out.dayTarget === null) out.dayTarget = isInt(a.dayTarget) ? a.dayTarget : (isInt(b.dayTarget) ? b.dayTarget : null);
    return out;
  }

  function cleanRecords(list) {
    if (!Array.isArray(list)) return [];
    var byDate = {};
    list.forEach(function (r) {
      if (validateRecord(r).length) return;
      var n = normalize(r);
      byDate[n.date] = byDate[n.date] ? pickBetter(byDate[n.date], n) : n;
    });
    return Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  }
  function mergeRecords(a, b) { return cleanRecords([].concat(a || [], b || [])); }
  function findDay(records, key) {
    for (var i = 0; i < records.length; i++) if (records[i].date === key) return records[i];
    return null;
  }

  function createStartRecord(records, now, settings) {
    var key = toDateKey(now);
    var existing = findDay(records, key);
    if (existing) return { ok: true, created: false, record: existing, records: records };
    var min = minuteOfDay(now), phase = dayPhase(min);
    if (phase !== 'open') return { ok: false, reason: phase === 'before' ? 'too-early' : 'too-late', records: records };
    var rec = {
      id: 'w-' + key, date: key, wokeAt: toLocalISO(now), minuteOfDay: min, cohort: cohortOf(min),
      dayTarget: settings ? planTargetFor(settings, key) : null, actionDoneAt: null, greetedAt: null
    };
    return { ok: true, created: true, record: rec, records: cleanRecords(records.concat([rec])) };
  }

  function markAction(rec, now) {
    if (!rec) return { ok: false, reason: 'no-record' };
    if (rec.actionDoneAt) return { ok: false, reason: 'already', record: rec };
    var next = normalize(rec); next.actionDoneAt = toLocalISO(now);
    return { ok: true, record: next };
  }

  // 목표 대비 판정: 목표보다 일찍이거나 +15분 이내면 달성
  function evaluate(rec) {
    if (!rec || !isInt(rec.dayTarget)) return { status: 'none', diff: null };
    var diff = rec.minuteOfDay - rec.dayTarget;
    var status = diff <= HIT_TOL ? 'hit' : (diff <= CLOSE_TOL ? 'close' : 'late');
    return { status: status, diff: diff };
  }

  function sd(xs) {
    var m = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    return Math.sqrt(xs.reduce(function (a, x) { return a + (x - m) * (x - m); }, 0) / xs.length);
  }
  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }

  function habitStats(records, todayKey, settings) {
    var dow = (dayOfWeek(todayKey) + 6) % 7; // 월=0
    var week = [];
    for (var i = 0; i < 7; i++) {
      var key = addDays(todayKey, i - dow), rec = findDay(records, key);
      week.push({
        key: key, label: DAY_LABELS[i], isToday: key === todayKey, isFuture: key > todayKey,
        time: rec ? formatMinute(rec.minuteOfDay) : null, status: rec ? evaluate(rec).status : null
      });
    }
    var last14 = [];
    for (var j = 13; j >= 0; j--) {
      var k = addDays(todayKey, -j), r = findDay(records, k);
      last14.push({ key: k, min: r ? r.minuteOfDay : null, target: settings ? planTargetFor(settings, k) : null, weekend: isWeekend(k) });
    }
    var hit7 = 0, rec7 = 0;
    for (var h = 0; h < 7; h++) {
      var rr = findDay(records, addDays(todayKey, -h));
      if (rr) { rec7++; if (evaluate(rr).status === 'hit') hit7++; }
    }
    var recent = records.filter(function (x) { var d = daysBetween(x.date, todayKey); return d >= 0 && d < 14; })
      .map(function (x) { return x.minuteOfDay; });
    var wobble = recent.length >= 3 ? Math.round(sd(recent)) : null;
    var wk = [], we = [];
    records.forEach(function (x) {
      var d = daysBetween(x.date, todayKey);
      if (d < 0 || d >= 28) return;
      (isWeekend(x.date) ? we : wk).push(x.minuteOfDay);
    });
    var weekendGap = (wk.length >= 2 && we.length >= 1) ? Math.round(mean(we) - mean(wk)) : null;
    var journeyDays = records.filter(function (x) { return x.date <= todayKey; }).length;
    return {
      week: week, weekCount: week.filter(function (d) { return d.time; }).length,
      last14: last14, hit7: hit7, rec7: rec7, wobble: wobble, weekendGap: weekendGap,
      journeyDays: journeyDays, journeyTotal: JOURNEY_DAYS
    };
  }

  // ---------- 함께 (군중) ----------
  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function crowdForDay(key, total) {
    total = total || DEMO_TOTAL;
    var rand = mulberry32(hashString(key));
    var base = isWeekend(key) ? WEEKEND_W : WEEKDAY_W;
    var w = base.map(function (x) { return x * (0.85 + rand() * 0.3); });
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    return w.map(function (x) { return Math.round(x / sum * total); });
  }
  function awakeUntil(buckets, min) {
    if (min <= OPEN_MIN) return 0;
    var n = 0;
    for (var i = 0; i < buckets.length; i++) {
      var start = OPEN_MIN + i * BUCKET;
      if (min >= start + BUCKET) n += buckets[i];
      else if (min > start) n += Math.floor(buckets[i] * (min - start) / BUCKET);
    }
    return n;
  }
  function recentCount(buckets, min, w) {
    w = w || 10;
    return Math.max(0, awakeUntil(buckets, min) - awakeUntil(buckets, min - w));
  }

  // 창문 배치: 1칸 = 1명. 날짜마다 고정된 순서로 불이 켜지고, 96칸을 넘으면 위로 층이 늘어난다.
  // 층이 늘어도 이미 정해진 칸의 순서는 그대로다 (96칸 묶음마다 따로 섞음).
  function buildingSize(others) {
    var need = others + 1; // 다른 사람 + 나
    return Math.min(MAX_WINDOWS, Math.max(WINDOWS, Math.ceil(need / COLS) * COLS));
  }
  function windowOrder(seedKey, total) {
    total = total || WINDOWS;
    var out = [];
    for (var b = 0; b * WINDOWS < total; b++) {
      var idx = [];
      for (var i = b * WINDOWS; i < Math.min(total, (b + 1) * WINDOWS); i++) idx.push(i);
      var rand = mulberry32(hashString('w:' + seedKey + ':' + b));
      for (var j = idx.length - 1; j > 0; j--) { var k = Math.floor(rand() * (j + 1)); var t = idx[j]; idx[j] = idx[k]; idx[k] = t; }
      out = out.concat(idx);
    }
    return out;
  }
  function myWindow(anonId) { return hashString('me:' + anonId) % WINDOWS; } // 내 창문은 항상 아래 8층 안
  function litWindows(count, seedKey, me) {
    var total = buildingSize(count);
    var order = windowOrder(seedKey, total).filter(function (i) { return i !== me; });
    var lit = order.slice(0, Math.min(count, order.length));
    return { per: 1, total: total, lit: lit, overflow: Math.max(0, count - lit.length) };
  }

  // ---------- 우리 방 ----------
  var ROOM_RE = /^[a-z2-9]{6}$/;
  function sanitizeName(text, max) {
    if (typeof text !== 'string') return '';
    var t = text.replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, max).join('');
  }
  // ---------- 여정: 오늘의 하늘(수집), 연속 기록과 보호권, 칭호 ----------
  // 하늘 12종. tier 0 흔함 · 1 가끔 · 2 드묾 · 3 아주 드묾. 기록한 날마다 하나가 정해지고 바뀌지 않음.
  var SKIES = [
    { id: 'clear', name: '맑은 새벽', tier: 0, top: '#1D3B6E', mid: '#5E93CC', bot: '#FFD9A0', sun: '#FFE7A8' },
    { id: 'blue', name: '파란 아침', tier: 0, top: '#0F2F63', mid: '#3E7DCC', bot: '#A9D6FF', sun: '#FFF4CF' },
    { id: 'cloudy', name: '구름 낀 아침', tier: 0, top: '#323C57', mid: '#7F8AA5', bot: '#D9C8B2', sun: '#F3E3C7', fx: 'clouds' },
    { id: 'mist', name: '안개 아침', tier: 0, top: '#46516B', mid: '#9EA8BD', bot: '#E9E3D8', sun: '#FFF1DC', fx: 'mist' },
    { id: 'pink', name: '분홍빛 새벽', tier: 1, top: '#2A1F52', mid: '#C46A98', bot: '#FFC2A3', sun: '#FFE1C7' },
    { id: 'gold', name: '금빛 아침', tier: 1, top: '#372849', mid: '#DD8740', bot: '#FFD36B', sun: '#FFF0B8' },
    { id: 'afterrain', name: '비 갠 아침', tier: 1, top: '#294760', mid: '#79AFC6', bot: '#F1E5C8', sun: '#FFF6DD', fx: 'drops' },
    { id: 'rainbow', name: '무지개 아침', tier: 2, top: '#284D78', mid: '#86BEE6', bot: '#FFF0C8', sun: '#FFF8E0', fx: 'rainbow' },
    { id: 'stars', name: '별이 남은 새벽', tier: 2, top: '#0C1230', mid: '#3A3E79', bot: '#EFA67A', sun: '#FFD9B0', fx: 'stars' },
    { id: 'halo', name: '햇무리', tier: 2, top: '#1E3C69', mid: '#76ADDF', bot: '#FFF2D0', sun: '#FFFBEA', fx: 'halo' },
    { id: 'aurora', name: '오로라 새벽', tier: 3, top: '#051224', mid: '#12495A', bot: '#EFB57A', sun: '#FFE2B8', fx: 'aurora' },
    { id: 'meteor', name: '유성우 새벽', tier: 3, top: '#090E25', mid: '#2D2969', bot: '#E6997A', sun: '#FFD6C2', fx: 'meteor' }
  ];
  var SKY_BY_ID = {}; SKIES.forEach(function (k) { SKY_BY_ID[k.id] = k; });
  var TIER_NAMES = ['흔함', '가끔', '드묾', '아주 드묾'];
  var TIER_W = [15, 8, 4, 2];
  // 목표를 지킨 날은 드문 하늘이 더 잘 나오고, 연속 7일 이상이면 조금 더
  function pickSky(rand, hit, streak, minTier) {
    var HIT = [1, 1.2, 1.6, 1.8], RUN = [1, 1, 1.3, 1.2], pool = [], sum = 0;
    SKIES.forEach(function (k) {
      if (k.tier < (minTier || 0)) return;
      var w = TIER_W[k.tier] * (hit ? HIT[k.tier] : 1) * (streak >= 7 ? RUN[k.tier] : 1);
      pool.push([k.id, w]); sum += w;
    });
    var x = rand() * sum;
    for (var i = 0; i < pool.length; i++) { x -= pool[i][1]; if (x < 0) return pool[i][0]; }
    return pool[pool.length - 1][0];
  }
  var MILESTONES = [
    { n: 3, title: '새벽 탐험가' }, { n: 7, title: '일주일의 리듬' }, { n: 14, title: '아침의 단골' }, { n: 21, title: '습관의 씨앗' },
    { n: 30, title: '한 달의 빛' }, { n: 50, title: '반짝이는 건물' }, { n: 66, title: '습관 완성' }, { n: 100, title: '아침의 주인' }
  ];
  var MS_AT = {}; MILESTONES.forEach(function (m) { MS_AT[m.n] = m; });
  var MAX_SHIELDS = 2, SHIELD_EVERY = 7;
  // 연속 기록에 따라 불 켜는 연출이 풍성해짐
  var EFFECTS = [
    { at: 1, label: '불빛' }, { at: 3, label: '아침 새' }, { at: 7, label: '햇살' }, { at: 14, label: '별똥별' }, { at: 30, label: '금빛 고리' }
  ];
  function effectTier(streak) { var t = 0; EFFECTS.forEach(function (e, i) { if (streak >= e.at) t = i; }); return t; }
  function nextEffect(streak) { for (var i = 0; i < EFFECTS.length; i++) if (EFFECTS[i].at > streak) return { at: EFFECTS[i].at, label: EFFECTS[i].label, left: EFFECTS[i].at - streak }; return null; }

  // 첫 기록부터 오늘까지 하루씩: 기록한 날(하늘·연속·칭호·보호권 얻음), 보호권으로 지킨 날, 끊긴 날
  // 보호권: 기록 7일마다 1개(최대 2개). 지난 날을 빠뜨리면 연속 중일 때 자동으로 1개 써서 연속을 이어 줌.
  function journeyTimeline(records, todayKey) {
    var recs = cleanRecords(records).filter(function (r) { return r.date <= todayKey; });
    var out = { days: [], streak: 0, best: 0, shields: 0, restDays: [], journeyDays: 0, skyCounts: {}, nextShieldIn: SHIELD_EVERY, titles: [] };
    if (!recs.length) return out;
    var byDate = {}; recs.forEach(function (r) { byDate[r.date] = r; });
    var seed = String(recs[0].wokeAt || recs[0].date), d = recs[0].date, streak = 0, shields = 0, n = 0;
    for (var g = 0; d <= todayKey && g < 5000; g++, d = addDays(d, 1)) {
      var r = byDate[d];
      if (r) {
        n++; streak++;
        var ev = evaluate(r), hit = ev.status === 'hit', ms = MS_AT[n] || null;
        var sky = n === 1 ? 'gold' : pickSky(mulberry32(hashString(seed + '|' + d)), hit, streak, ms ? 2 : 0);
        var earned = false;
        if (n % SHIELD_EVERY === 0 && shields < MAX_SHIELDS) { shields++; earned = true; }
        out.days.push({ date: d, rec: true, n: n, streak: streak, sky: sky, hit: hit, milestone: ms, shieldEarned: earned });
        out.skyCounts[sky] = (out.skyCounts[sky] || 0) + 1;
        if (ms) out.titles.push(ms);
        if (streak > out.best) out.best = streak;
      } else if (d < todayKey) {
        if (streak > 0 && shields > 0) { shields--; out.restDays.push(d); out.days.push({ date: d, rest: true, streak: streak }); }
        else streak = 0;
      }
    }
    out.streak = streak; out.shields = shields; out.journeyDays = n;
    out.nextShieldIn = shields >= MAX_SHIELDS ? null : SHIELD_EVERY - (n % SHIELD_EVERY);
    return out;
  }
  function dayInfo(timeline, key) {
    for (var i = timeline.days.length - 1; i >= 0; i--) if (timeline.days[i].date === key) return timeline.days[i];
    return null;
  }
  function skyById(id) { return SKY_BY_ID[id] || SKY_BY_ID.clear; }

  // 지난주(월~일) 리포트. 지난주에 기록이 없으면 null
  function weekRecap(records, todayKey, timeline) {
    var dow = dayOfWeek(todayKey), mon = addDays(todayKey, -((dow + 6) % 7)), lastMon = addDays(mon, -7), prevMon = addDays(mon, -14);
    var recs = cleanRecords(records);
    var pick = function (from) { var to = addDays(from, 6); return recs.filter(function (r) { return r.date >= from && r.date <= to; }); };
    var w = pick(lastMon), p = pick(prevMon);
    if (!w.length) return null;
    var mins = w.map(function (r) { return r.minuteOfDay; }), avg = Math.round(mins.reduce(function (a, b) { return a + b; }, 0) / mins.length);
    var pm = p.map(function (r) { return r.minuteOfDay; }), pavg = pm.length ? Math.round(pm.reduce(function (a, b) { return a + b; }, 0) / pm.length) : null;
    var wob = mins.length >= 2 ? Math.round(mins.reduce(function (a, m) { return a + Math.abs(m - avg); }, 0) / mins.length) : null;
    var tl = timeline || journeyTimeline(records, todayKey), skies = [];
    w.forEach(function (r) { var di = dayInfo(tl, r.date); if (di && di.sky) skies.push(di.sky); });
    return {
      from: lastMon, to: addDays(lastMon, 6), days: w.length, prevDays: p.length,
      hits: w.filter(function (r) { return evaluate(r).status === 'hit'; }).length,
      avg: avg, prevAvg: pavg, diff: pavg === null ? null : avg - pavg, wobble: wob, skies: skies,
      rests: tl.restDays.filter(function (d) { return d >= lastMon && d <= addDays(lastMon, 6); }).length
    };
  }

  // 우리 방: 오늘 켜진 수, 이번 주(최근 7일) 모두 켠 날. 그날 이후에 들어온 사람은 그날 계산에서 뺌. 2명 이상일 때만.
  function roomTogether(view, todayKey, myLocalMin) {
    var ms = view && Array.isArray(view.members) ? view.members : [];
    var on = function (v) { return isInt(v) && v >= 0; };
    var lit = ms.filter(function (m) { return on(m.start_min) || (m.me && isInt(myLocalMin)); }).length;
    var allDays = 0;
    for (var k = 0; k < 7; k++) {
      var day = addDays(todayKey, k - 6);
      var el = ms.filter(function (m) { return !(typeof m.joined === 'string' && m.joined > day); });
      if (el.length < 2) continue;
      var all = el.every(function (m) {
        var v = Array.isArray(m.week) ? m.week[k] : null;
        if (k === 6 && m.me && isInt(myLocalMin)) return true;
        return on(v);
      });
      if (all) allDays++;
    }
    return { lit: lit, total: ms.length, allLitToday: ms.length >= 2 && lit === ms.length, weekAllDays: allDays };
  }

  // ---------- 내 기록: 연속 일수, 최근 n일, CSV 내보내기 ----------
  function localStreak(records, todayKey) {
    var has = {}; cleanRecords(records).forEach(function (r) { has[r.date] = true; });
    var a = has[todayKey] ? todayKey : addDays(todayKey, -1), n = 0;
    while (has[a] && n < 1000) { n++; a = addDays(a, -1); }
    return n;
  }
  function recentDays(records, todayKey, n) {
    var has = {}; cleanRecords(records).forEach(function (r) { has[r.date] = true; });
    var out = []; for (var i = n - 1; i >= 0; i--) out.push(!!has[addDays(todayKey, -i)]);
    return out;
  }
  function csvCell(v) { v = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function recordsCsv(records) {
    var DOW = ['일', '월', '화', '수', '목', '금', '토'], NAME = { hit: '목표 달성', close: '조금 늦음', late: '늦음', none: '' };
    var rows = [['날짜', '요일', '하루 시작', '그날 목표', '목표와 차이(분)', '결과', '첫 행동']];
    cleanRecords(records).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (r) {
      var ev = evaluate(r);
      rows.push([r.date, DOW[new Date(keyToUTC(r.date)).getUTCDay()], formatMinute(r.minuteOfDay),
        isInt(r.dayTarget) ? formatMinute(r.dayTarget) : '', ev.diff === null ? '' : ev.diff, NAME[ev.status] || '', r.actionDoneAt ? '했음' : '']);
    });
    return '\uFEFF' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  // ---------- 아침 알림 (캘린더) ----------
  // 내일부터 목표 시각마다 '하루 시작 기록' 알림. 단계 목표(3일마다 15분)는 단계별 일정으로 나누고, 최종 목표는 매일 반복.
  function reminderStages(s, fromKey) {
    var out = [], prev = null;
    for (var i = 0; i < 400; i++) {
      var key = addDays(fromKey, i), t = planTargetFor(s, key);
      if (prev && prev.min === t) prev.days++;
      else { prev = { start: key, min: t, days: 1 }; out.push(prev); }
      if (t === s.targetMin) { prev.forever = true; break; }
    }
    return out;
  }
  // RFC 5545: 한 줄 75바이트 넘으면 접기 (한글 글자 중간에서 자르지 않음)
  function icsFold(line) {
    var out = '', n = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i), code = line.charCodeAt(i), b = code < 0x80 ? 1 : code < 0x800 ? 2 : (code >= 0xD800 && code <= 0xDBFF) ? 4 : 3;
      if (code >= 0xD800 && code <= 0xDBFF) { ch += line.charAt(++i); }
      if (n + b > (out ? 74 : 75)) { out += '\r\n '; n = 0; }
      out += ch; n += b;
    }
    return out;
  }
  function icsStamp(key, min) { return key.replace(/-/g, '') + 'T' + pad2(Math.floor(min / 60)) + pad2(min % 60) + '00'; }
  function reminderIcs(s, fromKey, site, nowIso) {
    var stamp = String(nowIso || '').replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 15) + 'Z';
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gachi-wake//ko', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:같이 일어나요'];
    reminderStages(s, fromKey).forEach(function (g, i) {
      L.push('BEGIN:VEVENT', 'UID:gachi-wake-morning-' + i + '@gachi-wake', 'DTSTAMP:' + stamp,
        'DTSTART:' + icsStamp(g.start, g.min), 'DURATION:PT10M',
        'RRULE:FREQ=DAILY' + (g.forever ? '' : ';COUNT=' + g.days),
        'SUMMARY:☀ 하루 시작 기록하기 · ' + formatMinute(g.min),
        'DESCRIPTION:일어났으면 같이 일어나요에서 \'하루 시작하기\'를 눌러요.',
        site ? 'URL:' + site : 'X-NO-URL:1', 'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0M', 'DESCRIPTION:☀ 하루 시작 기록하기', 'END:VALARM', 'END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.filter(function (x) { return x !== 'X-NO-URL:1'; }).map(icsFold).join('\r\n') + '\r\n';
  }
  // 구글 캘린더는 일정 하나만 받으므로 내일 목표로 매일 반복
  function googleReminderUrl(s, fromKey, site) {
    var t = planTargetFor(s, fromKey), a = icsStamp(fromKey, t), b = icsStamp(fromKey, Math.min(t + 10, 1439));
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent('☀ 하루 시작 기록하기') +
      '&dates=' + a + '/' + b + '&ctz=Asia%2FSeoul&recur=' + encodeURIComponent('RRULE:FREQ=DAILY') +
      '&details=' + encodeURIComponent('일어났으면 같이 일어나요에서 \'하루 시작하기\'를 눌러요.' + (site ? '\n' + site : ''));
  }
  function reminderSig(s) { return s ? [s.baselineMin, s.targetMin, s.planStart].join('|') : ''; }

  // 한글 자판인 채로 코드를 치면 '아ㅠ2' 처럼 들어온다 → 두벌식 자판 위치로 되돌린다 (아=d+k, ㅠ=b)
  var KO_I = 'r R s e E f a q Q t T d w W c z x v g'.split(' ');
  var KO_V = 'k o i O j p u P h hk ho hl y n nj np nl b m ml l'.split(' ');
  var KO_F = ' r R rt s sw sg e f fr fa fq ft fx fv fg a q qt t T d w c z x v g'.split(' ');
  var KO_J = 'r R rt s sw sg e E f fr fa fq ft fx fv fg a q Q qt t T d w W c z x v g'.split(' ').concat(KO_V);
  function hangulToKeys(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xAC00 && c <= 0xD7A3) { var n = c - 0xAC00; out += KO_I[Math.floor(n / 588)] + KO_V[Math.floor((n % 588) / 28)] + KO_F[n % 28]; }
      else if (c >= 0x3131 && c <= 0x3163) out += KO_J[c - 0x3131];
      else out += s.charAt(i);
    }
    return out;
  }
  // 초대 링크, 링크가 들어간 공유 문구, 직접 친 코드(대문자·띄어쓰기·하이픈·한글 자판) 모두 받는다
  function parseRoomCode(input) {
    if (typeof input !== 'string') return null;
    var m = input.match(/[?&]room=([^&#\s]*)/), c;
    try { c = m ? decodeURIComponent(m[1]) : input; } catch (e) { return null; }
    c = c.replace(/[\s\-]/g, '');
    if (ROOM_RE.test(c.toLowerCase())) return c.toLowerCase();
    c = hangulToKeys(c).toLowerCase();
    return ROOM_RE.test(c) ? c : null;
  }
  function inviteUrl(site, code) { return site ? site + (site.indexOf('?') >= 0 ? '&' : '?') + 'room=' + code : ''; }
  // 서버 room_view 결과 → 화면용 칸. 내 시작 시각은 서버에 아직 안 올라갔어도 기기 기록으로 채운다.
  function roomSlots(view, myLocalMin) {
    if (!view || !Array.isArray(view.members)) return { slots: [], started: 0, total: 0 };
    var slots = view.members.map(function (m) {
      var min = isInt(m.start_min) ? m.start_min : null;
      if (m.me && min === null && isInt(myLocalMin)) min = myLocalMin;
      return { name: sanitizeName(String(m.nickname || ''), 10) || '?', me: !!m.me, owner: !!m.owner, min: min, time: min === null ? null : formatMinute(min) };
    });
    var started = slots.filter(function (s) { return s.min !== null; }).length;
    return { slots: slots, started: started, total: slots.length };
  }

  // 방 멤버 한 명의 프로필 (서버 room_view의 멤버 항목 → 화면용)
  var DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
  function statusFor(min, target) {
    if (!isInt(min)) return null;
    if (!isInt(target)) return 'none';
    var d = min - target;
    return d <= HIT_TOL ? 'hit' : (d <= CLOSE_TOL ? 'close' : 'late');
  }
  function profileFromMember(m, todayKey) {
    if (!m) return null;
    var target = isInt(m.target_min) ? m.target_min : null;
    var raw = Array.isArray(m.week) ? m.week.slice(-7) : [];
    while (raw.length < 7) raw.unshift(null);
    var week = raw.map(function (v, i) {
      var key = addDays(todayKey, i - 6), rest = v === -1, min = isInt(v) && v >= 0 ? v : null;
      return { key: key, label: DOW_KO[dayOfWeek(key)], isToday: i === 6, rest: rest, time: min === null ? null : formatMinute(min), status: rest ? 'rest' : statusFor(min, target) };
    });
    var mins = raw.filter(function (v) { return isInt(v) && v >= 0; });
    var joined = typeof m.joined === 'string' && DATE_RE.test(m.joined) ? m.joined : null;
    return {
      name: sanitizeName(String(m.nickname || ''), 10) || '?',
      me: !!m.me,
      owner: !!m.owner,
      key: typeof m.key === 'string' && /^[0-9a-f]{12}$/.test(m.key) ? m.key : null,
      today: isInt(m.start_min) ? formatMinute(m.start_min) : null,
      target: target === null ? null : formatMinute(target),
      streak: isInt(m.streak) && m.streak >= 0 ? m.streak : 0,
      days30: isInt(m.days30) && m.days30 >= 0 ? Math.min(30, m.days30) : 0,
      week: week,
      weekCount: mins.length,
      hits: week.filter(function (d) { return d.status === 'hit'; }).length,
      avg7: mins.length ? formatMinute(Math.round(mins.reduce(function (a, b) { return a + b; }, 0) / mins.length)) : null,
      joined: joined,
      joinedDays: joined ? Math.max(0, daysBetween(joined, todayKey)) + 1 : null
    };
  }
  // 방에 올릴 내 최근 기록 (최근 66일, 서버 규칙과 같은 범위)
  function recentStarts(records, todayKey) {
    return records.filter(function (r) { var d = daysBetween(r.date, todayKey); return d >= 0 && d <= 66; })
      .slice(-70).map(function (r) { return { d: r.date, m: r.minuteOfDay }; });
  }

  // ---------- 계정 (선택) ----------
  var USER_RE = /^[a-z0-9_.]{4,20}$/;
  function normUsername(u) { return typeof u === 'string' ? u.trim().toLowerCase() : ''; }
  function validUsername(u) { return USER_RE.test(normUsername(u)); }
  function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 64; }
  function cleanRooms(list) {
    if (!Array.isArray(list)) return [];
    var seen = {}, out = [];
    list.forEach(function (r) {
      if (!r || typeof r.code !== 'string' || parseRoomCode(r.code) !== r.code || seen[r.code]) return;
      seen[r.code] = true;
      out.push({ code: r.code, name: sanitizeName(String(r.name || ''), 20) || '우리 방' });
    });
    return out.slice(0, 10);
  }
  // 계정에 보관할 묶음 (최근 400일 기록까지)
  function accountData(settings, records, rooms, nick) {
    return { v: 1, settings: settings || null, records: cleanRecords(records).slice(-400), rooms: cleanRooms(rooms), nick: sanitizeName(String(nick || ''), 10) };
  }
  // 로그인할 때: 계정의 묶음 + 이 기기의 기록을 합침. 목표는 계정 것이 우선, 없으면 기기 것.
  function mergeAccount(local, remote) {
    local = local || {}; remote = remote || {};
    var rs = remote.settings && !validateSettings(remote.settings).length ? remote.settings : null;
    var ls = local.settings && !validateSettings(local.settings).length ? local.settings : null;
    return {
      v: 1,
      settings: rs || ls,
      records: mergeRecords(remote.records, local.records).slice(-400),
      rooms: cleanRooms([].concat(remote.rooms || [], local.rooms || [])),
      nick: sanitizeName(String(remote.nick || local.nick || ''), 10)
    };
  }

  // ---------- 공유 서버(선택) ----------
  function serverPayload(rec, anonId) {
    return { anon_id: anonId, day: rec.date, bucket: Math.floor(rec.minuteOfDay / BUCKET) };
  }
  // 서버 응답 [{bucket, n}] → 04:00~13:30 20칸
  function parseServerCounts(rows) {
    var out = [];
    for (var i = 0; i < BUCKETS; i++) out.push(0);
    if (!Array.isArray(rows)) return out;
    rows.forEach(function (r) {
      if (!r || !isInt(r.bucket)) return;
      var i = r.bucket - OPEN_MIN / BUCKET;
      var n = Number(r.n);
      if (i >= 0 && i < BUCKETS && isFinite(n) && n >= 0) out[i] = Math.min(Math.floor(n), 1e7);
    });
    return out;
  }

  var api = {
    OPEN_MIN: OPEN_MIN, CLOSE_MIN: CLOSE_MIN, BUCKET: BUCKET, BUCKETS: BUCKETS, WINDOWS: WINDOWS,
    COLS: COLS, MAX_WINDOWS: MAX_WINDOWS, buildingSize: buildingSize,
    STEP_MIN: STEP_MIN, STEP_DAYS: STEP_DAYS, HIT_TOL: HIT_TOL, JOURNEY_DAYS: JOURNEY_DAYS, DEMO_TOTAL: DEMO_TOTAL,
    TARGET_MIN_LO: TARGET_MIN_LO, TARGET_MIN_HI: TARGET_MIN_HI, ACTION_MAX: ACTION_MAX,
    toDateKey: toDateKey, minuteOfDay: minuteOfDay, formatMinute: formatMinute, toLocalISO: toLocalISO,
    daysBetween: daysBetween, addDays: addDays, isWeekend: isWeekend, dayPhase: dayPhase, cohortOf: cohortOf,
    sanitizeAction: sanitizeAction, validateSettings: validateSettings, makeSettings: makeSettings,
    planTargetFor: planTargetFor, planInfo: planInfo, bedtimeFor: bedtimeFor,
    validateRecord: validateRecord, cleanRecords: cleanRecords, mergeRecords: mergeRecords, findDay: findDay,
    createStartRecord: createStartRecord, markAction: markAction, evaluate: evaluate, habitStats: habitStats,
    crowdForDay: crowdForDay, awakeUntil: awakeUntil, recentCount: recentCount,
    windowOrder: windowOrder, myWindow: myWindow, litWindows: litWindows,
    sanitizeName: sanitizeName, parseRoomCode: parseRoomCode, inviteUrl: inviteUrl, roomSlots: roomSlots,
    profileFromMember: profileFromMember, recentStarts: recentStarts,
    normUsername: normUsername, validUsername: validUsername, validPassword: validPassword, cleanRooms: cleanRooms,
    accountData: accountData, mergeAccount: mergeAccount,
    localStreak: localStreak, recentDays: recentDays, recordsCsv: recordsCsv,
    SKIES: SKIES, TIER_NAMES: TIER_NAMES, MILESTONES: MILESTONES, EFFECTS: EFFECTS, MAX_SHIELDS: MAX_SHIELDS,
    pickSky: pickSky, skyById: skyById, journeyTimeline: journeyTimeline, dayInfo: dayInfo, effectTier: effectTier, nextEffect: nextEffect,
    weekRecap: weekRecap, roomTogether: roomTogether, mulberry32: mulberry32,
    reminderStages: reminderStages, reminderIcs: reminderIcs, googleReminderUrl: googleReminderUrl, reminderSig: reminderSig,
    serverPayload: serverPayload, parseServerCounts: parseServerCounts, hashString: hashString
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WakeLogic = api;
})(typeof self !== 'undefined' ? self : this);
