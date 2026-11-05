@echo off
rem Setup AIT Drive Agent: pilih folder storage, port, token -> menulis agent.env
cd /d %~dp0
node setup.js
pause
