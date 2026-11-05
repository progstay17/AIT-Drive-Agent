# Architecture

## Responsibilities

AIT Drive is split into two independently deployed components.

### Web gateway (separate AIT-Drive repository, deployed to Coolify)
- Owns user authentication, sessions, account records, quotas, permissions, admin UI, share links, and browser UI.
- Persists account metadata in its own persistent volume (typically `/data` on Coolify).
- Authenticates each browser request, determines account ID/quota/permissions, then calls Agent over HTTPS.
- Holds `AGENT_TOKEN` server-side. Never expose it to browser JavaScript or responses.

### Storage Agent (this repository, runs on the storage PC)
- Owns file-system operations under `STORAGE_ROOT` only.
- Does not store passwords, sessions, account roles, or authoritative account quotas.
- Requires the shared Bearer token for every route except `/health`.
- For file routes, trusts gateway-supplied `X-AIT-User`, `X-AIT-Quota`, and `X-AIT-Perms`. The gateway is therefore a security boundary.

## Request flow

```text
Browser --HTTPS--> Coolify Web Gateway
                      | validates session + permissions
                      | Authorization: Bearer AGENT_TOKEN
                      | X-AIT-User / X-AIT-Quota / X-AIT-Perms
                      v
               HTTPS Agent hostname
                      | Caddy reverse proxy
               VPS 127.0.0.1:8081
                      | SSH reverse tunnel
                PC 127.0.0.1:4001
                      |
                 STORAGE_ROOT
```

The tunnel is infrastructure, not user authentication. In the current Caddy Panel deployment, the SSH client runs on the storage PC and opens a reverse forward to VPS loopback. Caddy terminates public HTTPS and proxies to that listener.

## Storage layout

```text
STORAGE_ROOT/
├── users/
│   ├── _owner/              # owner drive
│   │   └── .trash/
│   └── <account-id>/
│       └── .trash/
└── .ait/
    └── archive/              # archived account folders
```

`migrateV1()` performs a one-time migration from a legacy flat layout into `users/_owner` when `.ait` does not exist. Back up storage before upgrading a legacy installation.

## Quota accounting
- Gateway sends quota in bytes through `X-AIT-Quota`.
- Agent calculates actual usage from disk and caches it in memory, refreshing when dirty or after five minutes.
- Trash remains included in `used`; emptying trash releases that space.
- Upload checks quota and physical free space before streaming, then checks quota during streaming.
- Quota is a logical cap, not reserved physical disk capacity.

## Permission model

| Permission | Operations |
|---|---|
| `upload` | `POST /upload` |
| `modify` | `POST /mkdir`, `/rename`, `/move` |
| `delete` | `POST /delete`, `/trash/empty` |
| `share` | Sharing is implemented by gateway; Agent does not create public share links. |

Read/list/search/download require a valid account identity and Agent token, but no extra permission flag.

## Failure boundaries
- Browser-to-gateway failure: web UI cannot reach the gateway.
- Gateway-to-Agent failure: gateway should report storage offline/unavailable; account metadata may still be available.
- Tunnel down: local Agent `/health` can pass while the public hostname fails.
- Agent down: local and public `/health` fail.
- Storage unavailable/full: Agent returns file-system or quota errors.

## Deployment independence

Deploy the gateway from the AIT-Drive repository to Coolify. Install this repository separately on the PC that owns the data. The gateway container does not need a copy of Agent source; it needs only `AGENT_URL` and `AGENT_TOKEN`.
