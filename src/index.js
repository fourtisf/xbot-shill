import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { TwitterApi } from 'twitter-api-v2';
import { db, save } from './db.js';

const ADMINS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const bot = new Telegraf(process.env.BOT_TOKEN);
const isAdmin = (ctx) => ADMINS.includes(String(ctx.from?.id));
const norm = (h) => h.replace(/^@/, '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const esc = (s = '') => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- X client ----------
let x = null;
function initX() {
  x = db.x ? new TwitterApi(db.x).readWrite : null;
}
initX();

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

// ---------- Ekstrak handle X dari post ----------
const RESERVED = new Set(['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'settings']);
function extractHandles(text, urls) {
  const all = [text, ...urls].join(' ');
  const re = /(?:twitter\.com|x\.com)\/(?:#!\/)?([A-Za-z0-9_]{1,15})/gi;
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

// ---------- Antrian dengan batas aman ----------
const queue = [];
const sentAt = [];
let running = false;
function enqueue(job) {
  queue.push(job);
  runQueue();
}
async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    if (db.paused) { await sleep(10_000); continue; }
    const hourAgo = Date.now() - 3600_000;
    while (sentAt.length && sentAt[0] < hourAgo) sentAt.shift();
    if (sentAt.length >= db.limits.maxPerHour) { await sleep(60_000); continue; }
    const job = queue.shift();
    try {
      await job();
    } catch (e) {
      console.error('job error:', e);
      const code = e?.code || e?.data?.status;
      await report(`⚠️ <b>Error X API</b> (${esc(code)})\n${esc(e?.data?.detail || e.message)}`);
      if (code === 429) { db.paused = true; save(); await report('⏸ Bot di-pause otomatis karena rate limit. Ketik /resume nanti.'); }
    }
    sentAt.push(Date.now());
    if (queue.length) await sleep(rand(db.limits.minDelaySec, db.limits.maxDelaySec) * 1000);
  }
  running = false;
}

// ---------- Proses satu project ----------
async function processProject(handle, channelName, t0) {
  if (!x) return report('⚠️ Akun X belum diatur. Pakai /setx di DM bot.');
  const f = db.filter;
  const last = db.history[handle];
  if (last && Date.now() - last < f.cooldownDays * 86400_000) return;

  const { data: user } = await x.v2.userByUsername(handle, {
    'user.fields': ['public_metrics', 'created_at', 'description', 'name']
  });
  if (!user) return report(`⛔ <b>@${esc(handle)}</b> tidak ditemukan di X`);

  // Filter
  const ageDays = (Date.now() - new Date(user.created_at)) / 86400_000;
  const followers = user.public_metrics?.followers_count ?? 0;
  const text = `${user.name} ${user.description}`.toLowerCase();
  const bad = f.blacklist.find((w) => w && text.includes(w.toLowerCase()));
  let why = null;
  if (followers < f.minFollowers) why = `followers ${followers} < ${f.minFollowers}`;
  else if (ageDays < f.minAgeDays) why = `umur akun ${Math.floor(ageDays)} hari < ${f.minAgeDays}`;
  else if (bad) why = `kata terlarang "${bad}"`;
  if (why) {
    db.history[handle] = Date.now(); save();
    return report(`⛔ <b>@${esc(handle)}</b> di-skip — ${esc(why)}\nSumber: ${esc(channelName)}`);
  }

  db.history[handle] = Date.now(); save();
  const vars = { name: user.name, handle: user.username, channel: channelName };
  const followBtn = Markup.button.url('👤 Follow', `https://x.com/intent/follow?screen_name=${user.username}`);

  if (db.optins[handle]) {
    // Project opt-in -> komentar otomatis
    const tl = await x.v2.userTimeline(user.id, {
      max_results: 5, exclude: ['replies', 'retweets'], 'tweet.fields': ['created_at']
    });
    const maxAge = f.maxTweetAgeHours * 3600_000;
    const tweets = (tl.tweets || [])
      .filter((t) => Date.now() - new Date(t.created_at) < maxAge)
      .slice(0, f.tweetsPerProject);
    if (!tweets.length) return report(`ℹ️ <b>@${esc(handle)}</b> (opt-in) tidak punya tweet baru ≤ ${f.maxTweetAgeHours} jam`);

    for (const tw of tweets) {
      enqueue(async () => {
        const body = fill(pickTemplate(), vars);
        const { data } = await x.v2.reply(body, tw.id);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        await report(
          `✅ <b>Komentar terkirim</b>\nProject: <b>@${esc(user.username)}</b>\nSumber: ${esc(channelName)}\n` +
          `Tweet: "${esc(tw.text.slice(0, 90))}…"\nKomentar: "${esc(body)}"\n<i>${secs}s setelah post channel</i>`,
          [[followBtn, Markup.button.url('🔗 Buka', `https://x.com/i/status/${data.id}`)]]
        );
      });
    }
  } else if (db.ownTweetEnabled) {
    // Belum opt-in -> akun bot tweet sendiri (tanpa reply ke project)
    enqueue(async () => {
      const body = fill(db.ownTweetTemplate, vars);
      const { data } = await x.v2.tweet(body);
      await report(
        `🐦 <b>Tweet bot</b> tentang <b>@${esc(user.username)}</b> (belum opt-in)\nSumber: ${esc(channelName)}\n"${esc(body)}"`,
        [[followBtn, Markup.button.url('🔗 Buka', `https://x.com/i/status/${data.id}`)]]
      );
    });
  } else {
    await report(`ℹ️ <b>@${esc(handle)}</b> belum opt-in — dilewati\nSumber: ${esc(channelName)}`, [[followBtn]]);
  }
}

// ---------- Listener channel Telegram ----------
async function startListener() {
  const client = new TelegramClient(
    new StringSession(process.env.TG_SESSION || ''),
    Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 10 }
  );
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error('TG_SESSION belum valid. Jalankan: npm run login');

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg?.isChannel || db.paused) return;
      const chat = await msg.getChat();
      const keys = [chat.username && '@' + chat.username.toLowerCase(), `-100${chat.id}`, String(chat.id)].filter(Boolean);
      if (!db.channels.some((c) => keys.includes(c.toLowerCase()))) return;

      const t0 = Date.now();
      const urls = (msg.entities || []).map((e) => e.url).filter(Boolean);
      const handles = extractHandles(msg.message || '', urls);
      for (const h of handles) processProject(h, chat.title || chat.username, t0).catch(async (e) => {
        console.error(e);
        await report(`⚠️ Gagal proses @${esc(h)}: ${esc(e?.data?.detail || e.message)}`);
      });
    } catch (e) {
      console.error('listener error:', e);
    }
  }, new NewMessage({}));
  console.log('Listener Telegram aktif');
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

/pause · /resume · /status

<b>Untuk project</b>: /optin @handle lalu /verify @handle`;

bot.start((ctx) => ctx.replyWithHTML(isAdmin(ctx) ? HELP :
  'Hi! Mau tweet project kamu otomatis di-boost oleh Fourtis?\nKetik /optin @handle_x_project_kamu'));
bot.command('help', (ctx) => isAdmin(ctx) && ctx.replyWithHTML(HELP));

// Opt-in publik dengan verifikasi bio
bot.command('optin', async (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  if (!h) return ctx.reply('Format: /optin @handle_x');
  const handle = norm(h);
  if (db.optins[handle]) return ctx.reply('Project ini sudah opt-in ✅');
  const code = 'FTS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  db.pending[handle] = { code, by: ctx.from.id }; save();
  ctx.replyWithHTML(
    `Untuk verifikasi kepemilikan @${esc(handle)}:\n1. Tambahkan kode <code>${code}</code> ke bio X kamu\n` +
    `2. Ketik /verify @${esc(handle)}\n3. Setelah terverifikasi, kode boleh dihapus dari bio.\n\n` +
    `Dengan opt-in, kamu setuju akun Fourtis berkomentar otomatis di tweet project kamu. Batalkan kapan saja dengan /optout @${esc(handle)}`
  );
});

bot.command('verify', async (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  if (!h || !x) return ctx.reply('Format: /verify @handle_x');
  const handle = norm(h);
  const p = db.pending[handle];
  if (!p || p.by !== ctx.from.id) return ctx.reply('Mulai dulu dengan /optin @' + handle);
  const { data: u } = await x.v2.userByUsername(handle, { 'user.fields': ['description'] });
  if (!u?.description?.includes(p.code)) return ctx.reply(`Kode ${p.code} belum ditemukan di bio @${handle}. Coba lagi setelah bio di-update.`);
  db.optins[handle] = { at: Date.now(), via: 'verify', by: ctx.from.id };
  delete db.pending[handle]; save();
  ctx.reply(`✅ @${handle} terverifikasi & opt-in aktif.`);
  report(`🆕 <b>Opt-in baru</b>: @${esc(handle)} (verifikasi bio)`);
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
  db.x = { appKey, appSecret, accessToken, accessSecret };
  initX();
  try {
    const { data } = await x.v2.me();
    save();
    ctx.reply(`✅ Akun X tersambung: @${data.username}\n(pesan berisi key sudah dihapus)`);
  } catch (e) {
    db.x = null; initX();
    ctx.reply('❌ Key tidak valid: ' + (e?.data?.detail || e.message));
  }
});

bot.command('xstatus', async (ctx) => {
  if (!x) return ctx.reply('Akun X belum diatur.');
  const { data } = await x.v2.me();
  ctx.reply(`Akun X aktif: @${data.username}`);
});

bot.command('addchannel', (ctx) => {
  const c = ctx.message.text.split(/\s+/)[1];
  if (!c) return ctx.reply('Format: /addchannel @channel  (atau -100xxxxxxxx)');
  if (!db.channels.includes(c.toLowerCase())) db.channels.push(c.toLowerCase());
  save(); ctx.reply(`✅ ${c} ditambahkan. Pastikan akun listener sudah join channel ini.`);
});
bot.command('delchannel', (ctx) => {
  const c = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
  db.channels = db.channels.filter((x) => x !== c); save(); ctx.reply('Dihapus.');
});
bot.command('channels', (ctx) => ctx.reply(db.channels.length ? db.channels.join('\n') : 'Belum ada channel.'));

bot.command('setreport', (ctx) => {
  const arg = ctx.message?.text.split(/\s+/)[1];
  db.reportChat = arg || ctx.chat.id; save();
  bot.telegram.sendMessage(db.reportChat, '📊 Channel laporan aktif.').catch((e) => console.error(e.message));
});
bot.on('channel_post', (ctx, next) => {
  if (ctx.channelPost.text?.startsWith('/setreport')) {
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
  ctx.reply(list.length ? `Opt-in (${list.length}):\n` + list.map((h) => '@' + h).join('\n') : 'Belum ada.');
});
bot.command('addoptin', (ctx) => {
  const h = ctx.message.text.split(/\s+/)[1];
  if (!h) return ctx.reply('Format: /addoptin @handle — hanya untuk project yang sudah setuju (mis. paket listing)');
  db.optins[norm(h)] = { at: Date.now(), via: 'admin' }; save();
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
  obj[k] = Array.isArray(obj[k]) ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : typeof obj[k] === 'boolean' ? v === 'true' : Number(v);
  save(); ctx.reply(`✅ ${k} = ${obj[k]}`);
}
bot.command('filter', (ctx) => kv(db.filter, ctx, 'Filter'));
bot.command('limits', (ctx) => kv(db.limits, ctx, 'Batas'));

bot.command('pause', (ctx) => { db.paused = true; save(); ctx.reply('⏸ Bot di-pause.'); });
bot.command('resume', (ctx) => { db.paused = false; save(); ctx.reply('▶️ Bot jalan lagi.'); runQueue(); });
bot.command('status', (ctx) => ctx.replyWithHTML(
  `<b>Status</b>: ${db.paused ? '⏸ pause' : '🟢 jalan'}\nAkun X: ${db.x ? '✅' : '❌'}\n` +
  `Channel: ${db.channels.length}\nChannel laporan: ${db.reportChat ? '✅' : '❌'}\n` +
  `Opt-in: ${Object.keys(db.optins).length}\nTemplate: ${db.templates.length}\nAntrian: ${queue.length}\n` +
  `Terkirim 1 jam terakhir: ${sentAt.filter((t) => t > Date.now() - 3600_000).length}/${db.limits.maxPerHour}`
));

// ---------- Start ----------
bot.catch((e) => console.error('bot error:', e));
await startListener();
bot.launch();
console.log('Bot Telegram aktif');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
