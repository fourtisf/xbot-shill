import 'dotenv/config';
import { fileURLToPath } from 'url';
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
async function reportOnce(sig, html, every = 3600_000) { // pesan yang sama maks. 1x per jam (atau per `every` ms)
  if (Date.now() - (lastErr.get(sig) || 0) < every) return;
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
const jobLabel = (j) => `Komentar ke @${j.username} (${brandName(j.brand)})`;
const newestFirst = (a, b) => (BigInt(b.id ?? b.tweetId) > BigInt(a.id ?? a.tweetId) ? 1 : -1);
const lastReply = (h) => db.replyLog[h]?.at(-1) || 0;
const fmtSec = (s) => (s >= 60 ? `${+(s / 60).toFixed(1)} menit` : `${s} detik`);
const fmtGap = () => {
  const { minDelaySec: a, maxDelaySec: b } = db.limits;
  return a === b ? fmtSec(a) : `${fmtSec(a)}–${fmtSec(b)} (acak)`;
};
function withinLimits(b) { // batas per jam/hari akun (Jeda & Batas), juga untuk aksi lewat tombol
  db.sentAt[b] = (db.sentAt[b] || []).filter((t) => t > Date.now() - DAY);
  return sentIn(b, 3600_000) < db.limits.maxPerHour && db.sentAt[b].length < db.limits.maxPerDay;
}
function canAct(b) {
  if (!clients[b] || isDown(b) || limited(b) || Date.now() < (nextAt[b] || 0)) return false;
  return withinLimits(b);
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
      else if (cannotReply(e)) await replaceTweet(job, e);
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
  if (j.type !== 'reply') return false; // bot hanya berkomentar (tweet sendiri sudah dihapus)
  if (Date.now() - j.at > db.filter.maxTweetAgeHours * 3600_000) return false; // sudah basi di antrian
  // Cek ulang saat dieksekusi: project bisa saja opt-out / pindah brand selama antre
  const o = db.optins[j.handle];
  if (!o || brandOf(o) !== j.brand || db.repliedTweets.includes(j.tweetId)) return false;
  const log = (db.replyLog[j.handle] || []).filter((t) => t > Date.now() - DAY);
  if (log.length >= db.auto.maxRepliesPerProjectPerDay) {
    return dropProject(j, `sudah ${log.length} komentar dalam 24 jam (maxRepliesPerProjectPerDay)`);
  }
  const brand = db.brands[j.brand];
  const tpl = pickTemplate(brand.templates, j.handle, true);
  if (!tpl) return dropProject(j, `template komentar ${brand.name} sudah terpakai semua hari ini (tambah: /addtpl ${j.brand} teks)`);
  const body = fill(tpl, { name: j.name, handle: j.username, channel: j.channel });
  const { data } = await clients[j.brand].v2.reply(body, j.tweetId);
  useTemplate(j.handle, tpl);
  db.repliedTweets = [...db.repliedTweets.slice(-999), j.tweetId];
  db.replyLog[j.handle] = [...log, Date.now()];
  stat('replies', j.brand);
  const when = j.t0 ? `${((Date.now() - j.t0) / 1000).toFixed(1)}s setelah post channel` : 'dari pantauan tweet baru project opt-in';
  // Like & follow tidak otomatis (X melarang like/follow otomatis): tombol di laporan, 1 tekan = 1 aksi
  db.manual[j.tweetId] = { username: j.username, authorId: j.userId, at: Date.now(), brands: [j.brand], texts: {}, done: {}, replyId: data.id };
  await report(
    `✅ <b>Komentar terkirim</b> · ${esc(brandLabel(j.brand))}\nProject: <b>@${esc(j.username)}</b>\nSumber: ${esc(j.source || j.channel)}\n` +
    `Tweet: "${esc(j.tweetText.slice(0, 90))}…"\nKomentar: "${esc(body)}"\n<i>${when}</i>\n` +
    `👇 Like &amp; Follow: tekan tombol — dikirim dari ${esc(brandLabel(j.brand))}`,
    actionRows(j.tweetId)
  );
  return true;
}

// ---------- Proses satu project ----------
const inFlight = new Set();
const cooling = (handle) => db.history[handle] && Date.now() - db.history[handle] < db.filter.cooldownDays * DAY;
const followBtn = (username) => Markup.button.url('👤 Follow', `https://x.com/intent/follow?screen_name=${username}`);
const USER_FIELDS = { 'user.fields': ['public_metrics', 'created_at', 'description', 'name'] };
// Alasan project dilewati filter (null = lolos)
function filterWhy(user) {
  const f = db.filter;
  const ageDays = (Date.now() - new Date(user.created_at)) / DAY;
  const followers = user.public_metrics?.followers_count ?? 0;
  const text = `${user.name} ${user.description}`.toLowerCase();
  const bad = f.blacklist.find((w) => w && text.includes(w.toLowerCase()));
  if (followers < f.minFollowers) return `followers ${followers} < ${f.minFollowers}`;
  if (ageDays < f.minAgeDays) return `umur akun ${Math.floor(ageDays)} hari < ${f.minAgeDays}`;
  return bad ? `kata terlarang "${bad}"` : null;
}

// Project belum opt-in: bot TIDAK berkomentar sendiri (aturan X: komentar otomatis ke akun yang tidak minta = spam).
// Kalau "Komentar 1-tap" ON, bot mencari tweet terbarunya dan menyiapkan teks komentar per brand; admin yang
// menekan tombol 💬 di laporan (1 tekan = 1 komentar dari akun brand). Dilaporkan sekali per cooldown
async function notOptedIn(handle, channelName) {
  if (cooling(handle)) return;
  db.history[handle] = Date.now(); save();
  // Komentar 1-tap ON: channel laporan hanya berisi laporan "siap dikomentari" — project yang tidak bisa disiapkan
  // (tidak ada tweet baru, tidak ditemukan, di-skip filter, error X) cukup di log. OFF: setiap project dilaporkan
  const plain = (note = '') => (db.auto.manualAssist
    ? console.log(`@${handle} belum opt-in, tidak disiapkan${note}`)
    : report(`ℹ️ <b>@${esc(handle)}</b> belum opt-in — tidak dikomentari otomatis${note}\nSumber: ${esc(channelName)}`, [[followBtn(handle)]]));
  const rb = readerBrand();
  const brands = activeBrands().filter((b) => db.brands[b].templates.length);
  if (!db.auto.manualAssist || !brands.length) return plain();
  const toProfile = () => commentReport(handle, channelName, brands);
  if (db.auto.freeMode || !rb || limited(rb)) return toProfile();
  try {
    const x = clients[rb];
    const { data: user } = await x.v2.userByUsername(handle, USER_FIELDS);
    if (!user) return plain(' (tidak ditemukan di X)');
    const why = filterWhy(user);
    if (why) { stat('skipped'); return plain(` (di-skip — ${why})`); }
    const tl = await x.v2.userTimeline(user.id, { max_results: 5, exclude: ['replies', 'retweets'], 'tweet.fields': ['created_at', 'reply_settings'] });
    const maxAge = db.filter.maxTweetAgeHours * 3600_000;
    const tw = (tl.tweets || []).filter((t) => Date.now() - new Date(t.created_at) < maxAge && canReplyTo(t, rb)).sort(newestFirst)[0];
    if (!tw) return plain(` (tidak ada tweet baru ≤ ${db.filter.maxTweetAgeHours} jam)`);
    return commentReport(handle, channelName, brands, { user, tweet: tw });
  } catch (e) {
    console.error(e);
    // Kredit X API habis: satu peringatan per 6 jam (bukan per project); laporan tetap jalan dengan link profil
    if (e?.code === 402) {
      await reportOnce('x-credits', '⚠️ <b>Kredit X API habis</b> (402 credits depleted)\n' +
        'Bot tidak bisa mencari tweet terbaru: laporan memakai link 👤 Profil X sampai kredit diisi di console.x.com.', 6 * 3600_000);
    } else await xError(e, 'Siapkan komentar', rb); // sama per jenis error, maks. 1x per jam (bukan per project)
    return toProfile();
  }
}
// Laporan "siap dikomentari" project belum opt-in: komentar per brand (📋 Salin) + link ke tweet terbarunya, atau ke
// profilnya kalau tweet tidak dicari (mode hemat: tanpa API X) / tidak bisa dicari (kredit habis, error X).
// Reply, like & follow dilakukan admin di X — tidak ada aksi lewat API dari laporan ini
function commentReport(handle, channelName, brands, { user, tweet } = {}) {
  const username = user?.username || handle;
  const vars = { name: user?.name || handle, handle: username, channel: channelName };
  const texts = Object.fromEntries(brands.map((b) => {
    const tpl = pickTemplate(db.brands[b].templates, 'manual:' + b, false);
    useTemplate('manual:' + b, tpl);
    return [b, fill(tpl, vars)];
  }));
  save(); stat('manual');
  const multi = brands.length > 1;
  return report(
    `💬 <b>@${esc(username)}</b> belum opt-in — siap dikomentari\nSumber: ${esc(channelName)}\n` +
    (tweet ? `Tweet: "${esc(tweet.text.slice(0, 90))}…"\n` : '') +
    brands.map((b) => `Komentar ${esc(brandName(b))}: "${esc(texts[b])}"`).join('\n'),
    [
      brands.map((b) => ({ text: `📋 Salin${multi ? ` · ${brandName(b)}` : ''}`, copy_text: { text: texts[b].slice(0, 256) } })),
      tweet ? [
        // Link intent hanya jadi reply di browser PC (app X di HP membukanya sebagai postingan baru)
        Markup.button.url('✍️ Ubah di X (PC)', `https://x.com/intent/tweet?in_reply_to=${tweet.id}&text=${encodeURIComponent(texts[brands[0]])}`),
        Markup.button.url('🔗 Tweet terbaru', `https://x.com/${username}/status/${tweet.id}`)
      ] : [Markup.button.url('👤 Profil X', `https://x.com/${username}`)]
    ]
  );
}

// ---------- Tombol aksi di laporan: 💬 komentar / ❤️ like / 👤 follow ----------
// Dipicu admin satu per satu (bukan otomatis — X melarang komentar/like/follow otomatis ke akun yang tidak minta).
// 1 tekan = 1 aksi dari akun brand, ikut batas per jam/hari (Jeda & Batas). Tekan dua kali tidak dikirim dobel
const ACT_LABEL = { c: ['💬 Kirim', '✅ Terkirim'], l: ['❤️ Like', '✅ Liked'], f: ['👤 Follow', '✅ Followed'] };
function actionRows(tid) {
  const m = db.manual[tid];
  const multi = m.brands.length > 1;
  const rows = m.brands.filter((b) => db.brands[b]).map((b) => ['c', 'l', 'f']
    .filter((a) => (a !== 'c' || m.texts[b]) && (a !== 'f' || m.authorId))
    .map((a) => btn(`${ACT_LABEL[a][m.done[`${a}:${b}`] ? 1 : 0]}${a === 'c' || multi ? ` · ${brandName(b)}` : ''}`, `mx:${a}:${b}:${tid}`)));
  // HP: app X membuka link intent sebagai postingan baru (in_reply_to diabaikan), jadi komentar disalin
  // (tombol salin bawaan Telegram, maks. 256 karakter) lalu ditempel di Reply tweet-nya. Link intent tetap untuk PC
  const copy = m.brands.filter((b) => db.brands[b] && m.texts[b] && !m.done[`c:${b}`])
    .map((b) => ({ text: `📋 Salin${multi ? ` · ${brandName(b)}` : ''}`, copy_text: { text: m.texts[b].slice(0, 256) } }));
  if (copy.length) rows.push(copy);
  const first = m.brands.find((b) => m.texts[b]);
  rows.push([
    ...(first ? [Markup.button.url('✍️ Ubah di X (PC)', `https://x.com/intent/tweet?in_reply_to=${tid}&text=${encodeURIComponent(m.texts[first])}`)] : []),
    Markup.button.url('🔗 Tweet', `https://x.com/${m.username}/status/${tid}`),
    ...(m.replyId ? [Markup.button.url('🔗 Komentar', `https://x.com/i/status/${m.replyId}`)] : [])
  ]);
  return rows;
}
const busy = new Set();
const meId = async (b) => (db.brands[b].userId ||= (await clients[b].v2.me()).data.id);
bot.action(/^mx:([clf]):([a-z0-9_]+):(\d+)$/, async (ctx) => {
  // Laporan bisa dilihat subscriber channel: hanya ADMIN_IDS yang boleh menekan
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Khusus admin').catch(() => {});
  const [, a, b, tid] = ctx.match;
  const key = `${a}:${b}`;
  const alert = (t) => ctx.answerCbQuery(t.slice(0, 190), { show_alert: true }).catch(() => {});
  const m = db.manual[tid];
  if (!m || !m.brands.includes(b)) return alert('Tombol ini sudah kedaluwarsa (lebih dari 3 hari).');
  if (m.done[key]) return ctx.answerCbQuery('Sudah dilakukan ✅').catch(() => {});
  if (!clients[b]) return alert(`Akun X ${brandName(b)} belum tersambung.`);
  if (isDown(b) || limited(b)) return alert(`Akun ${brandName(b)} sedang jeda/dihentikan — coba lagi nanti.`);
  if (!withinLimits(b)) return alert(`Batas akun ${brandName(b)} tercapai (${db.limits.maxPerHour}/jam, ${db.limits.maxPerDay}/hari). Ubah di /menu → Jeda & Batas.`);
  if (busy.has(tid + key)) return ctx.answerCbQuery('Sedang diproses…').catch(() => {});
  busy.add(tid + key);
  try {
    const x = clients[b].v2;
    if (a === 'c') {
      const { data } = await x.reply(m.texts[b], tid);
      m.replyId = data.id;
      stat('replies', b);
    } else if (a === 'l') await x.like(await meId(b), tid);
    else await x.follow(await meId(b), m.authorId);
  } catch (e) {
    console.error('aksi tombol:', e);
    if (e?.code === 429) await xError(e, `${ACT_LABEL[a][0]} @${m.username}`, b);
    return alert(`❌ ${a === 'c' && cannotReply(e)
      ? 'X menolak komentar lewat API untuk tweet ini (project belum pernah me-mention / berinteraksi dengan akun brand). Pakai tombol ✍️ Ubah di X.'
      : e?.data?.detail || e?.data?.title || e.message}${a === 'c' ? '\nDi HP: 📋 Salin → 🔗 Tweet → Reply → tempel.' : ''}`);
  } finally {
    busy.delete(tid + key);
  }
  (db.sentAt[b] ||= []).push(Date.now());
  m.done[key] = Date.now(); save();
  await ctx.answerCbQuery({ c: `✅ Komentar terkirim dari ${brandLabel(b)}`, l: '✅ Di-like', f: `✅ @${m.username} di-follow` }[a].slice(0, 190)).catch(() => {});
  await ctx.editMessageReplyMarkup({ inline_keyboard: actionRows(tid) }).catch(() => {});
});

async function processProject(handle, channelName, t0, brand) {
  const x = clients[brand];
  if (!x) return report(`⚠️ Akun X ${esc(brandName(brand))} belum diatur. Pakai /menu → Akun X di DM bot.`);
  const f = db.filter;
  if (inFlight.has(handle) || cooling(handle)) return;
  inFlight.add(handle);
  try {
    const { data: user } = await x.v2.userByUsername(handle, USER_FIELDS);
    if (!user) return report(`⛔ <b>@${esc(handle)}</b> tidak ditemukan di X`);
    const why = filterWhy(user);
    if (why) {
      db.history[handle] = Date.now(); stat('skipped');
      return report(`⛔ <b>@${esc(handle)}</b> di-skip — ${esc(why)}\nSumber: ${esc(channelName)}`);
    }

    // Project opt-in -> komentar otomatis dari akun brand pilihan project
    const base = { handle, username: user.username, name: user.name, channel: channelName, brand };
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
  } finally {
    inFlight.delete(handle);
  }
}

// Hanya project opt-in yang dikomentari, oleh akun brand pilihannya; project lain cukup dilaporkan.
// Tunggu rate limit akun itu selesai, ulangi kalau error jaringan / server X
async function processSafe(handle, channelName, t0) {
  for (let tries = 0; tries < 3; tries++) {
    if (!db.optins[handle]) return notOptedIn(handle, channelName);
    const brand = brandOf(db.optins[handle]);
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

// ---------- Membaca channel Telegram ----------
// Tiga cara, dipilih otomatis per channel:
//  1. web publik: channel publik dibaca dari halaman t.me/s/<channel> — cukup BOT_TOKEN, bot TIDAK perlu admin
//  2. bot admin: post datang langsung lewat Bot API (channel privat milik sendiri)
//  3. akun listener (opsional, TG_API_ID/TG_API_HASH/TG_SESSION): akun Telegram biasa yang join channel
const LISTENER = !!(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);
const NOT_READ = 'belum terbaca';
let tg = null;
let tgDown = false;
let missing = []; // channel di db.channels yang belum bisa dibaca
const targets = new Map(); // channel di db.channels -> entity Telegram / { username, title } untuk web
const via = new Map(); // channel -> 'listener' | 'bot' | 'web'
const VIA = { listener: 'akun listener', bot: 'bot admin', web: 'web publik' };
const chanKeys = (chat) => [
  chat.username && '@' + chat.username.toLowerCase(),
  ...(chat.usernames || []).map((u) => '@' + u.username.toLowerCase()),
  `-100${chat.id}`, String(chat.id)
].filter(Boolean);
const matchChannel = (chat) => db.channels.find((c) => chanKeys(chat).includes(c.toLowerCase()));
const chanLine = (c) => `${targets.has(c) ? '✅' : '⚠️'} ${c}` + (targets.has(c) ? ` · ${VIA[via.get(c)]}` : ` (${NOT_READ})`);

// lastSeen satu kunci per channel (nama di db.channels), sama untuk semua cara baca,
// jadi pindah cara baca (mis. web → bot admin) tidak memproses post yang sama dua kali
function seenKey(ch, chat) {
  const old = chat?.id !== undefined && String(chat.id); // format lama: per id chat
  if (old && db.lastSeen[ch] === undefined && db.lastSeen[old] !== undefined) {
    db.lastSeen[ch] = db.lastSeen[old]; delete db.lastSeen[old];
  }
  return ch;
}

// Dipakai semua cara baca; lastSeen mencegah post diproses dua kali
function onChannelPost(msg, chat, t0, ch) {
  const key = seenKey(ch, chat);
  if (msg.id <= (db.lastSeen[key] || 0)) return false;
  db.lastSeen[key] = msg.id; save();
  if (db.paused) return false;
  const urls = (msg.entities || []).map((e) => e.url).filter(Boolean);
  for (const h of extractHandles(msg.message || '', urls)) processSafe(h, chat.title || chat.username, t0);
  return true;
}
const tooOld = (at) => Date.now() - at > db.auto.catchUpMaxAgeHours * 3600_000;

// Mode bot: post channel datang lewat Bot API. Post yang masuk saat bot mati disimpan Telegram
// sampai 24 jam, jadi tetap diproses saat bot hidup lagi (maks. catchUpMaxAgeHours)
function botChannelPost(post) {
  const ch = matchChannel(post.chat);
  if (!ch || via.get(ch) === 'listener') return; // dibaca akun listener
  if (via.get(ch) !== 'bot') { // bot baru dijadikan admin: langsung pakai jalur bot (instan, tanpa menunggu web)
    targets.set(ch, post.chat); via.set(ch, 'bot'); missing = missing.filter((m) => m !== ch);
  }
  const at = post.date * 1000;
  const key = seenKey(ch, post.chat);
  if (tooOld(at)) {
    db.lastSeen[key] = Math.max(db.lastSeen[key] || 0, post.message_id); save();
    return;
  }
  const msg = { id: post.message_id, message: post.text || post.caption || '', entities: post.entities || post.caption_entities };
  onChannelPost(msg, post.chat, Date.now() - at > 60_000 ? at : Date.now(), ch);
}

// ---------- Channel publik tanpa admin: halaman web t.me/s/<channel> ----------
// Channel publik punya halaman pratinjau yang bisa dibuka siapa saja, termasuk tanpa login.
// Bot membacanya berkala (auto.webPollSec) dan hanya memproses post yang lebih baru dari lastSeen.
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescapeHtml = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
  (m, d, h, n) => (d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : ENT[n.toLowerCase()]));
const webName = (c, chat) => (c.startsWith('@') ? c.slice(1) : chat?.username) || null;

function parseWebPosts(html) {
  const posts = [];
  for (const part of html.split('data-post="').slice(1)) {
    const id = Number(/^\w+\/(\d+)"/.exec(part)?.[1]);
    if (!id) continue;
    // Potong di awal post berikutnya / akhir daftar post: info channel (bio, link) tidak ikut terbaca
    const block = part.split(/tgme_widget_message_wrap|<\/section>|tgme_channel_info/)[0];
    // Teks post saja (bukan kutipan post yang dibalas); link diambil dari semua href di post (teks, tombol, preview)
    const text = [...block.matchAll(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
      .map((m) => unescapeHtml(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))).join('\n');
    const urls = [...block.matchAll(/href="(https?:[^"]+)"/g)].map((m) => unescapeHtml(m[1]));
    posts.push({ id, text, urls, date: Date.parse(/datetime="([^"]+)"/.exec(block)?.[1]) });
  }
  return posts;
}

let webPauseUntil = 0;
// null = tidak ada halaman publik (channel privat / bukan channel / username salah)
async function fetchWeb(name) {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(name)}`, {
    headers: { 'user-agent': WEB_UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(15_000)
  });
  if (res.status === 429) webPauseUntil = Date.now() + (Number(res.headers.get('retry-after')) || 60) * 1000;
  if (!res.ok) throw new Error(`t.me menjawab HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('data-post="')) return null;
  const title = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1];
  return { title: title ? unescapeHtml(title) : name, posts: parseWebPosts(html) };
}

const webFail = new Map(); // channel -> gagal berturut-turut
async function webPoll() {
  for (const [c, e] of targets) {
    if (via.get(c) !== 'web' || Date.now() < webPauseUntil) continue;
    try {
      const page = await fetchWeb(e.username);
      if (!page) throw new Error('halaman publik tidak tersedia (channel jadi privat / ganti username?)');
      if (webFail.get(c) >= 3) await report(`🔌 ${esc(c)} terbaca lagi dari web publik`);
      webFail.delete(c);
      e.title = page.title;
      const key = seenKey(c);
      if (db.lastSeen[key] === undefined) { // channel baru: mulai dari post terakhir, post lama tidak diproses
        db.lastSeen[key] = Math.max(0, ...page.posts.map((p) => p.id)); save();
        continue;
      }
      for (const p of page.posts.sort((a, b) => a.id - b.id)) {
        if (p.id <= db.lastSeen[key] || via.get(c) !== 'web') continue;
        const at = Math.min(p.date || Date.now(), Date.now()); // jam post asli: laporan menunjukkan jeda baca web yang sebenarnya
        if (tooOld(at)) { db.lastSeen[key] = p.id; save(); continue; }
        onChannelPost({ id: p.id, message: p.text, entities: p.urls.map((url) => ({ url })) }, e, at, c);
      }
    } catch (err) {
      const n = (webFail.get(c) || 0) + 1;
      webFail.set(c, n);
      console.error(`web ${c}:`, err.message);
      if (n === 3) await report(`⚠️ Gagal membaca ${esc(c)} dari web publik: ${esc(err.message)} — dicoba ulang otomatis`);
    }
  }
}
const WEB_POLL_MS = Number(process.env.WEB_POLL_MS) || 0; // dipercepat oleh npm test
async function webLoop() {
  try { await webPoll(); } catch (e) { console.error('webPoll:', e); }
  setTimeout(webLoop, WEB_POLL_MS || Math.max(10, db.auto.webPollSec) * 1000);
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

// Cocokkan db.channels dengan cara baca yang tersedia: akun listener sudah join → bot admin → web publik
async function refreshChannels() {
  const before = new Set(targets.keys());
  const old = new Map([...targets].map(([c, e]) => [c, [e, via.get(c)]]));
  const chats = new Map();
  targets.clear(); via.clear();
  if (LISTENER) {
    for (const d of await tg.getDialogs({})) {
      if (!d.isChannel || !d.entity) continue;
      for (const c of db.channels) if (chanKeys(d.entity).includes(c.toLowerCase())) { targets.set(c, d.entity); via.set(c, 'listener'); }
    }
    // Channel baru dipantau mulai dari post terakhir, post lama tidak diproses
    for (const [c, e] of targets) {
      const key = seenKey(c, e);
      if (db.lastSeen[key]) continue;
      const [last] = await tg.getMessages(e, { limit: 1 });
      db.lastSeen[key] = last?.id || 0;
    }
  }
  bot.botInfo ??= await bot.telegram.getMe();
  for (const c of db.channels) {
    if (targets.has(c)) continue;
    try {
      const chat = await bot.telegram.getChat(c); // channel publik: berhasil walau bot bukan anggota
      chats.set(c, chat);
      const m = await bot.telegram.getChatMember(chat.id, bot.botInfo.id);
      if (['administrator', 'creator'].includes(m.status)) { targets.set(c, chat); via.set(c, 'bot'); }
    } catch {} // channel privat / tidak ada / bot bukan anggota
  }
  for (const c of db.channels) {
    const name = !targets.has(c) && webName(c, chats.get(c));
    if (!name) continue;
    try {
      const page = await fetchWeb(name);
      if (!page) continue;
      targets.set(c, { username: name, title: page.title, read: page.posts.length, top: Math.max(0, ...page.posts.map((p) => p.id)) });
      via.set(c, 'web');
      const key = seenKey(c, chats.get(c));
      if (db.lastSeen[key] === undefined) db.lastSeen[key] = Math.max(0, ...page.posts.map((p) => p.id));
    } catch (e) { // t.me sedang tidak bisa dibuka: yang sudah terpantau lewat web tetap dipantau
      console.error(`web ${c}:`, e.message);
      if (old.get(c)?.[1] === 'web') { targets.set(c, old.get(c)[0]); via.set(c, 'web'); }
    }
  }
  save();
  missing = db.channels.filter((c) => !targets.has(c));
  return [...targets.keys()].filter((c) => !before.has(c)); // yang baru terpantau
}

// Ambil post yang terlewat (bot mati, koneksi putus) + sambung ulang listener
async function catchUp() {
  if (!LISTENER) return; // tanpa listener: Telegram mengirim ulang post bot yang tertunda, web dibaca ulang tiap putaran
  try {
    if (!tg.connected) await tg.connect();
    const minDate = Date.now() / 1000 - db.auto.catchUpMaxAgeHours * 3600;
    let n = 0;
    for (const [name, e] of targets) {
      if (via.get(name) !== 'listener') continue;
      const key = seenKey(name, e);
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
  for (const [k, log] of Object.entries(db.tplLog)) if (log.at(-1).at < Date.now() - 7 * DAY) delete db.tplLog[k];
  for (const [k, m] of Object.entries(db.manual)) if (m.at < Date.now() - 3 * DAY) delete db.manual[k];
  const file = backup();
  const s = db.stats;
  const perBrand = await Promise.all(Object.keys(db.brands).map(async (b) =>
    `${esc(brandName(b))}: ${esc(await accountStatus(b))} · ${s[`replies:${b}`] || 0} komentar`));
  await report(
    `📊 <b>Ringkasan harian</b>\nKomentar terkirim: ${s.replies || 0}\n` +
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
      if (joined.length) await report(`✅ Mulai dipantau: ${esc(joined.map((c) => `${c} (${VIA[via.get(c)]})`).join(', '))}`);
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
// Telegram menolak pesan > 4096 karakter: daftar panjang dikirim per potongan (dipotong di akhir baris)
async function replyLong(ctx, text) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n').flatMap((l) => l.match(/[\s\S]{1,4000}/g) || [''])) {
    if (cur && cur.length + 1 + line.length > 4000) { parts.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  parts.push(cur);
  for (const p of parts) await ctx.reply(p);
}

const HELP = `<b>Fourtis X Agent</b>
Paling mudah: /menu — semua pengaturan pakai tombol

<b>Akun X (1 akun per brand)</b>
/addaccount brand API_KEY API_KEY_SECRET ACCESS_TOKEN ACCESS_TOKEN_SECRET
/accounts — semua brand &amp; akun · /delaccount brand
/setx ... — sama dengan /addaccount untuk brand utama

<b>Channel</b> (publik: bot tidak perlu admin)
/addchannel @channel · /delchannel @channel · /channels
/setreport -100… — atur channel laporan (atau /menu → 📨 Channel laporan)

<b>Template per brand</b> (variabel: {name} {handle} {channel})
/tpls [brand] — lihat
/addtpl [brand] teks · /deltpl [brand] nomor — komentar

<b>Opt-in</b>
/optins · /addoptin @handle [brand] · /deloptin @handle

<b>Filter &amp; batas</b>
/filter — lihat · /filter minFollowers 500
/limits — lihat · /limits maxPerHour 20 (per akun)
/filter tweetsPerProject 3 — jumlah tweet terbaru yang dikomentari
/jeda — lihat · /jeda 5 · /jeda 3 6 (acak) · /jeda project 10

<b>Otomatis</b>
/auto — lihat · /auto watchOptins false · /auto dailyReportHour 8

/pause · /resume · /resume brand · /status

<b>Untuk project</b> (hanya kalau opt-in publik ON di /menu → Otomatis): /optin @handle [brand], /verify @handle`;

// Bot privat: hanya ADMIN_IDS. Project hanya bisa /optin sendiri kalau opt-in publik dinyalakan (panel Otomatis).
// Post channel lewat (dibaca bot / /setreport punya cek admin sendiri)
const PUBLIC_CMD = /^\/(start|optin|verify|optout)(@\w+)?(\s|$)/;
const noticeAt = new Map();
const pubAwait = new Map(); // project (bukan admin) yang membuka link opt-in -> waktu; balasan berikutnya = username X
bot.use((ctx, next) => {
  if (ctx.channelPost || isAdmin(ctx)) return next();
  if (db.auto.publicOptin && (PUBLIC_CMD.test(ctx.message?.text || '') || ctx.callbackQuery?.data?.startsWith('optin:'))) return next();
  const text = ctx.message?.text;
  if (db.auto.publicOptin && text && !text.startsWith('/') && ctx.chat?.type === 'private' &&
    Date.now() - (pubAwait.get(ctx.from.id) || 0) < 15 * 60_000) {
    const handle = norm(text.split(/\s+/)[0]);
    if (!validHandle(handle)) return ctx.reply('Username X tidak valid. Kirim lagi, contoh: @namaproject');
    pubAwait.delete(ctx.from.id);
    return optinFlow(ctx, handle);
  }
  if (ctx.callbackQuery) return ctx.answerCbQuery('Khusus admin').catch(() => {});
  if (ctx.chat?.type !== 'private' || !ctx.message) return;
  const id = ctx.from.id;
  console.log(`Pesan dari user ${id} (@${ctx.from.username || '-'}) diabaikan: bukan ADMIN_IDS`);
  if (Date.now() - (noticeAt.get(id) || 0) < 600_000) return; // balas maks. 1x per 10 menit
  noticeAt.set(id, Date.now());
  return ctx.replyWithHTML(`⛔ Bot ini privat — hanya untuk pemilik.\nID Telegram kamu: <code>${id}</code>`);
});

bot.start((ctx) => {
  if (isAdmin(ctx)) {
    setAdminCommands(ctx.chat.id);
    return showPanel(ctx, homePanel(), false);
  }
  // Juga untuk link opt-in 1-klik (t.me/bot?start=optin): langsung minta username X project
  const names = activeBrands().map(brandName).join(' / ') || 'kami';
  pubAwait.set(ctx.from.id, Date.now());
  return ctx.reply(`👋 Hi! Daftarkan project kamu supaya tweet-nya otomatis dikomentari (di-boost) oleh ${names}.\n\n` +
    'Kirim username X project kamu, contoh: @namaproject');
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
  return optinFlow(ctx, norm(h), b);
});
// Pilih brand (kalau lebih dari satu), lalu kode verifikasi bio
function optinFlow(ctx, handle, b) {
  if (!validHandle(handle)) return ctx.reply('Handle X tidak valid. Contoh: /optin @namaproject');
  const avail = activeBrands();
  if (!avail.length) return ctx.reply('Belum ada akun aktif. Coba lagi nanti.');
  if (b && !avail.includes(b.toLowerCase())) return ctx.reply(`Brand tidak dikenal. Pilihan: ${avail.join(', ')}`);
  const brand = b ? b.toLowerCase() : avail.length === 1 ? avail[0] : null;
  if (brand) return startOptin(ctx, handle, brand);
  if (db.optins[handle]) return ctx.reply(`Project ini sudah opt-in ke ${brandName(brandOf(db.optins[handle]))} ✅`);
  return ctx.reply(`Opt-in @${handle} ke brand mana?`,
    Markup.inlineKeyboard(avail.map((x) => Markup.button.callback(brandName(x), `optin:${x}:${handle}`))));
}
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
    return ctx.reply('Format: /addaccount brand API_KEY API_KEY_SECRET ACCESS_TOKEN ACCESS_TOKEN_SECRET\nContoh brand: fourtis, dexvra\nLebih mudah: /menu → Akun X → Hubungkan akun');
  }
  if (!/^[a-z0-9_]{2,20}$/.test(brand)) return ctx.reply('Nama brand: huruf kecil/angka tanpa spasi, contoh: dexvra');
  const [appKey, appSecret, accessToken, accessSecret] = keys;
  const creds = { appKey, appSecret, accessToken, accessSecret };
  const hadKeys = !!db.brands[brand]?.x;
  let me;
  try {
    ({ data: me } = await new TwitterApi(creds).readWrite.v2.me());
  } catch (e) {
    return ctx.reply('❌ Key tidak valid: ' + (e?.data?.detail || e.message) +
      '\n\nCek: urutannya 1. Consumer Key (API Key), 2. Secret Key (API Key Secret), 3. Access Token (diawali angka lalu "-"), 4. Access Token Secret; ' +
      'dan Access Token dibuat SETELAH App permissions = Read and write.' + (hadKeys ? '\nKey lama tetap dipakai.' : ''));
  }
  // Satu akun X hanya untuk satu brand (dua brand di satu akun = konten dobel)
  const dup = Object.entries(db.brands).find(([b, v]) => b !== brand && v.x && v.username?.toLowerCase() === me.username.toLowerCase());
  if (dup) return ctx.reply(`❌ @${me.username} sudah dipakai brand ${brandName(dup[0])}. Satu akun X hanya untuk satu brand.`);
  const isNew = !db.brands[brand];
  db.brands[brand] ||= newBrand(brand);
  Object.assign(db.brands[brand], { x: creds, username: me.username, userId: me.id });
  delete db.brandDown[brand]; failStreak[brand] = 0;
  initClients(); save();
  ctx.reply(
    `✅ Akun X ${brandName(brand)} ${hadKeys ? 'diganti' : 'tersambung'}: @${me.username}\n` +
    `Bot akan berkomentar sebagai @${me.username} — pastikan ini memang akun X ${brandName(brand)}.\n(pesan berisi kode sudah dihapus)` +
    (isNew ? `\n\nBrand baru "${brand}" dibuat dengan template contoh. Ganti dengan /addtpl ${brand} ...` : '')
  );
  runQueue();
}
bot.command('addaccount', (ctx) => {
  const [, brand, ...keys] = ctx.message.text.split(/\s+/);
  return setAccount(ctx, brand?.toLowerCase(), keys);
});
bot.command('setx', (ctx) => setAccount(ctx, db.defaultBrand, ctx.message.text.split(/\s+/).slice(1)));
function delAccount(b) {
  Object.assign(db.brands[b], { x: null, username: null, userId: null });
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
    const ops = Object.values(db.optins).filter((o) => brandOf(o) === b).length;
    return `<b>${esc(v.name)}</b> (${b})${b === db.defaultBrand ? ' · utama' : ''}\nAkun X: ${esc(await accountStatus(b))}\n` +
      `Opt-in: ${ops} · Template komentar: ${v.templates.length}`;
  }));
  save();
  ctx.replyWithHTML(lines.join('\n\n') + '\n\nTambah/ganti akun: /menu → Akun X (atau /addaccount brand API_KEY API_KEY_SECRET ACCESS_TOKEN ACCESS_TOKEN_SECRET)');
});

// ---------- Channel ----------
// Terima @channel, link t.me/channel (juga t.me/s/channel atau link post), link post privat t.me/c/…, atau ID -100…
const INVITE = /(?:t|telegram)\.me\/(?:\+|joinchat\/)/i;
const TME = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i;
function normChannel(s) {
  const priv = new RegExp(TME.source + /c\/(\d{5,})(?:\/\d+)*\/?(?:\?.*)?$/.source, 'i').exec(s);
  if (priv) return '-100' + priv[1];
  const m = new RegExp(TME.source + /(?:s\/)?([a-z]\w{3,31})(?:\/\d+)?\/?(?:\?.*)?$/.source, 'i').exec(s);
  const c = (m ? '@' + m[1] : s).toLowerCase();
  return /^(@[a-z]\w{3,31}|-100\d{5,})$/.test(c) ? c : null;
}
const CH_FORMAT = 'Contoh: @namachannel, link https://t.me/namachannel, atau ID -1001234567890';
const PRIVATE_LINK = 'Itu link undangan channel PRIVAT — tidak punya halaman publik. Channel privat hanya bisa dibaca kalau bot dijadikan admin di sana' +
  `${LISTENER ? ' atau akun listener join' : ''}. Setelah itu tambahkan pakai link salah satu post-nya (https://t.me/c/…) atau ID -100….`;

// Channel tidak punya brand: project opt-in selalu dikomentari akun brand yang dipilih project itu
async function addChannel(c) {
  const key = c.toLowerCase();
  if (!db.channels.includes(key)) db.channels.push(key);
  save();
  await refreshChannels().catch((e) => console.error('refreshChannels:', e));
  if (via.get(key) === 'web') {
    const e = targets.get(key);
    return `✅ ${c} ditambahkan & dipantau lewat halaman web publik t.me — bot tidak perlu jadi admin.\n` +
      `Terbaca ${e.read} post terakhir (terbaru #${e.top}); post lama tidak diproses. Post baru diproses dalam ±${db.auto.webPollSec} detik.`;
  }
  return targets.has(key)
    ? `✅ ${c} ditambahkan & sudah dipantau (${VIA[via.get(key)]}).`
    : `⚠️ ${c} ditambahkan, tapi BELUM bisa dibaca: ${key.startsWith('@') ? 'channel privat atau username salah' : 'channel privat'}.\n` +
      (key.startsWith('@') ? `• Channel publik: cek lagi ejaan (buka t.me/s/${key.slice(1)} di browser — harus muncul daftar post).\n` : '') +
      `• Channel privat: hanya bisa dibaca kalau bot dijadikan admin${LISTENER ? ' atau akun listener join' : ''}.\n` +
      'Bot cek ulang otomatis tiap 30 menit.';
}
function delChannel(c) {
  db.channels = db.channels.filter((x) => x !== c); delete db.lastSeen[c];
  targets.delete(c); via.delete(c); webFail.delete(c); missing = missing.filter((m) => m !== c);
  save();
}
bot.command('addchannel', async (ctx) => {
  const raw = ctx.message.text.split(/\s+/)[1];
  if (!raw) return ctx.reply(`Format: /addchannel @channel\n${CH_FORMAT}`);
  if (INVITE.test(raw)) return ctx.reply(PRIVATE_LINK);
  const c = normChannel(raw);
  if (!c) return ctx.reply(`Format channel salah. ${CH_FORMAT}`);
  ctx.reply(await addChannel(c));
});
bot.command('delchannel', (ctx) => {
  const raw = ctx.message.text.split(/\s+/)[1] || '';
  delChannel(normChannel(raw) || raw.toLowerCase());
  ctx.reply('Dihapus.');
});
bot.command('channels', (ctx) => replyLong(ctx, db.channels.length
  ? db.channels.map(chanLine).join('\n')
  : 'Belum ada channel.'));

// Kirim pesan tes dulu; disimpan hanya kalau bot benar-benar bisa posting ke sana
async function setReportChat(target) {
  const id = /^-?\d+$/.test(String(target)) ? Number(target) : target;
  try {
    const m = await bot.telegram.sendMessage(id, '📊 Channel laporan aktif — semua laporan bot dikirim ke sini.');
    db.reportChat = m.chat?.id ?? id; save();
    return `✅ Laporan sekarang dikirim ke ${m.chat?.title || id}. Di sana muncul pesan "Channel laporan aktif".`;
  } catch (e) {
    return `❌ Bot tidak bisa mengirim pesan ke ${id} (${e.description || e.message}).\n` +
      'Pastikan bot sudah jadi ADMIN di channel itu dengan izin "Post Messages", dan ID-nya benar (diawali -100).' +
      (db.reportChat ? ' Channel laporan lama tetap dipakai.' : '');
  }
}
const reportTarget = (s) => (/^-?\d+$/.test(s) ? (/^-100\d{5,}$/.test(s) ? s : null) : normChannel(s));
bot.command('setreport', async (ctx) => {
  const arg = ctx.message?.text.split(/\s+/)[1];
  if (!arg) return ctx.reply(await setReportChat(ctx.chat.id)); // laporan ke chat ini
  const t = reportTarget(arg);
  if (!t) return ctx.reply('Format: /setreport -1001234567890 (ID channel laporan) atau /setreport @namachannel');
  ctx.reply(await setReportChat(t));
});
bot.on('channel_post', async (ctx, next) => {
  if (ctx.channelPost.text?.startsWith('/setreport')) {
    // Post channel tidak membawa pengirim: pastikan salah satu ADMIN_IDS adalah admin channel ini
    const admins = await ctx.getChatAdministrators().catch(() => []);
    if (!admins.some((a) => ADMINS.includes(String(a.user.id)))) return;
    db.reportChat = ctx.chat.id; save();
    return ctx.reply('📊 Channel laporan aktif.');
  }
  botChannelPost(ctx.channelPost);
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
  return `✅ Template komentar ${brandName(b)} #${db.brands[b][field].length}:\n${t}`;
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
bot.command('tpls', (ctx) => {
  const b = findBrand(ctx.message.text.split(/\s+/)[1]);
  const show = (k) => {
    const v = db.brands[k];
    const list = (l) => l.map((t, i) => `${i + 1}. ${t}`).join('\n');
    return `== ${v.name} ==\nKomentar:\n${list(v.templates)}`;
  };
  return replyLong(ctx, (b ? [b] : Object.keys(db.brands)).map(show).join('\n\n'));
});

// ---------- Opt-in (admin) ----------
bot.command('optins', (ctx) => {
  const list = Object.entries(db.optins);
  const pending = Object.entries(db.pending);
  return replyLong(ctx, (list.length ? `Opt-in (${list.length}):\n` + list.map(([h, o]) => `@${h} → ${brandName(brandOf(o))}`).join('\n') : 'Belum ada.') +
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
    (LISTENER ? `Listener Telegram: ${tg?.connected ? '✅' : '❌'}\n` : 'Mode: bot saja (channel publik dibaca dari web t.me, tanpa admin)\n') +
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
const FIELD = { k: 'templates' };
const awaiting = new Map(); // admin -> { kind, brand, field, at }: bot menunggu balasan teks
const accIcon = (b) => (!clients[b] ? '❌' : isDown(b) ? '🛑' : limited(b) ? '⏸' : '✅');
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);

// Satu baris pilihan: label + nilai preset; nilai yang aktif diberi ✅
// Judul pengaturan selebar layar (tidak terpotong di HP), pilihan angkanya di baris bawahnya
function optionRows(label, path, values, fmt = String) {
  const [o, k] = path.split('.');
  return [[btn(label, 'm:noop')], values.map((v) => btn(`${db[o][k] === v ? '✅ ' : ''}${fmt(v)}`, `m:set:${path}:${v}`))];
}
const mnt = (v) => `${v} mnt`;

function homePanel() {
  const acc = Object.keys(db.brands).map((b) => `${esc(brandName(b))} ${accIcon(b)}`).join(' · ');
  return {
    text: `⚙️ <b>Panel pengaturan</b>\n\nStatus: ${db.paused ? '⏸ pause' : '🟢 jalan'}${LISTENER ? '' : ' · mode bot saja'}\n` +
      `Akun X: ${acc}\nChannel: ${targets.size}/${db.channels.length} terpantau · Opt-in: ${Object.keys(db.optins).length} · Antrian: ${db.queue.length}` +
      (db.reportChat ? '' : '\n⚠️ Channel laporan belum diatur — tekan 📨 Channel laporan') + '\n\nPilih menu:',
    rows: [
      [btn('📊 Status', 'm:status'), btn('👤 Akun X', 'm:acc')],
      [btn('📢 Channel', 'm:ch'), btn('📝 Template', 'm:tplb')],
      [btn('🤝 Opt-in', 'm:opt'), btn('⏱ Jeda & Batas', 'm:lim')],
      [btn('🔎 Filter', 'm:flt'), btn('🤖 Otomatis', 'm:auto')],
      [btn(`📨 Channel laporan ${db.reportChat ? '✅' : '❌'}`, 'm:ask:report')],
      [db.paused ? btn('▶️ Jalankan lagi', 'm:resume') : btn('⏸ Pause semua', 'm:pause'), btn('❓ Bantuan', 'm:help')]
    ]
  };
}
function accountsPanel(checked = {}) {
  const lines = Object.entries(db.brands).map(([b, v]) => {
    const st = checked[b] || (!clients[b] ? '❌ belum ada akun'
      : `${accIcon(b)} @${v.username || '?'}${isDown(b) ? ' · dihentikan' : limited(b) ? ' · rate limit' : ''}`);
    const ops = Object.values(db.optins).filter((o) => brandOf(o) === b).length;
    return `<b>${esc(v.name)}</b>: ${esc(st)}\n   opt-in ${ops}`;
  });
  const rows = Object.entries(db.brands).map(([b, v]) => [
    btn(`${v.x ? '🔑 Ganti' : '➕ Hubungkan'} akun ${v.name}`, `m:conn:${b}`),
    ...(isDown(b) || limited(b) ? [btn('▶️ Jalankan', `m:accres:${b}`)] : []),
    ...(v.x ? [btn('🗑', `m:accdel:${b}`)] : [])
  ]);
  rows.push([btn('➕ Brand baru', 'm:ask:newbrand'), btn('🔄 Cek akun', 'm:acccek')], HOME);
  return { text: `👤 <b>Akun X</b> (1 akun per brand)\n\n${lines.join('\n\n')}`, rows };
}
function channelsPanel() {
  const lines = db.channels.slice(0, 40).map((c) => esc(chanLine(c)));
  const rows = chunk(db.channels.slice(0, 40).map((c) => btn(`🗑 ${c}`, `m:chdel:${c}`)), 2);
  rows.push([btn('➕ Tambah channel', 'm:ask:channel'), btn('🔄 Cek ulang', 'm:chref')], HOME);
  return {
    text: '📢 <b>Channel target</b>\nChannel <b>publik</b> siapa pun: cukup tambah @username — dibaca dari web t.me, bot TIDAK perlu admin. ' +
      `Channel privat: bot harus admin${LISTENER ? ' / akun listener join' : ''}.\n` +
      'Channel berlaku untuk semua brand: project opt-in dikomentari akun brand pilihannya. Tombol 🗑 = hapus channel.\n\n' +
      (lines.join('\n') || 'Belum ada channel.') + (db.channels.length > 40 ? `\n… +${db.channels.length - 40} lagi (/channels)` : ''),
    rows
  };
}
function tplBrandPanel() {
  return { text: '📝 <b>Template</b> — pilih brand:', rows: [Object.entries(db.brands).map(([b, v]) => btn(v.name, `m:tpl:${b}`)), HOME] };
}
function tplPanel(b) {
  const v = db.brands[b];
  // Maks. 15 per jenis supaya muat batas Telegram (4096 karakter, 100 tombol); sisanya lewat /tpls
  const list = (l) => l.slice(0, 15).map((t, i) => `${i + 1}. ${esc(t.length > 100 ? t.slice(0, 100) + '…' : t)}`).join('\n') +
    (l.length > 15 ? `\n… +${l.length - 15} lagi (/tpls ${b})` : '');
  return {
    text: `📝 <b>Template komentar ${esc(v.name)}</b>\nBot memilih salah satu secara bergiliran saat berkomentar di tweet project opt-in.\n` +
      `Variabel: {name} nama project · {handle} username X · {channel} nama channel\n\n${list(v.templates)}`,
    rows: [
      [btn('➕ Tambah komentar', `m:ask:tpl:${b}:k`)],
      ...chunk(v.templates.slice(0, 15).map((_, i) => btn(`🗑 ${i + 1}`, `m:tdel:${b}:k:${i + 1}`)), 5),
      [btn('⬅️ Pilih brand', 'm:tplb'), ...HOME]
    ]
  };
}
const optinLink = () => `https://t.me/${bot.botInfo?.username || 'NAMA_BOT'}?start=optin`;
function optPanel() {
  const list = Object.entries(db.optins);
  const lines = list.slice(0, 30).map(([h, o]) => `@${esc(h)} → ${esc(brandName(brandOf(o)))}`);
  return {
    text: '🤝 <b>Opt-in</b> = daftar project yang SUDAH SETUJU dikomentari akun brand Anda (mis. klien / beli paket promosi).\n' +
      'Bot HANYA berkomentar di tweet project yang ada di daftar ini. Komentar otomatis ke akun yang tidak setuju = spam menurut X ' +
      'dan bisa membuat akun brand di-suspend.\n\n' +
      `<b>Daftar (${list.length})</b>\n${lines.join('\n') || '⚠️ Masih kosong — bot belum akan berkomentar ke project mana pun.'}` +
      `${list.length > 30 ? `\n… +${list.length - 30} lagi (/optins)` : ''}\n\n` +
      '<b>Cara menambah</b>\n• ➕ Opt-in manual: kirim @handle X project yang sudah setuju, pilih brand-nya.\n' +
      (db.auto.publicOptin
        ? `• 🔗 <b>Link opt-in 1-klik</b> — sebar ke project (bio, website, DM): ${esc(optinLink())}\n` +
          `  Project klik → kirim username X → pasang kode di bio → otomatis aktif (menunggu verifikasi: ${Object.keys(db.pending).length}).`
        : '• Atau biarkan project daftar sendiri lewat link opt-in 1-klik: nyalakan Opt-in publik di 🤖 Otomatis.'),
    rows: [[btn('➕ Opt-in manual', 'm:ask:optin'), btn('🗑 Hapus opt-in', 'm:ask:deloptin')], HOME]
  };
}
const GAPS = [[30, 90], [60, 180], [180, 360], [300, 600]];
function limPanel() {
  const { minDelaySec: lo, maxDelaySec: hi } = db.limits;
  const { replyGapMin: gap, maxRepliesPerProjectPerDay: perDay } = db.auto;
  const n = db.filter.tweetsPerProject;
  return {
    text: '⏱ <b>Jeda &amp; Batas</b>\nMengatur seberapa cepat dan seberapa banyak bot berkomentar. ' +
      'Berlaku untuk tiap akun X sendiri-sendiri.\n\n' +
      `1️⃣ <b>Jeda antar aksi: ${fmtGap()}</b>\nBot menunggu selama ini sebelum komentar berikutnya, supaya terlihat seperti manusia.\n\n` +
      `2️⃣ <b>Jeda di project yang sama: ${gap} menit</b>\nKalau 1 project punya beberapa tweet baru, komentarnya tidak dikirim sekaligus: ` +
      `komentar tweet ke-1 → tunggu ${gap} menit → komentar tweet ke-2. Project lain tetap jalan seperti biasa.\n\n` +
      `3️⃣ <b>Tweet yang dikomentari: ${n} terbaru</b>\nHanya ${n} tweet paling baru dari tiap project yang dikomentari.\n\n` +
      `4️⃣ <b>Maks. komentar per project: ${perDay}x sehari</b>\n\n` +
      `5️⃣ <b>Batas akun: ${db.limits.maxPerHour}x per jam, ${db.limits.maxPerDay}x per hari</b>\nTotal semua komentar dari satu akun. ` +
      'Lewat batas → bot menunggu sendiri.\n\n' +
      `📌 <b>Contoh</b> dengan setelan ini: project opt-in punya 10 tweet → bot berkomentar di ${Math.min(n, perDay)} tweet terbarunya, ` +
      `satu per satu dengan jarak ${gap} menit.\n\nTekan angka di bawah untuk mengubah (✅ = yang dipakai sekarang).\n` +
      '<i>Angka lain: /jeda 2 4 (jeda acak 2–4 menit) · /limits maxPerHour 15</i>',
    rows: [
      [btn('1️⃣ Jeda antar aksi', 'm:noop')],
      GAPS.map(([a, b]) => btn(`${lo === a && hi === b ? '✅ ' : ''}${a < 60 ? `${a}-${b} dtk` : `${a / 60}-${b / 60} mnt`}`, `m:gap:${a}:${b}`)),
      ...optionRows('2️⃣ Jeda komentar di project yang sama', 'auto.replyGapMin', [2, 5, 10, 30], mnt),
      ...optionRows('3️⃣ Berapa tweet terbaru dikomentari', 'filter.tweetsPerProject', [1, 2, 3, 5], (v) => `${v} tweet`),
      ...optionRows('4️⃣ Maks. komentar per project sehari', 'auto.maxRepliesPerProjectPerDay', [1, 2, 3, 5], (v) => `${v}x`),
      ...optionRows('5️⃣ Batas akun per JAM', 'limits.maxPerHour', [10, 20, 30, 50], (v) => `${v}x`),
      ...optionRows('5️⃣ Batas akun per HARI', 'limits.maxPerDay', [30, 50, 100, 200], (v) => `${v}x`),
      HOME
    ]
  };
}
function fltPanel() {
  const f = db.filter;
  return {
    text: '🔎 <b>Filter project</b>\nProject yang tidak lolos filter dilewati (tidak dikomentari) dan dilaporkan ke channel laporan.\n\n' +
      `1️⃣ <b>Min. followers: ${f.minFollowers}</b>\nAkun X project harus punya minimal segini followers.\n\n` +
      `2️⃣ <b>Min. umur akun: ${f.minAgeDays} hari</b>\nAkun X yang lebih baru dari ini dilewati (akun baru sering scam).\n\n` +
      `3️⃣ <b>Jeda project yang sama: ${f.cooldownDays} hari</b>\nKalau project yang sama di-posting lagi di channel (mis. PAID lalu BOOST), ` +
      `bot mengabaikannya selama ${f.cooldownDays} hari supaya tidak dikomentari/dilaporkan berulang. ` +
      'Tweet BARU project opt-in tetap dikomentari lewat pantauan otomatis.\n\n' +
      `4️⃣ <b>Umur tweet maks.: ${f.maxTweetAgeHours} jam</b>\nBot hanya berkomentar di tweet project yang diposting dalam ${f.maxTweetAgeHours} jam terakhir. ` +
      'Tweet yang lebih lama dilewati (sudah sepi, komentar telat terlihat aneh).\n\n' +
      `5️⃣ <b>Kata terlarang: ${esc(f.blacklist.join(', ') || '-')}</b>\nProject dengan kata ini di nama/bio dilewati.\n\n` +
      'Tekan angka di bawah untuk mengubah (✅ = yang dipakai sekarang).',
    rows: [
      ...optionRows('1️⃣ Min. followers', 'filter.minFollowers', [0, 100, 500, 1000, 5000], (v) => (!v ? 'Bebas' : v >= 1000 ? `${v / 1000}rb` : `${v}`)),
      ...optionRows('2️⃣ Min. umur akun X', 'filter.minAgeDays', [0, 7, 14, 30], (v) => (!v ? 'Bebas' : `${v} hari`)),
      ...optionRows('3️⃣ Jeda project yang sama', 'filter.cooldownDays', [1, 3, 7, 14], (v) => `${v} hari`),
      ...optionRows('4️⃣ Umur tweet maks.', 'filter.maxTweetAgeHours', [12, 24, 48, 72], (v) => `${v} jam`),
      [btn('5️⃣ ✏️ Ubah kata terlarang', 'm:ask:blacklist')],
      HOME
    ]
  };
}
function autoPanel() {
  const a = db.auto;
  return {
    text: '🤖 <b>Otomatis</b>\nHal-hal yang bot kerjakan sendiri.\n\n' +
      `⏱ <b>Pantau tweet baru project opt-in: ${a.watchOptins ? 'ON' : 'OFF'}</b> (cek tiap ${a.watchIntervalMin} menit)\n` +
      'Tweet baru dari project opt-in langsung dikomentari, tanpa menunggu ada post di channel.\n\n' +
      `📢 <b>Baca channel publik: tiap ${a.webPollSec} detik</b>\nSeberapa sering bot membuka halaman web channel target.\n\n` +
      `💬 <b>Komentar 1-tap (project belum opt-in): ${a.manualAssist ? 'ON' : 'OFF'}</b>\n` +
      'Bot menyiapkan komentar untuk project yang muncul di channel.\n\n' +
      `🆓 <b>Mode hemat (tanpa API X): ${a.freeMode ? 'ON' : 'OFF'}</b>\n` +
      (a.freeMode
        ? 'Gratis, tidak memakai kredit X: laporan berisi 📋 Salin + 👤 Profil X; reply, like &amp; follow dilakukan di X.'
        : 'Bot mencari tweet terbaru project (memakai kredit X, ±2 per project): laporan berisi 📋 Salin + 🔗 Tweet terbaru. ' +
          'Kredit habis / error X → otomatis link 👤 Profil X.') + '\n\n' +
      `✅ <b>Verifikasi opt-in otomatis: ${a.autoVerify ? 'ON' : 'OFF'}</b>\nBot mengecek sendiri kode opt-in di bio project.\n\n` +
      `📊 <b>Ringkasan harian + backup: jam ${a.dailyReportHour}.00</b>\n\n` +
      `🔓 <b>Opt-in publik: ${a.publicOptin ? 'ON' : 'OFF'}</b>\n` +
      (a.publicOptin ? 'Project bisa daftar sendiri lewat /optin.' : 'Bot privat, hanya Anda. ON = project bisa daftar sendiri lewat /optin.'),
    rows: [
      [btn(`Pantau tweet opt-in: ${a.watchOptins ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.watchOptins')],
      ...optionRows('⏱ Cek tweet baru opt-in tiap', 'auto.watchIntervalMin', [5, 10, 15, 30], mnt),
      ...optionRows('📢 Baca channel publik tiap', 'auto.webPollSec', [15, 30, 60, 120], (v) => `${v} dtk`),
      [btn(`Komentar 1-tap: ${a.manualAssist ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.manualAssist')],
      [btn(`Mode hemat (tanpa API X): ${a.freeMode ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.freeMode')],
      [btn(`Verifikasi otomatis: ${a.autoVerify ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.autoVerify')],
      [btn(`Opt-in publik (/optin project): ${a.publicOptin ? '✅ ON' : '❌ OFF'}`, 'm:tog:auto.publicOptin')],
      ...optionRows('📊 Ringkasan harian jam', 'auto.dailyReportHour', [7, 8, 9, 12], (v) => `${v}.00`),
      HOME
    ]
  };
}
// Hanya nilai ini yang bisa diubah lewat tombol (+ panel yang ditampilkan ulang)
const SETTABLE = {
  'limits.maxPerHour': limPanel, 'limits.maxPerDay': limPanel, 'auto.replyGapMin': limPanel,
  'filter.tweetsPerProject': limPanel, 'auto.maxRepliesPerProjectPerDay': limPanel,
  'filter.minFollowers': fltPanel, 'filter.minAgeDays': fltPanel, 'filter.cooldownDays': fltPanel, 'filter.maxTweetAgeHours': fltPanel,
  'auto.watchIntervalMin': autoPanel, 'auto.dailyReportHour': autoPanel, 'auto.webPollSec': autoPanel
};
const TOGGLE = {
  'auto.watchOptins': autoPanel, 'auto.autoVerify': autoPanel, 'auto.publicOptin': autoPanel, 'auto.manualAssist': autoPanel,
  'auto.freeMode': autoPanel
};

// Nama di console.x.com (nama lama di developer portal dalam kurung)
const KEY_STEPS = ['Consumer Key (API Key)', 'Secret Key (API Key Secret)', 'Access Token', 'Access Token Secret'];
const NOT_USED = '❌ Tidak dipakai: Bearer Token, dan semua di bagian OAuth 2.0 (Client ID, Client Secret, Access Token).';
const nameOf = (b) => esc(db.brands[b]?.name || newBrand(b).name);
// Kenali kode yang salah tempel sebelum dikirim ke X
function keyMistake(step, v) {
  if (/^A{8,}/.test(v) || v.includes('%')) return 'Itu Bearer Token — tidak dipakai.';
  if (/^[A-Za-z0-9+/=_-]{20,60}$/.test(v) && /:\d+:ci$/.test(Buffer.from(v, 'base64').toString('latin1'))) {
    return 'Itu Client ID (OAuth 2.0) — tidak dipakai.';
  }
  const access = /^\d+-\w+$/.test(v);
  if (step === 2 && !access) return 'Access Token selalu diawali angka lalu tanda "-" (contoh 123456789-AbCd…). Kode ini sepertinya bukan Access Token.';
  if (step !== 2 && access) return `Ini Access Token (diawali angka lalu "-"), padahal yang diminta sekarang ${KEY_STEPS[step]}.`;
  if (v.length < 20) return 'Kode ini terlalu pendek — pastikan tersalin utuh (pakai tombol copy di console X).';
  return null;
}
// Pilihan cara menghubungkan akun X ke brand
function connPanel(b) {
  const name = nameOf(b);
  const donors = Object.entries(db.brands).filter(([k, v]) => k !== b && v.x);
  return {
    text: `🔗 <b>Hubungkan akun X ${name}</b> — pilih cara:\n\n` +
      `<b>🔗 Login X (disarankan)</b>\nCukup 2 kode app (Consumer Key + Secret Key), lalu buka link dari bot, login sebagai akun X ${name}, dan kirim PIN yang muncul. ` +
      'Satu app developer bisa dipakai untuk semua brand.\n\n' +
      `<b>🔑 4 kode manual</b>\nConsumer Key, Secret Key, Access Token, Access Token Secret dari console X. ` +
      `Access Token di console selalu milik akun yang login ke console ("For @…") — harus akun X ${name}.`,
    rows: [
      [btn('🔗 Login X (disarankan)', `m:ask:oauth:${b}`)],
      ...donors.map(([k, v]) => [btn(`🔗 Login X pakai app ${v.name}`, `m:oauthreuse:${b}:${k}`)]),
      [btn('🔑 4 kode manual', `m:ask:keys:${b}`)],
      [btn('📷 Tutorial bergambar', 'm:guide'), btn('⬅️ Akun X', 'm:acc')]
    ]
  };
}
// Gambar tutorial (assets/, dibuat oleh assets/make-tutorial.py — ilustrasi, tanpa data asli)
const asset = (n) => fileURLToPath(new URL(`../assets/${n}`, import.meta.url));
const GUIDE = {
  izin: [asset('tutorial-1-izin.png'), 'Langkah 1 (sekali per app): User authentication settings → Read and write + Web App, Automated App or Bot → isi URL website → Save Changes.'],
  kode: [asset('tutorial-2-kode.png'), 'Langkah 2: ambil kode HANYA dari bagian OAuth 1.0 Keys. Bearer Token & semua OAuth 2.0 tidak dipakai.'],
  pin: [asset('tutorial-3-pin.png'), 'Login X: buka link dari bot → login sebagai akun BRAND → Authorize app → kirim PIN ke bot.']
};
// Kirim gambar tutorial; kalau gagal, alur tetap jalan (panduan teks tetap dikirim)
async function sendGuide(ctx, names, captions = {}) {
  try {
    const media = names.map((n) => ({ type: 'photo', media: { source: GUIDE[n][0] }, caption: captions[n] || GUIDE[n][1] }));
    if (media.length === 1) await ctx.replyWithPhoto(media[0].media, { caption: media[0].caption });
    else await ctx.replyWithMediaGroup(media);
  } catch (e) {
    console.error('tutorial:', e.message);
  }
}
const OAUTH_KODE = 'Langkah 2 untuk Login X: cukup baris Consumer Key → Regenerate → salin Consumer Key + Secret Key. Access Token tidak perlu.';

// Login X lewat PIN (OAuth 1.0a): link otorisasi untuk akun brand, token didapat dari PIN
async function startPinLogin(ctx, brand, appKey, appSecret) {
  let link;
  try {
    link = await new TwitterApi({ appKey, appSecret }).generateAuthLink('oob', { linkMode: 'authorize', forceLogin: true });
  } catch (e) {
    return ctx.reply(`❌ Gagal membuat link login: ${e?.data?.detail || e?.data?.errors?.[0]?.message || e.message}\n\n` +
      'Cek: Consumer Key + Secret Key benar, dan di console X → app → User authentication settings sudah disimpan (Read and write). ' +
      'Atau pakai "🔑 4 kode manual".');
  }
  awaiting.set(ctx.from.id, { kind: 'pin', brand, appKey, appSecret, token: link.oauth_token, secret: link.oauth_token_secret, at: Date.now() });
  await sendGuide(ctx, ['pin']);
  return ctx.replyWithHTML(
    `🔗 <b>Login X untuk ${nameOf(brand)}</b> — langkah terakhir (lihat gambar di atas)\n\n` +
    `1. Buka link ini: <a href="${esc(link.url)}">Login &amp; izinkan akses</a>\n` +
    `2. Login sebagai akun X <b>${nameOf(brand)}</b> (bukan akun pribadi), lalu klik <b>Authorize app</b>\n` +
    '3. X menampilkan <b>PIN</b> (7 angka) → kirim PIN itu ke sini\n\nLink berlaku ±15 menit. /batal untuk batal.',
    { disable_web_page_preview: true }
  );
}
const PROMPTS = {
  keys: (b) => `🔑 <b>Hubungkan akun X ${nameOf(b)} — 4 kode manual</b> (lihat 2 gambar di atas)\n\n` +
    'Di console.x.com → <b>Apps</b> → app Anda, bagian <b>OAuth 1.0 Keys</b>:\n' +
    `• Baris <b>Consumer Key</b> → klik Regenerate → muncul:\n   1. ${KEY_STEPS[0]}\n   2. ${KEY_STEPS[1]}\n` +
    `• Baris <b>Access Token</b> → klik Generate/Regenerate → muncul:\n   3. ${KEY_STEPS[2]}\n   4. ${KEY_STEPS[3]}\n` +
    `   Harus tertulis <b>Read and write</b> dan <b>For @akun-X-${nameOf(b)}</b>.\n\n${NOT_USED}\n\n` +
    `👉 Kirim sekarang: <b>1. ${KEY_STEPS[0]}</b>\n` +
    '(Boleh juga keempatnya sekaligus, dipisah spasi, urut 1–4.)\n\nPesan berisi kode langsung dihapus. /batal untuk batal.',
  oauth: (b) => `🔗 <b>Login X untuk ${nameOf(b)}</b> — kirim 2 kode app (lihat gambar di atas)\n\n` +
    'Di console.x.com → <b>Apps</b> → app Anda → <b>OAuth 1.0 Keys</b> → baris <b>Consumer Key</b> → klik Regenerate:\n' +
    `   1. ${KEY_STEPS[0]}\n   2. ${KEY_STEPS[1]}\n` +
    'App harus sudah diatur <b>Read and write</b> (User authentication settings).\n\n' + `${NOT_USED}\n\n` +
    `👉 Kirim sekarang: <b>1. ${KEY_STEPS[0]}</b>\n\nPesan berisi kode langsung dihapus. /batal untuk batal.`,
  newbrand: () => '➕ <b>Brand baru</b>\n\nKirim nama brand: huruf kecil/angka tanpa spasi, contoh <code>nova</code>.\n' +
    'Setelah itu pilih cara menghubungkan akun X-nya. /batal untuk batal.',
  channel: () => '📢 Kirim username channel (contoh <code>@namachannel</code>) atau link <code>https://t.me/namachannel</code>\n' +
    'Channel publik milik siapa pun bisa — bot tidak perlu jadi admin. /batal untuk batal.',
  tpl: (b) => `📝 Kirim teks template komentar untuk <b>${esc(brandName(b))}</b>.\n` +
    'Variabel: <code>{name}</code> nama project, <code>{handle}</code> username X, <code>{channel}</code> nama channel.\n' +
    'Contoh: <code>Love seeing {name} keep shipping 🚀</code>\n/batal untuk batal.',
  optin: () => '🤝 Kirim @handle X project yang sudah setuju (mis. beli paket listing). /batal untuk batal.',
  deloptin: () => '🗑 Kirim @handle project yang opt-in-nya mau dihapus. /batal untuk batal.',
  report: () => '📨 <b>Channel laporan</b>\nSemua laporan bot (komentar terkirim, project baru, error, ringkasan harian) dikirim ke sini.\n' +
    `Sekarang: ${db.reportChat ? `<code>${esc(String(db.reportChat))}</code>` : 'belum diatur'}\n\n` +
    '1. Jadikan bot ADMIN di channel laporan (izin Post Messages).\n' +
    '2. Kirim ID channel itu di sini, contoh <code>-1001234567890</code> (atau @username channel).\n\n' +
    'Bot langsung mengirim pesan tes ke sana. /batal untuk batal.',
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

// Kumpulkan kode satu per satu (atau beberapa sekaligus); pesan berisi kode langsung dihapus.
// Kembalikan daftar kode kalau sudah lengkap, selain itu balas dengan langkah berikutnya
async function collectKeys(ctx, a, need) {
  try { await ctx.deleteMessage(); } catch {}
  const got = [...(a.got || [])];
  for (const v of ctx.message.text.trim().split(/\s+/).filter(Boolean)) {
    const bad = keyMistake(got.length, v);
    if (bad) {
      awaiting.set(ctx.from.id, { ...a, got, at: Date.now() });
      await ctx.replyWithHTML(`⚠️ ${esc(bad)}\n👉 Kirim lagi: <b>${got.length + 1}. ${KEY_STEPS[got.length]}</b>`);
      return null;
    }
    got.push(v);
    if (got.length === need) return got;
  }
  awaiting.set(ctx.from.id, { ...a, got, at: Date.now() });
  await ctx.replyWithHTML(`✅ ${KEY_STEPS[got.length - 1]} diterima (${got.length}/${need}).\n👉 Sekarang kirim: <b>${got.length + 1}. ${KEY_STEPS[got.length]}</b>`);
  return null;
}

async function handleInput(ctx, a) {
  const text = ctx.message.text.trim();
  const again = (msg) => { awaiting.set(ctx.from.id, { ...a, at: Date.now() }); return ctx.reply(msg); };
  const brands = Object.keys(db.brands);
  switch (a.kind) {
    case 'keys': {
      const got = await collectKeys(ctx, a, 4);
      if (!got) return;
      await setAccount(ctx, a.brand, got);
      return showPanel(ctx, accountsPanel(), false);
    }
    case 'oauth': {
      const got = await collectKeys(ctx, a, 2);
      if (got) return startPinLogin(ctx, a.brand, got[0], got[1]);
      return;
    }
    case 'pin': {
      const pin = text.replace(/\D/g, '');
      if (pin.length < 6) return again('PIN berupa angka (7 digit) yang muncul di halaman X setelah klik Authorize app. Kirim lagi, atau /batal');
      let res;
      try {
        res = await new TwitterApi({ appKey: a.appKey, appSecret: a.appSecret, accessToken: a.token, accessSecret: a.secret }).login(pin);
      } catch (e) {
        return ctx.reply(`❌ PIN ditolak: ${e?.data?.detail || e.message}\nPIN hanya berlaku sekali dan sebentar. Ulangi dari /menu → Akun X → Hubungkan.`);
      }
      await setAccount(ctx, a.brand, [a.appKey, a.appSecret, res.accessToken, res.accessSecret]);
      return showPanel(ctx, accountsPanel(), false);
    }
    case 'newbrand': {
      const b = text.toLowerCase();
      if (!/^[a-z0-9_]{2,20}$/.test(b)) return again('Nama brand: huruf kecil/angka tanpa spasi, contoh: nova. Kirim lagi, atau /batal');
      if (db.brands[b]) return again(`Brand "${b}" sudah ada. Pakai tombol Hubungkan/Ganti akun di panel, atau kirim nama lain.`);
      return showPanel(ctx, connPanel(b), false);
    }
    case 'channel': {
      const raw = text.split(/\s+/)[0];
      if (INVITE.test(raw)) return again(`${PRIVATE_LINK}\nKirim channel lain, atau /batal`);
      const c = normChannel(raw);
      if (!c) return again(`Format salah. ${CH_FORMAT}. Kirim lagi, atau /batal`);
      await ctx.reply(await addChannel(c));
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
    case 'report': {
      const t = reportTarget(text.split(/\s+/)[0]);
      if (!t) return again('Format salah. Kirim ID channel diawali -100, contoh -1001234567890. Kirim lagi, atau /batal');
      const r = await setReportChat(t);
      if (r.startsWith('❌')) return again(`${r}\nKirim lagi setelah diperbaiki, atau /batal`);
      await ctx.reply(r);
      return showPanel(ctx, homePanel(), false);
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
    case 'conn': if (/^[a-z0-9_]{2,20}$/.test(arg)) panel = connPanel(arg); break;
    case 'guide':
      await ctx.answerCbQuery('Mengirim tutorial…').catch(() => {});
      return sendGuide(ctx, ['izin', 'kode', 'pin']);
    case 'oauthreuse': {
      const [b, from] = args;
      const app = db.brands[from]?.x;
      if (!/^[a-z0-9_]{2,20}$/.test(b) || !app) break;
      await ctx.answerCbQuery().catch(() => {});
      return startPinLogin(ctx, b, app.appKey, app.appSecret);
    }
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
        text: `Yakin lepas akun X <b>${esc(brandLabel(arg))}</b>? Template &amp; opt-in brand ini tetap disimpan.`,
        rows: [[btn('🗑 Ya, lepas', `m:accdelok:${arg}`), btn('Batal', 'm:acc')]]
      };
      break;
    case 'accdelok': if (db.brands[arg]?.x) toast = 'Akun dilepas'; if (toast) delAccount(arg); panel = accountsPanel(); break;
    case 'ch': panel = channelsPanel(); break;
    case 'chref': await refreshChannels().catch((e) => console.error('refreshChannels:', e)); toast = 'Dicek ulang'; panel = channelsPanel(); break;
    case 'chdel': delChannel(arg); toast = 'Channel dihapus'; panel = channelsPanel(); break;
    case 'tplb': panel = Object.keys(db.brands).length === 1 ? tplPanel(db.defaultBrand) : tplBrandPanel(); break;
    case 'tpl': panel = tplPanel(findBrand(arg) || db.defaultBrand); break;
    case 'tdel': {
      const [b, f, n] = args;
      if (!findBrand(b) || !FIELD[f]) break;
      toast = tplDel(b, FIELD[f], Number(n)); panel = tplPanel(b);
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
      if (arg === 'auto.publicOptin') await setPublicCommands();
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
      if (!PROMPTS[kind] || (['keys', 'oauth'].includes(kind) && !/^[a-z0-9_]{2,20}$/.test(b || '')) ||
        (kind === 'tpl' && (!findBrand(b) || !FIELD[f]))) break;
      awaiting.set(ctx.from.id, { kind, brand: b, field: f, at: Date.now() });
      await ctx.answerCbQuery().catch(() => {});
      if (kind === 'keys') await sendGuide(ctx, ['izin', 'kode']);
      if (kind === 'oauth') await sendGuide(ctx, ['izin', 'kode'], { kode: OAUTH_KODE });
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
// Menu "/" untuk orang lain: kosong kalau bot privat
function setPublicCommands() {
  return (db.auto.publicOptin ? bot.telegram.setMyCommands(PUBLIC_COMMANDS) : bot.telegram.deleteMyCommands())
    .catch((e) => console.error('setMyCommands:', e.message));
}
async function setupCommands() {
  await setPublicCommands();
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
  console.log('Mode bot saja: channel publik dibaca dari web t.me, channel privat lewat bot admin');
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
  `${missing.length ? `\n⚠️ Belum terbaca (privat / username salah): ${esc(missing.join(', '))}` : ''}` +
  `\nOpt-in: ${Object.keys(db.optins).length}\nAntrian dilanjutkan: ${db.queue.length}` +
  `${db.paused ? '\n⏸ Masih di-pause manual (/resume)' : ''}`
);
save();
runQueue();
setInterval(tick, TICK);
webLoop();

function stop(sig) {
  try { bot.stop(sig); } catch {}
  save();
  Promise.resolve(tg?.disconnect()).catch(() => {}).finally(() => process.exit(0));
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
