import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { TwitterApi } from 'twitter-api-v2';
import { db, save, backup } from './db.js';

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
const stat = (k) => { db.stats[k] = (db.stats[k] || 0) + 1; save(); };

// ---------- X client ----------
let x = null;
function initX() {
  x = db.x ? new TwitterApi(db.x).readWrite : null;
}
initX();
const xStatus = () => !x ? '❌ belum diatur (/setx)'
  : x.v2.me().then(({ data }) => '✅ @' + data.username, (e) => '❌ ' + (e?.data?.detail || e.message));

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

// ---------- Error X: jeda otomatis saat rate limit, ulangi error sementara ----------
const limited = () => Date.now() < db.pausedUntil;
const lastErr = new Map();
function rateLimitUntil(e) {
  const rl = e?.rateLimit || {};
  const resets = [rl.reset];
  for (const d of [rl.day, rl.userDay]) if (d?.remaining === 0) resets.push(d.reset); // batas 24 jam
  const reset = Math.max(0, ...resets.filter(Number.isFinite)) * 1000;
  return Math.max(reset ? reset + 5_000 : Date.now() + 15 * 60_000, Date.now() + TICK);
}
// Lapor error, kembalikan true kalau aksinya layak diulang
async function xError(e, label) {
  const code = e?.code || e?.data?.status;
  stat('errors');
  if (code === 429) {
    const until = rateLimitUntil(e);
    if (until > db.pausedUntil) {
      db.pausedUntil = until; save();
      await report(`⏸ Rate limit X (${esc(label)}). Bot jeda otomatis sampai ${fmtTime(until)}, lalu jalan lagi sendiri.`);
    }
    return true;
  }
  const detail = e?.data?.detail || e?.message;
  const sig = `${label}|${code}|${detail}`;
  if (Date.now() - (lastErr.get(sig) || 0) > 3600_000) { // error yang sama dilapor maks. 1x per jam
    lastErr.set(sig, Date.now());
    await report(`⚠️ <b>${esc(label)}</b> gagal (${esc(code ?? e?.requestError?.code ?? 'error')})\n${esc(detail)}`);
    if (code === 401) await report('❌ Key X ditolak — perbarui dengan /setx.');
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
let lastTpl = -1;
function fill(tpl, v) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
}
function pickTemplate() {
  if (db.templates.length === 1) return db.templates[0];
  let i;
  do i = Math.floor(Math.random() * db.templates.length);
  while (i === lastTpl);
  lastTpl = i;
  return db.templates[i];
}

// ---------- Antrian aksi X (tersimpan di data.json, lanjut setelah restart) ----------
let running = false;
const lastHour = () => db.sentAt.filter((t) => t > Date.now() - 3600_000).length;
const jobLabel = (j) => `${j.type === 'reply' ? 'Komentar ke' : 'Tweet tentang'} @${j.username}`;
function enqueue(job) {
  if (job.type === 'reply' && (db.repliedTweets.includes(job.tweetId) || db.queue.some((j) => j.tweetId === job.tweetId))) return;
  db.queue.push(job); save();
  runQueue();
}
async function runQueue() {
  if (running) return;
  running = true;
  while (db.queue.length) {
    if (db.paused || limited()) { await sleep(POLL); continue; }
    db.sentAt = db.sentAt.filter((t) => t > Date.now() - DAY);
    if (lastHour() >= db.limits.maxPerHour || db.sentAt.length >= db.limits.maxPerDay) { await sleep(TICK); continue; }
    const job = db.queue[0];
    let acted = true, retry = false;
    try {
      acted = (await runJob(job)) !== false;
    } catch (e) {
      console.error('job error:', e);
      retry = (await xError(e, jobLabel(job))) && (job.tries = (job.tries || 0) + 1) < 3;
    }
    if (!retry) db.queue.shift();
    if (acted) db.sentAt.push(Date.now());
    save();
    if (acted && db.queue.length) await sleep(rand(db.limits.minDelaySec, db.limits.maxDelaySec) * 1000);
  }
  running = false;
}

// Kembalikan false kalau aksi dilewati (tidak dihitung ke batas & tanpa jeda)
async function runJob(j) {
  if (Date.now() - j.at > db.filter.maxTweetAgeHours * 3600_000) return false; // sudah basi di antrian
  const vars = { name: j.name, handle: j.username, channel: j.channel };
  const followBtn = Markup.button.url('👤 Follow', `https://x.com/intent/follow?screen_name=${j.username}`);
  const openBtn = (id) => Markup.button.url('🔗 Buka', `https://x.com/i/status/${id}`);

  if (j.type === 'reply') {
    // Cek ulang saat dieksekusi: project bisa saja opt-out selama antre
    if (!db.optins[j.handle] || db.repliedTweets.includes(j.tweetId)) return false;
    const log = (db.replyLog[j.handle] || []).filter((t) => t > Date.now() - DAY);
    if (log.length >= db.auto.maxRepliesPerProjectPerDay) {
      await report(`ℹ️ @${esc(j.username)} sudah ${log.length} komentar dalam 24 jam (maxRepliesPerProjectPerDay) — tweet dilewati`);
      return false;
    }
    const body = fill(pickTemplate(), vars);
    const { data } = await x.v2.reply(body, j.tweetId);
    db.repliedTweets = [...db.repliedTweets.slice(-999), j.tweetId];
    db.replyLog[j.handle] = [...log, Date.now()];
    stat('replies');
    const when = j.t0 ? `${((Date.now() - j.t0) / 1000).toFixed(1)}s setelah post channel` : 'dari pantauan tweet baru project opt-in';
    await report(
      `✅ <b>Komentar terkirim</b>\nProject: <b>@${esc(j.username)}</b>\nSumber: ${esc(j.source || j.channel)}\n` +
      `Tweet: "${esc(j.tweetText.slice(0, 90))}…"\nKomentar: "${esc(body)}"\n<i>${when}</i>`,
      [[followBtn, openBtn(data.id)]]
    );
    return true;
  }

  // Belum opt-in -> akun bot tweet sendiri (tanpa reply ke project)
  if (!db.ownTweetEnabled) return false;
  const body = fill(db.ownTweetTemplate, vars);
  const { data } = await x.v2.tweet(body);
  stat('tweets');
  await report(
    `🐦 <b>Tweet bot</b> tentang <b>@${esc(j.username)}</b> (belum opt-in)\nSumber: ${esc(j.channel)}\n"${esc(body)}"`,
    [[followBtn, openBtn(data.id)]]
  );
  return true;
}

// ---------- Proses satu project ----------
const inFlight = new Set();
async function processProject(handle, channelName, t0) {
  if (!x) return report('⚠️ Akun X belum diatur. Pakai /setx di DM bot.');
  const f = db.filter;
  const last = db.history[handle];
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

    const base = { handle, username: user.username, name: user.name, channel: channelName };
    if (db.optins[handle]) {
      // Project opt-in -> komentar otomatis
      const tl = await x.v2.userTimeline(user.id, {
        max_results: 5, exclude: ['replies', 'retweets'], 'tweet.fields': ['created_at']
      });
      db.history[handle] = Date.now(); save(); // dicatat setelah timeline sukses, supaya bisa diulang kalau gagal
      const maxAge = f.maxTweetAgeHours * 3600_000;
      const tweets = (tl.tweets || [])
        .filter((t) => Date.now() - new Date(t.created_at) < maxAge)
        .slice(0, f.tweetsPerProject);
      if (!tweets.length) return report(`ℹ️ <b>@${esc(handle)}</b> (opt-in) tidak punya tweet baru ≤ ${f.maxTweetAgeHours} jam`);
      for (const tw of tweets) {
        enqueue({ ...base, type: 'reply', tweetId: tw.id, tweetText: tw.text, at: new Date(tw.created_at).getTime(), t0 });
      }
    } else {
      db.history[handle] = Date.now(); save();
      if (db.ownTweetEnabled) enqueue({ ...base, type: 'tweet', at: Date.now() });
      else await report(`ℹ️ <b>@${esc(handle)}</b> belum opt-in — dilewati\nSumber: ${esc(channelName)}`,
        [[Markup.button.url('👤 Follow', `https://x.com/intent/follow?screen_name=${user.username}`)]]);
    }
  } finally {
    inFlight.delete(handle);
  }
}

// Tunggu rate limit selesai, ulangi kalau error jaringan / server X
async function processSafe(handle, channelName, t0) {
  for (let tries = 0; tries < 3; tries++) {
    while (limited()) await sleep(POLL);
    try {
      return await processProject(handle, channelName, t0);
    } catch (e) {
      console.error(e);
      if (!(await xError(e, `Proses @${handle}`))) return;
      if (!limited()) await sleep(Math.min(30_000, TICK));
    }
  }
}

// ---------- Listener channel Telegram ----------
let tg = null;
let tgDown = false;
let missing = []; // channel di db.channels yang belum di-join akun listener
const targets = new Map(); // channel di db.channels -> entity Telegram
const chanKeys = (chat) => [
  chat.username && '@' + chat.username.toLowerCase(),
  ...(chat.usernames || []).map((u) => '@' + u.username.toLowerCase()),
  `-100${chat.id}`, String(chat.id)
].filter(Boolean);
const isTarget = (chat) => db.channels.some((c) => chanKeys(chat).includes(c.toLowerCase()));

// Dipakai listener live dan catch-up; lastSeen mencegah post diproses dua kali
function onChannelPost(msg, chat, t0) {
  const key = String(chat.id);
  if (msg.id <= (db.lastSeen[key] || 0)) return false;
  db.lastSeen[key] = msg.id; save();
  if (db.paused) return false;
  const urls = (msg.entities || []).map((e) => e.url).filter(Boolean);
  for (const h of extractHandles(msg.message || '', urls)) processSafe(h, chat.title || chat.username, t0);
  return true;
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
      if (chat && isTarget(chat)) onChannelPost(msg, chat, Date.now());
    } catch (e) {
      console.error('listener error:', e);
    }
  }, new NewMessage({}));
  console.log('Listener Telegram aktif');
}

// Cocokkan db.channels dengan channel yang sudah di-join akun listener
async function refreshChannels() {
  const before = new Set(targets.keys());
  targets.clear();
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
  save();
  missing = db.channels.filter((c) => !targets.has(c));
  return [...targets.keys()].filter((c) => !before.has(c)); // yang baru terpantau
}

// Ambil post yang terlewat (bot mati, koneksi putus) + sambung ulang listener
async function catchUp() {
  try {
    if (!tg.connected) await tg.connect();
    const minDate = Date.now() / 1000 - db.auto.catchUpMaxAgeHours * 3600;
    let n = 0;
    for (const [name, e] of targets) {
      const key = String(e.id);
      const msgs = await tg.getMessages(e, { minId: db.lastSeen[key] || 0, limit: 50 });
      for (const m of [...msgs].sort((a, b) => a.id - b.id)) {
        if (m.date < minDate) { db.lastSeen[key] = Math.max(db.lastSeen[key] || 0, m.id); continue; }
        if (onChannelPost(m, e, m.date * 1000)) { n++; console.log(`catch-up ${name} #${m.id}`); }
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
async function watchOptins() {
  const handles = Object.keys(db.optins);
  if (!x || !db.auto.watchOptins || !handles.length || db.paused || limited()) return;
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
  const since = db.watchSinceId && Date.now() - idTime(db.watchSinceId) < 6 * DAY ? db.watchSinceId : null;
  const maxAge = db.filter.maxTweetAgeHours * 3600_000;
  let newest = since;
  for (const query of queries) {
    const res = await x.v2.search(query, {
      max_results: 100,
      'tweet.fields': ['created_at', 'author_id'],
      expansions: ['author_id'],
      'user.fields': ['username', 'name'],
      ...(since ? { since_id: since } : { start_time: new Date(Date.now() - db.auto.watchIntervalMin * 60_000).toISOString() })
    });
    newest = maxId(newest, res.meta?.newest_id);
    const users = new Map((res.includes?.users || []).map((u) => [u.id, u]));
    for (const tw of [...(res.tweets || [])].reverse()) {
      const u = users.get(tw.author_id);
      const at = new Date(tw.created_at).getTime();
      if (!u || !db.optins[u.username.toLowerCase()] || Date.now() - at > maxAge) continue;
      enqueue({
        type: 'reply', handle: u.username.toLowerCase(), username: u.username, name: u.name, channel: '',
        source: 'tweet baru (pantauan opt-in)', tweetId: tw.id, tweetText: tw.text, at
      });
    }
  }
  if (newest !== db.watchSinceId) { db.watchSinceId = newest; save(); }
}

// ---------- Opt-in: verifikasi bio otomatis ----------
async function activateOptin(handle, p, via) {
  db.optins[handle] = { at: Date.now(), via, by: p.by };
  delete db.pending[handle];
  stat('optins');
  await report(`🆕 <b>Opt-in baru</b>: @${esc(handle)} (${via === 'verify' ? 'verifikasi bio' : 'verifikasi bio otomatis'})`);
}
async function autoVerify() {
  if (!x || !db.auto.autoVerify) return;
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
  if (!handles.length) return;
  const { data = [] } = await x.v2.usersByUsernames(handles, { 'user.fields': ['description'] });
  for (const u of data) {
    const h = u.username.toLowerCase();
    const p = db.pending[h];
    if (!p || !u.description?.includes(p.code)) continue;
    await activateOptin(h, p, 'auto-verify');
    bot.telegram.sendMessage(p.by, `✅ @${h} terverifikasi otomatis & opt-in aktif. Kode boleh dihapus dari bio.`).catch(() => {});
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
  const file = backup();
  const s = db.stats;
  await report(
    `📊 <b>Ringkasan harian</b>\nKomentar terkirim: ${s.replies || 0}\nTweet bot: ${s.tweets || 0}\n` +
    `Di-skip filter: ${s.skipped || 0}\nOpt-in baru: ${s.optins || 0}\nError: ${s.errors || 0}\n\n` +
    `Akun X: ${await xStatus()}\nChannel terpantau: ${targets.size}/${db.channels.length}` +
    `${missing.length ? ` (belum join: ${esc(missing.join(', '))})` : ''}\n` +
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
  if (db.pausedUntil && !limited()) {
    db.pausedUntil = 0; save();
    await report('▶️ Rate limit X selesai — bot jalan lagi otomatis.');
    runQueue();
  }
  const tasks = [
    [every(db.auto.catchUpMin), catchUp, 'Catch-up channel'],
    [every(db.auto.watchIntervalMin), watchOptins, 'Pantau tweet opt-in'],
    [every(db.auto.verifyIntervalMin), autoVerify, 'Verifikasi opt-in otomatis'],
    [every(targets.size < db.channels.length ? 30 : 360), async () => {
      const joined = await refreshChannels();
      if (joined.length) await report(`✅ Listener sudah join ${esc(joined.join(', '))} — mulai dipantau`);
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

<b>Akun X</b>
/setx APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET
/xstatus — cek akun X

<b>Channel</b>
/addchannel @channel · /delchannel @channel · /channels
/setreport — jalankan di channel laporan

<b>Template komentar</b> (variabel: {name} {handle} {channel})
/addtpl teks · /deltpl nomor · /tpls

<b>Tweet bot (project belum opt-in)</b>
/tweet on|off · /settweet teks

<b>Opt-in</b>
/optins · /addoptin @handle · /deloptin @handle

<b>Filter & batas</b>
/filter — lihat · /filter minFollowers 500
/limits — lihat · /limits maxPerHour 20

<b>Otomatis</b>
/auto — lihat · /auto watchOptins false · /auto dailyReportHour 8

/pause · /resume · /status

<b>Untuk project</b>: /optin @handle (verifikasi otomatis, atau /verify @handle)`;

bot.start((ctx) => ctx.replyWithHTML(isAdmin(ctx) ? HELP :
  'Hi! Mau tweet project kamu otomatis di-boost oleh Fourtis?\nKetik /optin @handle_x_project_kamu'));
bot.command('help', (ctx) => isAdmin(ctx) && ctx.replyWithHTML(HELP));

// Opt-in publik dengan verifikasi bio
bot.command('optin', async (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  if (!h) return ctx.reply('Format: /optin @handle_x');
  const handle = norm(h);
  if (!validHandle(handle)) return ctx.reply('Handle X tidak valid. Contoh: /optin @namaproject');
  if (db.optins[handle]) return ctx.reply('Project ini sudah opt-in ✅');
  const mine = Object.entries(db.pending).filter(([k, p]) => p.by === ctx.from.id && k !== handle).length;
  if (mine >= 3 && !isAdmin(ctx)) return ctx.reply('Maksimal 3 opt-in menunggu verifikasi. Selesaikan yang lain dulu.');
  const code = 'FTS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  db.pending[handle] = { code, by: ctx.from.id, at: Date.now() }; save();
  ctx.replyWithHTML(
    `Untuk verifikasi kepemilikan @${esc(handle)}:\n1. Tambahkan kode <code>${code}</code> ke bio X kamu\n` +
    `2. Bot mengecek bio otomatis tiap ${db.auto.verifyIntervalMin} menit (atau ketik /verify @${esc(handle)} untuk cek sekarang)\n` +
    `3. Setelah terverifikasi, kode boleh dihapus dari bio.\n\n` +
    `Dengan opt-in, kamu setuju akun Fourtis berkomentar otomatis di tweet project kamu. Batalkan kapan saja dengan /optout @${esc(handle)}`
  );
});

bot.command('verify', async (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  if (!h || !x) return ctx.reply('Format: /verify @handle_x');
  const handle = norm(h);
  const p = db.pending[handle];
  if (!p || p.by !== ctx.from.id) return ctx.reply('Mulai dulu dengan /optin @' + handle);
  const { data: u } = await x.v2.userByUsername(handle, { 'user.fields': ['description'] }).catch(() => ({}));
  if (!u?.description?.includes(p.code)) return ctx.reply(`Kode ${p.code} belum ditemukan di bio @${handle}. Coba lagi setelah bio di-update.`);
  ctx.reply(`✅ @${handle} terverifikasi & opt-in aktif.`);
  await activateOptin(handle, p, 'verify');
});

bot.command('optout', (ctx) => {
  const handle = norm(ctx.message.text.split(/\s+/)[1] || '');
  const o = db.optins[handle];
  if (!o || (o.by !== ctx.from.id && !isAdmin(ctx))) return ctx.reply('Tidak ditemukan.');
  delete db.optins[handle]; save();
  ctx.reply(`@${handle} sudah opt-out.`);
  report(`➖ Opt-out: @${esc(handle)}`);
});

// Semua perintah di bawah hanya admin
bot.use((ctx, next) => {
  const t = ctx.message?.text || ctx.channelPost?.text || '';
  if (!t.startsWith('/')) return next();
  if (ctx.channelPost && t.startsWith('/setreport')) return next();
  if (!isAdmin(ctx)) return;
  return next();
});

bot.command('setx', async (ctx) => {
  const [, appKey, appSecret, accessToken, accessSecret] = ctx.message.text.split(/\s+/);
  try { await ctx.deleteMessage(); } catch {}
  if (!accessSecret) return ctx.reply('Format: /setx APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET');
  const prev = db.x;
  db.x = { appKey, appSecret, accessToken, accessSecret };
  initX();
  try {
    const { data } = await x.v2.me();
    save();
    ctx.reply(`✅ Akun X tersambung: @${data.username}\n(pesan berisi key sudah dihapus)`);
  } catch (e) {
    db.x = prev; initX(); // key lama (yang masih jalan) tetap dipakai
    ctx.reply('❌ Key tidak valid: ' + (e?.data?.detail || e.message) + (prev ? '\nKey lama tetap dipakai.' : ''));
  }
});

bot.command('xstatus', async (ctx) => ctx.reply('Akun X: ' + await xStatus()));

bot.command('addchannel', async (ctx) => {
  const c = ctx.message.text.split(/\s+/)[1];
  if (!c) return ctx.reply('Format: /addchannel @channel  (atau -100xxxxxxxx)');
  if (!db.channels.includes(c.toLowerCase())) db.channels.push(c.toLowerCase());
  save();
  await refreshChannels().catch((e) => console.error('refreshChannels:', e));
  ctx.reply(targets.has(c.toLowerCase())
    ? `✅ ${c} ditambahkan & sudah dipantau.`
    : `⚠️ ${c} ditambahkan, tapi akun listener BELUM join channel ini. Join dulu — bot cek ulang otomatis tiap 30 menit.`);
});
bot.command('delchannel', (ctx) => {
  const c = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
  db.channels = db.channels.filter((x) => x !== c); targets.delete(c); missing = missing.filter((m) => m !== c);
  save(); ctx.reply('Dihapus.');
});
bot.command('channels', (ctx) => ctx.reply(db.channels.length
  ? db.channels.map((c) => `${targets.has(c) ? '✅' : '⚠️ belum join'} ${c}`).join('\n') : 'Belum ada channel.'));

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
  return next();
});

bot.command('addtpl', (ctx) => {
  const t = ctx.message.text.replace(/^\/addtpl(@\w+)?\s*/, '');
  if (!t) return ctx.reply('Format: /addtpl teks komentar dengan {name}');
  db.templates.push(t); save(); ctx.reply(`✅ Template #${db.templates.length} ditambahkan.`);
});
bot.command('deltpl', (ctx) => {
  const n = Number(ctx.message.text.split(/\s+/)[1]);
  if (!db.templates[n - 1]) return ctx.reply('Nomor tidak ada.');
  if (db.templates.length === 1) return ctx.reply('Minimal harus ada 1 template.');
  db.templates.splice(n - 1, 1); save(); ctx.reply('Dihapus.');
});
bot.command('tpls', (ctx) => ctx.reply(db.templates.map((t, i) => `${i + 1}. ${t}`).join('\n\n')));

bot.command('tweet', (ctx) => {
  const v = ctx.message.text.split(/\s+/)[1];
  db.ownTweetEnabled = v === 'on'; save();
  ctx.reply(`Tweet bot untuk project belum opt-in: ${db.ownTweetEnabled ? 'ON' : 'OFF'}`);
});
bot.command('settweet', (ctx) => {
  const t = ctx.message.text.replace(/^\/settweet(@\w+)?\s*/, '');
  if (!t) return ctx.reply(`Template sekarang:\n${db.ownTweetTemplate}`);
  db.ownTweetTemplate = t; save(); ctx.reply('✅ Template tweet bot diperbarui.');
});

bot.command('optins', (ctx) => {
  const list = Object.keys(db.optins);
  const pending = Object.keys(db.pending);
  ctx.reply((list.length ? `Opt-in (${list.length}):\n` + list.map((h) => '@' + h).join('\n') : 'Belum ada.') +
    (pending.length ? `\n\nMenunggu verifikasi bio (${pending.length}):\n` + pending.map((h) => '@' + h).join('\n') : ''));
});
bot.command('addoptin', (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  if (!h) return ctx.reply('Format: /addoptin @handle — hanya untuk project yang sudah setuju (mis. paket listing)');
  if (!validHandle(norm(h))) return ctx.reply('Handle X tidak valid.');
  db.optins[norm(h)] = { at: Date.now(), via: 'admin' }; stat('optins');
  ctx.reply(`✅ @${norm(h)} opt-in.`);
});
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
bot.command('limits', (ctx) => kv(db.limits, ctx, 'Batas'));
bot.command('auto', (ctx) => kv(db.auto, ctx, 'Otomatis'));

bot.command('pause', (ctx) => { db.paused = true; save(); ctx.reply('⏸ Bot di-pause.'); });
bot.command('resume', (ctx) => { db.paused = false; db.pausedUntil = 0; save(); ctx.reply('▶️ Bot jalan lagi.'); runQueue(); });
bot.command('status', (ctx) => ctx.replyWithHTML(
  `<b>Status</b>: ${db.paused ? '⏸ pause' : limited() ? `⏸ rate limit s/d ${fmtTime(db.pausedUntil)} (lanjut otomatis)` : '🟢 jalan'}\n` +
  `Akun X: ${db.x ? '✅' : '❌'}\nListener Telegram: ${tg?.connected ? '✅' : '❌'}\n` +
  `Channel terpantau: ${targets.size}/${db.channels.length}${missing.length ? ` (belum join: ${esc(missing.join(', '))})` : ''}\n` +
  `Channel laporan: ${db.reportChat ? '✅' : '❌'}\n` +
  `Opt-in: ${Object.keys(db.optins).length} (menunggu verifikasi: ${Object.keys(db.pending).length})\n` +
  `Pantau tweet opt-in: ${db.auto.watchOptins ? 'ON' : 'OFF'}\nTemplate: ${db.templates.length}\nAntrian: ${db.queue.length}\n` +
  `Aksi X 1 jam: ${lastHour()}/${db.limits.maxPerHour} · 24 jam: ${db.sentAt.filter((t) => t > Date.now() - DAY).length}/${db.limits.maxPerDay}`
));

// ---------- Start ----------
bot.catch((e) => console.error('bot error:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
await startListener();
await refreshChannels().catch((e) => console.error('refreshChannels:', e));
await catchUp();
bot.launch().catch((e) => {
  console.error('Bot Telegram gagal jalan:', e.message);
  process.exit(1); // pm2 akan restart otomatis
});
console.log('Bot Telegram aktif');
await report(
  `🟢 <b>Bot online</b>\nAkun X: ${await xStatus()}\nChannel terpantau: ${targets.size}/${db.channels.length}` +
  `${missing.length ? `\n⚠️ Akun listener belum join: ${esc(missing.join(', '))}` : ''}` +
  `\nOpt-in: ${Object.keys(db.optins).length}\nAntrian dilanjutkan: ${db.queue.length}` +
  `${db.paused ? '\n⏸ Masih di-pause manual (/resume)' : ''}${limited() ? `\n⏸ Rate limit X sampai ${fmtTime(db.pausedUntil)}` : ''}`
);
runQueue();
setInterval(tick, TICK);

function stop(sig) {
  try { bot.stop(sig); } catch {}
  save();
  Promise.resolve(tg?.disconnect()).catch(() => {}).finally(() => process.exit(0));
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
