// 같이 일어나요 — 알림 보내기 (Supabase Edge Function: send-reminders)
// mode=cron: 5분마다 pg_cron이 부름(x-cron-secret 확인) → 지금 보낼 아침·잘 시간 알림
// mode=test: 앱의 '테스트 알림' → 본인 구독(기기 번호+주소가 맞을 때)에만, 20초에 한 번
// mode=vapid: 공개 키 확인(처음이면 키를 만들어 DB 비공개 영역에 보관)
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://jmingyu2006-ship-it.github.io/gachi-wake/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ENDPOINT_RE = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

type Cfg = { vapid_public: string | null; vapid_private: string | null; cron_secret: string };
let cfg: Cfg | null = null;
async function config(): Promise<Cfg> {
  if (cfg) return cfg;
  let c: Cfg = await rpc("push_config");
  if (!c.vapid_public) {
    const k = webpush.generateVAPIDKeys();
    c = await rpc("push_set_vapid", { p_pub: k.publicKey, p_priv: k.privateKey });
  }
  webpush.setVapidDetails(SITE, c.vapid_public!, c.vapid_private!);
  cfg = c;
  return c;
}

const hhmm = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0");
};
type Sub = { kind: string; endpoint: string; p256dh: string; auth: string; target?: number; sleep?: number };
function payloadFor(s: Sub) {
  if (s.kind === "morning") {
    return { title: "☀ 하루를 시작할 시간이에요", body: `오늘 목표 ${hhmm(s.target!)} · 일어났으면 불을 켜 주세요`, tag: "gachi-morning", url: SITE + "?from=push" };
  }
  if (s.kind === "bedtime") {
    return { title: "🌙 잘 준비할 시간이에요", body: `내일 목표 ${hhmm(s.target!)} · 30분 안에 누우면 ${s.sleep}시간 잘 수 있어요`, tag: "gachi-bed", url: SITE };
  }
  return { title: "알림이 잘 와요", body: "목표 시각에 이렇게 알려 드릴게요. 이미 하루를 시작한 날엔 보내지 않아요.", tag: "gachi-test", url: SITE };
}
async function send(s: Sub) {
  if (!ENDPOINT_RE.test(s.endpoint)) return "skip";
  try {
    await webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payloadFor(s)),
      { TTL: s.kind === "bedtime" ? 1800 : 3600, urgency: "high" },
    );
    return "ok";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) { await rpc("push_gone", { p_endpoint: s.endpoint }); return "gone"; }
    return "err:" + (code || String((e as Error).message).slice(0, 80));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "bad_request" }, 405);
  const body = await req.json().catch(() => ({}));
  try {
    const c = await config();
    if (body.mode === "vapid") return json({ vapid: c.vapid_public });
    if (body.mode === "cron") {
      if (req.headers.get("x-cron-secret") !== c.cron_secret) return json({ error: "forbidden" }, 403);
      const due: Sub[] = (await rpc("push_claim_due")) || [];
      const results = await Promise.all(due.map(send));
      return json({ total: results.length, sent: results.filter((r) => r === "ok").length, results });
    }
    if (body.mode === "test") {
      if (!UUID_RE.test(String(body.anon)) || typeof body.endpoint !== "string") return json({ error: "bad_request" }, 400);
      const s: Sub | null = await rpc("push_for_test", { p_anon: body.anon, p_endpoint: body.endpoint });
      if (!s) return json({ error: "wait_or_not_found" }, 429);
      return json({ result: await send(s) });
    }
    return json({ error: "bad_request" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e).slice(0, 200) }, 500);
  }
});
