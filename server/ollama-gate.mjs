// Tiny token gate in front of Ollama. Runs on the server, listens on localhost only.
// The Cloudflare tunnel points at THIS (127.0.0.1:11435), never at Ollama directly.
//
//  - requires "Authorization: Bearer <GATE_TOKEN>"
//  - only allows POST /api/chat
//  - pins the model, so a leaked token cannot reach lazusai-booking or anything else
//  - forces stream:false and think:false, caps context and output length
//
// Env: GATE_TOKEN (required), MODEL (default qwen3:8b), PORT (default 11435),
//      OLLAMA (default http://127.0.0.1:11434), MAX_TOKENS (default 220)

import http from "node:http";

const TOKEN = process.env.GATE_TOKEN || "";
const MODEL = process.env.MODEL || "qwen3:8b";
const PORT = Number(process.env.PORT || 11435);
const OLLAMA = process.env.OLLAMA || "http://127.0.0.1:11434";
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 220);
const MAX_BODY = 32 * 1024;

if (!TOKEN || TOKEN.length < 24) {
  console.error("GATE_TOKEN must be set and at least 24 characters long.");
  process.exit(1);
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function tokenOk(header) {
  const want = "Bearer " + TOKEN;
  if (!header || header.length !== want.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < want.length; i++) diff |= header.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api/chat") return send(res, 404, { error: "not found" });
  if (!tokenOk(req.headers["authorization"])) return send(res, 401, { error: "unauthorized" });

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { send(res, 413, { error: "too large" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return send(res, 400, { error: "bad json" }); }
    if (!Array.isArray(body.messages) || !body.messages.length) return send(res, 400, { error: "messages required" });

    const msgs = body.messages
      .filter((m) => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    const upstream = {
      model: MODEL,
      messages: msgs,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { num_ctx: 4096, num_predict: MAX_TOKENS, temperature: 0.4 },
    };

    try {
      const r = await fetch(OLLAMA + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(upstream),
      });
      const text = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(text);
    } catch (e) {
      send(res, 502, { error: "ollama unreachable" });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`gate on 127.0.0.1:${PORT} -> ${OLLAMA} (${MODEL})`));
