'use strict';

const { spawn } = require('child_process');

const state = {
  provider: 'none',
  status: 'disabled',
  startedAt: null,
  lastExit: null,
  error: null,
};

let child = null;
let stopping = false;
let restartTimer = null;
let restartCount = 0;
let generation = 0;

function buildCommand(provider) {
  if (provider === 'cloudflare') {
    const token = process.env.CLOUDFLARED_TUNNEL_TOKEN || '';
    if (!token) throw new Error('CLOUDFLARED_TUNNEL_TOKEN is required.');
    return {
      exe: process.env.CLOUDFLARED_PATH || 'cloudflared',
      args: ['tunnel', '--no-autoupdate', 'run', '--token', token],
    };
  }

  if (provider === 'chisel') {
    const server = process.env.CHISEL_SERVER || '';
    const auth = process.env.CHISEL_AUTH || '';
    const remotePort = String(process.env.CHISEL_REMOTE_PORT || '14001');
    const agentPort = String(process.env.AGENT_PORT || '4001');

    if (!/^https?:\/\//i.test(server)) throw new Error('CHISEL_SERVER must be an http(s) URL.');
    if (!auth.includes(':')) throw new Error('CHISEL_AUTH must be a dedicated username:password pair.');
    if (!/^\d{2,5}$/.test(remotePort) || Number(remotePort) > 65535 || Number(remotePort) < 1) {
      throw new Error('CHISEL_REMOTE_PORT is invalid.');
    }
    if (!/^\d{2,5}$/.test(agentPort) || Number(agentPort) > 65535 || Number(agentPort) < 1) {
      throw new Error('AGENT_PORT is invalid.');
    }

    return {
      exe: process.env.CHISEL_PATH || 'chisel',
      args: [
        'client', '--keepalive', '25s', '--auth', auth, server,
        `R:127.0.0.1:${remotePort}:127.0.0.1:${agentPort}`,
      ],
    };
  }

  throw new Error(`Unsupported tunnel provider: ${provider}`);
}

function scheduleRestart() {
  if (stopping || restartTimer) return;
  const delay = Math.min(60000, 2000 * (2 ** Math.min(restartCount, 5)));
  restartCount += 1;
  state.status = 'reconnecting';
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start().catch((err) => {
      state.status = 'error';
      state.error = err.message;
      scheduleRestart();
    });
  }, delay);
}

function markConnected(id) {
  if (id !== generation || !child || stopping) return;
  state.status = 'connected';
  state.startedAt = new Date().toISOString();
  state.error = null;
  restartCount = 0;
}

async function start() {
  const provider = process.env.TUNNEL_PROVIDER || 'none';
  state.provider = provider;

  if (provider === 'none') {
    state.status = 'disabled';
    return;
  }
  if (child) return;

  stopping = false;
  let command;
  try {
    command = buildCommand(provider);
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    scheduleRestart();
    throw err;
  }

  const id = ++generation;
  state.status = 'starting';
  state.error = null;

  const proc = spawn(command.exe, command.args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child = proc;

  const handleOutput = (stream, chunk) => {
    const line = String(chunk).trim();
    if (!line) return;
    // Never print raw tunnel output: it may contain endpoints or credential-bearing URLs.
    console.log(`[tunnel:${provider}:${stream}] output received`);
    if (
      (provider === 'chisel' && /connected\s*\(/i.test(line)) ||
      (provider === 'cloudflare' && /registered tunnel connection/i.test(line))
    ) markConnected(id);
  };

  proc.stdout.on('data', (chunk) => handleOutput('stdout', chunk));
  proc.stderr.on('data', (chunk) => handleOutput('stderr', chunk));

  proc.once('spawn', () => {
    if (id === generation && child === proc) state.status = 'connecting';
  });

  proc.once('error', (err) => {
    if (id !== generation) return;
    state.status = 'error';
    state.error = err.message;
    if (child === proc) child = null;
    scheduleRestart();
  });

  proc.once('exit', (code, signal) => {
    if (id !== generation) return;
    state.lastExit = { code, signal, at: new Date().toISOString() };
    if (child === proc) child = null;
    if (!stopping) {
      state.status = 'disconnected';
      scheduleRestart();
    }
  });
}

async function stop() {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const proc = child;
  if (!proc) {
    state.status = 'stopped';
    return;
  }

  state.status = 'stopping';
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve();
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    try { proc.kill(); } catch {
      clearTimeout(timeout);
      resolve();
    }
  });

  if (child === proc) child = null;
  state.status = 'stopped';
}

function getStatus() {
  return { ...state, running: Boolean(child) };
}

module.exports = { start, stop, getStatus };
