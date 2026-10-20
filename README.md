# Fourtis X Agent

Bot Telegram yang memantau channel target. Setiap ada post dengan link X project:

- **Project opt-in** → akun X bot otomatis komentar di tweet terbaru project itu (realtime, dengan jeda aman)
- **Project belum opt-in** → bot TIDAK berkomentar, like atau follow sendiri (aturan X). Dengan **Komentar 1-tap** (ON bawaan, /menu → Otomatis)
  laporan berisi komentar per brand dengan tombol **📋 Salin**; reply, like & follow dilakukan admin di X (Salin → buka tweet → Reply → tempel):
  - **Mode hemat ON** (bawaan, `/auto freeMode`): tanpa API X, gratis → tombol **👤 Profil X** (buka tweet teratas, bukan yang Pinned)
  - **Mode hemat OFF**: bot mencari tweet terbarunya lewat API X (±2 kredit per project) → tombol **🔗 Tweet terbaru** + ✍️ Ubah di X (PC).
    Kredit habis (402) / error X → laporan otomatis memakai 👤 Profil X; kredit habis diberi 1 peringatan per 6 jam
  - Project yang tidak bisa disiapkan (tidak ada tweet baru, tidak ditemukan) tidak dilaporkan, cukup di log. Kalau 1-tap OFF: setiap project hanya dilaporkan
- **💬 Channel Telegram** (channel khusus, terpisah dari laporan X): post channel target yang berisi link grup/channel
  Telegram project (`t.me/…`) dikirim ke sini dengan komentar per brand → **📋 Salin** → **💬 Buka grup** → tempel di grup
  pakai akun Telegram sendiri. Lihat [Channel Telegram](#channel-telegram)
- **Link opt-in 1-klik** (`t.me/<bot>?start=optin`, tampil di /menu → Opt-in saat Opt-in publik ON): project klik → kirim username X → pasang kode di bio → komentar otomatis penuh
- Bot **tidak pernah mem-posting tweet sendiri** — satu-satunya aksi di X adalah komentar ke tweet project opt-in
- Setiap aksi dilaporkan ke **channel laporan**. Laporan komentar punya tombol **❤️ Like** + **👤 Follow** (1 tekan di Telegram, dikirim dari akun brand). Hanya ADMIN_IDS yang bisa menekan
- **Multi brand**: Fourtis & Dexvra (dan brand lain) masing-masing punya akun X & template sendiri

Semua pengaturan lewat bot Telegram — tidak ada website.

## Channel Telegram

Channel khusus untuk shill di **grup Telegram** project — terpisah dari channel laporan X. Channel target yang dipantau
sama; setiap post yang berisi link grup/channel Telegram project dikirim ke channel ini:

```
💬 @PepePortal siap dikomentari
👥 Grup · Pepe Portal · 12 345 anggota
Sumber: MadApes Calls
Komentar Fourtis: "…"
Komentar Dexvra: "…"
[📋 Salin · Fourtis] [📋 Salin · Dexvra]
[💬 Buka grup] [🚫 Abaikan]
```

- **Atur**: buat channel baru, jadikan bot admin (izin *Post Messages*) → /menu → **💬 Channel Telegram** → 📨 Atur channel →
  kirim ID channel (`-100…`). Bisa juga `/settgreport -100…` di DM bot, atau posting `/settgreport` di channel itu. Bot mengirim
  pesan tes dulu. Matikan: tombol 🛑 Matikan
- **Link yang dihitung**: link `t.me/…` yang ditulis, ditautkan (teks bertaut) atau di tombol post. `@mention` **tidak** dihitung
  (di post call, `@nama` sering handle X). Link undangan grup privat (`t.me/+…`) ikut dilaporkan
- **Dilewati otomatis**: bot (`…bot`, `?start=`), link post (`t.me/nama/123`), link ke channel target sendiri, nomor telepon.
  Tiap link dicek gratis di halaman `t.me/<nama>` (tanpa API, tanpa login): akun pribadi, bot, dan link mati tidak dilaporkan;
  grup/channel tampil dengan nama & jumlah anggota. t.me sedang tidak bisa dibuka → tetap dilaporkan tanpa info
- **Tidak dobel**: satu link maks. 1 laporan per *Jeda project yang sama* (🔎 Filter, bawaan 7 hari)
- **🚫 Abaikan** (hanya ADMIN_IDS): link itu tidak dilaporkan lagi — mis. grup chat milik channel call itu sendiri.
  Kosongkan daftarnya di /menu → 💬 Channel Telegram
- **Template**: tiap brand bisa punya komentar khusus grup Telegram (/menu → 📝 Template → brand → ➕ Tambah komentar Telegram,
  atau `/addtgtpl dexvra teks`). Kosong = memakai template komentar X brand itu. Variabel: `{name}` nama grup,
  `{handle}` username grup, `{channel}` channel sumber
- Bot **tidak pernah menulis di grup orang lain** — komentar ditempel admin sendiri (spam bot di grup = di-ban / akun dibatasi Telegram)

## Multi brand / multi akun

Satu brand = satu akun X dengan template komentar sendiri. Brand bawaan: **fourtis** (utama) dan **dexvra**.

Cara termudah: `/menu` → **👤 Akun X** → **Hubungkan akun …**:
- **🔗 Login X (disarankan)** — kirim 2 kode app (Consumer Key + Secret Key dari console.x.com → Apps → OAuth 1.0 Keys),
  buka link dari bot, login sebagai akun X brand itu, kirim PIN. Satu app developer bisa dipakai untuk semua brand
  (tombol "Login X pakai app Fourtis").
- **🔑 4 kode manual** — Consumer Key, Secret Key, Access Token, Access Token Secret. Access Token di console selalu
  milik akun yang login ke console ("For @…"), jadi harus akun X brand itu. Bot mengenali Bearer Token / Client ID /
  urutan yang salah tempel.

```
/addaccount fourtis APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET
/addaccount dexvra  APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET
/addaccount brandbaru ...        # brand baru otomatis dibuat
/accounts                        # semua brand, akun, jumlah opt-in/template
/addchannel @channel             # channel berlaku untuk semua brand
/addtpl dexvra Solid move from {name} 👀
```

Siapa yang bertindak:
- **Project opt-in** → akun brand yang dipilih project saat `/optin` (tombol pilihan brand), dari channel mana pun. Channel tidak punya brand
- **Project belum opt-in** → tidak ada akun yang bertindak, hanya laporan

Pengaman supaya akun-akun tidak dianggap terkoordinasi oleh X (bisa di-suspend bersamaan):
- Satu akun X hanya untuk satu brand, dan satu brand hanya satu akun
- Satu tweet hanya dikomentari **satu** akun; satu project hanya diurus **satu** brand (cooldown berlaku lintas brand)
- Template tiap brand berbeda; komentar ke project yang sama tidak pernah berteks sama dalam 24 jam
- Rate limit, jeda, dan batas per jam/hari dihitung **per akun** — Dexvra kena limit, Fourtis tetap jalan

## Yang berjalan otomatis

| Otomatis | Keterangan |
|---|---|
| Pantau channel 24 jam | Channel **publik** siapa pun dibaca dari halaman web `t.me/s/<channel>` tiap 30 detik (bot **tidak perlu admin**, ubah di /menu → Otomatis). Channel tempat bot admin: post langsung diproses |
| Kejar post yang terlewat | Bot mati / koneksi putus → saat hidup lagi, post ≤ 6 jam terakhir tetap diproses (tanpa dobel) |
| Sambung ulang listener | Koneksi Telegram putus → dilapor, disambung ulang sendiri |
| Pantau tweet project opt-in | Tweet baru project opt-in langsung dikomentari, tanpa menunggu post channel |
| Hanya tweet terbaru | Project punya 10+ tweet → hanya 3 tweet **terbaru** yang dikomentari, yang paling baru duluan (`/filter tweetsPerProject 3`), maks. 3 komentar/hari per project (`/auto maxRepliesPerProjectPerDay 3`) |
| Jeda komentar | Komentar ke project yang sama minimal 5 menit sekali (`/jeda project 5`); project lain tetap jalan. Jeda antar semua aksi: `/jeda 5` atau acak `/jeda 3 6` |
| Verifikasi opt-in | Project cukup pasang kode di bio; bot cek sendiri tiap 10 menit, kode kedaluwarsa setelah 3 hari |
| Rate limit X (429) | Akun itu jeda sampai waktu reset dari X (termasuk batas 24 jam), lalu **jalan lagi sendiri**; antrian dilanjutkan mulai dari tweet **terbaru** |
| Tweet tidak bisa dibalas | Balasan dibatasi / tweet dihapus → akun yang **sama** pindah ke tweet terbaru lain dari project itu (maks. 3x/hari). Tweet "hanya akun yang di-mention" dilewati dari awal |
| Project memblokir akun | Opt-in ke brand itu dihentikan otomatis — tidak dicoba lewat akun lain |
| Rem darurat per akun | Akun ditolak X (key salah, dikunci, dibatasi) → akun itu **berhenti otomatis**, admin dikabari di channel laporan + DM; akun lain tetap jalan. Lanjut lagi: `/resume brand` |
| Error jaringan / server X | Diulang otomatis (maks. 3x) |
| Antrian tersimpan | Restart / VPS reboot tidak menghilangkan antrian |
| Cek channel | Bot lapor channel yang belum terbaca (privat / username salah) dan lapor lagi begitu terbaca. Bot dijadikan admin di channel yang tadinya dibaca lewat web → langsung pindah ke jalur bot (instan), tanpa dobel |
| Ringkasan harian | Tiap pagi (jam di `/auto dailyReportHour`), 24 jam terakhir: jumlah project **siap dikomentari** di channel X & jumlah grup di channel Telegram (+ sumber teratas), komentar, skip, opt-in, error, status akun X. Channel Telegram mendapat ringkasannya sendiri. Kapan saja: `/laporan` atau /menu → 📈 Laporan 24 jam |
| Backup | `data.json` di-backup harian ke `backups/` (7 terakhir); kalau `data.json` rusak, dipulihkan sendiri dari backup |
| Restart | pm2 menyalakan ulang bot kalau crash atau VPS reboot |

## Yang dibutuhkan (sekali saja, tidak bisa diotomatisasi)

1. **Bot Telegram** — buat di @BotFather, ambil token. `.env` hanya butuh `BOT_TOKEN` + `ADMIN_IDS`.
   Channel **publik** orang lain: cukup `/addchannel @namachannel` — bot **tidak perlu** jadi admin (dibaca dari halaman web publik `t.me/s/namachannel`).
   Channel **privat**: hanya bisa dibaca kalau bot dijadikan admin di sana.
2. *(Opsional, jarang perlu)* **Akun Telegram listener** — hanya untuk channel **privat orang lain** (bot tidak bisa jadi admin, tidak ada halaman publik): isi `TG_API_ID`/`TG_API_HASH` dari https://my.telegram.org lalu `npm run login`
3. **Akun X bot** — buat app di https://developer.x.com (izin *Read and Write*), ambil 4 key. Aktifkan label *Automated* di pengaturan akun X
4. Server/VPS dengan Node.js 18+

## Instalasi

```bash
npm install
cp .env.example .env      # isi BOT_TOKEN dan ADMIN_IDS (TG_API_* boleh kosong)
# npm run login           # opsional, hanya untuk mode listener (channel privat orang lain)
npm test                  # opsional: test end-to-end (tanpa akun asli)

npm install -g pm2
pm2 start ecosystem.config.cjs   # jalan permanen, restart otomatis kalau crash
pm2 save && pm2 startup          # nyala lagi otomatis setelah VPS reboot (jalankan perintah yang dicetak)
pm2 install pm2-logrotate        # log tidak memenuhi disk
pm2 logs xagent                  # lihat log
```

## Setup di Telegram (sekali saja)

1. DM bot: `/addaccount fourtis APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET` lalu `/addaccount dexvra ...` (pesan otomatis dihapus)
2. `/addchannel @channeltarget` (boleh juga link `https://t.me/channeltarget`; ulangi untuk tiap channel). Channel publik langsung terbaca tanpa admin — bot membalas berapa post yang terbaca. Kalau bot bilang *belum bisa dibaca*: cek ejaan username, atau channel itu privat (jadikan bot admin)
3. Buat channel laporan, jadikan bot admin (izin *Post Messages*), lalu /menu → 📨 Channel laporan → kirim ID channel (`-100…`). Bisa juga `/setreport -100…` di DM bot, atau posting `/setreport` di channel itu. Bot mengirim pesan tes dulu; kalau gagal, bot memberi tahu dan channel lama tetap dipakai
   - *(Opsional)* Channel khusus grup Telegram: buat channel kedua, jadikan bot admin, lalu /menu → 💬 Channel Telegram (atau `/settgreport -100…`)
4. Ganti template contoh: `/tpls` untuk lihat, `/addtpl dexvra ...`, `/deltpl dexvra 1`
5. `/status` dan `/accounts` untuk cek semua sudah ✅

## Opt-in project

- **Otomatis**: project DM bot → `/optin @handle` → pilih brand (tombol) → pasang kode di bio X → bot verifikasi sendiri (atau `/verify @handle` untuk cek seketika). Bisa langsung: `/optin @handle dexvra`
- **Manual admin** (mis. project yang beli paket listing): `/addoptin @handle [brand]`
- Project bisa berhenti kapan saja: `/optout @handle` (komentar yang masih antre ikut dibatalkan)

## Panel tombol

Ketik **/menu** (atau /start) di DM bot: semua pengaturan pakai tombol — akun X per brand, channel, template,
opt-in, jeda & batas, filter, fitur otomatis, pause/jalankan. Untuk isian (key X, channel, template) bot
menanyakannya langsung; /batal untuk membatalkan. Ketik **/** untuk daftar perintah (project hanya melihat
/optin, /verify, /optout).

## Perintah admin

| Perintah | Fungsi |
|---|---|
| `/accounts` `/addaccount brand ...` `/delaccount brand` | Akun X per brand (`/setx ...` = `/addaccount` brand utama) |
| `/channels` `/addchannel @ch` `/delchannel` | Kelola channel target (berlaku untuk semua brand) |
| `/tpls [brand]` `/addtpl [brand] teks` `/deltpl [brand] n` | Template komentar per brand (`{name}` `{handle}` `{channel}`; `{channel}` kosong untuk komentar dari pantauan tweet) |
| `/settgreport -100…` `/addtgtpl [brand] teks` `/deltgtpl [brand] n` | Channel Telegram & komentar khusus grup Telegram per brand (kosong = template komentar X) |
| `/optins` `/addoptin @h [brand]` `/deloptin` | Daftar project opt-in & brand-nya (+ yang menunggu verifikasi) |
| `/filter` `/filter minFollowers 1000` | minFollowers, minAgeDays, blacklist (bawaan **mati**: setiap link X dari channel langsung diproses), cooldownDays, tweetsPerProject, maxTweetAgeHours |
| `/limits` `/limits maxPerHour 15` | minDelaySec, maxDelaySec, maxPerHour, maxPerDay (semua **per akun**) |
| `/jeda` `/jeda 5` `/jeda 3 6` `/jeda project 10` | Jeda dalam menit: antar semua aksi (tetap / acak) dan antar komentar ke project yang sama |
| `/auto` `/auto watchOptins false` | watchOptins, watchIntervalMin, maxRepliesPerProjectPerDay, replyGapMin, autoVerify, verifyIntervalMin, pendingExpireDays, catchUpMin, catchUpMaxAgeHours, dailyReportHour, backupKeep |
| `/laporan` | Laporan 24 jam terakhir: berapa "siap dikomentari" di channel X & channel Telegram, sumber teratas |
| `/pause` `/resume` `/resume brand` `/status` | Kontrol bot (`/resume dexvra` = jalankan lagi satu akun yang kena rem darurat) |

## Yang sengaja TIDAK diotomatisasi

Aturan otomasi X melarang hal-hal ini dan bisa membuat akun bot di-suspend:

- **Auto-like** — X melarang like otomatis. Gantinya: tombol ❤️ Like di laporan (1 tekan = 1 like, dipicu admin)
- **Auto-follow** — X melarang follow otomatis berulang. Gantinya: tombol 👤 Follow di laporan (1 tekan = 1 follow, dipicu admin)
- **Komentar / mention ke project yang belum opt-in** — reply otomatis hanya untuk project yang sudah setuju
- **Beberapa akun untuk brand yang sama / akun bergantian / akun cadangan yang menggantikan akun yang gagal** — X menganggapnya menghindari limit atau sanksi lewat banyak akun; tiap akun harus punya brand & tujuan sendiri

## Catatan

- Data tersimpan di `data.json` (berisi key X — jangan dibagikan / di-commit, sudah ada di `.gitignore`).
- X API berbayar: baca profil, timeline, dan pencarian (pantauan tweet opt-in) butuh minimal paket **Basic**. Pantauan memakai satu pencarian untuk banyak project sekaligus dan hanya membaca tweet baru (`since_id`); matikan dengan `/auto watchOptins false` kalau kuota baca menipis.
- `npm test` menjalankan bot asli dengan Telegram & X tiruan untuk memastikan semua alur jalan.
