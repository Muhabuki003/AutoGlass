# Connecting the AutoGlass chat widget to your local model

Flow: page -> Cloudflare Worker -> Cloudflare tunnel -> token gate (127.0.0.1:11435) -> Ollama (qwen3:8b)

Model: `qwen3:8b` (not `lazusai-booking`). It is the smaller of the two general models, so it fits
in the server's 8 GB RAM, and it handles Spanish. The gate turns off its "thinking" mode and
caps replies at 220 tokens so answers come back inside Cloudflare's ~100 s limit on CPU.

## 1. On the server: free memory and install the gate

```bash
ollama stop mistral-nemo:12b          # 8.7 GB resident, leaves no room for anything else
mkdir -p /opt/autoglass-gate
# copy server/ollama-gate.mjs to /opt/autoglass-gate/
openssl rand -hex 32                   # generate a token, keep it for step 4
echo "GATE_TOKEN=<paste token>" > /etc/autoglass-gate.env && chmod 600 /etc/autoglass-gate.env
cp autoglass-gate.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now autoglass-gate
```

Test locally:
```bash
curl -s http://127.0.0.1:11435/api/chat -H "Authorization: Bearer <token>" \
  -d '{"messages":[{"role":"user","content":"Hi"}]}'
```

## 2. Create the tunnel (separate from the lazusai one)

```bash
cloudflared tunnel login
cloudflared tunnel create autoglass-llm
cloudflared tunnel route dns autoglass-llm llm.yourdomain.com
# create /etc/cloudflared/autoglass-config.yaml from server/cloudflared-autoglass.yml.example
cloudflared service install      # or run a second systemd unit pointing at the new config:
# cloudflared tunnel --config /etc/cloudflared/autoglass-config.yaml run autoglass-llm
```

Note: `cloudflared service install` can clash with the existing lazusai tunnel service. Safer is a
second systemd unit that runs `cloudflared tunnel --config /etc/cloudflared/autoglass-config.yaml run autoglass-llm`.

## 3. Deploy the Worker

Edit `UPSTREAM_URL` (and `ALLOWED_ORIGIN`) in `wrangler.toml`, then:

```bash
cd worker
npx wrangler secret put GATE_TOKEN     # paste the same token from step 1
npx wrangler deploy
```

## 4. Point the page at the Worker

In `index.html`, set `API` (near the top of the script, marked TODO) to your Worker URL, e.g. `https://autoglass-chat.<your-subdomain>.workers.dev`.

## Housekeeping
- Add a Cloudflare rate-limiting rule on the Worker route (e.g. 20 requests/min per IP). The model is CPU-only and serves one request at a time.
- Ollama itself should stay bound to 127.0.0.1; never expose port 11434 through the tunnel.
