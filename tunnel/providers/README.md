# Tunnel providers

The agent API remains bound to `127.0.0.1:4001`. Do not expose port 4001 directly to the public internet. Keep reverse listeners restricted to VPS loopback.

## Caddy Panel SSH reverse tunnel (current AIT Drive deployment)

This deployment uses Caddy Panel's SSH reverse-tunnel feature, separate from the agent's built-in tunnel manager. Keep `TUNNEL_PROVIDER=none` in `agent.env` and run the PowerShell reconnect loop on the Windows storage PC.

1. Copy `run-tunnel.ps1.example` to `run-tunnel.ps1` and set `$sshHost`, `$sshUser`, and the port values for your VPS.
2. Keep the SSH private key under `%USERPROFILE%\.ssh\`; never commit its contents.
3. The reverse forward maps VPS `127.0.0.1:8081` to PC `127.0.0.1:4001`.
4. In Caddy Panel, create a site for the public agent hostname and set its reverse-proxy upstream to `127.0.0.1:8081`; enable HTTPS.
5. Restrict the VPS authorized key to `permitlisten="127.0.0.1:8081"` and verify the public `/health` endpoint.

The sample reconnects after an SSH disconnect. Keep the actual `run-tunnel.ps1` local; `.gitignore` excludes it because it contains your VPS address and account name.

## Cloudflare Tunnel (alternative)

Set `TUNNEL_PROVIDER=cloudflare`, `CLOUDFLARED_PATH` (optional; default `cloudflared` on PATH), and `CLOUDFLARED_TUNNEL_TOKEN`. Configure the Cloudflare public hostname to forward to `http://127.0.0.1:4001`. The hostname must belong to a DNS zone managed by your Cloudflare account. An `sslip.io` hostname cannot be attached to a Cloudflare named tunnel unless you control that DNS zone.

## Chisel reverse tunnel (optional legacy provider)

Set `TUNNEL_PROVIDER=chisel`, `CHISEL_SERVER`, `CHISEL_AUTH`, and optionally `CHISEL_PATH` / `CHISEL_REMOTE_PORT`. The VPS runs a Chisel server with the same dedicated auth pair; its reverse listener must remain on VPS loopback. Use HTTPS for the Chisel control endpoint and keep credentials private and distinct from `AGENT_TOKEN`.
