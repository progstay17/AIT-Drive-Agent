# Troubleshooting

## Local `/health` cannot connect

- Confirm the Agent process is running.
- Check `Get-NetTCPConnection -LocalPort 4001 -State Listen`.
- Verify `AGENT_HOST=127.0.0.1`, `AGENT_PORT=4001`, and that `AGENT_TOKEN` is at least 24 characters.
- Check the Agent process output for startup errors. Do not share `agent.env` or token values.

## Local health works, public health fails

The Agent is running; troubleshoot tunnel and Caddy separately:

1. Check the SSH tunnel Scheduled Task is running and its process exists.
2. Check the VPS loopback listener `127.0.0.1:8081` exists.
3. From the VPS, request `http://127.0.0.1:8081/health`.
4. Verify Caddy Panel site upstream is `127.0.0.1:8081` and HTTPS hostname is correct.
5. Verify external DNS resolves to the VPS and HTTPS certificate is valid.

A TCP port test alone does not prove the HTTP upstream is healthy.

## Public `/health` works, gateway reports unauthorized

- Confirm gateway `AGENT_URL` points to the correct HTTPS hostname.
- Compare `AGENT_TOKEN` on PC and Coolify privately; do not paste either value into chat or logs.
- Ensure gateway sends `X-AIT-User` and permission headers for file endpoints.
- A request without Bearer token to `/list` should return 401 by design.

## Upload fails with 413

- Check per-account quota and current `used` value (trash counts toward quota).
- Check free disk space on the storage volume.
- Check reverse proxy and tunnel upload/body-size/time limits.
- Current Agent per-file limit is 50 GiB; intermediary proxy limits may be lower.

## Scheduled Task shows Ready but nothing is running

- Start the task manually and inspect Last Run Result in Task Scheduler.
- Confirm the task runs as the same user who owns the private SSH key.
- Confirm action path and quoting are correct.
- For tunnel task, verify `run-tunnel.ps1` exists locally and host/user values were filled in.
- Ensure no other Agent process already owns port 4001.

## Disk usage appears wrong

Usage is recalculated from disk when dirty or after five minutes. Trash remains part of `used`. Files outside AIT Drive still reduce physical free space but do not count against an individual account quota.

## Safe diagnostics to collect

Share process/task state, error text with secrets redacted, port/listener status, and whether local/public `/health` succeeds. Never share `agent.env`, SSH private key, bearer token, tunnel token, or full command lines containing secrets.
