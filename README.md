# AIT Drive Agent

Standalone storage service for AIT Drive. This repository runs on the Windows PC that owns the files; the AIT Drive web gateway runs separately (for example, in Coolify).

## Security model

- The agent binds to `127.0.0.1:4001` by default. **Do not change this to `0.0.0.0` for a public deployment.**
- Publish it through an outbound HTTPS tunnel. The current AIT Drive deployment uses Caddy Panel SSH reverse tunneling; Cloudflare Tunnel remains an alternative. No router port-forwarding or inbound Windows Firewall rule is needed.
- Every API route except `/health` requires `Authorization: Bearer <AGENT_TOKEN>`. The gateway alone holds this token; never put it in browser code or a public repository.
- The public agent hostname is a separate origin from the web app, e.g. `https://pc-agent.example.com`. The gateway's `AGENT_URL` points to that hostname.
- Keep `agent.env`, credentials, tunnel credentials, and storage out of Git.

## Requirements

- Node.js 20+
- Windows 10/11 or Linux
- A persistent storage folder with enough disk space
- For a stable public HTTPS hostname: Caddy Panel on a VPS or a domain managed in Cloudflare

## Windows setup

1. Clone this repository to `C:\AIT-Drive-Agent` (or another non-storage folder).
2. Run `npm ci`.
3. Run `setup-agent.bat`, choose the existing AIT Drive storage directory, and retain the current `AGENT_TOKEN` when migrating an existing installation. Do not create a new storage root if it would hide the existing user files.
4. Confirm `agent.env` contains `AGENT_HOST=127.0.0.1`, `AGENT_PORT=4001`, the correct `STORAGE_ROOT`, and the same `AGENT_TOKEN` configured in the web gateway.
5. Start with `start-agent.bat`. Local health check: `curl http://127.0.0.1:4001/health`.

## Publish with Caddy Panel SSH reverse tunnel (current deployment)

1. Keep `AGENT_HOST=127.0.0.1` and `AGENT_PORT=4001` in `agent.env`.
2. In Caddy Panel, create an SSH reverse-tunnel client that listens on VPS `127.0.0.1:8081` and forwards to PC `127.0.0.1:4001`.
3. Configure the Caddy Panel site to reverse-proxy to `127.0.0.1:8081` and enable HTTPS.
4. Use `run-tunnel.ps1.example` as a template for the reconnect loop. Keep the actual `run-tunnel.ps1` and private SSH key local.
5. Set the gateway `AGENT_URL` to the public HTTPS hostname and keep `AGENT_TOKEN` identical on both sides.

## Publish with Cloudflare Tunnel

The public hostname must be on a domain/zone you control in Cloudflare. The `sslip.io` hostname used by the web app is not a Cloudflare-managed DNS zone, so it cannot be used as a named-tunnel hostname unless you separately control that DNS zone.

1. Install `cloudflared` on the storage PC.
2. Run `cloudflared tunnel login` and authorize the Cloudflare account that manages your domain.
3. Create a named tunnel: `cloudflared tunnel create ait-drive-agent`.
4. Create a DNS route such as `pc-agent.your-domain.com` for that tunnel: `cloudflared tunnel route dns ait-drive-agent pc-agent.your-domain.com`.
5. Create `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\Users\<WINDOWS-USER>\.cloudflared\<TUNNEL-UUID>.json
ingress:
  - hostname: pc-agent.your-domain.com
    service: http://127.0.0.1:4001
  - service: http_status:404
```

6. Install/run the tunnel as a Windows service using the documented `cloudflared service install` flow for the installed cloudflared version. Keep the tunnel credentials file private.
7. From a device outside the home network, request `https://pc-agent.your-domain.com/list` without a token. Expected result: HTTP 401. This proves the public route reaches the agent and the API is still protected.
8. Set the web gateway's `AGENT_URL=https://pc-agent.your-domain.com` and `AGENT_TOKEN` to the exact same secret in `agent.env`, then redeploy the gateway.

Do not expose port 4001 directly to the internet. Do not use a Cloudflare Quick Tunnel as a permanent production endpoint; its hostname is temporary.

## Configuration (`agent.env`)

```dotenv
STORAGE_ROOT=C:\AIT-Drive-Storage
AGENT_HOST=127.0.0.1
AGENT_PORT=4001
AGENT_TOKEN=<random-secret-at-least-32-bytes>
```

Generate a token locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The token is a shared secret between the gateway and agent. Rotate it on both sides together.

## API

The agent is a storage API, not a user-facing website. `/health` returns a minimal health response; all other routes require the bearer token and the gateway-supplied user identity/permissions. See the AIT-Drive repository's `docs/API.md` and `docs/ARCHITECTURE.md` for the gateway contract.

## Existing installation migration

- Stop the old `C:\cloud-drive\agent\start-agent.bat` process/task before starting this copy on port 4001.
- Preserve the existing `STORAGE_ROOT` and `AGENT_TOKEN`; never move or delete the storage folder during code migration.
- Verify the local `/health` endpoint, then verify the public tunnel returns 401 without a token and the AIT Drive UI reports the PC online.
- The main AIT-Drive repository currently retains a mirrored `agent/` directory for its integrated API test harness. Keep the standalone copy in sync when updating the Agent.
