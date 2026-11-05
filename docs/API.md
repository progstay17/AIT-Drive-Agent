# API Reference

Base URL pada host Agent: `http://127.0.0.1:4001`. Gateway mengaksesnya melalui hostname HTTPS yang disediakan tunnel dan reverse proxy.

## Authentication dan konteks akun

`GET /health` adalah satu-satunya endpoint tanpa autentikasi. Semua endpoint lain membutuhkan:

```http
Authorization: Bearer <AGENT_TOKEN>
```

Endpoint file dan statistik akun juga membutuhkan header yang hanya boleh dibuat oleh gateway setelah autentikasi pengguna:

| Header | Arti |
|---|---|
| `X-AIT-User` | ID akun gateway. Owner memakai `_owner`; ID lain harus 3–32 karakter dan cocok dengan `[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]`. |
| `X-AIT-Quota` | Kuota akun dalam bytes. Kosong/tidak dikirim berarti tanpa kuota. Nilai harus angka finite dan >= 0. |
| `X-AIT-Perms` | Daftar dipisahkan koma: `upload`, `modify`, `delete`, `share`. |

Agent **tidak** memverifikasi identitas pengguna akhir, password, sesi, atau hak akses dari browser. Gateway wajib memverifikasi semuanya, lalu mengirim header di atas. Jangan pernah meneruskan header ini langsung dari browser.

## Response umum

- JSON UTF-8 untuk respons metadata.
- Error: `{ "error": "..." }`.
- `400` input/path tidak valid; `401` token atau identitas tidak sah; `403` izin tidak cukup; `404` item/folder tidak ditemukan; `409` nama bentrok; `413` kuota/ukuran file terlampaui; `500` kesalahan internal.
- `X-AIT-Reason: token` atau `X-AIT-Reason: identity` membantu gateway membedakan penyebab `401`.

## Health

### `GET /health`

Tanpa token. Contoh respons:

```json
{ "ok": true }
```

Endpoint ini hanya untuk mengetahui proses HTTP hidup; bukan bukti bahwa storage bisa dibaca/ditulis atau bahwa tunnel dari luar berfungsi.

## System endpoints (gateway only)

Semua memerlukan Bearer token, tetapi tidak memakai `X-AIT-User`.

### `GET /sys/disk`

Mengembalikan kapasitas filesystem tempat `STORAGE_ROOT` berada:

```json
{ "total": 1000000000, "free": 500000000 }
```

### `GET /sys/tunnel`

Status tunnel manager internal Agent. Untuk deployment Caddy Panel SSH reverse tunnel dengan `TUNNEL_PROVIDER=none`, hasil menunjukkan provider `none`/status `disabled`; status SSH tunnel dipantau terpisah melalui Task Scheduler/SSH/Caddy Panel.

### `POST /sys/usage`

Body:

```json
{ "ids": ["alice", "bob", "_owner"] }
```

Maksimal 1000 ID. Respons berupa object keyed by ID:

```json
{
  "alice": { "used": 1234, "trash": 100 }
}
```

ID tidak valid dilewati. `used` mencakup trash.

### `POST /sys/users/:id/init`

Membuat folder akun jika belum ada. ID harus valid.

### `POST /sys/users/:id/archive`

Memindahkan folder akun ke `.ait/archive` dengan suffix timestamp. `_owner` tidak boleh diarsipkan. Data tidak dihancurkan oleh endpoint ini.

## File endpoints (gateway identity required)

### `GET /list?path=<relative-path>`

Mendaftar isi folder akun. `path` kosong berarti root akun. Respons:

```json
{
  "path": "Documents",
  "items": [
    { "name": "report.pdf", "type": "file", "size": 2048, "mtime": 1730000000000 },
    { "name": "Photos", "type": "dir", "size": 0, "mtime": 1730000000000 }
  ]
}
```

Folder `.trash` pada root tidak ditampilkan.

### `GET /stats`

Mengembalikan penggunaan akun dan kapasitas yang terlihat oleh akun:

```json
{
  "total": 1000000,
  "free": 750000,
  "used": 250000,
  "trash": 10000,
  "quota": 1000000,
  "diskFree": 500000000
}
```

`quota` adalah `null` jika header kuota tidak diberikan. `used` termasuk trash; `free` dibatasi kuota dan ruang disk fisik.

### `GET /search?q=<term>`

Pencarian nama file/folder secara rekursif di root akun. Maksimal 200 hasil:

```json
{ "items": [{ "name": "report.pdf", "path": "Documents/report.pdf", "type": "file", "size": 2048, "mtime": 1730000000000 }] }
```

### `GET /download?path=<relative-path>[&inline=1]`

Mengirim file sebagai stream. Default `Content-Disposition: attachment`; `inline=1` meminta browser menampilkan inline. `X-Content-Type-Options: nosniff` dipasang. Gateway sebaiknya melakukan streaming response, bukan memuat seluruh file ke memori.

### `POST /upload?path=<relative-folder>`

`multipart/form-data`, satu atau lebih field file. Izin `upload` wajib. Maksimum ukuran per file saat ini 50 GiB. Nama file dibersihkan menjadi basename; bila nama sudah ada, Agent membuat nama `(1)`, `(2)`, dan seterusnya.

Respons:

```json
{ "saved": ["photo.jpg", "photo (1).jpg"] }
```

Kuota diperiksa sebelum dan selama streaming. File sementara berakhiran `.part` dihapus jika upload gagal.

### `POST /mkdir`

Izin `modify` wajib.

```json
{ "path": "Documents", "name": "Invoices" }
```

### `POST /rename`

Izin `modify` wajib.

```json
{ "path": "Documents/old.txt", "newName": "new.txt" }
```

### `POST /move`

Izin `modify` wajib.

```json
{ "path": "Documents/report.pdf", "dest": "Archive" }
```

`dest` harus folder yang sudah ada. Memindahkan folder ke dalam dirinya sendiri atau turunannya ditolak.

### `POST /delete`

Izin `delete` wajib.

```json
{ "path": "Documents/old.txt" }
```

Memindahkan item ke `.trash` akun, bukan menghapus permanen. `used` tetap menghitung item tersebut.

### `POST /trash/empty`

Izin `delete` wajib. Menghapus isi `.trash` akun secara permanen dan membebaskan kuota.

## Path dan isolasi

Semua path adalah relatif terhadap root akun. Agent menolak path traversal, akses langsung ke `.trash`, dan target yang lolos dari root akun. Jangan menambahkan endpoint yang menerima path absolut dari client.
