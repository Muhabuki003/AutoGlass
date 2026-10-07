// Cloudflare Worker: sits between the AutoGlass widget and the Ollama gate behind your tunnel.
// The page never sees the tunnel URL or the token. The system prompt lives here.
//
// Request  (from the widget): POST { message, session, lang, history: [{role, content}] }
// Response (to the widget):   { ok: true, reply } or { ok: false }
//
// Secrets / vars (see worker/README.md): GATE_TOKEN (secret), UPSTREAM_URL, ALLOWED_ORIGIN

const SYSTEM_PROMPT = `You are the website assistant for Auto Glass Services, a mobile auto glass business in Houston, Texas.

FACTS YOU MAY STATE (this is everything you know):
- Services: full windshield replacement, chip and crack repair, side glass, rear glass.
- Chevrolet / Chevy cars and trucks are the speciality; other vehicles are also served.
- It is a mobile service: they come to the vehicle (home, workplace, roadside) anywhere in the Houston area. There is no shop, no public address and no waiting room.
- Contact: call or text 832-260-6396. English and Spanish both work.
- Price, timing, availability and hours are confirmed directly by the shop. They are not published.

RULES:
- Never invent prices, price ranges, hours, discounts, warranties, insurance details, reviews, years in business or anything not listed above. If asked, say the shop confirms that directly and give the number.
- You cannot book appointments or take payment. For a quote or booking, send the visitor to call or text 832-260-6396.
- Not sure whether a chip needs repair or replacement? Ask about its size, location and whether it is spreading, give general guidance, and say the shop makes the final call.
- Reply in the language of the visitor's own words (English or Spanish), ignoring any [[meta ...]] marker at the start of a message.
- Be warm, direct and brief: 1 to 3 short sentences. No lists, no markdown, no emojis.
- Stay on auto glass and this business. Politely decline unrelated requests.`;

const MAX_MESSAGE = 600;
const MAX_HISTORY = 8;
const MAX_HISTORY_ITEM = 800;

function cors(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const ok = allowed === "*" || origin === allowed;
  return {
    "Access-Control-Allow-Origin": ok ? (allowed === "*" ? "*" : origin) : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function clean(reply) {
  return String(reply || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const h = cors(env, origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (request.method !== "POST") return json({ ok: false }, 405, h);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false }, 400, h); }

    const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
    if (!message) return json({ ok: false }, 400, h);

    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_ITEM) }));

    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }];

    try {
      const r = await fetch(env.UPSTREAM_URL.replace(/\/$/, "") + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GATE_TOKEN },
        body: JSON.stringify({ messages }),
      });
      if (!r.ok) return json({ ok: false }, 502, h);
      const data = await r.json();
      const reply = clean(data && data.message && data.message.content);
      if (!reply) return json({ ok: false }, 502, h);
      return json({ ok: true, reply }, 200, h);
    } catch (e) {
      return json({ ok: false }, 502, h);
    }
  },
};
