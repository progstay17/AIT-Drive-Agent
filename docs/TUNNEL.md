# Tunnel Deployment

## Current AIT setup: Caddy Panel + SSH reverse tunnel

The storage PC runs Agent on `127.0.0.1:4001`. An SSH client on that PC creates a reverse listener on the VPS at `127.0.0.1:8081`. Caddy Panel proxies a public HTTPS hostname to the VPS loopback listener.

```text
Coolify gateway --HTTPS--> agent.example.net
                              |
                          Caddy on VPS
                              |
                       127.0.0.1:8081
                              |
                       SSH reverse tunnel
                              |
                    storage PC 127.0.0.1:4001
```

### Configure

1. Confirm Agent is listening locally and `http://127.0.0.1:4001/health` returns `{ "ok": true }`.
2. In Caddy Panel, create an SSH tunnel client. Keep the VPS listener on `127.0.0.1:8081`; target the storage PC's `127.0.0.1:4001`.
3. Install the generated public key in the intended VPS account's authorized keys. Restrict it to the exact loopback listener/port and use least privilege.
4. Copy `run-tunnel.ps1.example` to `run-tunnel.ps1` on the storage PC. Fill in the VPS host and SSH user. The actual file is intentionally ignored by Git.
5. Test SSH manually before creating a Scheduled Task. Use `-N`, `-i`, `IdentitiesOnly=yes`, `BatchMode=yes`, `ServerAliveInterval=30`, `ServerAliveCountMax=3`, `ExitOnForwardFailure=yes`, and the exact `-R 127.0.0.1:8081:127.0.0.1:4001` mapping.
6. In Caddy Panel, configure the public Agent site to reverse-proxy to `127.0.0.1:8081` and enable HTTPS.
7. From the storage PC, test `https://<agent-hostname>/health`. From an external network, test the same URL.
8. Test a protected endpoint without a token, such as `/list`; it should return HTTP 401, not an HTML page or a Caddy error.
9. Configure Coolify gateway variables: `AGENT_URL=https://<agent-hostname>` and `AGENT_TOKEN` equal to the local Agent token. Redeploy gateway.

### Windows auto-start

Use Windows Task Scheduler under the same Windows account that owns the SSH private key. Configure Agent to start at user logon, then the SSH tunnel task with a short delay. Set the tasks to restart on failure and do not store secrets in task arguments. The example `run-agent.ps1` reads local `agent.env`; the SSH script reads the private key from the user's `.ssh` directory.

Do not configure `TUNNEL_PROVIDER=cloudflare` or `chisel` at the same time for this SSH tunnel. Keep `TUNNEL_PROVIDER=none`; the Caddy Panel tunnel is managed separately from Node.

## Alternative: Cloudflare Tunnel

Use only if the hostname belongs to a DNS zone managed by your Cloudflare account.

1. Install `cloudflared` on the storage PC.
2. Authenticate and create a named tunnel using Cloudflare's current documentation.
3. Set its origin service to `http://127.0.0.1:4001`.
4. Set `TUNNEL_PROVIDER=cloudflare` and `CLOUDFLARED_TUNNEL_TOKEN` in `agent.env`.
5. Restart Agent and verify the public `/health` and protected endpoint behavior.

An `sslip.io` hostname is not a Cloudflare-managed DNS zone. Do not assume you can attach it to a named tunnel.

## Alternative: Chisel

Chisel is an optional legacy provider. Set `TUNNEL_PROVIDER=chisel`, `CHISEL_SERVER`, `CHISEL_AUTH`, and optionally `CHISEL_PATH`/`CHISEL_REMOTE_PORT`. Keep the reverse listener bound to server loopback and use HTTPS. Only use binaries obtained from a trusted official release and verified by your endpoint protection. Never disable antivirus or create exclusions to run a flagged archive.
