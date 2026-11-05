'use strict';
// Setup interaktif agent: pilih folder storage, port, dan token, lalu tulis agent.env.
// Jalankan: agent\setup-agent.bat   (atau: node agent/setup.js [--no-gui])
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ENV_FILE = path.join(__dirname, 'agent.env');
const noGui = process.argv.includes('--no-gui');

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

// Windows "Pilih folder" dialog. Returns the chosen path, or null if cancelled/unavailable.
function pickFolderDialog(startAt) {
  if (noGui || process.platform !== 'win32') return null;
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Pilih folder tempat AIT Drive menyimpan file'",
    '$d.ShowNewFolderButton = $true',
    startAt ? `$d.SelectedPath = '${startAt.replace(/'/g, "''")}'` : '',
    '$top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; $top.WindowState = "Minimized"; $top.Show()',
    'if ($d.ShowDialog($top) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
  ].filter(Boolean).join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const p = (r.stdout || '').trim();
  return p || null;
}

function freeSpace(dir) {
  try {
    let probe = dir;
    while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
    const s = fs.statfsSync(probe);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}
const gb = (n) => (n / 1024 ** 3).toFixed(1) + ' GB';

// antrean baris: aman untuk input konsol maupun input terpipa
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
const waiting = [];
let closed = false;
rl.on('line', (l) => { if (waiting.length) waiting.shift()(l); else lines.push(l); });
rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
const ask = (q) => new Promise((resolve) => {
  process.stdout.write(q);
  const done = (l) => { if (!process.stdin.isTTY) process.stdout.write(l + '\n'); resolve(l.trim()); };
  if (lines.length) done(lines.shift());
  else if (closed) done('');
  else waiting.push(done);
});

(async () => {
  const cur = readEnv();
  console.log('\n=== Setup AIT Drive Agent ===\n');

  // 1) storage folder
  const defFolder = cur.STORAGE_ROOT || path.join(process.env.ProgramData || 'C:\ProgramData', 'AIT-Drive', 'storage');
  console.log('Folder storage menentukan di mana SEMUA file pengguna disimpan di PC ini.');
  console.log(`Sekarang: ${defFolder}\n`);
  let folder = null;
  const how = (await ask('Pilih folder lewat jendela? [Y/n/ketik sendiri]: ')).toLowerCase();
  if (how === '' || how === 'y' || how === 'ya') {
    folder = pickFolderDialog(defFolder);
    if (!folder) console.log('Jendela pilih folder tidak tersedia atau dibatalkan.');
  } else if (how !== 'n') {
    folder = how.replace(/^"|"$/g, '');
  }
  if (!folder) folder = (await ask(`Ketik path folder [${defFolder}]: `)).replace(/^"|"$/g, '') || defFolder;
  folder = path.resolve(folder);

  const isDrive = /^[A-Za-z]:\\?$/.test(folder);
  if (isDrive) {
    folder = path.join(folder, 'AIT-Drive-Storage');
    console.log(`Itu root drive, jadi dibuatkan subfolder: ${folder}`);
  }
  fs.mkdirSync(folder, { recursive: true });
  const probe = path.join(folder, '.write-test');
  try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe); } catch (e) {
    console.error(`\nFolder tidak bisa ditulis: ${e.message}\nPilih folder lain lalu jalankan setup lagi.`);
    process.exit(1);
  }
  const sp = freeSpace(folder);
  console.log(`\nFolder: ${folder}${sp ? `  (kosong ${gb(sp.free)} dari ${gb(sp.total)})` : ''}`);

  // 2) port + token
  const port = (await ask(`Port agent [${cur.AGENT_PORT || '4001'}]: `)) || cur.AGENT_PORT || '4001';
  if (!/^\d{2,5}$/.test(port)) { console.error('Port tidak valid.'); process.exit(1); }
  let token = cur.AGENT_TOKEN && cur.AGENT_TOKEN.length >= 24 && !/CHANGE_ME/.test(cur.AGENT_TOKEN) ? cur.AGENT_TOKEN : '';
  if (token) {
    const keep = (await ask('AGENT_TOKEN sudah ada. Pakai yang sama? [Y/n]: ')).toLowerCase();
    if (keep === 'n') token = '';
  }
  if (!token) token = crypto.randomBytes(32).toString('hex');

  // 3) write agent.env
  const body = [
    '# Dibuat oleh setup.js. Jangan dibagikan atau di-commit.',
    '# Folder yang menyimpan semua file pengguna (satu subfolder per akun)',
    `STORAGE_ROOT=${folder}`,
    '# Hanya didengarkan lokal; tunnel (cloudflared/tailscale) yang menjangkaunya',
    `AGENT_HOST=${cur.AGENT_HOST || '127.0.0.1'}`,
    `AGENT_PORT=${port}`,
    '# Rahasia bersama dengan web di Coolify (harus sama persis dengan AGENT_TOKEN di sana)',
    `AGENT_TOKEN=${token}`,
    '# Tunnel: none | cloudflare | chisel',
    `TUNNEL_PROVIDER=${cur.TUNNEL_PROVIDER || 'none'}`,
    `CLOUDFLARED_PATH=${cur.CLOUDFLARED_PATH || ''}`,
    `CLOUDFLARED_TUNNEL_TOKEN=${cur.CLOUDFLARED_TUNNEL_TOKEN || ''}`,
    `CHISEL_PATH=${cur.CHISEL_PATH || ''}`,
    `CHISEL_SERVER=${cur.CHISEL_SERVER || ''}`,
    `CHISEL_AUTH=${cur.CHISEL_AUTH || ''}`,
    `CHISEL_REMOTE_PORT=${cur.CHISEL_REMOTE_PORT || '14001'}`,
    '',
  ].join('\r\n');
  fs.writeFileSync(ENV_FILE, body);

  console.log('\nSelesai. agent.env tersimpan.\n');
  console.log('Isi di Coolify (Environment Variables):');
  console.log(`  AGENT_TOKEN=${token}`);
  console.log('  AGENT_URL=<alamat tunnel ke http://127.0.0.1:' + port + '>\n');
  console.log('Lalu jalankan agent\\start-agent.bat (restart bila sudah berjalan).');
  rl.close();
})();
