import fs from 'fs';
import path from 'path';

const FILE = process.env.DB_FILE || './data.json';
const BACKUP_DIR = path.join(path.dirname(FILE), 'backups');

const defaults = {
  x: null, // { appKey, appSecret, accessToken, accessSecret }
  channels: [], // '@username' atau id numerik
  reportChat: null,
  paused: false, // pause manual (/pause)
  pausedUntil: 0, // pause otomatis karena rate limit X, jalan lagi sendiri setelah waktu ini
  templates: [
    'Big things happening at {name} 🔥 watching this one closely',
    'Love seeing {name} keep shipping 🚀',
    '{name} is one to watch 👀 tracking it on Fourtis'
  ],
  ownTweetEnabled: true,
  ownTweetTemplate: '🚀 New project spotted: {name}\nVia {channel}\nx.com/{handle}',
  optins: {}, // handle -> { at, via }
  pending: {}, // handle -> { code, by, at }
  history: {}, // handle -> timestamp terakhir diproses
  filter: {
    minFollowers: 500,
    minAgeDays: 14,
    blacklist: ['scam', 'rug'],
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
    catchUpMin: 5, // ambil post channel yang terlewat (bot mati / koneksi putus)
    catchUpMaxAgeHours: 6,
    dailyReportHour: 9, // jam ringkasan harian + backup (zona waktu TZ di .env)
    backupKeep: 7
  },
  queue: [], // antrian aksi X, tersimpan supaya tidak hilang saat restart
  sentAt: [], // waktu aksi X 24 jam terakhir (batas per jam/hari)
  replyLog: {}, // handle -> [timestamp komentar 24 jam terakhir]
  repliedTweets: [], // id tweet yang sudah dikomentari (anti dobel)
  lastSeen: {}, // id channel -> id post terakhir yang sudah dibaca
  watchSinceId: null,
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
  return {
    ...structuredClone(defaults),
    ...saved,
    filter: { ...defaults.filter, ...(saved.filter || {}) },
    limits: { ...defaults.limits, ...(saved.limits || {}) },
    auto: { ...defaults.auto, ...(saved.auto || {}) }
  };
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
