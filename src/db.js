import fs from 'fs';
import path from 'path';

const FILE = process.env.DB_FILE || './data.json';
const BACKUP_DIR = path.join(path.dirname(FILE), 'backups');

// Satu brand = satu akun X dengan template komentar sendiri. Template bawaan hanya contoh, ganti lewat /addtpl
export function newBrand(key, name = key[0].toUpperCase() + key.slice(1)) {
  return {
    name,
    x: null, // { appKey, appSecret, accessToken, accessSecret }
    username: null,
    templates: [
      `Big things happening at {name} 🔥 watching this one closely`,
      `Love seeing {name} keep shipping 🚀`,
      `{name} is one to watch 👀 tracking it on ${name}`
    ]
  };
}

const defaults = {
  defaultBrand: 'fourtis', // brand untuk perintah tanpa nama brand
  brands: {
    fourtis: newBrand('fourtis', 'Fourtis'),
    dexvra: {
      ...newBrand('dexvra', 'Dexvra'),
      templates: [
        '{name} keeps building 🔥 Dexvra is watching',
        'Solid move from {name} 👀',
        'Big potential at {name} 📈 on our list'
      ]
    }
  },
  channels: [], // '@username' atau id numerik
  reportChat: null,
  paused: false, // pause manual (/pause)
  pausedUntil: {}, // brand -> pause otomatis karena rate limit X, jalan lagi sendiri setelah waktu ini
  optins: {}, // handle -> { at, via, by, brand }
  pending: {}, // handle -> { code, by, at, brand }
  history: {}, // handle -> timestamp terakhir diproses
  filter: {
    // Bawaan tanpa filter: setiap link X dari channel target langsung diproses (bisa dinyalakan di /menu → Filter)
    minFollowers: 0,
    minAgeDays: 0,
    blacklist: [],
    cooldownDays: 7,
    tweetsPerProject: 3, // berapa tweet TERBARU yang dikomentari per project
    maxTweetAgeHours: 48,
    useMentions: false
  },
  limits: { minDelaySec: 30, maxDelaySec: 90, maxPerHour: 20, maxPerDay: 50 },
  auto: {
    watchOptins: true, // komentar otomatis di tweet baru project opt-in, tanpa menunggu post channel
    watchIntervalMin: 10,
    maxRepliesPerProjectPerDay: 3,
    replyGapMin: 5, // jeda minimal antar komentar ke project yang sama (menit)
    autoVerify: true, // cek bio project yang /optin tiap beberapa menit, tanpa perlu /verify
    verifyIntervalMin: 10,
    pendingExpireDays: 3,
    webPollSec: 30, // baca halaman web channel publik (t.me/s/…) tiap N detik
    manualAssist: true, // project belum opt-in: siapkan komentar 1-tap (admin yang menekan kirim di X)
    // Mode hemat: komentar project belum opt-in disiapkan TANPA API X (gratis, tidak memakai kredit): laporan berisi
    // tombol 📋 Salin + link profil project; reply / like / follow dilakukan di X. OFF = cari tweet terbaru + tombol 💬 ❤️ 👤
    freeMode: true,
    catchUpMin: 5, // ambil post channel yang terlewat (bot mati / koneksi putus)
    catchUpMaxAgeHours: 6,
    dailyReportHour: 9, // jam ringkasan harian + backup (zona waktu TZ di .env)
    backupKeep: 7,
    publicOptin: false // false = bot privat, hanya ADMIN_IDS; true = project boleh /optin sendiri
  },
  queue: [], // antrian aksi X, tersimpan supaya tidak hilang saat restart
  sentAt: {}, // brand -> waktu aksi X 24 jam terakhir (batas per jam/hari per akun)
  replyLog: {}, // handle -> [timestamp komentar 24 jam terakhir]
  repliedTweets: [], // id tweet yang sudah dikomentari akun mana pun (anti dobel)
  skippedTweets: [], // id tweet yang tidak bisa dibalas (balasan dibatasi / dihapus)
  refills: {}, // handle -> [waktu pindah ke tweet lain] (maks. 3 per 24 jam)
  brandDown: {}, // brand -> { at, reason }: akun dihentikan rem darurat, jalan lagi dengan /resume brand
  tplLog: {}, // handle / #brand -> template terakhir dipakai (anti komentar kembar)
  manual: {}, // tweet id -> data tombol aksi di laporan (💬 / ❤️ / 👤), dibersihkan setelah 3 hari
  lastSeen: {}, // channel (@nama / -100…) -> id post terakhir yang sudah dibaca
  watchSinceId: {}, // brand -> id tweet terbaru yang sudah dibaca
  stats: {}, // hitungan sejak ringkasan harian terakhir
  lastDaily: null
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readSaved() {
  if (!fs.existsSync(FILE)) return null;
  try {
    return readJson(FILE);
  } catch (e) {
    // File rusak (mis. VPS mati saat menulis): pulihkan dari backup terbaru
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort().reverse() : [];
    for (const f of files) {
      try {
        const saved = readJson(path.join(BACKUP_DIR, f));
        console.error(`${FILE} rusak (${e.message}), dipulihkan dari backups/${f}`);
        return saved;
      } catch {}
    }
    throw e;
  }
}

function load() {
  const saved = readSaved();
  if (!saved) return structuredClone(defaults);
  const d = {
    ...structuredClone(defaults),
    ...saved,
    filter: { ...defaults.filter, ...(saved.filter || {}) },
    limits: { ...defaults.limits, ...(saved.limits || {}) },
    auto: { ...defaults.auto, ...(saved.auto || {}) }
  };
  // Data versi lama (satu akun X, template global) -> brand utama
  if (!saved.brands) {
    const main = d.brands[d.defaultBrand];
    if (saved.x) main.x = saved.x;
    if (saved.templates?.length) main.templates = saved.templates;
  }
  for (const k of ['x', 'templates', 'ownTweetTemplate', 'ownTweetEnabled']) delete d[k];
  if (Array.isArray(d.sentAt)) d.sentAt = { [d.defaultBrand]: d.sentAt };
  if (typeof d.pausedUntil !== 'object' || !d.pausedUntil) d.pausedUntil = d.pausedUntil ? { [d.defaultBrand]: d.pausedUntil } : {};
  if (typeof d.watchSinceId !== 'object' || !d.watchSinceId) d.watchSinceId = d.watchSinceId ? { [d.defaultBrand]: d.watchSinceId } : {};
  for (const j of d.queue) j.brand ||= d.defaultBrand;
  // Filter followers / umur akun / kata terlarang dulu aktif bawaan; sekarang mati. Data lama dimatikan sekali
  if (!d.filterOffDefault) {
    Object.assign(d.filter, { minFollowers: 0, minAgeDays: 0, blacklist: [] });
    d.filterOffDefault = true;
  }
  // Tweet bot (akun brand tweet sendiri tentang project) dihapus: buang sisa pengaturan & tweet yang masih antre.
  // Brand channel ikut dihapus — dulu hanya menentukan akun untuk tweet bot; komentar selalu dari brand opt-in project
  d.queue = d.queue.filter((j) => j.type === 'reply');
  for (const v of Object.values(d.brands)) { delete v.ownTweetEnabled; delete v.tweetTemplates; }
  for (const k of Object.keys(d.tplLog || {})) if (k.startsWith('#')) delete d.tplLog[k];
  for (const k of ['channelBrand', 'tweetBotDefaultOff']) delete d[k];
  return d;
}

export const db = load();

export function save() {
  // Tulis ke file sementara lalu rename, supaya data.json tidak pernah setengah tertulis
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

export function backup() {
  save();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `data-${new Date().toISOString().slice(0, 10)}.json`;
  fs.copyFileSync(FILE, path.join(BACKUP_DIR, name));
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - db.auto.backupKeep))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return name;
}
