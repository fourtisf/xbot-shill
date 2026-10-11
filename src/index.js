import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { TwitterApi } from 'twitter-api-v2';
import { db, save, backup, newBrand } from './db.js';

const ADMINS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const bot = new Telegraf(process.env.BOT_TOKEN);
const isAdmin = (ctx) => ADMINS.includes(String(ctx.from?.id));
const norm = (h) => h.replace(/^@/, '').toLowerCase();
const validHandle = (h) => /^[a-z0-9_]{1,15}$/.test(h); // handle tidak valid membuat X menolak satu batch penuh
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const esc = (s = '') => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const TICK = Number(process.env.TICK_MS) || 60_000; // jeda tugas otomatis (dipercepat oleh npm test)
const POLL = Math.min(10_000, TICK);
const DAY = 86400_000;
const fmtTime = (t) => new Date(t).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
const stat = (k, brand) => {
  db.stats[k] = (db.stats[k] || 0) + 1;
  if (brand) db.stats[`${k}:${brand}`] = (db.stats[`${k}:${brand}`] || 0) + 1;
  save();
};

// ---------- Brand & akun X (satu akun per brand) ----------
const clients = {}; // brand -> client X
function initClients() {
  for (const b of Object.keys(clients)) delete clients[b];
  for (const [b, v] of Object.entries(db.brands)) if (v.x) clients[b] = new TwitterApi(v.x).readWrite;
}
initClients();
const brandName = (b) => db.brands[b]?.name || b;
const brandLabel = (b) => `${brandName(b)}${db.brands[b]?.username ? ` (@${db.brands[b].username})` : ''}`;
const findBrand = (s) => (s && db.brands[s.toLowerCase()] ? s.toLowerCase() : null);
const brandOf = (o) => findBrand(o?.brand) || db.defaultBrand; // brand opt-in / pending
const activeBrands = () => Object.keys(db.brands).filter((b) => clients[b]);
const isDown = (b) => !!db.brandDown[b]; // dihentikan rem darurat
const readerBrand = () => [db.defaultBrand, ...activeBrands()].find((b) => clients[b] && !isDown(b)); // untuk baca data umum
const channelBrand = (c) => findBrand(db.channelBrand[c]) || db.defaultBrand;
async function accountStatus(b) {
  if (!clients[b]) return '❌ belum ada akun';
  const down = isDown(b) ? ` · 🛑 dihentikan (${db.brandDown[b].reason}) — /resume ${b}` : '';
  try {
    const { data } = await clients[b].v2.me();
    db.brands[b].username = data.username;
    return '✅ @' + data.username + down;
  } catch (e) {
    return '❌ ' + (e?.data?.detail || e.message);
  }
}
const accountsReport = async () =>
  (await Promise.all(Object.keys(db.brands).map(async (b) => `${brandName(b)}: ${await accountStatus(b)}`))).join('\n');

// ---------- Laporan ----------
async function report(html, buttons) {
  if (!db.reportChat) return;
  try {
    await bot.telegram.sendMessage(db.reportChat, html, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons ? Markup.inlineKeyboard(buttons) : {})
    });
  } catch (e) {
    console.error('report error:', e.message);
  }
}

// ---------- Error X: jeda otomatis per akun saat rate limit, ulangi error sementara ----------
const limited = (b) => Date.now() < (db.pausedUntil[b] || 0);
const lastErr = new Map();
async function reportOnce(sig, html) { // pesan yang sama maks. 1x per jam
  if (Date.now() - (lastErr.get(sig) || 0) < 3600_000) return;
  lastErr.set(sig, Date.now());
  await report(html);
}
function rateLimitUntil(e) {
  const rl = e?.rateLimit || {};
  const resets = [rl.reset];
  for (const d of [rl.day, rl.userDay]) if (d?.remaining === 0) resets.push(d.reset); // batas 24 jam
  const reset = Math.max(0, ...resets.filter(Number.isFinite)) * 1000;
  return Math.max(reset ? reset + 5_000 : Date.now() + 15 * 60_000, Date.now() + TICK);
}
// ---------- Rem darurat per akun ----------
// Akun ditolak X (key salah, dikunci, dibatasi): berhenti sebelum makin parah, admin dikabari.
// Langsung untuk 401 / dikunci / suspend; error 403 lain setelah 3x berturut-turut. Akun lain tetap jalan.
const failStreak = {};
const SEVERE = /suspend|locked|restrict|automated/i;
async function accountProblem(brand, code, detail) {
  failStreak[brand] = (failStreak[brand] || 0) + 1;
  if (isDown(brand) || (code !== 401 && !SEVERE.test(detail) && failStreak[brand] < 3)) return;
  db.brandDown[brand] = { at: Date.now(), reason: `${code} ${detail}`.slice(0, 200) }; save();
  const msg = `🛑 <b>Akun ${esc(brandLabel(brand))} dihentikan otomatis</b>\nAlasan: ${esc(detail)}\n` +
    `Akun lain tetap jalan; antrian akun ini disimpan.\nCek akun di X, lalu /resume ${brand}` +
    (code === 401 ? ` (key berubah? /addaccount ${brand} ...)` : '');
  await report(msg);
  for (const id of ADMINS) await bot.telegram.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(() => {});
}

// Lapor error, kembalikan true kalau aksinya layak diulang. brand hanya untuk error dari X API
async function xError(e, label, brand) {
  const code = e?.code || e?.data?.status;
  stat('errors');
  if (code === 429) {
    brand ||= db.defaultBrand;
    const until = rateLimitUntil(e);
    if (until > (db.pausedUntil[brand] || 0)) {
      db.pausedUntil[brand] = until; save();
      await report(`⏸ Rate limit X akun ${esc(brandLabel(brand))} (${esc(label)}). Akun ini jeda otomatis sampai ${fmtTime(until)}, lalu jalan lagi sendiri.`);
    }
    return true;
  }
  const detail = e?.data?.detail || e?.message;
  if (brand && (code === 401 || (code === 403 && !/duplicate/i.test(detail)))) await accountProblem(brand, code, detail);
  const sig = `${label}|${code}|${detail}`;
  if (Date.now() - (lastErr.get(sig) || 0) > 3600_000) { // error yang sama dilapor maks. 1x per jam
    lastErr.set(sig, Date.now());
    await report(`⚠️ <b>${esc(label)}</b> gagal (${esc(code ?? e?.requestError?.code ?? 'error')})\n${esc(detail)}`);
  }
  return e?.type === 'request' || code >= 500; // jaringan putus / server X error
}

// ---------- Ekstrak handle X dari post ----------
const RESERVED = new Set(['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'settings']);
function extractHandles(text, urls) {
  const all = [text, ...urls].join(' ');
  // Lookbehind: jangan cocokkan domain lain yang berakhiran x.com (okx.com, coinex.com, phemex.com)
  const re = /(?<![\w.-])(?:(?:www|mobile)\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(all))) if (!RESERVED.has(m[1].toLowerCase())) out.add(m[1].toLowerCase());
  return [...out];
}

// ---------- Template ----------
function fill(tpl, v) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
}
// Bergiliran: template yang baru dipakai untuk key ini dihindari dulu.
// strict (komentar): template yang sudah dipakai ke project yang sama dalam 24 jam tidak dipakai lagi,
// supaya tidak ada komentar kembar (X menganggapnya spam). null = template habis.
function pickTemplate(list, key, strict) {
  const recent = db.tplLog[key] || [];
  const turn = list.length > 1 ? recent.slice(1 - list.length).map((r) => r.tpl) : [];
  const today = strict ? recent.filter((r) => r.at > Date.now() - DAY).map((r) => r.tpl) : [];
  const pool = list.filter((t) => !today.includes(t));
  const fresh = pool.filter((t) => !turn.includes(t));
  const from = fresh.length ? fresh : pool;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}
const useTemplate = (key, tpl) => { db.tplLog[key] = [...(db.tplLog[key] || []).slice(-9), { at: Date.now(), tpl }]; };

// ---------- Antrian aksi X (tersimpan di data.json, lanjut setelah restart) ----------
let running = false;
const nextAt = {}; // brand -> paling cepat aksi berikutnya (jeda acak per akun)
const sentIn = (b, ms) => (db.sentAt[b] || []).filter((t) => t > Date.now() - ms).length;
const jobLabel = (j) => `${j.type === 'reply' ? 'Komentar ke' : 'Tweet tentang'} @${j.username} (${brandName(j.brand)})`;
const newestFirst = (a, b) => (BigInt(b.id ?? b.tweetId) > BigInt(a.id ?? a.tweetId) ? 1 : -1);
const lastReply = (h) => db.replyLog[h]?.at(-1) || 0;
const fmtSec = (s) => (s >= 60 ? `${+(s / 60).toFixed(1)} menit` : `${s} detik`);
const fmtGap = () => {
  const { minDelaySec: a, maxDelaySec: b } = db.limits;
  return a === b ? fmtSec(a) : `${fmtSec(a)}–${fmtSec(b)} (acak)`;
};
function canAct(b) {
  if (!clients[b] || isDown(b) || limited(b) || Date.now() < (nextAt[b] || 0)) return false;
  db.sentAt[b] = (db.sentAt[b] || []).filter((t) => t > Date.now() - DAY);
  return sentIn(b, 3600_000) < db.limits.maxPerHour && db.sentAt[b].length < db.limits.maxPerDay;
}
// Aksi berikutnya: akun yang sedang jeda/limit/dihentikan dan project yang masih dalam jeda dilewati
// (yang lain tetap jalan). Yang terbaru duluan — tweet terbaru project, juga setelah antrian menumpuk karena limit
function nextJob() {
  const gap = db.auto.replyGapMin * 60_000;
  return db.queue
    .filter((j) => canAct(j.brand) && (j.type !== 'reply' || Date.now() - lastReply(j.handle) >= gap))
    .sort((a, b) => b.at - a.at || (a.tweetId && b.tweetId ? newestFirst(a, b) : 0))[0];
}
function enqueue(job) {
  if (job.type === 'reply' && (db.repliedTweets.includes(job.tweetId) || db.queue.some((j) => j.tweetId === job.tweetId))) return;
  db.queue.push(job); save();
  runQueue();
}
async function runQueue() {
  if (running) return;
  running = true;
  await Promise.resolve(); // biarkan semua enqueue dari satu batch masuk dulu
  while (db.queue.length) {
    const orphan = db.queue.filter((j) => !db.brands[j.brand]?.x); // akun brand sudah dihapus
    if (orphan.length) {
      db.queue = db.queue.filter((j) => !orphan.includes(j)); save();
      await report(`🗑 ${orphan.length} aksi dibuang karena akun X brand-nya sudah dihapus`);
      continue;
    }
    if (db.paused) { await sleep(POLL); continue; }
    const job = nextJob();
    if (!job) {
      const soon = Object.values(nextAt).map((t) => t - Date.now()).filter((d) => d > 0);
      await sleep(Math.max(20, Math.min(POLL, ...soon)));
      continue;
    }
    let acted = true, retry = false;
    try {
      acted = (await runJob(job)) !== false;
      if (acted) failStreak[job.brand] = 0;
    } catch (e) {
      console.error('job error:', e);
      if (job.type === 'reply' && blockedByAuthor(e)) await stopProject(job, e);
      else if (job.type === 'reply' && cannotReply(e)) await replaceTweet(job, e);
      else retry = (await xError(e, jobLabel(job), job.brand)) && (job.tries = (job.tries || 0) + 1) < 3;
    }
    if (!retry && db.queue.includes(job)) db.queue.splice(db.queue.indexOf(job), 1);
    if (acted) {
      (db.sentAt[job.brand] ||= []).push(Date.now());
      nextAt[job.brand] = Date.now() + rand(db.limits.minDelaySec, db.limits.maxDelaySec) * 1000;
    }
    save();
  }
  running = false;
}

// Lewati tweet ini + sisa antrian project yang sama, dengan satu laporan
async function dropProject(j, why) {
  const rest = db.queue.filter((q) => q !== j && q.type === 'reply' && q.handle === j.handle);
  db.queue = db.queue.filter((q) => !rest.includes(q));
  await report(`ℹ️ @${esc(j.username)} ${esc(why)} — ${rest.length + 1} tweet dilewati`);
  return false;
}

// ---------- Tweet yang tidak bisa dibalas (bukan masalah akun) ----------
const errText = (e) => `${e?.data?.detail || ''} ${e?.data?.title || ''} ${e?.message || ''}`;
const blockedByAuthor = (e) => e?.code === 403 && /blocked/i.test(errText(e));
const cannotReply = (e) => [400, 403, 404].includes(e?.code) &&
  /reply to this conversation is not allowed|not allowed to reply|deleted or not visible|not found/i.test(errText(e));
const freshTweet = (t) => Date.now() - new Date(t.created_at) < db.filter.maxTweetAgeHours * 3600_000;
// Balasan "hanya akun yang di-mention" tidak mungkin dibalas, kecuali akun brand ikut di-mention
const canReplyTo = (t, brand) => t.reply_settings !== 'mentionedUsers' ||
  !!db.brands[brand]?.username && t.text.toLowerCase().includes('@' + db.brands[brand].username.toLowerCase());

// Project memblokir akun brand = tidak mau dikomentari lagi: opt-in brand itu dihentikan, tidak dicoba lewat akun lain
async function stopProject(j, e) {
  if (brandOf(db.optins[j.handle]) === j.brand) delete db.optins[j.handle];
  db.queue = db.queue.filter((q) => !(q.type === 'reply' && q.handle === j.handle));
  save();
  await report(`🚫 @${esc(j.username)} memblokir akun ${esc(brandLabel(j.brand))} — opt-in dihentikan, komentar ke project ini berhenti.\n${esc(e?.data?.detail || e.message)}`);
}

// Balasan dibatasi / tweet dihapus: akun yang SAMA pindah ke tweet terbaru lain dari project itu (maks. 3x per 24 jam)
async function replaceTweet(j, e) {
  const why = esc(e?.data?.detail || e.message);
  db.skippedTweets = [...db.skippedTweets.slice(-999), j.tweetId];
  const tries = (db.refills[j.handle] || []).filter((t) => t > Date.now() - DAY);
  save();
  if (!j.userId || tries.length >= 3) return report(`ℹ️ Tweet @${esc(j.username)} tidak bisa dibalas (${why}) — dilewati`);
  db.refills[j.handle] = [...tries, Date.now()];
  try {
    const tl = await clients[j.brand].v2.userTimeline(j.userId, {
      max_results: 10, exclude: ['replies', 'retweets'], 'tweet.fields': ['created_at', 'reply_settings']
    });
    const skip = new Set([...db.repliedTweets, ...db.skippedTweets, ...db.queue.map((q) => q.tweetId)]);
    const next = (tl.tweets || []).filter((t) => !skip.has(t.id) && freshTweet(t) && canReplyTo(t, j.brand)).sort(newestFirst)[0];
    if (!next) return report(`ℹ️ Tweet @${esc(j.username)} tidak bisa dibalas (${why}) dan tidak ada tweet lain yang bisa dikomentari`);
    await report(`↪️ Tweet @${esc(j.username)} tidak bisa dibalas (${why}) — pindah ke tweet berikutnya`);
    enqueue({ ...j, tweetId: next.id, tweetText: next.text, at: new Date(next.created_at).getTime(), tries: 0 });
  } catch (err) {
    await xError(err, `Cari tweet lain @${j.username}`, j.brand);
  }
}

// Kembalikan false kalau aksi dilewati (tidak dihitung ke batas & tanpa jeda)
async function runJob(j) {
  if (Date.now() - j.at > db.filter.maxTweetAgeHours * 3600_000) return false; // sudah basi di antrian
  const brand = db.brands[j.brand];
  const vars = { name: j.name, handle: j.username, channel: j.channel };
  const followBtn = Markup.button.url('👤 Follow', `https://x.com/intent/follow?screen_name=${j.username}`);
  const openBtn = (id) => Markup.button.url('🔗 Buka', `https://x.com/i/status/${id}`);

  if (j.type === 'reply') {
    // Cek ulang saat dieksekusi: project bisa saja opt-out / pindah brand selama antre
    const o = db.optins[j.handle];
    if (!o || brandOf(o) !== j.brand || db.repliedTweets.includes(j.tweetId)) return false;
    const log = (db.replyLog[j.handle] || []).filter((t) => t > Date.now() - DAY);
    if (log.length >= db.auto.maxRepliesPerProjectPerDay) {
      return dropProject(j, `sudah ${log.length} komentar dalam 24 jam (maxRepliesPerProjectPerDay)`);
    }
    const tpl = pickTemplate(brand.templates, j.handle, true);
    if (!tpl) return dropProject(j, `template komentar ${brand.name} sudah terpakai semua hari ini (tambah: /addtpl ${j.brand} teks)`);
    const body = fill(tpl, vars);
    const { data } = await clients[j.brand].v2.reply(body, j.tweetId);
    useTemplate(j.handle, tpl);
    db.repliedTweets = [...db.repliedTweets.slice(-999), j.tweetId];
    db.replyLog[j.handle] = [...log, Date.now()];
    stat('replies', j.brand);
    const when = j.t0 ? `${((Date.now() - j.t0) / 1000).toFixed(1)}s setelah post channel` : 'dari pantauan tweet baru project opt-in';
    await report(
      `✅ <b>Komentar terkirim</b> · ${esc(brandLabel(j.brand))}\nProject: <b>@${esc(j.username)}</b>\nSumber: ${esc(j.source || j.channel)}\n` +
      `Tweet: "${esc(j.tweetText.slice(0, 90))}…"\nKomentar: "${esc(body)}"\n<i>${when}</i>`,
      [[followBtn, openBtn(data.id)]]
    );
    return true;
  }

  // Belum opt-in -> akun brand tweet sendiri (tanpa reply ke project)
  if (!brand.ownTweetEnabled) return false;
  const tpl = pickTemplate(brand.tweetTemplates, '#' + j.brand, false);
  if (!tpl) return false;
  const body = fill(tpl, vars);
  const { data } = await clients[j.brand].v2.tweet(body);
  useTemplate('#' + j.brand, tpl);
  stat('tweets', j.brand);
  await report(
    `🐦 <b>Tweet ${esc(brandLabel(j.brand))}</b> tentang <b>@${esc(j.username)}</b> (belum opt-in)\nSumber: ${esc(j.channel)}\n"${esc(body)}"`,
    [[followBtn, openBtn(data.id)]]
  );
  return true;
}

// ---------- Proses satu project ----------
const inFlight = new Set();
async function processProject(handle, channelName, t0, brand) {
  const x = clients[brand];
  if (!x) return report(`⚠️ Akun X ${esc(brandName(brand))} belum diatur. Pakai /addaccount ${brand} ... di DM bot.`);
  const f = db.filter;
  const last = db.history[handle]; // cooldown berlaku untuk semua brand: satu project tidak di-tweet dua akun
  if (inFlight.has(handle) || (last && Date.now() - last < f.cooldownDays * DAY)) return;
  inFlight.add(handle);
  try {
    const { data: user } = await x.v2.userByUsername(handle, {
      'user.fields': ['public_metrics', 'created_at', 'description', 'name']
    });
    if (!user) return report(`⛔ <b>@${esc(handle)}</b> tidak ditemukan di X`);

    // Filter
    const ageDays = (Date.now() - new Date(user.created_at)) / DAY;
    const followers = user.public_metrics?.followers_count ?? 0;
    const text = `${user.name} ${user.description}`.toLowerCase();
    const bad = f.blacklist.find((w) => w && text.includes(w.toLowerCase()));
    let why = null;
    if (followers < f.minFollowers) why = `followers ${followers} < ${f.minFollowers}`;
    else if (ageDays < f.minAgeDays) why = `umur akun ${Math.floor(ageDays)} hari < ${f.minAgeDays}`;
    else if (bad) why = `kata terlarang "${bad}"`;
    if (why) {
      db.history[handle] = Date.now(); stat('skipped');
      return report(`⛔ <b>@${esc(handle)}</b> di-skip — ${esc(why)}\nSumber: ${esc(channelName)}`);
    }

    const base = { handle, username: user.username, name: user.name, channel: channelName, brand };
    if (db.optins[handle]) {
      // Project opt-in -> komentar otomatis dari akun brand pilihan project
      const tl = await x.v2.userTimeline(user.id, {
        max_results: Math.min(100, Math.max(5, f.tweetsPerProject)), exclude: ['replies', 'retweets'],
        'tweet.fields': ['created_at', 'reply_settings']
      });
      db.history[handle] = Date.now(); save(); // dicatat setelah timeline sukses, supaya bisa diulang kalau gagal
      const maxAge = f.maxTweetAgeHours * 3600_000;
      const tweets = (tl.tweets || [])
        .filter((t) => Date.now() - new Date(t.created_at) < maxAge && canReplyTo(t, brand))
        .sort(newestFirst)
        .slice(0, f.tweetsPerProject); // hanya tweet terbaru
      if (!tweets.length) return report(`ℹ️ <b>@${esc(handle)}</b> (opt-in) tidak punya tweet baru ≤ ${f.maxTweetAgeHours} jam`);
      for (const tw of tweets) {
        enqueue({ ...base, type: 'reply', userId: user.id, tweetId: tw.id, tweetText: tw.text, at: new Date(tw.created_at).getTime(), t0 });
      }
    } else {
      db.history[handle] = Date.now(); save();
      if (db.brands[brand].ownTweetEnabled) enqueue({ ...base, type: 'tweet', at: Date.now() });
      else await report(`ℹ️ <b>@${esc(handle)}</b> belum opt-in — dilewati (tweet ${esc(brandName(brand))} OFF)\nSumber: ${esc(channelName)}`,
        [[Markup.button.url('👤 Follow', `https://x.com/intent/follow?screen_name=${user.username}`)]]);
    }
  } finally {
    inFlight.delete(handle);
  }
}

// Project opt-in diurus akun brand pilihannya, selain itu akun brand channel.
// Tunggu rate limit akun itu selesai, ulangi kalau error jaringan / server X
async function processSafe(handle, channelName, t0, chBrand) {
  for (let tries = 0; tries < 3; tries++) {
    const brand = db.optins[handle] ? brandOf(db.optins[handle]) : chBrand;
    if (isDown(brand)) return reportOnce(`down|${brand}`, `⏭ Project dilewati karena akun ${esc(brandLabel(brand))} sedang dihentikan (/resume ${brand})`);
    while (limited(brand)) await sleep(POLL);
    try {
      return await processProject(handle, channelName, t0, brand);
    } catch (e) {
      console.error(e);
      if (!(await xError(e, `Proses @${handle}`, brand))) return;
      if (!limited(brand)) await sleep(Math.min(30_000, TICK));
    }
  }
}

// ---------- Listener channel Telegram ----------
// Tanpa TG_API_ID/TG_API_HASH/TG_SESSION: mode bot saja — bot membaca post dari channel tempat dia jadi admin.
// Dengan ketiganya: akun Telegram biasa (listener) membaca channel orang lain yang sudah di-join.
const LISTENER = !!(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);
const NOT_READ = LISTENER ? 'belum join' : 'bot belum admin';
let tg = null;
let tgDown = false;
let missing = []; // channel di db.channels yang belum bisa dibaca
const targets = new Map(); // channel di db.channels -> entity Telegram
const chanKeys = (chat) => [
  chat.username && '@' + chat.username.toLowerCase(),
  ...(chat.usernames || []).map((u) => '@' + u.username.toLowerCase()),
  `-100${chat.id}`, String(chat.id)
].filter(Boolean);
const matchChannel = (chat) => db.channels.find((c) => chanKeys(chat).includes(c.toLowerCase()));

// Dipakai listener live dan catch-up; lastSeen mencegah post diproses dua kali
function onChannelPost(msg, chat, t0, ch) {
  const key = String(chat.id);
  if (msg.id <= (db.lastSeen[key] || 0)) return false;
  db.lastSeen[key] = msg.id; save();
  if (db.paused) return false;
  const urls = (msg.entities || []).map((e) => e.url).filter(Boolean);
  for (const h of extractHandles(msg.message || '', urls)) processSafe(h, chat.title || chat.username, t0, channelBrand(ch));
  return true;
}

// Mode bot saja: post channel datang lewat Bot API. Post yang masuk saat bot mati disimpan Telegram
// sampai 24 jam, jadi tetap diproses saat bot hidup lagi (maks. catchUpMaxAgeHours)
function botChannelPost(post) {
  const ch = matchChannel(post.chat);
  if (!ch) return;
  const at = post.date * 1000;
  const key = String(post.chat.id);
  if (Date.now() - at > db.auto.catchUpMaxAgeHours * 3600_000) {
    db.lastSeen[key] = Math.max(db.lastSeen[key] || 0, post.message_id); save();
    return;
  }
  const msg = { id: post.message_id, message: post.text || post.caption || '', entities: post.entities || post.caption_entities };
  onChannelPost(msg, post.chat, Date.now() - at > 60_000 ? at : Date.now(), ch);
}

async function startListener() {
  tg = new TelegramClient(
    new StringSession(process.env.TG_SESSION || ''),
    Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 10 }
  );
  await tg.connect();
  if (!(await tg.checkAuthorization())) throw new Error('TG_SESSION belum valid. Jalankan: npm run login');

  tg.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg?.isChannel) return;
      const chat = await msg.getChat();
      const ch = chat && matchChannel(chat);
      if (ch) onChannelPost(msg, chat, Date.now(), ch);
    } catch (e) {
      console.error('listener error:', e);
    }
  }, new NewMessage({}));
  console.log('Listener Telegram aktif');
}

// Cocokkan db.channels dengan channel yang bisa dibaca: di-join akun listener, atau bot jadi admin (mode bot saja)
async function refreshChannels() {
  const before = new Set(targets.keys());
  targets.clear();
  if (LISTENER) {
    for (const d of await tg.getDialogs({})) {
      if (!d.isChannel || !d.entity) continue;
      for (const c of db.channels) if (chanKeys(d.entity).includes(c.toLowerCase())) targets.set(c, d.entity);
    }
    // Channel baru dipantau mulai dari post terakhir, post lama tidak diproses
    for (const e of targets.values()) {
      const key = String(e.id);
      if (db.lastSeen[key]) continue;
      const [last] = await tg.getMessages(e, { limit: 1 });
      db.lastSeen[key] = last?.id || 0;
    }
  } else {
    bot.botInfo ??= await bot.telegram.getMe();
    for (const c of db.channels) {
      try {
        const chat = await bot.telegram.getChat(c);
        const m = await bot.telegram.getChatMember(chat.id, bot.botInfo.id);
        if (['administrator', 'creator'].includes(m.status)) targets.set(c, chat);
      } catch {} // channel tidak ada / bot bukan anggota
    }
  }
  save();
  missing = db.channels.filter((c) => !targets.has(c));
  return [...targets.keys()].filter((c) => !before.has(c)); // yang baru terpantau
}

// Ambil post yang terlewat (bot mati, koneksi putus) + sambung ulang listener
async function catchUp() {
  if (!LISTENER) return; // mode bot saja: Telegram sendiri yang mengirim ulang post yang tertunda
  try {
    if (!tg.connected) await tg.connect();
    const minDate = Date.now() / 1000 - db.auto.catchUpMaxAgeHours * 3600;
    let n = 0;
    for (const [name, e] of targets) {
      const key = String(e.id);
      const msgs = await tg.getMessages(e, { minId: db.lastSeen[key] || 0, limit: 50 });
      for (const m of [...msgs].sort((a, b) => a.id - b.id)) {
        if (m.date < minDate) { db.lastSeen[key] = Math.max(db.lastSeen[key] || 0, m.id); continue; }
        if (onChannelPost(m, e, m.date * 1000, name)) { n++; console.log(`catch-up ${name} #${m.id}`); }
      }
    }
    save();
    if (n) await report(`📥 ${n} post channel yang terlewat diproses otomatis`);
    if (tgDown) { tgDown = false; await report('🔌 Listener Telegram tersambung lagi'); }
  } catch (e) {
    console.error('catch-up error:', e);
    if (!tgDown) { tgDown = true; await report(`⚠️ Listener Telegram bermasalah: ${esc(e.message)} — dicoba ulang otomatis`); }
  }
}

// ---------- Pantau tweet baru project opt-in (tanpa menunggu post channel) ----------
const maxId = (a, b) => (!a ? b : !b ? a : BigInt(a) > BigInt(b) ? a : b);
const idTime = (id) => Number(BigInt(id) >> 22n) + 1288834974657; // waktu dari ID tweet
// Tiap akun memantau project yang opt-in ke brand-nya sendiri
async function watchOptins() {
  if (!db.auto.watchOptins || db.paused) return;
  for (const brand of activeBrands()) {
    const handles = Object.keys(db.optins).filter((h) => brandOf(db.optins[h]) === brand);
    if (!handles.length || limited(brand) || isDown(brand)) continue;
    try {
      await watchBrand(brand, handles);
    } catch (e) {
      console.error('watch error:', e);
      await xError(e, `Pantau tweet opt-in ${brandName(brand)}`, brand);
    }
  }
}
async function watchBrand(brand, handles) {
  // Satu pencarian untuk banyak project sekaligus (query maks. 512 karakter)
  const q = (hs) => `(${hs.map((h) => 'from:' + h).join(' OR ')}) -is:reply -is:retweet`;
  const queries = [];
  let cur = [];
  for (const h of handles) {
    if (cur.length && q([...cur, h]).length > 512) { queries.push(q(cur)); cur = []; }
    cur.push(h);
  }
  queries.push(q(cur));

  // since_id hanya berlaku 7 hari; kalau bot lama mati, mulai dari sekarang saja
  const saved = db.watchSinceId[brand];
  const since = saved && Date.now() - idTime(saved) < 6 * DAY ? saved : null;
  const maxAge = db.filter.maxTweetAgeHours * 3600_000;
  let newest = since;
  for (const query of queries) {
    const res = await clients[brand].v2.search(query, {
      max_results: 100,
      'tweet.fields': ['created_at', 'author_id', 'reply_settings'],
      expansions: ['author_id'],
      'user.fields': ['username', 'name'],
      ...(since ? { since_id: since } : { start_time: new Date(Date.now() - db.auto.watchIntervalMin * 60_000).toISOString() })
    });
    newest = maxId(newest, res.meta?.newest_id);
    const users = new Map((res.includes?.users || []).map((u) => [u.id, u]));
    const perProject = new Map();
    for (const tw of res.tweets || []) {
      const u = users.get(tw.author_id);
      const at = new Date(tw.created_at).getTime();
      if (!u || brandOf(db.optins[u.username.toLowerCase()]) !== brand || !db.optins[u.username.toLowerCase()]) continue;
      if (Date.now() - at > maxAge || !canReplyTo(tw, brand)) continue;
      perProject.set(u, [...(perProject.get(u) || []), { ...tw, at }]);
    }
    // Project yang tweet banyak sekaligus: hanya tweetsPerProject tweet terbaru
    for (const [u, tweets] of perProject) {
      for (const tw of tweets.sort(newestFirst).slice(0, db.filter.tweetsPerProject)) {
        enqueue({
          type: 'reply', brand, handle: u.username.toLowerCase(), username: u.username, name: u.name, channel: '',
          source: 'tweet baru (pantauan opt-in)', userId: u.id, tweetId: tw.id, tweetText: tw.text, at: tw.at
        });
      }
    }
  }
  if (newest !== db.watchSinceId[brand]) { db.watchSinceId[brand] = newest; save(); }
}

// ---------- Opt-in: verifikasi bio otomatis ----------
async function activateOptin(handle, p, via) {
  const brand = brandOf(p);
  db.optins[handle] = { at: Date.now(), via, by: p.by, brand };
  delete db.pending[handle];
  stat('optins', brand);
  await report(`🆕 <b>Opt-in baru</b>: @${esc(handle)} → ${esc(brandLabel(brand))} (${via === 'verify' ? 'verifikasi bio' : 'verifikasi bio otomatis'})`);
}
async function autoVerify() {
  const rb = readerBrand();
  if (!rb || !db.auto.autoVerify) return;
  for (const [h, p] of Object.entries(db.pending)) {
    p.at ||= Date.now(); // data lama tanpa waktu
    if (Date.now() - p.at > db.auto.pendingExpireDays * DAY) {
      delete db.pending[h];
      bot.telegram.sendMessage(p.by, `⌛ Kode opt-in @${h} kedaluwarsa. Ulangi dengan /optin @${h}`).catch(() => {});
    }
  }
  save();
  // Maks. 100 per panggilan X; utamakan yang terbaru
  const handles = Object.entries(db.pending).filter(([h]) => validHandle(h))
    .sort((a, b) => b[1].at - a[1].at).slice(0, 100).map(([h]) => h);
  if (!handles.length || limited(rb)) return;
  let data = [];
  try {
    ({ data = [] } = await clients[rb].v2.usersByUsernames(handles, { 'user.fields': ['description'] }));
  } catch (e) {
    return xError(e, 'Verifikasi opt-in otomatis', rb);
  }
  for (const u of data) {
    const h = u.username.toLowerCase();
    const p = db.pending[h];
    if (!p || !u.description?.includes(p.code)) continue;
    await activateOptin(h, p, 'auto-verify');
    bot.telegram.sendMessage(p.by, `✅ @${h} terverifikasi otomatis & opt-in ${brandName(brandOf(p))} aktif. Kode boleh dihapus dari bio.`).catch(() => {});
  }
}

// ---------- Ringkasan harian + backup + bersih-bersih ----------
async function dailyTasks() {
  const now = new Date();
  if (db.lastDaily === now.toDateString() || now.getHours() < db.auto.dailyReportHour) return;
  db.lastDaily = now.toDateString();
  lastErr.clear();
  for (const [h, t] of Object.entries(db.history)) if (Date.now() - t > db.filter.cooldownDays * DAY) delete db.history[h];
  for (const [h, log] of Object.entries(db.replyLog)) {
    const l = log.filter((t) => t > Date.now() - DAY);
    if (l.length) db.replyLog[h] = l; else delete db.replyLog[h];
  }
  for (const [k, log] of Object.entries(db.tplLog)) if (!k.startsWith('#') && log.at(-1).at < Date.now() - 7 * DAY) delete db.tplLog[k];
  const file = backup();
  const s = db.stats;
  const perBrand = await Promise.all(Object.keys(db.brands).map(async (b) =>
    `${esc(brandName(b))}: ${esc(await accountStatus(b))} · ${s[`replies:${b}`] || 0} komentar · ${s[`tweets:${b}`] || 0} tweet`));
  await report(
    `📊 <b>Ringkasan harian</b>\nKomentar terkirim: ${s.replies || 0}\nTweet bot: ${s.tweets || 0}\n` +
    `Di-skip filter: ${s.skipped || 0}\nOpt-in baru: ${s.optins || 0}\nError: ${s.errors || 0}\n\n` +
    `<b>Akun X</b>\n${perBrand.join('\n')}\n\nChannel terpantau: ${targets.size}/${db.channels.length}` +
    `${missing.length ? ` (${NOT_READ}: ${esc(missing.join(', '))})` : ''}\n` +
    `Opt-in aktif: ${Object.keys(db.optins).length}\nAntrian: ${db.queue.length}\nBackup: ${esc(file)}`
  );
  db.stats = {}; save();
}

// ---------- Penjadwal tugas otomatis ----------
let ticks = 0, ticking = false;
const every = (min) => ticks % Math.max(1, Math.round(min)) === 0;
async function tick() {
  if (ticking) return;
  ticking = true; ticks++;
  for (const [b, until] of Object.entries(db.pausedUntil)) {
    if (!until || Date.now() < until) continue;
    delete db.pausedUntil[b]; save();
    const n = db.queue.filter((j) => j.brand === b).length;
    await report(`▶️ Rate limit X akun ${esc(brandLabel(b))} selesai — jalan lagi otomatis` +
      `${n ? `, ${n} aksi antre dilanjutkan mulai dari yang terbaru` : ''}.`);
    runQueue();
  }
  const tasks = [
    [every(db.auto.catchUpMin), catchUp, 'Catch-up channel'],
    [every(db.auto.watchIntervalMin), watchOptins, 'Pantau tweet opt-in'],
    [every(db.auto.verifyIntervalMin), autoVerify, 'Verifikasi opt-in otomatis'],
    [every(targets.size < db.channels.length ? 30 : 360), async () => {
      const joined = await refreshChannels();
      if (joined.length) await report(`✅ ${LISTENER ? 'Listener sudah join' : 'Bot sudah admin di'} ${esc(joined.join(', '))} — mulai dipantau`);
    }, 'Cek channel'],
    [true, dailyTasks, 'Ringkasan harian']
  ];
  for (const [due, fn, label] of tasks) {
    if (!due) continue;
    try { await fn(); } catch (e) { console.error(label, e); await xError(e, label); }
  }
  ticking = false;
}

// ---------- Perintah bot ----------
const HELP = `<b>Fourtis X Agent</b>
Paling mudah: /menu — semua pengaturan pakai tombol

<b>Akun X (1 akun per brand)</b>
/addaccount brand APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET
/accounts — semua brand & akun · /delaccount brand
/setx ... — sama dengan /addaccount untuk brand utama

<b>Channel</b>
/addchannel @channel [brand] · /delchannel @channel · /channels
/setreport — jalankan di channel laporan

<b>Template per brand</b> (variabel: {name} {handle} {channel})
/tpls [brand] — lihat
/addtpl [brand] teks · /deltpl [brand] nomor — komentar
/addtweet [brand] teks · /deltweet [brand] nomor — tweet bot
/tweet on|off [brand] — tweet bot untuk project belum opt-in

<b>Opt-in</b>
/optins · /addoptin @handle [brand] · /deloptin @handle

<b>Filter & batas</b>
/filter — lihat · /filter minFollowers 500
/limits — lihat · /limits maxPerHour 20 (per akun)
/filter tweetsPerProject 3 — jumlah tweet terbaru yang dikomentari
/jeda — lihat · /jeda 5 · /jeda 3 6 (acak) · /jeda project 10

<b>Otomatis</b>
/auto — lihat · /auto watchOptins false · /auto dailyReportHour 8

/pause · /resume · /resume brand · /status

<b>Untuk project</b>: /optin @handle [brand] (verifikasi otomatis, atau /verify @handle)`;

bot.start((ctx) => {
  if (isAdmin(ctx)) {
    setAdminCommands(ctx.chat.id);
    return showPanel(ctx, homePanel(), false);
  }
  const names = activeBrands().map(brandName).join(' / ') || 'kami';
  return ctx.reply(`Hi! Mau tweet project kamu otomatis di-boost oleh ${names}?\nKetik /optin @handle_x_project_kamu`);
});
bot.command('help', (ctx) => isAdmin(ctx) && ctx.replyWithHTML(HELP));

// Opt-in publik dengan verifikasi bio, ke satu brand pilihan project
async function startOptin(ctx, handle, brand) {
  if (!validHandle(handle)) return ctx.reply('Handle X tidak valid. Contoh: /optin @namaproject');
  if (db.optins[handle]) return ctx.reply(`Project ini sudah opt-in ke ${brandName(brandOf(db.optins[handle]))} ✅`);
  const mine = Object.entries(db.pending).filter(([k, p]) => p.by === ctx.from.id && k !== handle).length;
  if (mine >= 3 && !isAdmin(ctx)) return ctx.reply('Maksimal 3 opt-in menunggu verifikasi. Selesaikan yang lain dulu.');
  const prefix = brand === 'fourtis' ? 'FTS' : brand.slice(0, 3).toUpperCase();
  const code = `${prefix}-` + Math.random().toString(36).slice(2, 8).toUpperCase();
  db.pending[handle] = { code, by: ctx.from.id, at: Date.now(), brand }; save();
  return ctx.replyWithHTML(
    `Opt-in @${esc(handle)} ke <b>${esc(brandLabel(brand))}</b>:\n1. Tambahkan kode <code>${code}</code> ke bio X kamu\n` +
    `2. Bot mengecek bio otomatis tiap ${db.auto.verifyIntervalMin} menit (atau ketik /verify @${esc(handle)} untuk cek sekarang)\n` +
    `3. Setelah terverifikasi, kode boleh dihapus dari bio.\n\n` +
    `Dengan opt-in, kamu setuju akun ${esc(brandLabel(brand))} berkomentar otomatis di tweet project kamu. Batalkan kapan saja dengan /optout @${esc(handle)}`
  );
}
bot.command('optin', async (ctx) => {
  const [, h, b] = ctx.message.text.split(/\s+/);
  if (!h) return ctx.reply('Format: /optin @handle_x');
  const handle = norm(h);
  if (!validHandle(handle)) return ctx.reply('Handle X tidak valid. Contoh: /optin @namaproject');
  const avail = activeBrands();
  if (!avail.length) return ctx.reply('Belum ada akun aktif. Coba lagi nanti.');
  if (b && !avail.includes(b.toLowerCase())) return ctx.reply(`Brand tidak dikenal. Pilihan: ${avail.join(', ')}`);
  const brand = b ? b.toLowerCase() : avail.length === 1 ? avail[0] : null;
  if (brand) return startOptin(ctx, handle, brand);
  if (db.optins[handle]) return ctx.reply(`Project ini sudah opt-in ke ${brandName(brandOf(db.optins[handle]))} ✅`);
  return ctx.reply(`Opt-in @${handle} ke brand mana?`,
    Markup.inlineKeyboard(avail.map((x) => Markup.button.callback(brandName(x), `optin:${x}:${handle}`))));
});
bot.action(/^optin:([a-z0-9_]+):([a-z0-9_]{1,15})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const [, brand, handle] = ctx.match;
  if (!clients[brand]) return ctx.reply('Brand ini belum aktif.');
  return startOptin(ctx, handle, brand);
});

bot.command('verify', async (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  const handle = norm(h || '');
  const p = db.pending[handle];
  const x = p && (clients[brandOf(p)] || clients[readerBrand()]);
  if (!h || !activeBrands().length) return ctx.reply('Format: /verify @handle_x');
  if (!p || p.by !== ctx.from.id) return ctx.reply('Mulai dulu dengan /optin @' + handle);
  const { data: u } = await x.v2.userByUsername(handle, { 'user.fields': ['description'] }).catch(() => ({}));
  if (!u?.description?.includes(p.code)) return ctx.reply(`Kode ${p.code} belum ditemukan di bio @${handle}. Coba lagi setelah bio di-update.`);
  ctx.reply(`✅ @${handle} terverifikasi & opt-in ${brandName(brandOf(p))} aktif.`);
  await activateOptin(handle, p, 'verify');
});

bot.command('optout', (ctx) => {
  const handle = norm(ctx.message.text.split(/\s+/)[1] || '');
  const o = db.optins[handle];
  if (!o || (o.by !== ctx.from.id && !isAdmin(ctx))) return ctx.reply('Tidak ditemukan.');
  delete db.optins[handle]; save();
  ctx.reply(`@${handle} sudah opt-out.`);
  report(`➖ Opt-out: @${esc(handle)} (${esc(brandName(brandOf(o)))})`);
});

// Semua perintah di bawah hanya admin
bot.use((ctx, next) => {
  const t = ctx.message?.text || ctx.channelPost?.text || '';
  if (!t.startsWith('/')) return next();
  if (ctx.channelPost && t.startsWith('/setreport')) return next();
  if (!isAdmin(ctx)) return;
  return next();
});

// Panel: bot sedang menunggu balasan teks dari admin (key X, channel, template, ...). Perintah apa pun membatalkannya
bot.on('text', (ctx, next) => {
  const a = ctx.chat?.type === 'private' && awaiting.get(ctx.from.id);
  if (!a) return next();
  awaiting.delete(ctx.from.id);
  if (ctx.message.text.startsWith('/') || Date.now() - a.at > 10 * 60_000) return next();
  return handleInput(ctx, a);
});

// ---------- Akun X per brand ----------
async function setAccount(ctx, brand, keys) {
  try { await ctx.deleteMessage(); } catch {}
  if (!brand || keys.length < 4 || keys.some((k) => !k)) {
    return ctx.reply('Format: /addaccount brand APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET\nContoh brand: fourtis, dexvra');
  }
  if (!/^[a-z0-9_]{2,20}$/.test(brand)) return ctx.reply('Nama brand: huruf kecil/angka tanpa spasi, contoh: dexvra');
  const [appKey, appSecret, accessToken, accessSecret] = keys;
  const creds = { appKey, appSecret, accessToken, accessSecret };
  const hadKeys = !!db.brands[brand]?.x;
  let me;
  try {
    ({ data: me } = await new TwitterApi(creds).readWrite.v2.me());
  } catch (e) {
    return ctx.reply('❌ Key tidak valid: ' + (e?.data?.detail || e.message) + (hadKeys ? '\nKey lama tetap dipakai.' : ''));
  }
  // Satu akun X hanya untuk satu brand (dua brand di satu akun = konten dobel)
  const dup = Object.entries(db.brands).find(([b, v]) => b !== brand && v.x && v.username?.toLowerCase() === me.username.toLowerCase());
  if (dup) return ctx.reply(`❌ @${me.username} sudah dipakai brand ${brandName(dup[0])}. Satu akun X hanya untuk satu brand.`);
  const isNew = !db.brands[brand];
  db.brands[brand] ||= newBrand(brand);
  Object.assign(db.brands[brand], { x: creds, username: me.username });
  delete db.brandDown[brand]; failStreak[brand] = 0;
  initClients(); save();
  ctx.reply(
    `✅ Akun X ${brandName(brand)} ${hadKeys ? 'diganti' : 'tersambung'}: @${me.username}\n(pesan berisi key sudah dihapus)` +
    (isNew ? `\n\nBrand baru "${brand}" dibuat dengan template contoh. Ganti dengan /addtpl ${brand} ... dan /addtweet ${brand} ...` : '')
  );
  runQueue();
}
bot.command('addaccount', (ctx) => {
  const [, brand, ...keys] = ctx.message.text.split(/\s+/);
  return setAccount(ctx, brand?.toLowerCase(), keys);
});
bot.command('setx', (ctx) => setAccount(ctx, db.defaultBrand, ctx.message.text.split(/\s+/).slice(1)));
function delAccount(b) {
  Object.assign(db.brands[b], { x: null, username: null });
  initClients(); save();
  runQueue();
  return `Akun X ${brandName(b)} dihapus. Template & opt-in brand ini tetap disimpan; tambah akun lagi dengan /addaccount ${b} ...`;
}
bot.command('delaccount', (ctx) => {
  const b = findBrand(ctx.message.text.split(/\s+/)[1]);
  if (!b || !db.brands[b].x) return ctx.reply('Format: /delaccount brand (lihat /accounts)');
  ctx.reply(delAccount(b));
});
bot.command(['accounts', 'xstatus'], async (ctx) => {
  const lines = await Promise.all(Object.entries(db.brands).map(async ([b, v]) => {
    const chs = db.channels.filter((c) => channelBrand(c) === b).length;
    const ops = Object.values(db.optins).filter((o) => brandOf(o) === b).length;
    return `<b>${esc(v.name)}</b> (${b})${b === db.defaultBrand ? ' · utama' : ''}\nAkun X: ${esc(await accountStatus(b))}\n` +
      `Channel: ${chs} · Opt-in: ${ops} · Template: ${v.templates.length} komentar, ${v.tweetTemplates.length} tweet` +
      ` · Tweet bot: ${v.ownTweetEnabled ? 'ON' : 'OFF'}`;
  }));
  save();
  ctx.replyWithHTML(lines.join('\n\n') + '\n\nTambah/ganti akun: /addaccount brand APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET');
});

// ---------- Channel ----------
async function addChannel(c, b) {
  const key = c.toLowerCase();
  if (!db.channels.includes(key)) db.channels.push(key);
  if (b) db.channelBrand[key] = b;
  save();
  await refreshChannels().catch((e) => console.error('refreshChannels:', e));
  const brand = brandName(channelBrand(key));
  return targets.has(key)
    ? `✅ ${c} → ${brand} ditambahkan & sudah dipantau.`
    : LISTENER
      ? `⚠️ ${c} → ${brand} ditambahkan, tapi akun listener BELUM join channel ini. Join dulu — bot cek ulang otomatis tiap 30 menit.`
      : `⚠️ ${c} → ${brand} ditambahkan, tapi bot BELUM jadi admin di channel ini. Jadikan bot admin dulu — bot cek ulang otomatis tiap 30 menit.`;
}
function delChannel(c) {
  db.channels = db.channels.filter((x) => x !== c); delete db.channelBrand[c];
  targets.delete(c); missing = missing.filter((m) => m !== c);
  save();
}
bot.command('addchannel', async (ctx) => {
  const [, c, b] = ctx.message.text.split(/\s+/);
  if (!c) return ctx.reply('Format: /addchannel @channel [brand]  (atau -100xxxxxxxx)');
  if (b && !findBrand(b)) return ctx.reply(`Brand "${b}" tidak ada. Pilihan: ${Object.keys(db.brands).join(', ')}`);
  ctx.reply(await addChannel(c, findBrand(b)));
});
bot.command('delchannel', (ctx) => {
  delChannel((ctx.message.text.split(/\s+/)[1] || '').toLowerCase());
  ctx.reply('Dihapus.');
});
bot.command('channels', (ctx) => ctx.reply(db.channels.length
  ? db.channels.map((c) => `${targets.has(c) ? '✅' : `⚠️ ${NOT_READ}`} ${c} → ${brandName(channelBrand(c))}`).join('\n')
  : 'Belum ada channel.'));

bot.command('setreport', (ctx) => {
  const arg = ctx.message?.text.split(/\s+/)[1];
  db.reportChat = arg || ctx.chat.id; save();
  bot.telegram.sendMessage(db.reportChat, '📊 Channel laporan aktif.').catch((e) => console.error(e.message));
});
bot.on('channel_post', async (ctx, next) => {
  if (ctx.channelPost.text?.startsWith('/setreport')) {
    // Post channel tidak membawa pengirim: pastikan salah satu ADMIN_IDS adalah admin channel ini
    const admins = await ctx.getChatAdministrators().catch(() => []);
    if (!admins.some((a) => ADMINS.includes(String(a.user.id)))) return;
    db.reportChat = ctx.chat.id; save();
    return ctx.reply('📊 Channel laporan aktif.');
  }
  if (!LISTENER) botChannelPost(ctx.channelPost);
  return next();
});

// ---------- Template per brand ----------
// Kata pertama = nama brand kalau cocok, selain itu brand utama. Baris baru di template tetap dipertahankan
function brandAndText(ctx, cmd) {
  const rest = ctx.message.text.replace(new RegExp(`^/${cmd}(@\\w+)?\\s*`), '');
  const m = rest.match(/^(\S+)\s*([\s\S]*)$/);
  const b = m && findBrand(m[1]);
  return b ? [b, m[2].trim()] : [db.defaultBrand, rest.trim()];
}
function tplAdd(b, field, t) {
  db.brands[b][field].push(t); save();
  return `✅ Template ${field === 'templates' ? 'komentar' : 'tweet'} ${brandName(b)} #${db.brands[b][field].length}:\n${t}`;
}
function tplDel(b, field, n) {
  const list = db.brands[b]?.[field];
  if (!list?.[n - 1]) return `Nomor tidak ada. Lihat /tpls ${b}`;
  if (list.length === 1) return 'Minimal harus ada 1 template.';
  list.splice(n - 1, 1); save();
  return `Dihapus dari ${brandName(b)}.`;
}
function addTemplate(ctx, cmd, field) {
  const [b, t] = brandAndText(ctx, cmd);
  if (!t) return ctx.reply(`Format: /${cmd} [brand] teks dengan {name}`);
  ctx.reply(tplAdd(b, field, t));
}
function delTemplate(ctx, cmd, field) {
  const [b, t] = brandAndText(ctx, cmd);
  ctx.reply(tplDel(b, field, Number(t)));
}
bot.command('addtpl', (ctx) => addTemplate(ctx, 'addtpl', 'templates'));
bot.command('deltpl', (ctx) => delTemplate(ctx, 'deltpl', 'templates'));
bot.command('addtweet', (ctx) => addTemplate(ctx, 'addtweet', 'tweetTemplates'));
bot.command('deltweet', (ctx) => delTemplate(ctx, 'deltweet', 'tweetTemplates'));
bot.command('tpls', (ctx) => {
  const b = findBrand(ctx.message.text.split(/\s+/)[1]);
  const show = (k) => {
    const v = db.brands[k];
    const list = (l) => l.map((t, i) => `${i + 1}. ${t}`).join('\n');
    return `== ${v.name} ==\nKomentar:\n${list(v.templates)}\n\nTweet bot (${v.ownTweetEnabled ? 'ON' : 'OFF'}):\n${list(v.tweetTemplates)}`;
  };
  ctx.reply((b ? [b] : Object.keys(db.brands)).map(show).join('\n\n'));
});
bot.command('tweet', (ctx) => {
  const [, v, b] = ctx.message.text.split(/\s+/);
  if (v !== 'on' && v !== 'off') return ctx.reply('Format: /tweet on|off [brand]');
  if (b && !findBrand(b)) return ctx.reply(`Brand "${b}" tidak ada.`);
  const list = b ? [findBrand(b)] : Object.keys(db.brands);
  for (const k of list) db.brands[k].ownTweetEnabled = v === 'on';
  save();
  ctx.reply(`Tweet bot untuk project belum opt-in: ${v.toUpperCase()} (${list.map(brandName).join(', ')})`);
});

// ---------- Opt-in (admin) ----------
bot.command('optins', (ctx) => {
  const list = Object.entries(db.optins);
  const pending = Object.entries(db.pending);
  ctx.reply((list.length ? `Opt-in (${list.length}):\n` + list.map(([h, o]) => `@${h} → ${brandName(brandOf(o))}`).join('\n') : 'Belum ada.') +
    (pending.length ? `\n\nMenunggu verifikasi bio (${pending.length}):\n` + pending.map(([h, p]) => `@${h} → ${brandName(brandOf(p))}`).join('\n') : ''));
});
bot.command('addoptin', (ctx) => {
  const [, h, b] = ctx.message.text.split(/\s+/);
  if (!h) return ctx.reply('Format: /addoptin @handle [brand] — hanya untuk project yang sudah setuju (mis. paket listing)');
  if (!validHandle(norm(h))) return ctx.reply('Handle X tidak valid.');
  if (b && !findBrand(b)) return ctx.reply(`Brand "${b}" tidak ada. Pilihan: ${Object.keys(db.brands).join(', ')}`);
  ctx.reply(addOptinManual(h, findBrand(b) || db.defaultBrand));
});
function addOptinManual(h, brand) {
  const handle = norm(h);
  db.optins[handle] = { at: Date.now(), via: 'admin', brand }; stat('optins', brand);
  return `✅ @${handle} opt-in ke ${brandName(brand)}.`;
}
bot.command('deloptin', (ctx) => {
  delete db.optins[norm(ctx.message.text.split(/\s+/)[1] || '')]; save(); ctx.reply('Dihapus.');
});

function kv(obj, ctx, label) {
  const [, k, ...rest] = ctx.message.text.split(/\s+/);
  if (!k) return ctx.reply(`${label}:\n` + Object.entries(obj).map(([a, b]) => `${a}: ${Array.isArray(b) ? b.join(', ') : b}`).join('\n'));
  if (!(k in obj)) return ctx.reply('Key tidak dikenal.');
  const v = rest.join(' ');
  if (typeof obj[k] === 'number' && (v === '' || !Number.isFinite(Number(v)))) return ctx.reply('Nilai harus angka.');
  obj[k] = Array.isArray(obj[k]) ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : typeof obj[k] === 'boolean' ? v === 'true' : Number(v);
  save(); ctx.reply(`✅ ${k} = ${obj[k]}`);
}
bot.command('filter', (ctx) => kv(db.filter, ctx, 'Filter'));
bot.command('limits', (ctx) => kv(db.limits, ctx, 'Batas (per akun)'));
bot.command('auto', (ctx) => kv(db.auto, ctx, 'Otomatis'));

// Jeda dalam menit (lebih mudah daripada /limits minDelaySec)
bot.command('jeda', (ctx) => {
  const [, a, b] = ctx.message.text.split(/\s+/);
  if (!a) {
    return ctx.reply(
      `Jeda antar aksi (per akun X): ${fmtGap()}\nJeda komentar ke project yang sama: ${db.auto.replyGapMin} menit\n\n` +
      'Ubah:\n/jeda 5 — tiap 5 menit\n/jeda 3 6 — acak 3–6 menit\n/jeda project 10 — project yang sama maks. 1 komentar per 10 menit'
    );
  }
  if (a === 'project') {
    const m = Number(b);
    if (b === undefined || !(m >= 0)) return ctx.reply('Format: /jeda project 10');
    db.auto.replyGapMin = m; save();
    return ctx.reply(`✅ Komentar ke project yang sama minimal ${m} menit sekali.`);
  }
  const lo = Number(a), hi = b === undefined ? lo : Number(b);
  if (!(lo >= 0) || !(hi >= lo)) return ctx.reply('Format: /jeda 5  atau  /jeda 3 6');
  db.limits.minDelaySec = Math.round(lo * 60);
  db.limits.maxDelaySec = Math.round(hi * 60);
  save();
  ctx.reply(`✅ Jeda antar aksi: ${fmtGap()}.`);
});

bot.command('pause', (ctx) => { db.paused = true; save(); ctx.reply('⏸ Bot di-pause.'); });
bot.command('resume', (ctx) => {
  const arg = ctx.message.text.split(/\s+/)[1];
  const b = findBrand(arg);
  if (arg && !b) return ctx.reply(`Brand "${arg}" tidak ada. Pilihan: ${Object.keys(db.brands).join(', ')}`);
  ctx.reply(resume(b));
});
function resume(b) {
  for (const k of b ? [b] : Object.keys(db.brands)) { delete db.brandDown[k]; delete db.pausedUntil[k]; failStreak[k] = 0; }
  if (!b) db.paused = false;
  save();
  runQueue();
  return b ? `▶️ Akun ${brandName(b)} jalan lagi.` : '▶️ Bot jalan lagi.';
}
bot.command('status', (ctx) => ctx.replyWithHTML(statusText()));
function statusText() {
  const accounts = Object.keys(db.brands).map((b) => {
    if (!clients[b]) return `${esc(brandName(b))}: ❌ belum ada akun`;
    const state = isDown(b) ? `🛑 dihentikan (/resume ${b})` : limited(b) ? `⏸ rate limit s/d ${fmtTime(db.pausedUntil[b])}` : '🟢';
    return `${esc(brandLabel(b))}: ${state} · 1 jam ${sentIn(b, 3600_000)}/${db.limits.maxPerHour} · 24 jam ${sentIn(b, DAY)}/${db.limits.maxPerDay}`;
  });
  return (
    `<b>Status</b>: ${db.paused ? '⏸ pause' : '🟢 jalan'}\n` +
    (LISTENER ? `Listener Telegram: ${tg?.connected ? '✅' : '❌'}\n` : 'Mode: bot saja (bot harus admin di channel target)\n') +
    `Channel terpantau: ${targets.size}/${db.channels.length}${missing.length ? ` (${NOT_READ}: ${esc(missing.join(', '))})` : ''}\n` +
    `Channel laporan: ${db.reportChat ? '✅' : '❌'}\n\n<b>Akun X</b>\n${accounts.join('\n')}\n\n` +
    `Opt-in: ${Object.keys(db.optins).length} (menunggu verifikasi: ${Object.keys(db.pending).length})\n` +
    `Pantau tweet opt-in: ${db.auto.watchOptins ? 'ON' : 'OFF'}\nAntrian: ${db.queue.length}\n` +
    `Komentar per project: ${db.filter.tweetsPerProject} tweet terbaru, maks. ${db.auto.maxRepliesPerProjectPerDay}/hari\n` +
    `Jeda: ${fmtGap()} antar aksi · ${db.auto.replyGapMin} menit per project`
  );
}

// ---------- Panel tombol (/menu): semua pengaturan tanpa hafal perintah ----------
const btn = (text, data) => Markup.button.callback(text, data);
const HOME = [btn('⬅️ Menu utama', 'm:home')];
const FIELD = { k: 'templates', t: 'tweetTemplates' };
const awaiting = new Map(); // admin -> { kind, brand, field, at }: bot menunggu balasan teks
const accIcon = (b) => (!clients[b] ? '❌' : isDown(b) ? '🛑' : limited(b) ? '⏸' : '✅');
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);

// Satu baris pilihan: label + nilai preset; nilai yang aktif diberi ✅
function optionRow(label, path, values, fmt = String) {
  const [o, k] = path.split('.');
  return [btn(label, 'm:noop'), ...values.map((v) => btn(`${db[o][k] === v ? '✅' : ''}${fmt(v)}`, `m:set:${path}:${v}`))];
}

function homePanel() {
  const acc = Object.keys(db.brands).map((b) => `${esc(brandName(b))} ${accIcon(b)}`).join(' · ');
  return {
    text: `⚙️ <b>Panel pengaturan</b>\n\nStatus: ${db.paused ? '⏸ pause' : '🟢 jalan'}${LISTENER ? '' : ' · mode bot saja'}\n` +
      `Akun X: ${acc}\nChannel: ${targets.size}/${db.channels.length} terpantau · Opt-in: ${Object.keys(db.optins).length} · Antrian: ${db.queue.length}` +
      (db.reportChat ? '' : '\n⚠️ Channel laporan belum diatur — posting /setreport di channel laporan') + '\n\nPilih menu:',
    rows: [
      [btn('📊 Status', 'm:status'), btn('👤 Akun X', 'm:acc')],
      [btn('📢 Channel', 'm:ch'), btn('📝 Template', 'm:tplb')],
      [btn('🤝 Opt-in', 'm:opt'), btn('⏱ Jeda & Batas', 'm:lim')],
      [btn('🔎 Filter', 'm:flt'), btn('🤖 Otomatis', 'm:auto')],
      [db.paused ? btn('▶️ Jalankan lagi', 'm:resume') : btn('⏸ Pause semua', 'm:pause'), btn('❓ Bantuan', 'm:help')]
    ]
  };
}
function accountsPanel(checked = {}) {
  const lines = Object.entries(db.brands).map(([b, v]) => {
    const st = checked[b] || (!clients[b] ? '❌ belum ada akun'
      : `${accIcon(b)} @${v.username || '?'}${isDown(b) ? ' · dihentikan' : limited(b) ? ' · rate limit' : ''}`);
    const chs = db.channels.filter((c) => channelBrand(c) === b).length;
    const ops = Object.values(db.optins).filter((o) => brandOf(o) === b).length;
    return `<b>${esc(v.name)}</b>: ${esc(st)}\n   channel ${chs} · opt-in ${ops}`;
  });
  const rows = Object.entries(db.brands).map(([b, v]) => [
    btn(`${v.x ? '🔑 Ganti' : '➕ Hubungkan'} akun ${v.name}`, `m:ask:keys:${b}`),
    ...(isDown(b) || limited(b) ? [btn('▶️ Jalankan', `m:accres:${b}`)] : []),
    ...(v.x ? [btn('🗑', `m:accdel:${b}`)] : [])
  ]);
  rows.push([btn('➕ Brand baru', 'm:ask:newbrand'), btn('🔄 Cek akun', 'm:acccek')], HOME);
  return { text: `👤 <b>Akun X</b> (1 akun per brand)\n\n${lines.join('\n\n')}`, rows };
}
function channelsPanel() {
  const lines = db.channels.map((c) => `${targets.has(c) ? '✅' : '⚠️'} ${esc(c)} → ${esc(brandName(channelBrand(c)))}${targets.has(c) ? '' : ` (${NOT_READ})`}`);
  const rows = db.channels.slice(0, 20).map((c) => [btn(`🔁 ${c}: ${brandName(channelBrand(c))}`, `m:chb:${c}`), btn('🗑', `m:chdel:${c}`)]);
  rows.push([btn('➕ Tambah channel', 'm:ask:channel'), btn('🔄 Cek ulang', 'm:chref')], HOME);
  return {
    text: `📢 <b>Channel target</b>\n${LISTENER ? 'Akun listener harus join channel.' : 'Bot harus jadi admin di channel.'} Tombol 🔁 = ganti brand.\n\n` +
      (lines.join('\n') || 'Belum ada channel.'),
    rows
  };
}
function tplBrandPanel() {
  return { text: '📝 <b>Template</b> — pilih brand:', rows: [Object.entries(db.brands).map(([b, v]) => btn(v.name, `m:tpl:${b}`)), HOME] };
}
function tplPanel(b) {
  const v = db.brands[b];
  const list = (l) => l.map((t, i) => `${i + 1}. ${esc(t.length > 120 ? t.slice(0, 120) + '…' : t)}`).join('\n');
  const delRows = (l, f) => chunk(l.map((_, i) => btn(`🗑 ${f.toUpperCase()}${i + 1}`, `m:tdel:${b}:${f}:${i + 1}`)), 5);
  return {
    text: `📝 <b>Template ${esc(v.name)}</b>\nVariabel: {name} {handle} {channel}\n\n<b>K = Komentar</b> (project opt-in):\n${list(v.templates)}\n\n` +
      `<b>T = Tweet bot</b> (project belum opt-in, ${v.ownTweetEnabled ? 'ON' : 'OFF'}):\n${list(v.tweetTemplates)}`,
    rows: [
      [btn('➕ Komentar', `m:ask:tpl:${b}:k`), btn('➕ Tweet', `m:ask:tpl:${b}:t`)],
      ...delRows(v.templates, 'k'), ...delRows(v.tweetTemplates, 't'),
      [btn(`Tweet bot: ${v.ownTweetEnabled ? '✅ ON' : '❌ OFF'}`, `m:twtog:${b}`)],
      [btn('⬅️ Pilih brand', 'm:tplb'), ...HOME]
    ]
  };
}
function optPanel() {
  const list = Object.entries(db.optins);
  const lines = list.slice(0, 30).map(([h, o]) => `@${esc(h)} → ${esc(brandName(brandOf(o)))}`);
  return {
    text: `🤝 <b>Opt-in</b> (${list.length})\n${lines.join('\n') || 'Belum ada.'}${list.length > 30 ? `\n… +${list.length - 30} lagi (/optins)` : ''}\n\n` +
      `Menunggu verifikasi bio: ${Object.keys(db.pending).length}\nProject daftar sendiri dengan /optin @handle di bot ini.`,
    rows: [[btn('➕ Opt-in manual', 'm:ask:optin'), btn('🗑 Hapus opt-in', 'm:ask:deloptin')], HOME]
  };
}
const GAPS = [[30, 90], [60, 180], [180, 360], [300, 600]];
function limPanel() {
  const { minDelaySec: lo, maxDelaySec: hi } = db.limits;
  return {
    text: `⏱ <b>Jeda & Batas</b> (berlaku per akun X)\n\nJeda antar aksi: ${fmtGap()}\nJeda komentar ke project yang sama: ${db.auto.replyGapMin} menit\n` +
      `Tweet terbaru yang dikomentari: ${db.filter.tweetsPerProject}\nMaks. komentar per project/hari: ${db.auto.maxRepliesPerProjectPerDay}\n` +
      `Maks. aksi per jam: ${db.limits.maxPerHour} · per hari: ${db.limits.maxPerDay}\n\nNilai lain: /jeda 2 4 · /limits maxPerHour 15`,
    rows: [
      [btn('Jeda aksi', 'm:noop'), ...GAPS.map(([a, b]) =>
        btn(`${lo === a && hi === b ? '✅' : ''}${a < 60 ? `${a}-${b}d` : `${a / 60}-${b / 60}m`}`, `m:gap:${a}:${b}`))],
      optionRow('Per project', 'auto.replyGapMin', [2, 5, 10, 30], (v) => `${v}m`),
      optionRow('Tweet baru', 'filter.tweetsPerProject', [1, 2, 3, 5]),
      optionRow('Komen/hari', 'auto.maxRepliesPerProjectPerDay', [1, 2, 3, 5]),
      optionRow('Aksi/jam', 'limits.maxPerHour', [10, 20, 30, 50]),
      optionRow('Aksi/hari', 'limits.maxPerDay', [30, 50, 100, 200]),
      HOME
    ]
  };
}
function fltPanel() {
  const f = db.filter;
  return {
    text: `🔎 <b>Filter project</b>\n\nMin. followers: ${f.minFollowers}\nMin. umur akun: ${f.minAgeDays} hari\nCooldown per project: ${f.cooldownDays} hari\n` +
      `Umur tweet maks.: ${f.maxTweetAgeHours} jam\nKata terlarang: ${esc(f.blacklist.join(', ') || '-')}`,
    rows: [
      optionRow('Followers', 'filter.minFollowers', [100, 500, 1000, 5000], (v) => (v >= 1000 ? `${v / 1000}k` : `${v}`)),
      optionRow('Umur akun', 'filter.minAgeDays', [0, 7, 14, 30], (v) => `${v} hr`),
      optionRow('Cooldown', 'filter.cooldownDays', [1, 3, 7, 14], (v) => `${v} hr`),
      optionRow('Tweet maks', 'filter.maxTweetAgeHours', [12, 24, 48, 72], (v) => `${v} j`),
      [btn('✏️ Ubah kata terlarang', 'm:ask:blacklist')],
      HOME
    ]
  };
}
function autoPanel() {
  const a = db.auto;
  return {
    text: `🤖 <b>Otomatis</b>\n\nPantau tweet baru project opt-in: ${a.watchOptins ? 'ON' : 'OFF'} (tiap ${a.watchIntervalMin} menit)\n` +
      `Verifikasi opt-in otomatis: ${a.autoVerify ? 'ON' : 'OFF'}\nRingkasan harian + backup: jam ${a.dailyReportHour}.00`,
    rows: [
      [btn(`Pantau tweet opt-in: ${a.watchOptins ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.watchOptins')],
      optionRow('Tiap', 'auto.watchIntervalMin', [5, 10, 15, 30], (v) => `${v}m`),
      [btn(`Verifikasi otomatis: ${a.autoVerify ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.autoVerify')],
      optionRow('Ringkasan', 'auto.dailyReportHour', [7, 8, 9, 12], (v) => `${v}.00`),
      HOME
    ]
  };
}
// Hanya nilai ini yang bisa diubah lewat tombol (+ panel yang ditampilkan ulang)
const SETTABLE = {
  'limits.maxPerHour': limPanel, 'limits.maxPerDay': limPanel, 'auto.replyGapMin': limPanel,
  'filter.tweetsPerProject': limPanel, 'auto.maxRepliesPerProjectPerDay': limPanel,
  'filter.minFollowers': fltPanel, 'filter.minAgeDays': fltPanel, 'filter.cooldownDays': fltPanel, 'filter.maxTweetAgeHours': fltPanel,
  'auto.watchIntervalMin': autoPanel, 'auto.dailyReportHour': autoPanel
};
const TOGGLE = { 'auto.watchOptins': autoPanel, 'auto.autoVerify': autoPanel };

const PROMPTS = {
  keys: (b) => `🔑 Kirim 4 key X untuk <b>${esc(brandName(b))}</b> dalam satu pesan, dipisah spasi:\n` +
    '<code>APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET</code>\n\nPesan Anda langsung dihapus setelah dibaca. /batal untuk batal.',
  newbrand: () => '➕ Kirim nama brand baru + 4 key X, dipisah spasi:\n<code>namabrand APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET</code>\n\n' +
    'Pesan Anda langsung dihapus. /batal untuk batal.',
  channel: () => '📢 Kirim username channel (contoh <code>@namachannel</code>) atau ID <code>-100…</code>\n' +
    `${LISTENER ? 'Akun listener harus sudah join channel itu.' : 'Jadikan bot admin di channel itu dulu.'} /batal untuk batal.`,
  tpl: (b, f) => `📝 Kirim teks template ${f === 'k' ? 'komentar' : 'tweet bot'} untuk <b>${esc(brandName(b))}</b>.\n` +
    'Variabel: <code>{name}</code> nama project, <code>{handle}</code> username X, <code>{channel}</code> nama channel.\n' +
    `Contoh: <code>${f === 'k' ? 'Love seeing {name} keep shipping 🚀' : '🚀 New project: {name}\nx.com/{handle}'}</code>\n/batal untuk batal.`,
  optin: () => '🤝 Kirim @handle X project yang sudah setuju (mis. beli paket listing). /batal untuk batal.',
  deloptin: () => '🗑 Kirim @handle project yang opt-in-nya mau dihapus. /batal untuk batal.',
  blacklist: () => '✏️ Kirim kata terlarang dipisah koma, contoh: <code>scam, rug, presale</code>\nKirim <code>-</code> untuk mengosongkan. /batal untuk batal.'
};

async function showPanel(ctx, { text, rows }, edit = true) {
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) };
  if (edit && ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (e) {
      if (/not modified/.test(e.message)) return;
    }
  }
  return ctx.reply(text, extra);
}
// Pilih brand lewat tombol kalau lebih dari satu, selain itu langsung jalan
function chooseBrand(ctx, question, data) {
  return ctx.reply(question, Markup.inlineKeyboard([Object.entries(db.brands).map(([b, v]) => btn(v.name, data(b)))]));
}

async function handleInput(ctx, a) {
  const text = ctx.message.text.trim();
  const again = (msg) => { awaiting.set(ctx.from.id, { ...a, at: Date.now() }); return ctx.reply(msg); };
  const brands = Object.keys(db.brands);
  switch (a.kind) {
    case 'keys':
      await setAccount(ctx, a.brand, text.split(/\s+/));
      return showPanel(ctx, accountsPanel(), false);
    case 'newbrand': {
      const [b, ...keys] = text.split(/\s+/);
      await setAccount(ctx, b.toLowerCase(), keys);
      return showPanel(ctx, accountsPanel(), false);
    }
    case 'channel': {
      const c = text.split(/\s+/)[0].toLowerCase();
      if (!/^(@\w{4,32}|-100\d{5,})$/.test(c)) return again('Format salah. Contoh: @namachannel atau -1001234567890. Kirim lagi, atau /batal');
      if (brands.length > 1) return chooseBrand(ctx, `Channel ${c} untuk brand mana?`, (b) => `m:chadd:${b}:${c}`);
      await ctx.reply(await addChannel(c, brands[0]));
      return showPanel(ctx, channelsPanel(), false);
    }
    case 'tpl':
      await ctx.reply(tplAdd(a.brand, FIELD[a.field], text));
      return showPanel(ctx, tplPanel(a.brand), false);
    case 'optin': {
      const h = norm(text.split(/\s+/)[0]);
      if (!validHandle(h)) return again('Handle X tidak valid. Contoh: @namaproject. Kirim lagi, atau /batal');
      if (brands.length > 1) return chooseBrand(ctx, `Opt-in @${h} ke brand mana?`, (b) => `m:optadd:${b}:${h}`);
      await ctx.reply(addOptinManual(h, brands[0]));
      return showPanel(ctx, optPanel(), false);
    }
    case 'deloptin': {
      const h = norm(text.split(/\s+/)[0]);
      if (!db.optins[h]) return again(`@${h} tidak ada di daftar opt-in. Kirim lagi, atau /batal`);
      delete db.optins[h]; save();
      await ctx.reply(`🗑 Opt-in @${h} dihapus.`);
      return showPanel(ctx, optPanel(), false);
    }
    case 'blacklist':
      db.filter.blacklist = text === '-' ? [] : text.split(',').map((w) => w.trim()).filter(Boolean);
      save();
      await ctx.reply(`✅ Kata terlarang: ${db.filter.blacklist.join(', ') || '-'}`);
      return showPanel(ctx, fltPanel(), false);
  }
}

bot.command('menu', (ctx) => showPanel(ctx, homePanel(), false));
bot.command('batal', (ctx) => ctx.reply('Dibatalkan.'));

bot.action(/^m:([a-z]+)(?::(.*))?$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Khusus admin').catch(() => {});
  const [, act, arg = ''] = ctx.match;
  const args = arg.split(':');
  let panel, toast, alert = false;
  switch (act) {
    case 'home': panel = homePanel(); break;
    case 'status': panel = { text: statusText(), rows: [[btn('🔄 Refresh', 'm:status')], HOME] }; break;
    case 'acc': panel = accountsPanel(); break;
    case 'acccek': {
      const checked = {};
      for (const b of Object.keys(db.brands)) checked[b] = await accountStatus(b);
      save(); toast = 'Akun dicek'; panel = accountsPanel(checked);
      break;
    }
    case 'accres': if (findBrand(arg)) toast = resume(arg); panel = accountsPanel(); break;
    case 'accdel':
      if (!db.brands[arg]?.x) { panel = accountsPanel(); break; }
      panel = {
        text: `Yakin lepas akun X <b>${esc(brandLabel(arg))}</b>? Template & opt-in brand ini tetap disimpan.`,
        rows: [[btn('🗑 Ya, lepas', `m:accdelok:${arg}`), btn('Batal', 'm:acc')]]
      };
      break;
    case 'accdelok': if (db.brands[arg]?.x) toast = 'Akun dilepas'; if (toast) delAccount(arg); panel = accountsPanel(); break;
    case 'ch': panel = channelsPanel(); break;
    case 'chref': await refreshChannels().catch((e) => console.error('refreshChannels:', e)); toast = 'Dicek ulang'; panel = channelsPanel(); break;
    case 'chb': {
      const keys = Object.keys(db.brands);
      if (db.channels.includes(arg)) { db.channelBrand[arg] = keys[(keys.indexOf(channelBrand(arg)) + 1) % keys.length]; save(); }
      panel = channelsPanel();
      break;
    }
    case 'chdel': delChannel(arg); toast = 'Channel dihapus'; panel = channelsPanel(); break;
    case 'chadd': {
      const [b, ...rest] = args;
      if (findBrand(b)) { toast = await addChannel(rest.join(':'), b); alert = toast.startsWith('⚠️'); }
      panel = channelsPanel();
      break;
    }
    case 'tplb': panel = Object.keys(db.brands).length === 1 ? tplPanel(db.defaultBrand) : tplBrandPanel(); break;
    case 'tpl': panel = tplPanel(findBrand(arg) || db.defaultBrand); break;
    case 'tdel': {
      const [b, f, n] = args;
      if (!findBrand(b) || !FIELD[f]) break;
      toast = tplDel(b, FIELD[f], Number(n)); panel = tplPanel(b);
      break;
    }
    case 'twtog': {
      const b = findBrand(arg);
      if (!b) break;
      db.brands[b].ownTweetEnabled = !db.brands[b].ownTweetEnabled; save(); panel = tplPanel(b);
      break;
    }
    case 'opt': panel = optPanel(); break;
    case 'optadd': {
      const [b, h] = args;
      if (findBrand(b) && validHandle(h)) toast = addOptinManual(h, b);
      panel = optPanel();
      break;
    }
    case 'lim': panel = limPanel(); break;
    case 'flt': panel = fltPanel(); break;
    case 'auto': panel = autoPanel(); break;
    case 'help': panel = { text: HELP, rows: [HOME] }; break;
    case 'set': {
      const [path, raw] = args;
      const v = Number(raw);
      if (!SETTABLE[path] || !Number.isFinite(v) || v < 0) break;
      const [o, k] = path.split('.');
      db[o][k] = v; save(); toast = '✅ Disimpan'; panel = SETTABLE[path]();
      break;
    }
    case 'tog': {
      if (!TOGGLE[arg]) break;
      const [o, k] = arg.split('.');
      db[o][k] = !db[o][k]; save(); toast = '✅ Disimpan'; panel = TOGGLE[arg]();
      break;
    }
    case 'gap': {
      const [a, b] = args.map(Number);
      if (!GAPS.some(([x, y]) => x === a && y === b)) break;
      db.limits.minDelaySec = a; db.limits.maxDelaySec = b; save(); toast = '✅ Disimpan'; panel = limPanel();
      break;
    }
    case 'pause': db.paused = true; save(); toast = '⏸ Bot di-pause'; panel = homePanel(); break;
    case 'resume': toast = resume(); panel = homePanel(); break;
    case 'ask': {
      const [kind, b, f] = args;
      if (!PROMPTS[kind] || (['keys', 'tpl'].includes(kind) && !findBrand(b)) || (kind === 'tpl' && !FIELD[f])) break;
      awaiting.set(ctx.from.id, { kind, brand: b, field: f, at: Date.now() });
      await ctx.answerCbQuery().catch(() => {});
      return ctx.replyWithHTML(PROMPTS[kind](b, f));
    }
  }
  await ctx.answerCbQuery(toast?.slice(0, 190), { show_alert: alert }).catch(() => {});
  if (panel) await showPanel(ctx, panel);
});

// ---------- Menu "/" di Telegram ----------
const PUBLIC_COMMANDS = [
  { command: 'optin', description: 'Daftarkan project kamu (opt-in)' },
  { command: 'verify', description: 'Cek kode opt-in di bio X' },
  { command: 'optout', description: 'Berhenti opt-in' }
];
const ADMIN_COMMANDS = [
  { command: 'menu', description: '⚙️ Panel pengaturan (tombol)' },
  { command: 'status', description: 'Status bot & akun X' },
  { command: 'accounts', description: 'Akun X per brand' },
  { command: 'channels', description: 'Channel yang dipantau' },
  { command: 'tpls', description: 'Lihat template' },
  { command: 'optins', description: 'Daftar project opt-in' },
  { command: 'jeda', description: 'Lihat/atur jeda komentar' },
  { command: 'pause', description: 'Pause semua aksi' },
  { command: 'resume', description: 'Jalankan lagi' },
  { command: 'batal', description: 'Batalkan input yang sedang ditunggu' },
  { command: 'help', description: 'Semua perintah' }
];
// Gagal untuk admin yang belum pernah /start — diulang saat admin itu /start
function setAdminCommands(id) {
  return bot.telegram.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: Number(id) } }).catch(() => {});
}
async function setupCommands() {
  await bot.telegram.setMyCommands(PUBLIC_COMMANDS).catch((e) => console.error('setMyCommands:', e.message));
  for (const id of ADMINS) await setAdminCommands(id);
}

// ---------- Start ----------
bot.catch((e) => console.error('bot error:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
// Konfigurasi salah: keluar dengan pesan jelas (jangan tampak "online" di pm2 padahal mati)
const missingEnv = ['BOT_TOKEN', 'ADMIN_IDS'].filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`❌ .env belum lengkap: ${missingEnv.join(', ')} kosong. Isi .env (lihat .env.example)`);
  process.exit(1);
}
if (LISTENER) {
  try {
    await startListener();
  } catch (e) {
    console.error('❌ Listener Telegram gagal start:', e.message);
    process.exit(1);
  }
} else {
  console.log('Mode bot saja: post dibaca dari channel tempat bot jadi admin');
  if (process.env.TG_API_ID || process.env.TG_API_HASH) console.log('(TG_API_* terisi tapi TG_SESSION kosong — jalankan npm run login untuk mode listener)');
}
await refreshChannels().catch((e) => console.error('refreshChannels:', e));
await catchUp();
bot.launch().catch((e) => {
  console.error('Bot Telegram gagal jalan:', e.message);
  process.exit(1); // pm2 akan restart otomatis
});
console.log('Bot Telegram aktif');
await setupCommands();
await report(
  `🟢 <b>Bot online</b>${LISTENER ? '' : ' · mode bot saja'}\n<b>Akun X</b>\n${esc(await accountsReport())}\n\nChannel terpantau: ${targets.size}/${db.channels.length}` +
  `${missing.length ? `\n⚠️ ${LISTENER ? 'Akun listener belum join' : 'Bot belum jadi admin di'}: ${esc(missing.join(', '))}` : ''}` +
  `\nOpt-in: ${Object.keys(db.optins).length}\nAntrian dilanjutkan: ${db.queue.length}` +
  `${db.paused ? '\n⏸ Masih di-pause manual (/resume)' : ''}`
);
save();
runQueue();
setInterval(tick, TICK);

function stop(sig) {
  try { bot.stop(sig); } catch {}
  save();
  Promise.resolve(tg?.disconnect()).catch(() => {}).finally(() => process.exit(0));
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
