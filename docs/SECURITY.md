# Security Notes

## Trust boundaries
1. **Browser:** untrusted. It must never receive `AGENT_TOKEN` or set trusted `X-AIT-*` headers directly to Agent.
2. **Web gateway:** trusted policy enforcement point. It validates sessions, account state, quotas, and permissions before calling Agent.
3. **Tunnel/reverse proxy:** trusted transport path. Use HTTPS publicly and bind the reverse listener to VPS loopback.
4. **Agent:** trusted storage service. It authenticates the gateway's shared token and confines paths to each account directory.
5. **Storage PC:** contains private files, Agent config, and SSH private key. Protect the OS account and backups.

## Required controls
- Keep `AGENT_HOST=127.0.0.1`; do not bind Agent directly to a public interface.
- Use a random `AGENT_TOKEN` of at least 32 random bytes. The current code accepts 24+ characters; 32 random bytes encoded as hex is recommended.
- Store the token only in local `agent.env` and Coolify environment variables. Never commit it, paste it into tickets, or include it in logs.
- Use HTTPS from Coolify to the public Agent hostname.
- In Caddy Panel SSH tunnel, bind the remote listener to `127.0.0.1`, not `0.0.0.0`; restrict the authorized key to the intended listener/port.
- Protect SSH private keys with Windows account permissions. Never upload private keys to GitHub.
- Keep `STORAGE_ROOT` outside the application repository and back it up separately.
- Keep Windows Defender enabled. Do not whitelist suspicious tunnel binaries to force deployment.
- Restrict access to the Coolify project and its environment variables.

## Current Agent behavior
- `/health` is intentionally unauthenticated and reveals only `{ ok: true }`.
- All other routes require `Authorization: Bearer <AGENT_TOKEN>`.
- File endpoints additionally require gateway-supplied identity, quota, and permissions headers.
- Paths are resolved within the current user's storage root; path traversal and direct access to `.trash` are rejected.
- Downloads set `X-Content-Type-Options: nosniff`.
- Express `X-Powered-By` is disabled; internal server errors return a generic message.

## Important limitation

Agent trusts `X-AIT-User`, `X-AIT-Quota`, and `X-AIT-Perms` after the shared token check. Anyone who obtains `AGENT_TOKEN` can impersonate the gateway and choose account IDs/permissions. Treat this token as a high-impact credential and never expose Agent directly to untrusted clients.

## Rotation procedure
1. Generate a new token locally:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update `AGENT_TOKEN` in Agent's local `agent.env`.
3. Update gateway `AGENT_TOKEN` in Coolify to the exact same value.
4. Restart/redeploy both sides in a coordinated maintenance window.
5. Verify local `/health`, public `/health`, and a gateway file operation.
6. Remove obsolete copies from secret stores where applicable. Never add tokens to Git history.

## Backups and deletion

Soft delete is not a backup. Emptying trash is permanent. Account archival moves data to `.ait/archive`; it does not protect from disk failure, ransomware, or administrator deletion. Keep versioned backups on a separate device/offsite destination and test restoration.
