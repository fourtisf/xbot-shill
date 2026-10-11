# Fourtis X Agent

Bot Telegram yang memantau channel target. Setiap ada post dengan link X project:

- **Project opt-in** → akun X bot otomatis komentar di tweet terbaru project itu (realtime, dengan jeda aman)
- **Project belum opt-in** → akun X bot posting tweet sendiri tentang project (bisa dimatikan dengan `/tweet off`)
- Setiap aksi dilaporkan ke **channel laporan**, lengkap dengan tombol Follow & Buka
- **Multi brand**: Fourtis & Dexvra (dan brand lain) masing-masing punya akun X & template sendiri

Semua pengaturan lewat bot Telegram — tidak ada website.

## Multi brand / multi akun

Satu brand = satu akun X dengan template komentar & tweet sendiri. Brand bawaan: **fourtis** (utama) dan **dexvra**.

```
/addaccount fourtis APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET
/addaccount dexvra  APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET
/addaccount brandbaru ...        # brand baru otomatis dibuat
/accounts                        # semua brand, akun, jumlah channel/opt-in/template
/addchannel @channel dexvra      # post channel ini diurus akun Dexvra
/addtpl dexvra Solid move from {name} 👀
/addtweet dexvra 📡 New on our radar: {name}\nx.com/{handle}
```

Siapa yang bertindak:
- **Project opt-in** → akun brand yang dipilih project saat `/optin` (tombol pilihan brand), dari channel mana pun
- **Project belum opt-in** → akun brand channel tempat link diposting (`/addchannel @ch brand`; tanpa brand = brand utama)

Pengaman supaya akun-akun tidak dianggap terkoordinasi oleh X (bisa di-suspend bersamaan):
- Satu akun X hanya untuk satu brand, dan satu brand hanya satu akun
- Satu tweet hanya dikomentari **satu** akun; satu project hanya diurus **satu** brand (cooldown berlaku lintas brand)
- Template tiap brand berbeda; komentar ke project yang sama tidak pernah berteks sama dalam 24 jam
- Rate limit, jeda, dan batas per jam/hari dihitung **per akun** — Dexvra kena limit, Fourtis tetap jalan

## Yang berjalan otomatis

| Otomatis | Keterangan |
|---|---|
| Pantau channel 24 jam | Post baru langsung diproses |
| Kejar post yang terlewat | Bot mati / koneksi putus → saat hidup lagi, post ≤ 6 jam terakhir tetap diproses (tanpa dobel) |
| Sambung ulang listener | Koneksi Telegram putus → dilapor, disambung ulang sendiri |
| Pantau tweet project opt-in | Tweet baru project opt-in langsung dikomentari, tanpa menunggu post channel |
| Hanya tweet terbaru | Project punya 10+ tweet → hanya 3 tweet **terbaru** yang dikomentari, yang paling baru duluan (`/filter tweetsPerProject 3`), maks. 3 komentar/hari per project (`/auto maxRepliesPerProjectPerDay 3`) |
| Jeda komentar | Komentar ke project yang sama minimal 5 menit sekali (`/jeda project 5`); project lain tetap jalan. Jeda antar semua aksi: `/jeda 5` atau acak `/jeda 3 6` |
| Verifikasi opt-in | Project cukup pasang kode di bio; bot cek sendiri tiap 10 menit, kode kedaluwarsa setelah 3 hari |
| Rate limit X (429) | Bot jeda sampai waktu reset dari X (termasuk batas 24 jam), lalu **jalan lagi sendiri** dan mengulang aksi yang gagal |
| Error jaringan / server X | Diulang otomatis (maks. 3x) |
| Antrian tersimpan | Restart / VPS reboot tidak menghilangkan antrian |
| Cek channel | Bot lapor kalau akun listener belum join channel target, dan lapor lagi begitu sudah join |
| Ringkasan harian | Tiap pagi (jam di `/auto dailyReportHour`): jumlah komentar, tweet, skip, opt-in, error, status akun X |
| Backup | `data.json` di-backup harian ke `backups/` (7 terakhir); kalau `data.json` rusak, dipulihkan sendiri dari backup |
| Restart | pm2 menyalakan ulang bot kalau crash atau VPS reboot |

## Yang dibutuhkan (sekali saja, tidak bisa diotomatisasi)

1. **Bot Telegram** — buat di @BotFather, ambil token
2. **Akun Telegram listener** — akun biasa yang sudah join semua channel target. API ID/HASH dari https://my.telegram.org
3. **Akun X bot** — buat app di https://developer.x.com (izin *Read and Write*), ambil 4 key. Aktifkan label *Automated* di pengaturan akun X
4. Server/VPS dengan Node.js 18+

## Instalasi

```bash
npm install
cp .env.example .env      # isi BOT_TOKEN, ADMIN_IDS, TG_API_ID, TG_API_HASH, TZ
npm run login             # login akun listener, tempel TG_SESSION ke .env
npm test                  # opsional: test end-to-end (tanpa akun asli)

npm install -g pm2
pm2 start ecosystem.config.cjs   # jalan permanen, restart otomatis kalau crash
pm2 save && pm2 startup          # nyala lagi otomatis setelah VPS reboot (jalankan perintah yang dicetak)
pm2 install pm2-logrotate        # log tidak memenuhi disk
pm2 logs xagent                  # lihat log
```

## Setup di Telegram (sekali saja)

1. DM bot: `/addaccount fourtis APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET` lalu `/addaccount dexvra ...` (pesan otomatis dihapus)
2. `/addchannel @channeltarget fourtis` atau `... dexvra` (ulangi untuk tiap channel — bot langsung bilang kalau akun listener belum join)
3. Buat channel laporan, jadikan bot admin, lalu posting `/setreport` di channel itu (akun di `ADMIN_IDS` harus admin channel tersebut)
4. Ganti template contoh: `/tpls` untuk lihat, `/addtpl dexvra ...`, `/addtweet fourtis ...`, `/deltpl dexvra 1`
5. `/status` dan `/accounts` untuk cek semua sudah ✅

## Opt-in project

- **Otomatis**: project DM bot → `/optin @handle` → pilih brand (tombol) → pasang kode di bio X → bot verifikasi sendiri (atau `/verify @handle` untuk cek seketika). Bisa langsung: `/optin @handle dexvra`
- **Manual admin** (mis. project yang beli paket listing): `/addoptin @handle [brand]`
- Project bisa berhenti kapan saja: `/optout @handle` (komentar yang masih antre ikut dibatalkan)

## Perintah admin

| Perintah | Fungsi |
|---|---|
| `/accounts` `/addaccount brand ...` `/delaccount brand` | Akun X per brand (`/setx ...` = `/addaccount` brand utama) |
| `/channels` `/addchannel @ch [brand]` `/delchannel` | Kelola channel target & brand-nya |
| `/tpls [brand]` `/addtpl [brand] teks` `/deltpl [brand] n` | Template komentar per brand (`{name}` `{handle}` `{channel}`; `{channel}` kosong untuk komentar dari pantauan tweet) |
| `/addtweet [brand] teks` `/deltweet [brand] n` | Template tweet bot per brand (dirotasi) |
| `/tweet on\|off [brand]` | Tweet bot untuk project belum opt-in (semua brand atau satu brand) |
| `/optins` `/addoptin @h [brand]` `/deloptin` | Daftar project opt-in & brand-nya (+ yang menunggu verifikasi) |
| `/filter` `/filter minFollowers 1000` | minFollowers, minAgeDays, blacklist, cooldownDays, tweetsPerProject, maxTweetAgeHours |
| `/limits` `/limits maxPerHour 15` | minDelaySec, maxDelaySec, maxPerHour, maxPerDay (semua **per akun**) |
| `/jeda` `/jeda 5` `/jeda 3 6` `/jeda project 10` | Jeda dalam menit: antar semua aksi (tetap / acak) dan antar komentar ke project yang sama |
| `/auto` `/auto watchOptins false` | watchOptins, watchIntervalMin, maxRepliesPerProjectPerDay, replyGapMin, autoVerify, verifyIntervalMin, pendingExpireDays, catchUpMin, catchUpMaxAgeHours, dailyReportHour, backupKeep |
| `/pause` `/resume` `/status` | Kontrol bot |

## Yang sengaja TIDAK diotomatisasi

Aturan otomasi X melarang hal-hal ini dan bisa membuat akun bot di-suspend:

- **Auto-like** — X melarang like otomatis
- **Auto-follow massal** — tombol Follow di laporan sengaja manual
- **Komentar / mention ke project yang belum opt-in** — reply otomatis hanya untuk project yang sudah setuju
- **Beberapa akun untuk brand yang sama / akun bergantian** — X menganggapnya akun terkoordinasi untuk menghindari limit; tiap akun harus punya brand & tujuan sendiri

## Catatan

- Data tersimpan di `data.json` (berisi key X — jangan dibagikan / di-commit, sudah ada di `.gitignore`).
- X API berbayar: baca profil, timeline, dan pencarian (pantauan tweet opt-in) butuh minimal paket **Basic**. Pantauan memakai satu pencarian untuk banyak project sekaligus dan hanya membaca tweet baru (`since_id`); matikan dengan `/auto watchOptins false` kalau kuota baca menipis.
- `npm test` menjalankan bot asli dengan Telegram & X tiruan untuk memastikan semua alur jalan.
