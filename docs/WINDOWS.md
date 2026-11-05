# Windows Operations

## Install and start

```powershell
cd C:\AIT-Drive-Agent
npm ci
.\setup-agent.bat
.\start-agent.bat
```

The setup wizard writes `agent.env`. Review `STORAGE_ROOT`, `AGENT_HOST=127.0.0.1`, `AGENT_PORT=4001`, and `AGENT_TOKEN`. Keep the storage folder outside the application folder.

## Start through PowerShell

`run-agent.ps1` loads local `agent.env` into the current process and starts Node directly. It does not create or print the secret values.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\AIT-Drive-Agent\run-agent.ps1
```

## Scheduled Task recommendations

Create two tasks under the Windows account that owns the SSH key:

1. `AIT-Drive-Agent-AutoStart`: trigger At log on; action PowerShell with `-NoProfile -ExecutionPolicy Bypass -File "C:\AIT-Drive-Agent\run-agent.ps1"`.
2. `AIT-Drive-Tunnel-AutoReconnect`: trigger At log on with a 30-second delay; action PowerShell with `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\AIT-Drive-Agent\run-tunnel.ps1"`.

Set restart-on-failure in task settings. Do not run multiple copies of Agent on port 4001. Run the SSH task as the same user whose `%USERPROFILE%\.ssh` contains the private key. A logon-triggered task requires that user to log in; an unattended service/startup design needs separate service credentials and permissions.

## Verify

```powershell
Get-NetTCPConnection -LocalPort 4001 -State Listen
Invoke-RestMethod http://127.0.0.1:4001/health
Get-ScheduledTask | Where-Object { $_.TaskName -like 'AIT-Drive-*' } | Select-Object TaskName,State
```

A healthy local Agent should listen only on `127.0.0.1:4001` and return `{ ok: true }`.

## Storage and migration safety

- Preserve the current `STORAGE_ROOT` when upgrading.
- Back up storage before first startup of a legacy installation because Agent may migrate the old flat directory into `users/_owner`.
- Never delete `STORAGE_ROOT` when removing/reinstalling application code.
- Do not keep the application checkout inside `STORAGE_ROOT`.
