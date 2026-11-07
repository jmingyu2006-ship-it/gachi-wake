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
  var WINDOWS = 96;        // 건물 창문 수 (8 x 12)
  var DEMO_TOTAL = 5000;
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

  // 창문 배치: 날짜마다 고정된 순서로 불이 켜진다. 내 창문은 기기 id로 고정.
  function windowOrder(seedKey, total) {
    total = total || WINDOWS;
    var idx = [];
    for (var i = 0; i < total; i++) idx.push(i);
    var rand = mulberry32(hashString('w:' + seedKey));
    for (var j = total - 1; j > 0; j--) { var k = Math.floor(rand() * (j + 1)); var t = idx[j]; idx[j] = idx[k]; idx[k] = t; }
    return idx;
  }
  function myWindow(anonId, total) { return hashString('me:' + anonId) % (total || WINDOWS); }
  // 창문 1칸 = 몇 명: 하루 예상 인원(expected)을 알면 그 기준으로 고정해 아침 동안 건물이 점점 차오르게,
  // 모르면(실제 서버 초기) 1·2·5·10… 단위로 올려서 건물의 3/4을 넘지 않게
  var NICE = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000];
  function windowScale(count, total, expected) {
    total = total || WINDOWS;
    var per;
    if (expected) per = Math.max(1, Math.ceil(expected / (total * 0.9)));
    else { per = NICE[NICE.length - 1]; for (var i = 0; i < NICE.length; i++) if (count / NICE[i] <= total * 0.75) { per = NICE[i]; break; } }
    return { per: per, lit: Math.min(total - 1, Math.ceil(count / per)) };
  }
  function litWindows(count, seedKey, me, total, expected) {
    total = total || WINDOWS;
    var s = windowScale(count, total, expected);
    var order = windowOrder(seedKey, total).filter(function (i) { return i !== me; });
    return { per: s.per, lit: order.slice(0, Math.min(s.lit, order.length)) };
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
    STEP_MIN: STEP_MIN, STEP_DAYS: STEP_DAYS, HIT_TOL: HIT_TOL, JOURNEY_DAYS: JOURNEY_DAYS, DEMO_TOTAL: DEMO_TOTAL,
    TARGET_MIN_LO: TARGET_MIN_LO, TARGET_MIN_HI: TARGET_MIN_HI, ACTION_MAX: ACTION_MAX,
    toDateKey: toDateKey, minuteOfDay: minuteOfDay, formatMinute: formatMinute, toLocalISO: toLocalISO,
    daysBetween: daysBetween, addDays: addDays, isWeekend: isWeekend, dayPhase: dayPhase, cohortOf: cohortOf,
    sanitizeAction: sanitizeAction, validateSettings: validateSettings, makeSettings: makeSettings,
    planTargetFor: planTargetFor, planInfo: planInfo, bedtimeFor: bedtimeFor,
    validateRecord: validateRecord, cleanRecords: cleanRecords, mergeRecords: mergeRecords, findDay: findDay,
    createStartRecord: createStartRecord, markAction: markAction, evaluate: evaluate, habitStats: habitStats,
    crowdForDay: crowdForDay, awakeUntil: awakeUntil, recentCount: recentCount,
    windowOrder: windowOrder, myWindow: myWindow, windowScale: windowScale, litWindows: litWindows,
    serverPayload: serverPayload, parseServerCounts: parseServerCounts, hashString: hashString
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WakeLogic = api;
})(typeof self !== 'undefined' ? self : this);
