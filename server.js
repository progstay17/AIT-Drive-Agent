'use strict';
// AIT Drive - storage agent (runs on the local PC). Storage only: accounts, quotas and permissions
// live in the web gateway (Coolify); the gateway tells this agent, per request, who is calling and
// what they may do (X-AIT-User / X-AIT-Quota / X-AIT-Perms), authenticated by the shared AGENT_TOKEN.
//
// Layout on disk (STORAGE_ROOT):
//   users/<id>/        each account's private drive (the owner uses users/_owner)
//   users/<id>/.trash  soft-deleted items (counted against the quota)
//   .ait/archive/      data of deleted accounts (never destroyed automatically)
const express = require('express');
const Busboy = require('busboy');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');

const PORT = parseInt(process.env.AGENT_PORT || '4001', 10);
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_TOKEN || '';
const ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, '..', 'storage'));

const TRASH = '.trash';
const USERS_DIR = path.join(ROOT, 'users');
const META_DIR = path.join(ROOT, '.ait');
const ARCHIVE_DIR = path.join(META_DIR, 'archive');
const OWNER_ID = '_owner';
const ALL_PERMS = Object.freeze({ upload: true, modify: true, delete: true, share: true });
const PERM_LABEL = { upload: 'mengunggah', modify: 'mengubah (buat folder, ganti nama, pindah)', delete: 'menghapus', share: 'membagikan link' };
const USER_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;

if (TOKEN.length < 24) {
  console.error('AGENT_TOKEN must be set and at least 24 characters long.');
  process.exit(1);
}

// ---------- helpers ----------
function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function validName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n === '.' || n === '..') return false;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return false;
  return n.length <= 200;
}
const userRoot = (id) => path.join(USERS_DIR, id);

// ---------- v1 -> v2 migration (single shared drive -> owner's folder) ----------
function migrateV1() {
  if (fs.existsSync(META_DIR)) return;
  const skip = new Set([TRASH, 'users', '.ait']);
  const entries = fs.readdirSync(ROOT).filter((n) => !skip.has(n));
  const hasTrash = fs.existsSync(path.join(ROOT, TRASH));
  if (!entries.length && !hasTrash) return;
  const dest = userRoot(OWNER_ID);
  fs.mkdirSync(dest, { recursive: true });
  for (const n of entries) fs.renameSync(path.join(ROOT, n), path.join(dest, n));
  if (hasTrash) fs.renameSync(path.join(ROOT, TRASH), path.join(dest, TRASH));
  console.log(`Migrated ${entries.length} item(s) from the v1 layout into users/${OWNER_ID}`);
}
fs.mkdirSync(ROOT, { recursive: true });
migrateV1();
fs.mkdirSync(USERS_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });

// ---------- disk + usage accounting ----------
async function disk() {
  const s = await fsp.statfs(ROOT);
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}
async function dirSize(dir) {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await dirSize(p);
    else if (e.isFile()) { try { n += (await fsp.stat(p)).size; } catch {} }
  }
  return n;
}
async function walkUsage(root) {
  let used = 0, trash = 0;
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { const s = await dirSize(p); used += s; if (e.name === TRASH) trash = s; }
    else if (e.isFile()) { try { used += (await fsp.stat(p)).size; } catch {} }
  }
  return { used, trash };
}
// used = everything under the account's folder, INCLUDING .trash (so deleting does not free quota
// until the trash is emptied). Counters are kept incrementally during uploads and re-synced from disk.
const usage = new Map();
async function getUsage(ctx) {
  let u = usage.get(ctx.id);
  if (!u) { u = { used: 0, trash: 0, at: 0, dirty: true, uploading: 0 }; usage.set(ctx.id, u); }
  if (u.uploading === 0 && (u.dirty || Date.now() - u.at > 5 * 60 * 1000)) {
    const r = await walkUsage(ctx.root);
    u.used = r.used; u.trash = r.trash; u.at = Date.now(); u.dirty = false;
  }
  return u;
}
const touchUsage = (id) => { const u = usage.get(id); if (u) u.dirty = true; };

// ---------- path helpers (all confined to the caller's own root) ----------
function resolveSafe(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(400, 'invalid path');
  const first = path.relative(root, abs).split(path.sep)[0];
  if (first === TRASH) throw httpError(400, 'invalid path');
  return abs;
}
async function ensureInside(root, abs) {
  let real;
  try { real = await fsp.realpath(abs); } catch { return; }
  const realRoot = await fsp.realpath(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw httpError(400, 'invalid path');
}
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// ---------- app + auth ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return res.json({ ok: true });
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t || !safeEqual(t, TOKEN)) { res.setHeader('X-AIT-Reason', 'token'); return res.status(401).json({ error: 'unauthorized' }); }
  next();
});

// ---------- system endpoints (gateway only: bearer token, no user identity) ----------
const validId = (id) => id === OWNER_ID || USER_RE.test(String(id));
app.get('/sys/disk', wrap(async (req, res) => res.json(await disk())));
app.get('/sys/tunnel', (req, res) => res.json(require('./tunnel/manager').getStatus()));

app.post('/sys/usage', wrap(async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.slice(0, 1000) : [];
  const out = {};
  for (const id of ids) {
    if (!validId(id)) continue;
    const u = await getUsage({ id, root: userRoot(id) });
    out[id] = { used: u.used, trash: u.trash };
  }
  res.json(out);
}));

app.post('/sys/users/:id/init', wrap(async (req, res) => {
  const id = req.params.id;
  if (!validId(id)) throw httpError(400, 'invalid id');
  await fsp.mkdir(userRoot(id), { recursive: true });
  ensuredRoots.add(id);
  res.json({ ok: true });
}));

// account deleted in the gateway: its folder is moved to .ait/archive (never destroyed)
app.post('/sys/users/:id/archive', wrap(async (req, res) => {
  const id = req.params.id;
  if (!validId(id) || id === OWNER_ID) throw httpError(400, 'invalid id');
  let archived = null;
  if (fs.existsSync(userRoot(id))) {
    await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
    archived = `${id}__${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.rename(userRoot(id), path.join(ARCHIVE_DIR, archived));
  }
  usage.delete(id); ensuredRoots.delete(id);
  res.json({ ok: true, archived });
}));

// ---------- who is calling? The gateway authenticated the person and sends their current rights ----------
const ensuredRoots = new Set();
app.use((req, res, next) => {
  const id = String(req.headers['x-ait-user'] || '');
  if (!validId(id)) { res.setHeader('X-AIT-Reason', 'identity'); return res.status(401).json({ error: 'unauthorized' }); }
  const q = String(req.headers['x-ait-quota'] || '');
  const quota = q === '' ? null : Number(q);
  if (quota !== null && !(Number.isFinite(quota) && quota >= 0)) return res.status(400).json({ error: 'invalid quota header' });
  const have = new Set(String(req.headers['x-ait-perms'] || '').split(',').map((x) => x.trim()).filter(Boolean));
  const perms = {};
  for (const k of Object.keys(ALL_PERMS)) perms[k] = have.has(k);
  const ctx = { id, quota, perms, root: userRoot(id) };
  if (!ensuredRoots.has(id)) { fs.mkdirSync(ctx.root, { recursive: true }); ensuredRoots.add(id); }
  req.ctx = ctx;
  next();
});
function need(ctx, perm) {
  if (!ctx.perms[perm]) throw httpError(403, `Akun kamu tidak punya izin untuk ${PERM_LABEL[perm]}.`);
}

// ---------- files ----------
app.get('/list', wrap(async (req, res) => {
  const root = req.ctx.root;
  const abs = resolveSafe(root, req.query.path);
  await ensureInside(root, abs);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw httpError(404, 'folder not found');
  const items = [];
  for (const name of await fsp.readdir(abs)) {
    if (abs === root && name === TRASH) continue;
    try {
      const s = await fsp.stat(path.join(abs, name));
      items.push({ name, type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs });
    } catch { /* skip unreadable */ }
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  res.json({ path: toRel(root, abs), items });
}));

app.get('/stats', wrap(async (req, res) => {
  const c = req.ctx;
  const u = await getUsage(c);
  const d = await disk();
  let total, free;
  if (c.quota != null) { total = c.quota; free = Math.max(0, Math.min(c.quota - u.used, d.free)); }
  else { free = d.free; total = u.used + d.free; }
  res.json({ total, free, used: u.used, trash: u.trash, quota: c.quota, diskFree: d.free });
}));

app.get('/search', wrap(async (req, res) => {
  const root = req.ctx.root;
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ items: [] });
  const out = [];
  async function walk(dir) {
    if (out.length >= 200) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (dir === root && e.name === TRASH) continue;
      const p = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(q)) {
        try {
          const s = await fsp.stat(p);
          out.push({ name: e.name, path: toRel(root, p), type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? 0 : s.size, mtime: s.mtimeMs });
        } catch {}
      }
      if (e.isDirectory()) await walk(p);
      if (out.length >= 200) return;
    }
  }
  await walk(root);
  res.json({ items: out });
}));

app.get('/download', wrap(async (req, res) => {
  const root = req.ctx.root;
  const abs = resolveSafe(root, req.query.path);
  await ensureInside(root, abs);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw httpError(404, 'file not found');
  const inline = req.query.inline === '1';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(abs, { dotfiles: 'allow', acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).json({ error: 'send failed' });
  });
}));

app.post('/upload', (req, res, next) => {
  (async () => {
    const ctx = req.ctx;
    need(ctx, 'upload');
    const dir = resolveSafe(ctx.root, req.query.path);
    await ensureInside(ctx.root, dir);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) throw httpError(404, 'folder not found');

    const u = await getUsage(ctx);
    const cl = parseInt(req.headers['content-length'] || '0', 10) || 0;
    if (ctx.quota != null && u.used + cl > ctx.quota) {
      throw httpError(413, `Kuota tidak cukup. Sisa ${fmtBytes(Math.max(0, ctx.quota - u.used))} dari ${fmtBytes(ctx.quota)}.`);
    }
    if (cl > (await disk()).free) throw httpError(413, 'Ruang disk PC tidak cukup.');

    u.uploading++;
    let ended = false;
    const end = () => { if (!ended) { ended = true; u.uploading--; } };
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });
    const saved = [];
    const pending = [];
    let failed = null;
    let responded = false;

    const finish = async () => {
      if (responded) return;
      responded = true;
      await Promise.all(pending);
      end();
      if (failed) return next(failed);
      res.json({ saved });
    };

    bb.on('file', (field, stream, info) => {
      const name = path.basename(String(info.filename || '').replace(/\\/g, '/'));
      if (!validName(name)) { stream.resume(); failed = failed || httpError(400, 'invalid file name'); return; }
      let target = path.join(dir, name);
      const ext = path.extname(name), base = path.basename(name, ext);
      let i = 1;
      while (fs.existsSync(target) || fs.existsSync(target + '.part')) target = path.join(dir, `${base} (${i++})${ext}`);
      const tmp = target + '.part';
      const ws = fs.createWriteStream(tmp);
      let written = 0, over = false, limited = false;
      stream.on('limit', () => { limited = true; });
      const counter = new Transform({
        transform(chunk, enc, cb) {
          if (over) return cb(); // keep draining, drop data
          if (ctx.quota != null && u.used + chunk.length > ctx.quota) { over = true; return cb(); }
          written += chunk.length; u.used += chunk.length;
          cb(null, chunk);
        },
      });
      pending.push(new Promise((resolve) => {
        pipeline(stream, counter, ws, async (err) => {
          const bad = err || over || limited;
          if (bad) {
            failed = failed || (over ? httpError(413, `Kuota terlampaui (${fmtBytes(ctx.quota)}).`) : limited ? httpError(413, 'file too large') : err);
            u.used -= written;
            await fsp.rm(tmp, { force: true }).catch(() => {});
            return resolve();
          }
          try { await fsp.rename(tmp, target); saved.push(path.basename(target)); }
          catch (e) { failed = failed || e; u.used -= written; await fsp.rm(tmp, { force: true }).catch(() => {}); }
          resolve();
        });
      }));
    });
    bb.on('error', (e) => { failed = failed || e; finish().catch(() => {}); });
    bb.on('close', () => { finish().catch(() => {}); });
    req.on('aborted', () => { failed = failed || httpError(499, 'aborted'); finish().catch(() => {}); });
    req.pipe(bb);
  })().catch(next);
});

app.post('/mkdir', wrap(async (req, res) => {
  const ctx = req.ctx;
  need(ctx, 'modify');
  const { path: parent = '', name } = req.body || {};
  if (!validName(name)) throw httpError(400, 'invalid name');
  const dir = resolveSafe(ctx.root, parent);
  await ensureInside(ctx.root, dir);
  const target = path.join(dir, name.trim());
  if (fs.existsSync(target)) throw httpError(409, 'already exists');
  await fsp.mkdir(target);
  res.json({ ok: true });
}));

app.post('/rename', wrap(async (req, res) => {
  const ctx = req.ctx;
  need(ctx, 'modify');
  const { path: p, newName } = req.body || {};
  if (!validName(newName)) throw httpError(400, 'invalid name');
  const abs = resolveSafe(ctx.root, p);
  if (abs === ctx.root) throw httpError(400, 'invalid path');
  await ensureInside(ctx.root, abs);
  const target = path.join(path.dirname(abs), newName.trim());
  if (fs.existsSync(target)) throw httpError(409, 'already exists');
  await fsp.rename(abs, target);
  res.json({ ok: true });
}));

app.post('/move', wrap(async (req, res) => {
  const ctx = req.ctx;
  need(ctx, 'modify');
  const { path: p, dest } = req.body || {};
  const abs = resolveSafe(ctx.root, p);
  const dir = resolveSafe(ctx.root, dest);
  if (abs === ctx.root) throw httpError(400, 'invalid path');
  await ensureInside(ctx.root, abs); await ensureInside(ctx.root, dir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw httpError(404, 'destination not found');
  if (dir === abs || dir.startsWith(abs + path.sep)) throw httpError(400, 'cannot move into itself');
  const target = path.join(dir, path.basename(abs));
  if (fs.existsSync(target)) throw httpError(409, 'already exists in destination');
  await fsp.rename(abs, target);
  res.json({ ok: true });
}));

app.post('/delete', wrap(async (req, res) => {
  const ctx = req.ctx;
  need(ctx, 'delete');
  const abs = resolveSafe(ctx.root, (req.body || {}).path);
  if (abs === ctx.root) throw httpError(400, 'invalid path');
  await ensureInside(ctx.root, abs);
  if (!fs.existsSync(abs)) throw httpError(404, 'not found');
  const trashDir = path.join(ctx.root, TRASH);
  await fsp.mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.rename(abs, path.join(trashDir, `${stamp}__${path.basename(abs)}`));
  touchUsage(ctx.id); // total stays the same, only the trash figure changes
  res.json({ ok: true });
}));

app.post('/trash/empty', wrap(async (req, res) => {
  const ctx = req.ctx;
  need(ctx, 'delete');
  const u = await getUsage(ctx);
  await fsp.rm(path.join(ctx.root, TRASH), { recursive: true, force: true });
  u.used = Math.max(0, u.used - u.trash); u.trash = 0; u.dirty = true;
  res.json({ ok: true });
}));

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
});

const tunnel = require('./tunnel/manager');

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Agent listening on http://${HOST}:${PORT}  root=${ROOT}`);
  tunnel.start().catch((err) => console.error(`Tunnel startup failed: ${err.message}`));
});

async function shutdown(signal) {
  console.log(`Received ${signal}; stopping agent and tunnel...`);
  await tunnel.stop().catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 7000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
