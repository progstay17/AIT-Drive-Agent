# AIT Drive Agent

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![License](https://img.shields.io/badge/license-proprietary-lightgrey)](#license)

**AIT Drive Agent** adalah layanan penyimpanan yang berjalan di PC pemilik file. Agent menyediakan API HTTP lokal untuk membaca, mengunggah, mengunduh, memindahkan, dan menghapus file. Aplikasi web AIT Drive berjalan terpisah—misalnya di Coolify—dan bertanggung jawab atas login, akun, kuota, izin, serta antarmuka pengguna.

> Agent bukan aplikasi web untuk pengguna akhir. Jangan membuka port Agent langsung ke internet.

## Arsitektur singkat

```text
Browser
   │ HTTPS
   ▼
AIT Drive Web Gateway (Coolify)
   │ HTTPS + Authorization: Bearer <AGENT_TOKEN>
   │ + identitas, kuota, dan izin per request
   ▼
Public Agent hostname / Caddy reverse proxy
   │ VPS loopback :8081
   │ SSH reverse tunnel
   ▼
Windows PC — 127.0.0.1:4001
   │
   ▼
STORAGE_ROOT/
```

- **Agent (repo ini):** API file dan penyimpanan di PC.
- **Web Gateway:** autentikasi pengguna, sesi, akun, kuota, izin, share link, dan UI. Dideploy terpisah dari repo AIT Drive.
- **Tunnel/proxy:** menyediakan jalur HTTPS dari gateway ke Agent tanpa membuka port masuk pada router atau Windows PC.
- Token Agent hanya berada di environment gateway dan `agent.env` pada PC. Token tidak boleh dikirim ke browser.

Detail: [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [Security](docs/SECURITY.md).

## Fitur Agent

- Penyimpanan multi-akun: direktori terpisah di `STORAGE_ROOT/users/<id>`.
- Operasi file: list, search, upload streaming, upload folder bertingkat, download file/folder ZIP, buat folder, rename, move, soft-delete, lihat Trash, restore, dan empty trash.
- Kuota per akun ditegakkan di Agent menggunakan nilai yang dikirim gateway.
- Izin upload, modify, delete, dan share diteruskan gateway pada setiap request.
- File/folder yang dihapus dipindahkan ke `.trash`; Trash dapat ditampilkan dan item dapat dipulihkan ke lokasi asal. Ukuran trash tetap dihitung dalam kuota sampai dikosongkan.
- Data akun yang diarsipkan dipindahkan ke `.ait/archive` dan tidak dihapus otomatis.
- Pemeriksaan path untuk mencegah path traversal dan akses keluar dari folder akun.
- Health endpoint `/health` untuk monitoring koneksi.

## Persyaratan

- Node.js 20 atau lebih baru.
- Windows 10/11 atau Windows Server (panduan utama di bawah memakai PowerShell); Linux dapat menjalankan Agent dengan environment variable yang sama.
- Akses tulis ke folder penyimpanan.
- Tunnel HTTPS yang dikonfigurasi secara terpisah. Deployment AIT saat ini menggunakan SSH reverse tunnel dari Caddy Panel.

## Instalasi Windows

1. Clone repo ini ke folder aplikasi, misalnya `C:\AIT-Drive-Agent`. Jangan letakkan kode aplikasi di dalam `STORAGE_ROOT`.
2. Buka PowerShell pada folder tersebut, lalu jalankan:

   ```powershell
   npm ci
   .\setup-agent.bat
   ```

3. Pada setup, pilih folder data yang memang akan menjadi penyimpanan AIT Drive. Jika memindahkan instalasi lama, gunakan kembali folder `STORAGE_ROOT` lama. **Jangan pilih folder kosong baru jika file lama masih berada di lokasi sebelumnya.**
4. Setup membuat `agent.env` dan token acak jika belum ada. Pertahankan token yang sudah dipakai gateway; menggantinya hanya di satu sisi akan memutus koneksi.
5. Jalankan Agent:

   ```powershell
   .\start-agent.bat
   ```

6. Di PowerShell lain, periksa:

   ```powershell
   Test-NetConnection 127.0.0.1 -Port 4001
   Invoke-RestMethod http://127.0.0.1:4001/health
   ```

   Hasil health yang benar adalah `{ ok: true }`.

Untuk instalasi otomatis tanpa jendela pemilihan folder, jalankan `node setup.js --no-gui` dan ikuti prompt. Lihat [Windows Operations](docs/WINDOWS.md).

## Konfigurasi

File `agent.env` dibuat secara lokal oleh setup dan **tidak boleh di-commit**. Template publik tersedia di [`agent.env.example`](agent.env.example).

| Variabel | Default | Keterangan |
|---|---|---|
| `STORAGE_ROOT` | `../storage` | Root semua file pengguna. Jaga agar tetap pada disk penyimpanan yang benar. |
| `AGENT_HOST` | `127.0.0.1` | Alamat bind HTTP. Pertahankan loopback jika menggunakan tunnel pada host yang sama. |
| `AGENT_PORT` | `4001` | Port HTTP lokal Agent. |
| `AGENT_TOKEN` | wajib | Shared secret gateway ↔ Agent; minimal 24 karakter. Gunakan random secret panjang. |
| `TUNNEL_PROVIDER` | `none` | `none`, `cloudflare`, atau `chisel` untuk tunnel yang dikelola Agent. |
| `CLOUDFLARED_PATH` | `cloudflared` | Path executable Cloudflare Tunnel jika provider `cloudflare`. |
| `CLOUDFLARED_TUNNEL_TOKEN` | — | Token tunnel Cloudflare. Rahasia. |
| `CHISEL_PATH` | `chisel` | Path executable Chisel jika provider `chisel`. |
| `CHISEL_SERVER` | — | URL `http(s)` server Chisel. |
| `CHISEL_AUTH` | — | Kredensial Chisel khusus `username:password`. Rahasia. |
| `CHISEL_REMOTE_PORT` | `14001` | Port reverse listener pada server Chisel. |

Generate token baru secara lokal:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lalu pasang nilai yang sama sebagai `AGENT_TOKEN` di `agent.env` dan environment variable gateway di Coolify. Jangan menempelkan token ke issue, chat publik, screenshot, atau source code.

## Koneksi tunnel AIT saat ini: Caddy Panel + SSH reverse tunnel

Pada deployment yang sudah disiapkan, Agent berjalan di PC pada `127.0.0.1:4001`, SSH reverse tunnel membuka listener **VPS loopback** `127.0.0.1:8081`, dan Caddy Panel mem-proxy hostname HTTPS publik ke listener tersebut.

1. Pastikan `/health` pada PC lokal mengembalikan `ok: true`.
2. Di Caddy Panel, buat SSH tunnel dengan remote/listen address `127.0.0.1:8081` dan tujuan lokal PC `127.0.0.1:4001`.
3. Simpan private key SSH hanya di PC. Public key pada VPS dibatasi ke listener `127.0.0.1:8081`.
4. Jalankan loop reconnect dari template [`run-tunnel.ps1.example`](run-tunnel.ps1.example). Salin menjadi `run-tunnel.ps1` secara lokal, lalu isi host dan user VPS. File aktual itu di-ignore Git.
5. Pada Caddy Panel, arahkan site HTTPS Agent ke upstream `127.0.0.1:8081`.
6. Dari PC, uji `Invoke-RestMethod https://<hostname-agent>/health`. Hasil harus `{ ok: true }`.
7. Uji endpoint terlindungi tanpa token, misalnya `/list`. Hasil yang diharapkan HTTP `401`.
8. Atur `AGENT_URL` pada gateway Coolify ke hostname HTTPS Agent dan samakan `AGENT_TOKEN` pada kedua sisi.

`TUNNEL_PROVIDER=none` untuk arsitektur ini karena SSH tunnel dikelola Caddy Panel/PowerShell, bukan tunnel manager di dalam proses Node Agent. Panduan rinci: [Tunnel Deployment](docs/TUNNEL.md).

## Tunnel alternatif

Agent juga memiliki tunnel manager opsional:

- **Cloudflare Tunnel:** set `TUNNEL_PROVIDER=cloudflare` dan `CLOUDFLARED_TUNNEL_TOKEN`. Public hostname harus berasal dari DNS zone yang dikelola akun Cloudflare kamu.
- **Chisel:** set `TUNNEL_PROVIDER=chisel`, `CHISEL_SERVER`, dan `CHISEL_AUTH`. Gunakan hanya server Chisel yang kamu kendalikan dan HTTPS.

Jangan menjalankan dua tunnel yang mencoba mengambil alih port/hostname yang sama. Jangan gunakan Chisel jika executable atau arsip yang diunduh ditandai antivirus; jangan mematikan antivirus atau membuat pengecualian untuk memaksa instalasi.

## API dan integrasi gateway

Semua endpoint selain `/health` membutuhkan header:

```http
Authorization: Bearer <AGENT_TOKEN>
```

Endpoint file juga membutuhkan header identitas gateway:

```http
X-AIT-User: user-id
X-AIT-Quota: <bytes-or-empty>
X-AIT-Perms: upload,modify,delete,share
```

Gateway harus memvalidasi pengguna dan hak akses sebelum meneruskan request. Agent tidak menyediakan login pengguna dan tidak boleh diakses langsung oleh browser. Daftar route, payload, respons, dan contoh `curl` ada di [API Reference](docs/API.md).

## Operasional dan backup

- Pastikan PC penyimpanan selalu menyala dan tidak masuk sleep ketika layanan dibutuhkan.
- Jalankan Agent dan tunnel saat user login menggunakan Windows Task Scheduler atau service manager yang dikelola administrator.
- Pantau `/health`, koneksi HTTPS publik, status task, ruang disk, dan log proses.
- Backup **seluruh `STORAGE_ROOT`** secara terjadwal ke media terpisah. Backup volume `/data` gateway juga diperlukan untuk akun, kuota, izin, dan konfigurasi web.
- Uji pemulihan backup sebelum mengandalkannya. Soft-delete bukan backup.
- Jangan menghapus, memindahkan, atau mengubah struktur `STORAGE_ROOT` saat Agent aktif.

Panduan: [Windows Operations](docs/WINDOWS.md), [Troubleshooting](docs/TROUBLESHOOTING.md).

## Struktur repository

```text
AIT-Drive-Agent/
├── server.js                  # HTTP storage API
├── setup.js                   # setup interaktif + agent.env generator
├── setup-agent.bat            # setup launcher Windows
├── start-agent.bat            # launcher Windows
├── run-agent.ps1              # PowerShell launcher untuk Task Scheduler
├── run-tunnel.ps1.example     # template tunnel SSH; tanpa data host pribadi
├── tunnel/
│   └── manager.js             # Cloudflare/Chisel optional tunnel manager
├── docs/                      # API, architecture, security, deployment, operations
├── agent.env.example          # template tanpa secret
├── package.json
└── package-lock.json
```

## Pengembangan dan pemeriksaan

```bash
npm ci
npm run check
```

`npm run check` memeriksa sintaks `server.js`. Pengujian integrasi Agent dilakukan bersama test harness AIT Drive; lihat instruksi pada repo AIT Drive.

## Dokumen

- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Security](docs/SECURITY.md)
- [Tunnel Deployment](docs/TUNNEL.md)
- [Windows Operations](docs/WINDOWS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## License

Source code repository ini dipublikasikan untuk kebutuhan proyek AIT Drive. Hak penggunaan, distribusi, dan modifikasi mengikuti ketentuan yang ditetapkan pemilik repository. Belum ada lisensi open-source yang diberikan.
