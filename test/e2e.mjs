// Test end-to-end: menjalankan src/index.js ASLI dengan Telegram & X di-mock.
// Jalankan: npm test
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xagent-test-'));
const DB_FILE = path.join(tmp, 'data.json');
const REPORT = -100500;
const ADMIN = 111;
const now = Date.now();
const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
const unix = (ms) => Math.floor(ms / 1000);
// ID tweet asli (snowflake) menyimpan waktu pembuatan
const snow = (ms, seq = 0) => String(((BigInt(ms) - 1288834974657n) << 22n) + BigInt(seq));
const T1 = snow(now, 1);
const T2 = snow(now, 2);

// ---------- State dunia palsu ----------
const channel = (id, username, title, joined, history = []) =>
  ({ entity: { id: BigInt(id), username, title }, joined, history, lastId: history.length });
const msg = (id, text, date = unix(now)) => ({ id, message: text, entities: [], date, isChannel: true });
const user = (id, username, name, followers = 5000, extra = {}) =>
  ({ id, username, name, description: '', created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: followers }, ...extra });

const alpha = channel(1001, 'alpha', 'Alpha Calls', true, [
  msg(1, 'old post', unix(now - 86400_000)), msg(2, 'old', unix(now - 86400_000)), msg(3, 'old', unix(now - 86400_000)),
  msg(4, 'Missed while offline: https://x.com/MissedProj', unix(now - 10 * 60_000)) // post saat bot mati
]);
const beta = channel(1002, 'beta', 'Beta Gems', false); // listener belum join
const gamma = channel(1003, 'gamma', 'Not A Target', true);

const users = Object.fromEntries([
  user('u1', 'OptProj', 'Opt Project'),
  user('u2', 'NewProj', 'New Project'),
  user('u3', 'TinyProj', 'Tiny', 10),
  user('u4', 'ScamProj', 'Scam Project', 5000, { description: 'definitely not a scam' }),
  user('u5', 'MissedProj', 'Missed'),
  user('u6', 'join', 'Join', 90000), user('u7', 'register', 'Register', 90000), user('u8', 'account', 'Account', 90000),
  user('u9', 'PendProj', 'Pending Project'),
  user('u10', 'VerProj', 'Verify Project'),
  user('u11', 'RateProj', 'Rate Project'),
  user('u12', 'DayProj', 'Day Project'),
  user('u13', 'NetProj', 'Net Project'),
  user('u14', 'PausedProj', 'Paused'),
  user('u15', 'OfflineProj', 'Offline'),
  user('u16', 'WwwProj', 'Www'), user('u17', 'FxProj', 'Fx'),
  user('u18', 'DupProj', 'Dup'),
  user('u19', 'GammaProj', 'Gamma')
].map((u) => [u.username.toLowerCase(), u]));

const M = globalThis.__mock = {
  channels: [alpha, beta, gamma],
  chatAdmins: {},
  botCalls: [],
  x: {
    users,
    timelines: {
      u1: [{ id: '1700000000000000001', text: 'gm we shipped v2', created_at: hoursAgo(1) }],
      u10: [{ id: '1700000000000000010', text: 'verproj update', created_at: hoursAgo(1) }]
    },
    searchResults: [], calls: [], failNext: {}, n: 0
  }
};

// Data awal = kondisi setelah restart: ada antrian tersimpan & post yang terlewat
fs.writeFileSync(DB_FILE, JSON.stringify({
  x: { appKey: 'k', appSecret: 's', accessToken: 't', accessSecret: 'a' },
  channels: ['@alpha', '@beta'],
  reportChat: REPORT,
  // Format data versi lama (satu akun, template global): ikut menguji migrasi ke brand
  templates: ['Love seeing {name} 🚀', '{name} keeps shipping 🔥', 'Big week for {name} 👀'],
  ownTweetTemplate: '🚀 New project spotted: {name}\nVia {channel}\nx.com/{handle}',
  filter: { minFollowers: 500, minAgeDays: 14, blacklist: ['scam', 'rug'] }, filterOffDefault: true, // filter dinyalakan untuk diuji
  optins: { optproj: { at: now, via: 'admin' }, queuedproj: { at: now, via: 'admin' } },
  lastSeen: { 1001: 3 },
  queue: [
    { type: 'tweet', handle: 'oldtweet', username: 'OldTweet', name: 'Old', channel: 'Alpha Calls', at: now }, // tweet bot (sudah dihapus): dibuang
    { type: 'reply', handle: 'queuedproj', username: 'QueuedProj', name: 'Queued', channel: 'Alpha Calls', userId: 'uq', tweetId: '1700000000000000077', tweetText: 'queued news', at: now }
  ],
  limits: { minDelaySec: 0, maxDelaySec: 0, maxPerHour: 1000, maxPerDay: 1000 }, // test melakukan banyak aksi
  auto: { catchUpMin: 1, watchIntervalMin: 1, verifyIntervalMin: 1, dailyReportHour: 23, replyGapMin: 0, publicOptin: true, manualAssist: false },
  lastDaily: new Date().toDateString()
}));

Object.assign(process.env, {
  DB_FILE, BOT_TOKEN: '123:test', ADMIN_IDS: String(ADMIN),
  TG_API_ID: '1', TG_API_HASH: 'hash', TG_SESSION: 'session', TICK_MS: '100', WEB_POLL_MS: '100'
});

// ---------- Helper ----------
const sent = () => M.botCalls.filter((c) => c.method === 'sendMessage');
const reports = () => sent().filter((c) => c.payload.chat_id === REPORT).map((c) => c.payload.text);
const messagesTo = (id) => sent().filter((c) => String(c.payload.chat_id) === String(id)).map((c) => c.payload.text);
const xcalls = (name) => M.x.calls.filter((c) => c[0] === name);
const lookedUp = (h) => xcalls('userByUsername').filter((c) => c[1] === h).length;
// Project yang terbaca dari channel: yang opt-in dicari di X, yang belum opt-in cukup dilaporkan (tanpa API X)
const seen = (h) => reports().filter((r) => r.includes(`<b>@${h}</b> belum opt-in`)).length + lookedUp(h);
async function until(fn, label, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('timeout menunggu: ' + label);
}
const reportMatching = (s) => until(() => reports().find((r) => r.includes(s)), `laporan "${s}"`);
const tick = (n = 3) => sleep(100 * n + 50);

function post(ch, text, { live = true } = {}) {
  const m = { ...msg(++ch.lastId, text), getChat: async () => ch.entity };
  ch.history.push(m);
  if (live) for (const h of M.tg.handlers) h({ message: m });
  return m;
}
let updateId = 1;
async function dm(from, text) {
  const cmd = text.split(' ')[0];
  await M.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: updateId, date: unix(Date.now()), text,
      chat: { id: from, type: 'private', first_name: 'u' },
      from: { id: from, is_bot: false, first_name: 'u' },
      entities: cmd.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: cmd.length }] : []
    }
  });
  await sleep(30);
  return messagesTo(from).at(-1);
}
async function tap(from, data) {
  await M.bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId), from: { id: from, is_bot: false, first_name: 'u' }, chat_instance: '1', data,
      message: { message_id: updateId, date: unix(Date.now()), chat: { id: from, type: 'private', first_name: 'u' }, text: 'pilih' }
    }
  });
  await sleep(30);
  return messagesTo(from).at(-1);
}
async function channelPost(chatId, text) {
  await M.bot.handleUpdate({
    update_id: updateId++,
    channel_post: {
      message_id: updateId, date: unix(Date.now()), text, chat: { id: chatId, type: 'channel', title: 'c' },
      entities: [{ type: 'bot_command', offset: 0, length: text.length }]
    }
  });
}
const rateLimitError = (rateLimit) => Object.assign(new Error('Too Many Requests'), { code: 429, rateLimit, data: { title: 'Too Many Requests' } });

// ---------- Jalankan bot ----------
await import('./mocks/web.mjs'); // halaman web t.me palsu (tanpa jaringan)
register('./mocks/hooks.mjs', import.meta.url);
await import('../src/index.js');
const { db } = await import('../src/db.js'); // instance yang sama dengan yang dipakai bot

// Project opt-in dengan 1 tweet baru: untuk test yang butuh aksi nyata di X (komentar)
let optSeq = 900;
function optedIn(username, brand) {
  const h = username.toLowerCase();
  users[h] ||= user('u' + ++optSeq, username, username.replace(/Proj$/, ' Project'));
  db.optins[h] = { at: Date.now(), via: 'admin', ...(brand ? { brand } : {}) };
  const tid = snow(Date.now(), ++optSeq);
  M.x.timelines[users[h].id] = [{ id: tid, text: `${username} news`, created_at: new Date().toISOString() }];
  return tid;
}
const repliesTo = (tid) => xcalls('reply').filter((c) => c[2] === tid);
const xErr = (code, detail) => Object.assign(new Error(detail), { code, data: { detail } });

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log('  ✔', name);
  } catch (e) {
    results.push([false, name]);
    console.log('  ✘', name, '\n    ', e.message);
  }
}

console.log('Fourtis X Agent — test end-to-end\n');

await test('startup: laporan "Bot online", akun X, channel yang belum di-join', async () => {
  const r = await reportMatching('Bot online');
  assert.match(r, /@fourtisbot/);
  assert.match(r, /Channel terpantau: 1\/2/);
  assert.match(r, /Belum terbaca \(privat \/ username salah\): @beta/);
});

await test('restart: post channel yang terlewat saat bot mati diproses (catch-up)', async () => {
  await until(() => seen('missedproj'), 'MissedProj terbaca');
  await reportMatching('post channel yang terlewat');
  assert.equal(db.lastSeen['@alpha'], 4); // kunci lama (id chat) dipindah ke nama channel
  assert.equal(db.lastSeen['1001'], undefined);
});

await test('restart: antrian tersimpan dilanjutkan; tweet bot lama di antrian dibuang', async () => {
  await until(() => xcalls('reply').some((c) => c[2] === '1700000000000000077'), 'komentar Queued');
  assert.ok(!db.queue.some((j) => j.type === 'tweet'));
});

await test('project opt-in di channel → komentar di tweet terbarunya', async () => {
  post(alpha, 'New gem 👀 https://x.com/OptProj');
  const c = await until(() => xcalls('reply').find((c) => c[2] === '1700000000000000001'), 'reply OptProj');
  assert.ok(['Love seeing Opt Project 🚀', 'Opt Project keeps shipping 🔥', 'Big week for Opt Project 👀'].includes(c[1]), c[1]);
  assert.equal(c.at(-1), 'k'); // akun Fourtis
  const r = await reportMatching('Project: <b>@OptProj</b>');
  assert.match(r, /Komentar terkirim/);
  assert.match(r, /setelah post channel/);
  assert.match(r, /Like &amp; Follow: tekan tombol — dikirim dari Fourtis \(@fourtisbot\)/);
  const kb = sent().find((m) => m.payload.text === r).payload.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.filter((b) => b.callback_data).map((b) => b.callback_data),
    ['mx:l:fourtis:1700000000000000001', 'mx:f:fourtis:1700000000000000001']);
  assert.equal(xcalls('like').length + xcalls('follow').length, 0); // tidak pernah like/follow otomatis
});

await test('project belum opt-in → tidak ada aksi di X (tanpa kuota API X), hanya dilaporkan + tombol Follow', async () => {
  post(alpha, 'Check x.com/NewProj');
  const r = await reportMatching('<b>@newproj</b> belum opt-in — tidak dikomentari');
  assert.match(r, /Sumber: Alpha Calls/);
  const kb = sent().find((m) => m.payload.text === r).payload.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.url), ['https://x.com/intent/follow?screen_name=newproj']);
  await tick(3);
  assert.equal(lookedUp('newproj'), 0);
  assert.equal(xcalls('reply').filter((c) => c[1].includes('New Project')).length, 0);
});

await test('filter (kalau dinyalakan): project opt-in dengan followers kurang & kata terlarang di-skip', async () => {
  db.optins.tinyproj = { at: Date.now(), via: 'admin' };
  db.optins.scamproj = { at: Date.now(), via: 'admin' };
  post(alpha, 'x.com/TinyProj and twitter.com/ScamProj');
  await reportMatching('followers 10 &lt; 500');
  await reportMatching('kata terlarang "scam"');
  await tick();
  assert.equal(xcalls('reply').filter((c) => /Tiny|Scam/.test(c[1])).length, 0);
  delete db.optins.tinyproj; delete db.optins.scamproj;
});

await test('link exchange (okx.com, coinex.com, phemex.com) tidak dianggap project', async () => {
  post(alpha, 'Trade https://www.okx.com/join/ABC, coinex.com/register, phemex.com/account');
  await tick(5);
  assert.equal(seen('join') + seen('register') + seen('account'), 0);
});

await test('link www.x.com / fxtwitter dikenali, handle > 15 karakter diabaikan', async () => {
  post(alpha, 'https://www.x.com/WwwProj https://fxtwitter.com/FxProj/status/1 x.com/averyveryverylonghandle');
  await until(() => seen('wwwproj') && seen('fxproj'), 'lookup www/fx');
  assert.ok(!reports().some((r) => r.includes('averyvery')));
});

await test('channel yang bukan target diabaikan', async () => {
  post(gamma, 'x.com/GammaProj');
  await tick(5);
  assert.equal(seen('gammaproj'), 0);
});

await test('cooldown: project yang sama tidak diproses ulang', async () => {
  post(alpha, 'again x.com/NewProj');
  await tick(5);
  assert.equal(seen('newproj'), 1);
});

await test('post yang sama tidak diproses dua kali (live + catch-up)', async () => {
  const before = reports().filter((r) => r.includes('terlewat')).length;
  post(alpha, 'x.com/DupProj');
  await tick(5);
  assert.equal(seen('dupproj'), 1);
  assert.equal(reports().filter((r) => r.includes('terlewat')).length, before);
});

await test('/setreport: channel orang lain ditolak, channel admin diterima', async () => {
  M.chatAdmins[-100777] = [555];
  await channelPost(-100777, '/setreport');
  assert.equal(db.reportChat, REPORT);
  M.chatAdmins[-100888] = [ADMIN];
  await channelPost(-100888, '/setreport');
  await until(() => db.reportChat === -100888, 'reportChat admin');
  db.reportChat = REPORT;
});

await test('non-admin tidak bisa pakai perintah admin', async () => {
  assert.match(await dm(222, '/status'), /Bot ini privat[\s\S]*222/);
  await dm(222, '/pause');
  assert.equal(db.paused, false);
});

await test('/optin → kode di bio → terverifikasi OTOMATIS tanpa /verify', async () => {
  const r = await dm(222, '/optin @PendProj');
  const code = r.match(/FTS-[A-Z0-9]+/)[0];
  await tick(3);
  assert.equal(db.optins.pendproj, undefined); // bio belum diubah
  users.pendproj.description = 'building cool stuff ' + code;
  await until(() => db.optins.pendproj, 'auto-verify');
  assert.equal(db.optins.pendproj.via, 'auto-verify');
  await until(() => messagesTo(222).some((m) => m.includes('terverifikasi otomatis')), 'DM ke project');
  await reportMatching('Opt-in baru</b>: @pendproj');
});

await test('/optin: handle tidak valid ditolak & maks. 3 pending per orang', async () => {
  assert.match(await dm(555, '/optin @bad-handle'), /tidak valid/);
  assert.match(await dm(555, '/optin https://x.com/foo'), /tidak valid/);
  for (const h of ['spam1', 'spam2', 'spam3']) assert.match(await dm(555, '/optin @' + h), /FTS-/);
  assert.match(await dm(555, '/optin @spam4'), /Maksimal 3/);
  assert.equal(db.pending.spam4, undefined);
  for (const h of ['spam1', 'spam2', 'spam3']) delete db.pending[h];
});

await test('/verify manual tetap jalan', async () => {
  db.auto.autoVerify = false;
  try {
    const code = (await dm(333, '/optin @VerProj')).match(/FTS-[A-Z0-9]+/)[0];
    assert.match(await dm(333, '/verify @VerProj'), /belum ditemukan/);
    users.verproj.description = code;
    assert.match(await dm(333, '/verify @VerProj'), /terverifikasi & opt-in Fourtis aktif/);
    assert.equal(db.optins.verproj.by, 333);
    assert.equal(db.optins.verproj.brand, 'fourtis');
  } finally {
    db.auto.autoVerify = true;
  }
});

await test('kode opt-in kedaluwarsa otomatis', async () => {
  db.pending.oldproj = { code: 'FTS-OLD', by: 444, at: Date.now() - 4 * 86400_000 };
  await until(() => !db.pending.oldproj, 'pending expired');
  await until(() => messagesTo(444).some((m) => m.includes('kedaluwarsa')), 'DM kedaluwarsa');
});

await test('pantau tweet baru project opt-in → komentar tanpa post channel', async () => {
  M.x.searchResults.push({
    tweets: [{ id: T1, text: 'big announcement', author_id: 'u1', created_at: new Date().toISOString() }],
    users: [{ id: 'u1', username: 'OptProj', name: 'Opt Project' }]
  });
  await until(() => xcalls('reply').some((c) => c[2] === T1), 'reply dari pantauan');
  await reportMatching('dari pantauan tweet baru project opt-in');
  const q = xcalls('search')[0][1];
  assert.match(q, /from:optproj/);
  assert.match(q, /-is:reply -is:retweet/);
});

await test('pantauan memakai since_id (tidak membaca ulang tweet lama)', async () => {
  await tick(3);
  assert.equal(xcalls('search').at(-1)[2].since_id, T1);
});

await test('since_id lebih tua dari 6 hari (bot lama mati) → mulai dari sekarang', async () => {
  const saved = db.watchSinceId;
  db.watchSinceId = snow(now - 8 * 86400_000);
  const n = xcalls('search').length;
  await until(() => xcalls('search').length > n + 1, 'search berikutnya');
  const opts = xcalls('search')[n][2];
  assert.equal(opts.since_id, undefined);
  assert.ok(Date.now() - Date.parse(opts.start_time) < 5 * 60_000);
  db.watchSinceId = saved;
});

await test('batas komentar per project per hari → sisa antrian project dibuang sekaligus', async () => {
  db.auto.maxRepliesPerProjectPerDay = 2; // OptProj sudah 2 komentar
  const extra = [T2, snow(now, 3), snow(now, 4)];
  M.x.searchResults.push({
    tweets: extra.map((id) => ({ id, text: 'another one', author_id: 'u1', created_at: new Date().toISOString() })),
    users: [{ id: 'u1', username: 'OptProj', name: 'Opt Project' }]
  });
  try {
    await reportMatching('3 tweet dilewati');
    assert.equal(reports().filter((r) => r.includes('tweet dilewati')).length, 1); // satu laporan, bukan tiga
    assert.equal(xcalls('reply').filter((c) => extra.includes(c[2])).length, 0);
    assert.equal(db.queue.filter((j) => j.handle === 'optproj').length, 0);
  } finally {
    db.auto.maxRepliesPerProjectPerDay = 3;
  }
});

// 10 tweet, index 9 = paling baru
const tenTweets = (seq, text) => Array.from({ length: 10 }, (_, i) => ({
  id: snow(now - (10 - i) * 60_000, seq + i), text: `${text} #${i}`, created_at: new Date(now - (10 - i) * 60_000).toISOString()
}));

await test('project dengan 10 tweet (dari channel) → hanya 3 terbaru, yang terbaru duluan', async () => {
  users.manyproj = user('u20', 'ManyProj', 'Many Project');
  db.optins.manyproj = { at: Date.now(), via: 'admin' };
  const tweets = tenTweets(100, 'many');
  M.x.timelines.u20 = [...tweets].reverse(); // X mengirim dari yang terbaru
  post(alpha, 'x.com/ManyProj');
  const newest3 = tweets.slice(-3).reverse().map((t) => t.id);
  await until(() => xcalls('reply').filter((c) => c[1].includes('Many Project')).length === 3, '3 komentar ManyProj');
  await tick(5);
  const many = xcalls('reply').filter((c) => c[1].includes('Many Project'));
  assert.deepEqual(many.map((c) => c[2]), newest3);
  assert.equal(new Set(many.map((c) => c[1])).size, 3, 'tiga komentar ke project yang sama harus beda teks');
});

await test('project opt-in tweet 10x sekaligus (pantauan) → hanya 3 terbaru, yang terbaru duluan', async () => {
  users.watchmany = user('u21', 'WatchMany', 'Watch Many');
  db.optins.watchmany = { at: Date.now(), via: 'admin' };
  const tweets = tenTweets(200, 'burst');
  M.x.searchResults.push({ tweets: [...tweets].reverse().map((t) => ({ ...t, author_id: 'u21' })), users: [users.watchmany] });
  const newest3 = tweets.slice(-3).reverse().map((t) => t.id);
  await until(() => xcalls('reply').filter((c) => c[1].includes('Watch Many')).length === 3, '3 komentar WatchMany');
  await tick(5);
  assert.deepEqual(xcalls('reply').filter((c) => c[1].includes('Watch Many')).map((c) => c[2]), newest3);
});

await test('jeda per project: komentar ke project yang sama berjarak, project lain tidak ikut tertahan', async () => {
  db.auto.replyGapMin = 0.02; // 1,2 detik (di produksi: menit)
  users.gapproj = user('u22', 'GapProj', 'Gap Project');
  users.otherproj = user('u23', 'OtherProj', 'Other Project');
  const otherT = optedIn('OtherProj');
  db.optins.gapproj = { at: Date.now(), via: 'admin' };
  M.x.timelines.u22 = tenTweets(300, 'gap').reverse();
  try {
  post(alpha, 'x.com/GapProj');
  await until(() => xcalls('reply').some((c) => c[1].includes('Gap Project')), 'komentar GapProj pertama');
  post(alpha, 'x.com/OtherProj');
  await until(() => xcalls('reply').filter((c) => c[1].includes('Gap Project')).length === 3, '3 komentar GapProj', 8000);
  const times = xcalls('reply').filter((c) => c[1].includes('Gap Project')).map((c) => c[3]);
  assert.ok(times[1] - times[0] >= 1150 && times[2] - times[1] >= 1150, `jarak ${times[1] - times[0]}ms, ${times[2] - times[1]}ms`);
  const other = repliesTo(otherT)[0];
  assert.ok(other && other[3] < times[1], 'project lain jalan saat GapProj menunggu jeda');
  } finally {
    db.auto.replyGapMin = 0;
  }
});

await test('project opt-out saat antre → komentar dibatalkan', async () => {
  db.limits.maxPerHour = 0; // tahan antrian
  post(alpha, 'x.com/VerProj');
  await until(() => db.queue.some((j) => j.handle === 'verproj'), 'reply VerProj masuk antrian');
  assert.match(await dm(333, '/optout @VerProj'), /sudah opt-out/);
  db.limits.maxPerHour = 1000;
  await until(() => db.queue.length === 0, 'antrian kosong');
  assert.equal(xcalls('reply').filter((c) => c[2] === '1700000000000000010').length, 0);
});

await test('rate limit 429 → jeda otomatis, lapor, lalu jalan lagi sendiri & diulang', async () => {
  const t = optedIn('RateProj');
  M.x.failNext.reply = rateLimitError({ limit: 50, remaining: 0, reset: unix(Date.now()) + 1 });
  post(alpha, 'x.com/RateProj');
  await reportMatching('Rate limit X akun Fourtis');
  assert.ok(db.pausedUntil.fourtis > Date.now());
  db.pausedUntil.fourtis = Date.now() + 200; // percepat waktu tunggu untuk test
  await reportMatching('selesai — jalan lagi otomatis');
  await until(() => repliesTo(t).length === 2, 'komentar RateProj diulang');
});

await test('batas 24 jam X (userDay) → jeda sampai reset harian', async () => {
  const t = optedIn('DayProj');
  M.x.failNext.reply = rateLimitError({ limit: 50, remaining: 10, reset: unix(Date.now()) + 60, userDay: { limit: 100, remaining: 0, reset: unix(Date.now()) + 3600 } });
  post(alpha, 'x.com/DayProj');
  await until(() => db.pausedUntil.fourtis > Date.now() + 3000_000, 'pausedUntil ~1 jam');
  db.pausedUntil.fourtis = Date.now() + 200;
  await until(() => repliesTo(t).length === 2, 'komentar DayProj diulang');
});

await test('error jaringan → diulang otomatis', async () => {
  const t = optedIn('NetProj');
  M.x.failNext.reply = Object.assign(new Error('socket hang up'), { type: 'request', requestError: { code: 'ECONNRESET' } });
  post(alpha, 'x.com/NetProj');
  await until(() => repliesTo(t).length === 2, 'komentar NetProj diulang');
  await reportMatching('gagal (ECONNRESET)');
});

await test('/pause: post selama pause diabaikan, tidak diproses setelah /resume', async () => {
  assert.match(await dm(ADMIN, '/pause'), /di-pause/);
  post(alpha, 'x.com/PausedProj');
  await tick(3);
  assert.match(await dm(ADMIN, '/resume'), /jalan lagi/);
  await tick(5);
  assert.equal(seen('pausedproj'), 0);
});

await test('listener putus → lapor, sambung ulang otomatis, post saat putus tetap diproses', async () => {
  M.tg.connected = false;
  M.tgFailConnect = true;
  await reportMatching('Listener Telegram bermasalah');
  post(alpha, 'x.com/OfflineProj', { live: false }); // tidak sampai ke listener live
  M.tgFailConnect = false;
  await reportMatching('Listener Telegram tersambung lagi');
  await until(() => seen('offlineproj'), 'OfflineProj terbaca');
});

await test('/addchannel memberi tahu kalau listener belum join, lalu terdeteksi otomatis setelah join', async () => {
  const delta = channel(1004, 'delta', 'Delta', false);
  M.channels.push(delta);
  assert.match(await dm(ADMIN, '/addchannel @gamma'), /sudah dipantau \(akun listener\)/);
  assert.match(await dm(ADMIN, '/addchannel @delta'), /BELUM bisa dibaca[\s\S]*atau akun listener join/);
  delta.joined = true;
  beta.joined = true;
  await until(() => reports().find((r) => r.includes('Mulai dipantau') && r.includes('@delta (akun listener)')), 'deteksi join', 8000);
  const chs = await dm(ADMIN, '/channels');
  assert.doesNotMatch(chs, /belum terbaca/);
});

await test('listener belum join channel publik → tetap terbaca lewat web t.me', async () => {
  M.web.etacalls = { title: 'Eta Calls', posts: [{ id: 9, html: 'hello', date: Date.now() }] };
  assert.match(await dm(ADMIN, '/addchannel @etacalls'), /dipantau lewat halaman web publik/);
  M.web.etacalls.posts.push({ id: 10, html: '<a href="https://x.com/EtaProj">x.com/EtaProj</a>', date: Date.now() });
  await until(() => seen('etaproj'), 'EtaProj terbaca');
  await dm(ADMIN, '/delchannel @etacalls');
});

await test('/setx key salah ditolak & key lama tetap dipakai', async () => {
  const good = db.brands.fourtis.x;
  assert.match(await dm(ADMIN, '/setx bad b c d'), /Key tidak valid[\s\S]*Key lama tetap dipakai/);
  assert.deepEqual(db.brands.fourtis.x, good);
  assert.match(await dm(ADMIN, '/xstatus'), /✅ @fourtisbot/);
});

await test('/auto & /limits bisa diubah, nilai bukan angka ditolak', async () => {
  assert.match(await dm(ADMIN, '/auto maxRepliesPerProjectPerDay 3'), /= 3/);
  assert.equal(db.auto.maxRepliesPerProjectPerDay, 3);
  assert.match(await dm(ADMIN, '/limits maxPerDay abc'), /harus angka/);
  assert.equal(db.limits.maxPerDay, 1000);
});

await test('data lama otomatis jadi brand Fourtis', async () => {
  assert.deepEqual(db.brands.fourtis.x, { appKey: 'k', appSecret: 's', accessToken: 't', accessSecret: 'a' });
  assert.equal(db.brands.fourtis.templates.length, 3);
  assert.equal(db.brands.fourtis.username, 'fourtisbot');
  assert.equal(db.x, undefined);
  assert.equal(db.brands.fourtis.tweetTemplates, undefined); // tweet bot lama tidak ikut
  assert.ok(db.brands.dexvra && !db.brands.dexvra.x);
});

await test('template habis → komentar dilewati, tidak ada komentar kembar', async () => {
  const saved = db.brands.fourtis.templates;
  db.brands.fourtis.templates = ['Only {name} 🙌'];
  users.tplproj = user('u24', 'TplProj', 'Tpl Project');
  db.optins.tplproj = { at: Date.now(), via: 'admin' };
  M.x.timelines.u24 = tenTweets(400, 'tpl').reverse();
  try {
    post(alpha, 'x.com/TplProj');
    await reportMatching('sudah terpakai semua hari ini');
    assert.equal(xcalls('reply').filter((c) => c[1].includes('Tpl Project')).length, 1);
  } finally {
    db.brands.fourtis.templates = saved;
  }
});

// ---------- Multi akun / brand ----------
await test('/addaccount dexvra → akun kedua tersambung, /accounts menampilkan dua brand', async () => {
  assert.match(await dm(ADMIN, '/addaccount dexvra dk ds dt da'), /Akun X Dexvra tersambung: @dexvra_x/);
  assert.equal(db.brands.dexvra.x.appKey, 'dk');
  const a = await dm(ADMIN, '/accounts');
  assert.match(a, /Fourtis<\/b> \(fourtis\) · utama\nAkun X: ✅ @fourtisbot/);
  assert.match(a, /Dexvra<\/b> \(dexvra\)\nAkun X: ✅ @dexvra_x/);
});

await test('/addaccount: key salah ditolak, satu akun X tidak boleh dipakai dua brand', async () => {
  assert.match(await dm(ADMIN, '/addaccount dexvra bad b c d'), /Key tidak valid[\s\S]*Key lama tetap dipakai/);
  assert.equal(db.brands.dexvra.x.appKey, 'dk');
  assert.match(await dm(ADMIN, '/addaccount fourtis2 k s t a'), /sudah dipakai brand Fourtis/);
  assert.equal(db.brands.fourtis2, undefined);
  assert.match(await dm(ADMIN, '/addaccount Bad-Name a b c d'), /Nama brand/);
});

await test('template per brand: /addtpl, /tpls, /deltpl (baris baru tetap)', async () => {
  const n = db.brands.dexvra.templates.length;
  assert.match(await dm(ADMIN, '/addtpl dexvra Dexvra sees {name} 💎'), /komentar Dexvra #/);
  assert.equal(db.brands.dexvra.templates.length, n + 1);
  assert.equal(db.brands.fourtis.templates.length, 3); // brand lain tidak berubah
  assert.match(await dm(ADMIN, '/tpls dexvra'), /== Dexvra ==[\s\S]*Dexvra sees \{name\}/);
  assert.doesNotMatch(await dm(ADMIN, '/tpls dexvra'), /== Fourtis ==/);
  assert.match(await dm(ADMIN, `/deltpl dexvra ${n + 1}`), /Dihapus dari Dexvra/);
  assert.match(await dm(ADMIN, '/addtpl Love it {name}'), /komentar Fourtis #4/); // tanpa brand = brand utama
  db.brands.fourtis.templates.pop();
});

await test('channel tanpa brand: project opt-in dikomentari akun brand pilihannya, dari channel mana pun', async () => {
  const t = optedIn('DexNew', 'dexvra');
  assert.match(await dm(ADMIN, '/addchannel @gamma dexvra'), /@gamma ditambahkan & sudah dipantau/); // kata brand diabaikan
  assert.match(await dm(ADMIN, '/channels'), /✅ @gamma · akun listener/);
  post(gamma, 'x.com/DexNew');
  const c = await until(() => repliesTo(t)[0], 'komentar DexNew');
  assert.equal(c.at(-1), 'dk');
  assert.match(c[1], /DexNew/);
  post(alpha, 'again x.com/DexNew'); // channel lain: tidak dikomentari ulang (cooldown)
  await tick(5);
  assert.equal(repliesTo(t).length, 1);
});

await test('komentar 1-tap: project belum opt-in → komentar disiapkan per brand (admin yang kirim), bot sendiri tidak berkomentar', async () => {
  db.auto.manualAssist = true;
  try {
    users.manualproj = user('u98', 'ManualProj', 'Manual Labs');
    const tid = snow(Date.now(), 990);
    M.x.timelines.u98 = [{ id: tid, text: 'we just launched v1', created_at: new Date().toISOString() }];
    post(alpha, 'x.com/ManualProj');
    const r = await reportMatching('<b>@ManualProj</b> belum opt-in — siap dikomentari');
    assert.match(r, /Sumber: Alpha Calls\nTweet: "we just launched v1…"\nKomentar Fourtis: "[^"]*Manual Labs[^"]*"\nKomentar Dexvra: "[^"]*Manual Labs/);
    const kb = sent().find((m) => m.payload.text === r).payload.reply_markup.inline_keyboard;
    assert.deepEqual(kb.slice(0, 2).map((row) => row.map((b) => b.callback_data)), [
      [`mx:c:fourtis:${tid}`, `mx:l:fourtis:${tid}`, `mx:f:fourtis:${tid}`],
      [`mx:c:dexvra:${tid}`, `mx:l:dexvra:${tid}`, `mx:f:dexvra:${tid}`]
    ]);
    assert.equal(new URL(kb[2][0].url).searchParams.get('in_reply_to'), tid); // ✍️ Ubah di X (cadangan)
    await tick(3);
    assert.equal(xcalls('reply').filter((c) => c[2] === tid).length, 0); // tanpa tombol ditekan: bot TIDAK berkomentar

    // Bukan admin (subscriber channel laporan) tidak bisa menekan
    await tap(555, `mx:c:fourtis:${tid}`);
    assert.equal(xcalls('reply').filter((c) => c[2] === tid).length, 0);
    // Admin tekan 💬 Fourtis → 1 komentar dari akun Fourtis; tekan lagi → tidak dobel
    const text = db.manual[tid].texts.fourtis;
    await tap(ADMIN, `mx:c:fourtis:${tid}`);
    await tap(ADMIN, `mx:c:fourtis:${tid}`);
    assert.deepEqual(xcalls('reply').filter((c) => c[2] === tid).map((c) => [c[1], c.at(-1)]), [[text, 'k']]);
    const edit = M.botCalls.filter((c) => c.method === 'editMessageReplyMarkup').at(-1).payload.reply_markup.inline_keyboard;
    assert.equal(edit[0][0].text, '✅ Terkirim · Fourtis');
    // ❤️ Like & 👤 Follow dari akun Dexvra
    await tap(ADMIN, `mx:l:dexvra:${tid}`);
    await tap(ADMIN, `mx:f:dexvra:${tid}`);
    assert.deepEqual(xcalls('like').at(-1).slice(1), [db.brands.dexvra.userId || 'dk', tid, 'dk']);
    assert.deepEqual(xcalls('follow').at(-1).slice(1, 3), [db.brands.dexvra.userId || 'dk', 'u98']);
    // X menolak komentar API (project belum pernah berinteraksi) → penjelasan, tidak ditandai terkirim
    M.x.failNext.reply = xErr(403, 'Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author of the post you are replying to.');
    await tap(ADMIN, `mx:c:dexvra:${tid}`);
    assert.match(M.botCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1).payload.text, /X menolak komentar lewat API/);
    assert.ok(!db.manual[tid].done['c:dexvra']);
    assert.ok(!db.brandDown.dexvra);
    // Batas per jam akun tercapai → ditolak dengan penjelasan
    const hour = db.limits.maxPerHour;
    db.limits.maxPerHour = 0;
    await tap(ADMIN, `mx:c:dexvra:${tid}`);
    db.limits.maxPerHour = hour;
    assert.match(M.botCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1).payload.text, /Batas akun Dexvra tercapai/);
    assert.equal(xcalls('reply').filter((c) => c[2] === tid && c.at(-1) === 'dk').length, 1); // hanya percobaan yang ditolak X
  } finally {
    db.auto.manualAssist = false;
  }
});

await test('/optin dengan 2 brand → pilih tombol Dexvra → akun Dexvra yang komentar', async () => {
  users.brandproj = user('u26', 'BrandProj', 'Brand Project');
  M.x.timelines.u26 = [{ id: snow(now, 500), text: 'brand news', created_at: new Date().toISOString() }];
  await dm(777, '/optin @BrandProj');
  const kb = sent().filter((c) => c.payload.chat_id === 777).at(-1).payload.reply_markup.inline_keyboard[0];
  assert.deepEqual(kb.map((b) => b.callback_data), ['optin:fourtis:brandproj', 'optin:dexvra:brandproj']);
  const r = await tap(777, 'optin:dexvra:brandproj');
  assert.match(r, /Dexvra \(@dexvra_x\)/);
  const code = r.match(/DEX-[A-Z0-9]+/)[0];
  users.brandproj.description = code;
  await until(() => db.optins.brandproj, 'auto-verify BrandProj');
  assert.equal(db.optins.brandproj.brand, 'dexvra');
  await until(() => messagesTo(777).some((m) => m.includes('opt-in Dexvra aktif')), 'DM Dexvra');
  post(alpha, 'x.com/BrandProj'); // channel Fourtis, tapi project milih Dexvra
  const c = await until(() => xcalls('reply').find((c) => c[2] === snow(now, 500)), 'reply BrandProj');
  assert.equal(c.at(-1), 'dk');
  assert.equal(xcalls('reply').filter((c) => c[2] === snow(now, 500)).length, 1);
  assert.match(await dm(ADMIN, '/optins'), /@brandproj → Dexvra/);
});

await test('/optin @handle brand langsung tanpa tombol', async () => {
  const r = await dm(778, '/optin @DirectProj fourtis');
  assert.match(r, /FTS-[A-Z0-9]+/);
  assert.equal(db.pending.directproj.brand, 'fourtis');
  assert.match(await dm(778, '/optin @OtherProj2 nope'), /Brand tidak dikenal/);
  delete db.pending.directproj;
});

await test('rate limit akun Dexvra tidak menghentikan akun Fourtis', async () => {
  const dr = optedIn('DexRate', 'dexvra');
  const ff = optedIn('FourFree');
  M.x.failNext.reply = rateLimitError({ limit: 50, remaining: 0, reset: unix(Date.now()) + 600 });
  post(gamma, 'x.com/DexRate');
  await until(() => db.pausedUntil.dexvra > Date.now(), 'Dexvra jeda');
  assert.ok(!db.pausedUntil.fourtis);
  post(alpha, 'x.com/FourFree');
  const c = await until(() => repliesTo(ff)[0], 'Fourtis tetap jalan');
  assert.equal(c.at(-1), 'k');
  assert.match(await dm(ADMIN, '/status'), /Dexvra \(@dexvra_x\): ⏸ rate limit/);
  db.pausedUntil.dexvra = Date.now() + 200;
  await until(() => repliesTo(dr).length === 2, 'Dexvra lanjut sendiri');
});

await test('data lama: tweet bot & brand channel dihapus — tweet yang antre dibuang, komentar tetap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xagent-notweet-'));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    brands: { fourtis: { name: 'Fourtis', ownTweetEnabled: true, templates: ['a'], tweetTemplates: ['b'] } },
    channelBrand: { '@x': 'fourtis' }, tweetBotDefaultOff: true,
    tplLog: { '#fourtis': [{ at: 1, tpl: 'b' }], proj: [{ at: 1, tpl: 'a' }] },
    queue: [{ type: 'tweet', handle: 'a', at: 1 }, { type: 'reply', handle: 'b', at: 1, brand: 'fourtis' }]
  }));
  const d = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { db } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)}); console.log(JSON.stringify(db))`],
  { env: { ...process.env, DB_FILE: path.join(dir, 'data.json') }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  assert.deepEqual(d.brands.fourtis.templates, ['a']);
  assert.equal(d.brands.fourtis.ownTweetEnabled, undefined);
  assert.equal(d.brands.fourtis.tweetTemplates, undefined);
  assert.equal(d.channelBrand, undefined);
  assert.equal(d.tweetBotDefaultOff, undefined);
  assert.deepEqual(Object.keys(d.tplLog), ['proj']);
  assert.deepEqual(d.queue.map((j) => j.type), ['reply']);
});

await test('filter mati bawaan: data lama dimatikan sekali saat update, setelah itu pilihan pemilik dihormati', async () => {
  const load = (data) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xagent-filteroff-'));
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { db } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)}); console.log(JSON.stringify(db.filter))`],
    { env: { ...process.env, DB_FILE: path.join(dir, 'data.json') }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  };
  const on = { minFollowers: 500, minAgeDays: 14, blacklist: ['scam', 'rug'], cooldownDays: 3 };
  const off = { minFollowers: 0, minAgeDays: 0, blacklist: [] };
  assert.deepEqual(load({}), { ...load({}), ...off }); // instalasi baru: tanpa filter
  const old = load({ filter: on });
  assert.deepEqual({ ...old, ...off }, old);
  assert.equal(old.cooldownDays, 3); // pengaturan lain tidak disentuh
  assert.equal(load({ filter: on, filterOffDefault: true }).minFollowers, 500); // dinyalakan lagi oleh pemilik
});

await test('/delaccount → akun dihapus, template & brand tetap', async () => {
  assert.match(await dm(ADMIN, '/delaccount dexvra'), /Akun X Dexvra dihapus/);
  assert.equal(db.brands.dexvra.x, null);
  assert.ok(db.brands.dexvra.templates.length);
  assert.match(await dm(ADMIN, '/accounts'), /Dexvra<\/b> \(dexvra\)\nAkun X: ❌ belum ada akun/);
  assert.match(await dm(ADMIN, '/addaccount dexvra dk ds dt da'), /tersambung/);
});

// ---------- Keandalan: tweet berikutnya, rem darurat, antrian terbaru duluan ----------

await test('tweet yang balasannya dibatasi → akun yang sama pindah ke tweet berikutnya', async () => {
  users.restrictproj = user('u30', 'RestrictProj', 'Restrict Project');
  db.optins.restrictproj = { at: Date.now(), via: 'admin' };
  const tw = tenTweets(600, 'restrict').slice(-3).reverse(); // [terbaru, ..]
  M.x.timelines.u30 = tw;
  db.filter.tweetsPerProject = 1;
  M.x.failNext.reply = xErr(403, 'Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author of the post you are replying to.');
  try {
    post(alpha, 'x.com/RestrictProj');
    await reportMatching('pindah ke tweet berikutnya');
    const c = await until(() => xcalls('reply').find((c) => c[2] === tw[1].id && c[1].includes('Restrict')), 'reply tweet ke-2');
    assert.equal(c.at(-1), 'k'); // akun yang sama, bukan akun lain
    assert.ok(!db.brandDown.fourtis, 'bukan masalah akun');
  } finally {
    db.filter.tweetsPerProject = 3;
  }
});

await test('tweet "hanya akun yang di-mention" dilewati dari awal, kecuali akun brand di-mention', async () => {
  users.mentionproj = user('u31', 'MentionProj', 'Mention Project');
  db.optins.mentionproj = { at: Date.now(), via: 'admin' };
  const [a, b, c] = tenTweets(700, 'mention').slice(-3).reverse();
  M.x.timelines.u31 = [
    { ...a, reply_settings: 'mentionedUsers' },
    { ...b, reply_settings: 'mentionedUsers', text: 'thanks @FourtisBot for the support' },
    { ...c, reply_settings: 'everyone' }
  ];
  post(alpha, 'x.com/MentionProj');
  await until(() => xcalls('reply').filter((r) => r[1].includes('Mention Project')).length === 2, '2 komentar MentionProj');
  const ids = xcalls('reply').filter((r) => r[1].includes('Mention Project')).map((r) => r[2]);
  assert.deepEqual(ids, [b.id, c.id]);
});

await test('project memblokir akun → opt-in brand itu dihentikan, tidak dicoba lewat akun lain', async () => {
  users.blockproj = user('u32', 'BlockProj', 'Block Project');
  db.optins.blockproj = { at: Date.now(), via: 'admin' };
  M.x.timelines.u32 = tenTweets(800, 'block').reverse();
  M.x.failNext.reply = xErr(403, 'You have been blocked from replying to this user.');
  post(alpha, 'x.com/BlockProj');
  await reportMatching('@BlockProj memblokir akun Fourtis');
  await tick(5);
  assert.equal(db.optins.blockproj, undefined);
  assert.equal(xcalls('reply').filter((c) => c[1].includes('Block Project')).length, 1); // hanya percobaan yang gagal
  assert.equal(db.queue.filter((j) => j.handle === 'blockproj').length, 0);
});

await test('error konten dobel tidak dihitung sebagai masalah akun', async () => {
  optedIn('DupContent');
  M.x.failNext.reply = xErr(403, 'You are not allowed to create a Tweet with duplicate content.');
  post(alpha, 'x.com/DupContent');
  await reportMatching('duplicate content');
  assert.ok(!db.brandDown.fourtis);
});

await test('rem darurat: akun dikunci → langsung berhenti, admin di-DM, akun lain tetap jalan, /resume brand', async () => {
  optedIn('LockProj', 'dexvra');
  const st = optedIn('StillRun');
  optedIn('WhileDown', 'dexvra');
  M.x.failNext.reply = xErr(403, 'Your account is temporarily locked.');
  try {
  post(gamma, 'x.com/LockProj'); // opt-in ke Dexvra
  await until(() => db.brandDown.dexvra, 'Dexvra dihentikan');
  await reportMatching('Akun Dexvra (@dexvra_x) dihentikan otomatis');
  await until(() => messagesTo(ADMIN).some((m) => m.includes('dihentikan otomatis')), 'DM admin');
  post(alpha, 'x.com/StillRun'); // Fourtis tetap jalan
  const c = await until(() => repliesTo(st)[0], 'Fourtis jalan');
  assert.equal(c.at(-1), 'k');
  post(gamma, 'x.com/WhileDown');
  await reportMatching('akun Dexvra (@dexvra_x) sedang dihentikan');
  assert.equal(seen('whiledown'), 0);
  assert.match(await dm(ADMIN, '/status'), /Dexvra \(@dexvra_x\): 🛑 dihentikan/);
  assert.match(await dm(ADMIN, '/accounts'), /🛑 dihentikan/);
  assert.match(await dm(ADMIN, '/resume dexvra'), /Akun Dexvra jalan lagi/);
  assert.ok(!db.brandDown.dexvra);
  } finally {
    delete db.brandDown.dexvra;
  }
});

await test('rem darurat: error 403 biasa baru berhenti setelah 3x berturut-turut', async () => {
  const err = () => xErr(403, 'You are not permitted to perform this action.');
  const [pa] = ['PermPa', 'PermPb', 'PermPc'].map((n) => optedIn(n, 'dexvra'));
  M.x.failNext.reply = [err(), err(), err()];
  try {
  post(gamma, 'x.com/PermPa');
  await until(() => repliesTo(pa).length, 'percobaan 1');
  await tick(2);
  assert.ok(!db.brandDown.dexvra, '1x gagal belum berhenti');
  post(gamma, 'x.com/PermPb');
  post(gamma, 'x.com/PermPc');
  await until(() => db.brandDown.dexvra, 'berhenti setelah 3x');
  } finally {
    await dm(ADMIN, '/resume dexvra');
  }
});

await test('setelah limit selesai: antrian dilanjutkan mulai dari yang terbaru', async () => {
  const ids = {};
  db.limits.maxPerHour = 0; // tahan antrian
  try {
    for (const n of ['OldA', 'MidB', 'NewC']) {
      ids[optedIn(n)] = n; // tweet project ini dibuat sekarang: NewC paling baru
      post(alpha, `x.com/${n}`);
      await until(() => db.queue.some((j) => j.handle === n.toLowerCase()), `${n} antre`);
      await sleep(20);
    }
    db.pausedUntil.fourtis = Date.now() + 150; // seolah kena rate limit
  } finally {
    db.limits.maxPerHour = 1000;
  }
  await reportMatching('aksi antre dilanjutkan mulai dari yang terbaru');
  await until(() => Object.keys(ids).every((t) => repliesTo(t).length), '3 komentar');
  const order = xcalls('reply').filter((c) => ids[c[2]]).map((c) => ids[c[2]]);
  assert.deepEqual(order, ['NewC', 'MidB', 'OldA']);
});

await test('/jeda: atur jeda dalam menit', async () => {
  try {
  assert.match(await dm(ADMIN, '/jeda'), /Jeda antar aksi/);
  assert.match(await dm(ADMIN, '/jeda 5'), /5 menit/);
  assert.equal(db.limits.minDelaySec, 300);
  assert.equal(db.limits.maxDelaySec, 300);
  assert.match(await dm(ADMIN, '/jeda 3 6'), /3 menit–6 menit \(acak\)/);
  assert.equal(db.limits.minDelaySec, 180);
  assert.equal(db.limits.maxDelaySec, 360);
  assert.match(await dm(ADMIN, '/jeda project 10'), /minimal 10 menit/);
  assert.equal(db.auto.replyGapMin, 10);
  assert.match(await dm(ADMIN, '/jeda abc'), /Format/);
  assert.match(await dm(ADMIN, '/jeda 6 3'), /Format/);
  assert.match(await dm(ADMIN, '/filter tweetsPerProject 2'), /= 2/);
  const s = await dm(ADMIN, '/status');
  assert.match(s, /Komentar per project: 2 tweet terbaru, maks\. 3\/hari/);
  assert.match(s, /Jeda: 3 menit–6 menit \(acak\) antar aksi · 10 menit per project/);
  } finally {
    Object.assign(db.limits, { minDelaySec: 0, maxDelaySec: 0 });
    db.auto.replyGapMin = 0;
    db.filter.tweetsPerProject = 3;
  }
});

await test('/status lengkap', async () => {
  const s = await dm(ADMIN, '/status');
  assert.match(s, /🟢 jalan/);
  assert.match(s, /Listener Telegram: ✅/);
  assert.match(s, /Pantau tweet opt-in: ON/);
});

await test('ringkasan harian + backup otomatis', async () => {
  db.auto.dailyReportHour = 0;
  db.lastDaily = null;
  const r = await reportMatching('Ringkasan harian');
  assert.match(r, /Komentar terkirim: \d+/);
  assert.match(r, /Fourtis: ✅ @fourtisbot/);
  assert.match(r, /Dexvra: /);
  const backups = fs.readdirSync(path.join(tmp, 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(db.stats, {});
});

await test('data.json tersimpan valid (antrian, opt-in, lastSeen)', async () => {
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  assert.ok(saved.optins.pendproj);
  assert.ok(saved.lastSeen['@alpha'] >= 4);
  assert.ok(Array.isArray(saved.queue));
});

await test('data.json rusak → dipulihkan otomatis dari backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xagent-corrupt-'));
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, 'data.json'), '{"channels": ["@x"');
  fs.writeFileSync(path.join(dir, 'backups', 'data-2026-01-01.json'), JSON.stringify({ channels: ['@recovered'] }));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { db } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)}); console.log(JSON.stringify(db.channels))`],
  { env: { ...process.env, DB_FILE: path.join(dir, 'data.json') }, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out.toString().trim(), '["@recovered"]');
});

await test('sepanjang test, bot tidak pernah mem-posting tweet sendiri (hanya komentar ke project opt-in)', async () => {
  assert.equal(xcalls('tweet').length, 0);
});

await test('semua pesan bot lolos aturan Telegram (HTML, panjang, tombol, perintah)', async () => {
  if (M.apiErrors.length) console.log(JSON.stringify(M.apiErrors, null, 1));
  assert.deepEqual(M.apiErrors, []);
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
