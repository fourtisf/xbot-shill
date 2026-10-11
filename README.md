# Fourtis X Agent

Bot Telegram yang memantau channel target. Setiap ada post dengan link X project:

- **Project opt-in** → akun X bot otomatis komentar di tweet terbaru project itu (realtime, dengan jeda aman)
- **Project belum opt-in** → akun X bot posting tweet sendiri tentang project (bisa dimatikan dengan `/tweet off`)
- Setiap aksi dilaporkan ke **channel laporan**, lengkap dengan tombol Follow & Buka

Semua pengaturan lewat bot Telegram — tidak ada website.

## Yang dibutuhkan

1. **Bot Telegram** — buat di @BotFather, ambil token
2. **Akun Telegram listener** — akun biasa yang sudah join semua channel target. API ID/HASH dari https://my.telegram.org
3. **Akun X bot** — buat app di https://developer.x.com (izin *Read and Write*), ambil 4 key. Aktifkan label *Automated* di pengaturan akun X
4. Server/VPS dengan Node.js 18+

## Instalasi

```bash
npm install
cp .env.example .env      # isi BOT_TOKEN, ADMIN_IDS, TG_API_ID, TG_API_HASH
npm run login             # login akun listener, tempel TG_SESSION ke .env
npm start                 # jalankan (pakai pm2 di VPS: pm2 start src/index.js --name xagent)
```

## Setup di Telegram (sekali saja)

1. DM bot: `/setx APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET` (pesan otomatis dihapus)
2. `/addchannel @channeltarget` (ulangi untuk tiap channel)
3. Buat channel laporan, jadikan bot admin, lalu posting `/setreport` di channel itu
4. Atur template: `/addtpl Love seeing {name} keep shipping 🚀`
5. `/status` untuk cek semua sudah ✅

## Opt-in project

- **Otomatis**: project DM bot → `/optin @handle` → pasang kode di bio X → `/verify @handle`
- **Manual admin** (mis. project yang beli paket listing): `/addoptin @handle`
- Project bisa berhenti kapan saja: `/optout @handle`

## Perintah admin

| Perintah | Fungsi |
|---|---|
| `/channels` `/addchannel` `/delchannel` | Kelola channel target |
| `/tpls` `/addtpl` `/deltpl n` | Template komentar (`{name}` `{handle}` `{channel}`) |
| `/tweet on\|off` `/settweet teks` | Tweet bot untuk project belum opt-in |
| `/optins` `/addoptin` `/deloptin` | Daftar project opt-in |
| `/filter` `/filter minFollowers 1000` | minFollowers, minAgeDays, blacklist, cooldownDays, tweetsPerProject, maxTweetAgeHours |
| `/limits` `/limits maxPerHour 15` | minDelaySec, maxDelaySec, maxPerHour |
| `/pause` `/resume` `/status` | Kontrol bot |

## Catatan

- Data tersimpan di `data.json` (backup berkala).
- Kalau X membalas rate limit (429), bot otomatis pause dan lapor ke channel laporan.
- X API berbayar: baca profil + timeline butuh minimal paket **Basic**.
