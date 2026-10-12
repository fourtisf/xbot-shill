// Test end-to-end mode bot saja: TG_API_ID / TG_API_HASH / TG_SESSION kosong.
// Bot membaca post dari channel tempat dia jadi admin, dan channel publik orang lain dari halaman web t.me/s/…
// (di-mock, lihat mocks/web.mjs). Jalankan: npm test
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xagent-bot-test-'));
const DB_FILE = path.join(tmp, 'data.json');
const REPORT = -100500;
const ADMIN = 111;
const now = Date.now();
const unix = (ms) => Math.floor(ms / 1000);
const user = (id, username, name, followers = 5000) =>
  ({ id, username, name, description: '', created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: followers } });

const alpha = { id: -1001001, type: 'channel', username: 'alpha', title: 'Alpha Calls' };
const beta = { id: -1001002, type: 'channel', username: 'beta', title: 'Beta Gems' };
const other = { id: -1009999, type: 'channel', username: 'other', title: 'Not A Target' };

const users = Object.fromEntries(['NewProj', 'LinkProj', 'OtherProj', 'OldProj', 'LateProj', 'AaaProj', 'BbbProj']
  .map((n, i) => [n.toLowerCase(), user('u' + i, n, n.replace('Proj', ' Project'))]));

const M = globalThis.__mock = {
  channels: [], chatAdmins: {}, botCalls: [],
  botChats: { '@alpha': alpha, '@beta': beta },
  botAdminIn: [alpha.id], // bot admin di @alpha, belum di @beta
  x: { users, timelines: {}, searchResults: [], calls: [], failNext: {}, n: 0 }
};

fs.writeFileSync(DB_FILE, JSON.stringify({
  x: { appKey: 'k', appSecret: 's', accessToken: 't', accessSecret: 'a' },
  channels: ['@alpha'],
  reportChat: REPORT,
  ownTweetEnabled: true, tweetBotDefaultOff: true, // test ini menguji tweet bot, jadi dinyalakan
  limits: { minDelaySec: 0, maxDelaySec: 0, maxPerHour: 1000, maxPerDay: 1000 },
  auto: { catchUpMin: 1, watchIntervalMin: 1, verifyIntervalMin: 1, dailyReportHour: 23, replyGapMin: 0 },
  lastDaily: new Date().toDateString()
}));

// Hanya BOT_TOKEN + ADMIN_IDS; TG_* sengaja kosong (string kosong supaya .env di server tidak ikut terbaca)
Object.assign(process.env, {
  DB_FILE, BOT_TOKEN: '123:test', ADMIN_IDS: String(ADMIN), TG_API_ID: '', TG_API_HASH: '', TG_SESSION: '', TICK_MS: '100', WEB_POLL_MS: '100'
});

const sent = () => M.botCalls.filter((c) => c.method === 'sendMessage');
const reports = () => sent().filter((c) => c.payload.chat_id === REPORT).map((c) => c.payload.text);
const messagesTo = (id) => sent().filter((c) => String(c.payload.chat_id) === String(id)).map((c) => c.payload.text);
const xcalls = (name) => M.x.calls.filter((c) => c[0] === name);
const lookedUp = (h) => xcalls('userByUsername').filter((c) => c[1] === h).length;
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

let updateId = 1;
let msgId = 100;
async function channelPost(chat, text, { id = ++msgId, date = unix(Date.now()), caption = false, entities = [] } = {}) {
  await M.bot.handleUpdate({
    update_id: updateId++,
    channel_post: {
      message_id: id, date, chat,
      ...(caption ? { caption: text, caption_entities: entities, photo: [] } : { text, entities })
    }
  });
}
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
// Klik tombol panel; kembalikan panel terakhir (pesan baru atau hasil edit) untuk chat itu
async function tap(from, data) {
  await M.bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId), from: { id: from, is_bot: false, first_name: 'u' }, chat_instance: '1', data,
      message: { message_id: 7, date: unix(Date.now()), chat: { id: from, type: 'private', first_name: 'u' }, text: 'panel' }
    }
  });
  await sleep(60);
  return lastPanel(from);
}
const lastPanel = (id) => M.botCalls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) &&
  String(c.payload.chat_id) === String(id)).at(-1)?.payload;
const buttonsOf = (p) => (p?.reply_markup?.inline_keyboard || []).flat();
const dataOf = (p) => buttonsOf(p).map((b) => b.callback_data);
const lastAnswer = () => M.botCalls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload;

await import('./mocks/web.mjs');
register('./mocks/hooks.mjs', import.meta.url);
await import('../src/index.js');
const { db } = await import('../src/db.js');

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

console.log('Fourtis X Agent — test mode bot saja (tanpa TG API)\n');

await test('jalan hanya dengan BOT_TOKEN + ADMIN_IDS, akun listener tidak dipakai', async () => {
  const r = await reportMatching('Bot online');
  assert.match(r, /mode bot saja/);
  assert.match(r, /Channel terpantau: 1\/1/);
  assert.equal(M.tg, undefined); // TelegramClient (TG API) tidak pernah dibuat
});

await test('post di channel tempat bot admin → diproses (tweet)', async () => {
  await channelPost(alpha, 'New gem https://x.com/NewProj 🚀');
  const c = await until(() => xcalls('tweet').find((c) => c[1].includes('New Project')), 'tweet NewProj');
  assert.equal(c.at(-1), 'k');
  assert.match(await reportMatching('tentang <b>@NewProj'), /Sumber: Alpha Calls/);
});

await test('link tersembunyi (text_link) di caption foto ikut terbaca', async () => {
  await channelPost(alpha, 'Cek project ini 👇', {
    caption: true, entities: [{ type: 'text_link', offset: 0, length: 4, url: 'https://x.com/LinkProj' }]
  });
  await until(() => lookedUp('linkproj'), 'lookup LinkProj');
});

await test('channel yang bukan target diabaikan', async () => {
  await channelPost(other, 'x.com/OtherProj');
  await sleep(300);
  assert.equal(lookedUp('otherproj'), 0);
});

await test('setelah bot mati: post 10 menit lalu tetap diproses, post terlalu lama dilewati', async () => {
  await channelPost(alpha, 'x.com/OldProj', { date: unix(now - 8 * 3600_000) });
  await channelPost(alpha, 'x.com/LateProj', { date: unix(now - 10 * 60_000) });
  await until(() => lookedUp('lateproj'), 'lookup LateProj');
  assert.equal(lookedUp('oldproj'), 0);
});

await test('post yang sama terkirim dua kali → diproses sekali', async () => {
  await channelPost(alpha, 'x.com/AaaProj', { id: 900 });
  await channelPost(alpha, 'x.com/BbbProj', { id: 900 });
  await until(() => lookedUp('aaaproj'), 'lookup AaaProj');
  await sleep(300);
  assert.equal(lookedUp('bbbproj'), 0);
});

await test('/addchannel: channel privat (tanpa web publik, bot bukan admin) → diberi tahu, terdeteksi otomatis setelah bot admin', async () => {
  assert.match(await dm(ADMIN, '/addchannel @beta dexvra'), /BELUM bisa dibaca: channel privat atau username salah/);
  assert.match(await dm(ADMIN, '/channels'), /⚠️ @beta → Dexvra \(belum terbaca\)/);
  M.botAdminIn.push(beta.id);
  await until(() => reports().find((r) => r.includes('Mulai dipantau: @beta (bot admin)')), 'deteksi admin', 8000);
  assert.match(await dm(ADMIN, '/channels'), /✅ @beta → Dexvra · bot admin/);
});

// ---------- Channel publik orang lain: dibaca dari web t.me/s/… (bot bukan admin) ----------
const delta = { id: -1001004, type: 'channel', username: 'delta', title: 'Delta Signals' };
const webPosts = [];
const webPost = (id, html, extra = {}) => webPosts.push({ id, html, date: Date.now(), ...extra });
for (const [n, i] of [['WebProj', 1], ['HiddenWebProj', 2], ['BtnWebProj', 3], ['SwitchProj', 4], ['AmpProj', 5]]) {
  M.x.users[n.toLowerCase()] = user('w' + i, n, n.replace('Proj', ' Project'));
}

await test('channel publik orang lain: cukup @username, bot TIDAK perlu admin; post lama tidak diproses', async () => {
  M.botChats['@delta'] = delta; // getChat berhasil untuk channel publik, tapi bot bukan anggota/admin
  M.web.delta = { title: 'Delta Signals', posts: webPosts };
  webPost(50, '<a href="https://x.com/OldWebProj" target="_blank" rel="noopener">x.com/OldWebProj</a>', { date: Date.now() - 60_000 });
  const r = await dm(ADMIN, '/addchannel @delta');
  assert.match(r, /@delta → Fourtis ditambahkan & dipantau lewat halaman web publik t\.me — bot tidak perlu jadi admin/);
  assert.match(r, /Terbaca 1 post terakhir \(terbaru #50\)/);
  assert.equal(db.lastSeen['@delta'], 50);
  assert.match(await dm(ADMIN, '/channels'), /✅ @delta → Fourtis · web publik/);
  await sleep(400);
  assert.equal(lookedUp('oldwebproj'), 0);
});

await test('web: link biasa, link tersembunyi, tombol link → diproses; kutipan balasan & info channel diabaikan', async () => {
  webPost(51, 'New listing 🚀<br/><a href="https://x.com/WebProj" target="_blank" rel="noopener" onclick="return confirm(\'Open this link?\\n\\n\'+this.href);">x.com/WebProj</a>',
    { replyTo: { id: 50, text: 'Kemarin: https://x.com/OldWebProj' } });
  webPost(52, 'Cek <a href="https://twitter.com/HiddenWebProj?s=21&amp;t=abc" target="_blank">di sini</a> <i class="emoji"><b>🔥</b></i>',
    { buttons: [['Twitter', 'https://x.com/BtnWebProj']] });
  webPost(53, 'Tom &amp; Jerry x.com/AmpProj');
  await until(() => lookedUp('webproj') && lookedUp('hiddenwebproj') && lookedUp('btnwebproj') && lookedUp('ampproj'), 'lookup post web');
  assert.match(await reportMatching('tentang <b>@WebProj'), /Sumber: Delta Signals/);
  await sleep(400); // beberapa putaran baca web lagi
  assert.equal(lookedUp('webproj'), 1, 'post yang sama tidak diproses dua kali');
  assert.equal(lookedUp('oldwebproj'), 0);
  assert.equal(lookedUp('channelownx'), 0);
  assert.equal(db.lastSeen['@delta'], 53);
});

await test('web: post terlalu lama dilewati; t.me error → laporan sekali, channel tetap dipantau, lalu pulih', async () => {
  webPost(54, 'x.com/AncientProj', { date: Date.now() - 8 * 3600_000 });
  await until(() => db.lastSeen['@delta'] === 54, 'lewati post lama');
  assert.equal(lookedUp('ancientproj'), 0);
  M.web.delta.down = true;
  await reportMatching('Gagal membaca @delta dari web publik');
  assert.match(await dm(ADMIN, '/channels'), /✅ @delta/);
  M.web.delta.down = false;
  await reportMatching('@delta terbaca lagi dari web publik');
  assert.equal(reports().filter((r) => r.includes('Gagal membaca @delta')).length, 1);
});

await test('web → bot dijadikan admin: langsung pindah jalur bot, post tidak diproses dua kali', async () => {
  M.botAdminIn.push(delta.id);
  webPost(60, 'x.com/SwitchProj');
  await channelPost(delta, 'x.com/SwitchProj', { id: 60 });
  await until(() => lookedUp('switchproj'), 'lookup SwitchProj');
  await sleep(400);
  assert.equal(lookedUp('switchproj'), 1);
  assert.match(await dm(ADMIN, '/channels'), /✅ @delta → Fourtis · bot admin/);
  await dm(ADMIN, '/delchannel @delta');
  assert.equal(db.lastSeen['@delta'], undefined);
});

await test('link t.me diterima (t.me/x, t.me/s/x, link post); link undangan privat dijelaskan', async () => {
  M.web.epsilon = { title: 'Epsilon', posts: [{ id: 7, html: 'hi', date: Date.now() }] };
  assert.match(await dm(ADMIN, '/addchannel https://t.me/s/Epsilon/7 dexvra'), /@epsilon → Dexvra ditambahkan & dipantau lewat halaman web publik/);
  assert.ok(db.channels.includes('@epsilon'));
  assert.match(await dm(ADMIN, '/addchannel https://t.me/+AbCdEf123'), /link undangan channel PRIVAT/);
  assert.match(await dm(ADMIN, '/addchannel https://t.me/c/1009999/15'), /-1001009999 → Fourtis ditambahkan, tapi BELUM bisa dibaca/);
  await dm(ADMIN, '/delchannel https://t.me/c/1009999/15');
  assert.ok(!db.channels.includes('-1001009999'));
  assert.match(await dm(ADMIN, '/addchannel bukan-channel'), /Format channel salah/);
  await tap(ADMIN, 'm:ask:channel');
  assert.match(await dm(ADMIN, 't.me/joinchat/AbCdEf'), /link undangan channel PRIVAT/);
  await dm(ADMIN, 't.me/Zeta_Calls');
  assert.deepEqual(dataOf(lastPanel(ADMIN)).slice(0, 2), ['m:chadd:fourtis:@zeta_calls', 'm:chadd:dexvra:@zeta_calls']);
  await dm(ADMIN, '/batal');
  await dm(ADMIN, '/delchannel https://t.me/epsilon');
  assert.ok(!db.channels.includes('@epsilon'));
});

await test('/status menampilkan mode bot saja', async () => {
  const s = await dm(ADMIN, '/status');
  assert.match(s, /Mode: bot saja \(channel publik dibaca dari web t\.me, tanpa admin\)/);
  assert.doesNotMatch(s, /Listener Telegram/);
  assert.equal(db.channels.length, 2);
});

// ---------- Menu "/" dan panel tombol ----------
await test('menu "/" terdaftar: publik untuk project, lengkap untuk admin', async () => {
  const calls = M.botCalls.filter((c) => c.method === 'setMyCommands');
  const adm = calls.find((c) => c.payload.scope?.chat_id === ADMIN);
  assert.ok(!calls.some((c) => !c.payload.scope), 'bot privat: tidak ada menu publik');
  assert.ok(M.botCalls.some((c) => c.method === 'deleteMyCommands' && !c.payload.scope));
  assert.ok(adm.payload.commands.some((c) => c.command === 'menu'));
  assert.ok(adm.payload.commands.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length >= 3));
});

await test('/start dari admin → panel tombol (dan menu admin dipasang ulang)', async () => {
  const before = M.botCalls.filter((c) => c.method === 'setMyCommands').length;
  await dm(ADMIN, '/start');
  const p = lastPanel(ADMIN);
  assert.match(p.text, /Panel pengaturan/);
  for (const d of ['m:status', 'm:acc', 'm:ch', 'm:tplb', 'm:opt', 'm:lim', 'm:flt', 'm:auto', 'm:pause', 'm:help']) assert.ok(dataOf(p).includes(d), d);
  assert.ok(M.botCalls.filter((c) => c.method === 'setMyCommands').length > before);
  assert.match(await dm(222, '/start'), /Bot ini privat[\s\S]*222/); // bukan admin: tanpa panel
});

await test('Jeda & Batas: klik preset langsung mengubah nilai', async () => {
  let p = await tap(ADMIN, 'm:lim');
  assert.match(p.text, /Jeda &amp; Batas/);
  // Judul tiap pengaturan selebar layar (tidak terpotong), pilihan angkanya di baris bawahnya
  const kb = p.reply_markup.inline_keyboard;
  assert.deepEqual(kb.slice(0, 2).map((r) => r.map((b) => b.text)), [['1️⃣ Jeda antar aksi'], ['30-90 dtk', '1-3 mnt', '3-6 mnt', '5-10 mnt']]);
  assert.match(p.text, /Contoh<\/b> dengan setelan ini: project opt-in punya 10 tweet → bot berkomentar di \d+ tweet terbarunya/);
  p = await tap(ADMIN, 'm:set:limits.maxPerHour:30');
  assert.equal(db.limits.maxPerHour, 30);
  assert.ok(buttonsOf(p).some((b) => b.text === '✅ 30x'));
  p = await tap(ADMIN, 'm:gap:180:360');
  assert.deepEqual([db.limits.minDelaySec, db.limits.maxDelaySec], [180, 360]);
  assert.match(p.text, /3 menit–6 menit/);
  await tap(ADMIN, 'm:set:auto.replyGapMin:10');
  await tap(ADMIN, 'm:set:filter.tweetsPerProject:2');
  assert.deepEqual([db.auto.replyGapMin, db.filter.tweetsPerProject], [10, 2]);
  Object.assign(db.limits, { minDelaySec: 0, maxDelaySec: 0, maxPerHour: 1000 });
});

await test('tombol palsu / nilai di luar daftar ditolak', async () => {
  const before = JSON.stringify(db);
  await tap(ADMIN, 'm:set:reportChat:123');
  await tap(ADMIN, 'm:set:limits.maxPerHour:abc');
  await tap(ADMIN, 'm:gap:1:2');
  await tap(ADMIN, 'm:tog:paused');
  assert.equal(JSON.stringify(db), before);
});

await test('Filter & Otomatis: preset dan tombol ON/OFF', async () => {
  await tap(ADMIN, 'm:flt');
  await tap(ADMIN, 'm:set:filter.minFollowers:1000');
  assert.equal(db.filter.minFollowers, 1000);
  await tap(ADMIN, 'm:ask:blacklist');
  await dm(ADMIN, 'scam, rug, presale');
  assert.deepEqual(db.filter.blacklist, ['scam', 'rug', 'presale']);
  let p = await tap(ADMIN, 'm:tog:auto.watchOptins');
  assert.equal(db.auto.watchOptins, false);
  assert.ok(buttonsOf(p).some((b) => b.text === 'Pantau tweet opt-in: ❌ OFF'));
  await tap(ADMIN, 'm:tog:auto.watchOptins');
  assert.equal(db.auto.watchOptins, true);
  db.filter.minFollowers = 500;
});

// Kode X palsu berformat realistis (bukan kode asli)
const keysFor = (p) => [`${p}ConsumerKey`.padEnd(25, '0'), `${p}SecretKey`.padEnd(50, '0'),
  `1234567890-${p}AccessToken`.padEnd(50, '0'), `${p}AccessSecret`.padEnd(45, '0')];
const DK = keysFor('dk'), FT = keysFor('ft'), NK = keysFor('nk'), BAD = keysFor('bad');
const deletes = () => M.botCalls.filter((c) => c.method === 'deleteMessage').length;

const photosTo = (id) => M.botCalls.filter((c) => ['sendPhoto', 'sendMediaGroup'].includes(c.method) && String(c.payload.chat_id) === String(id))
  .map((c) => (c.method === 'sendPhoto' ? [c.payload.photo.source] : c.payload.media.map((m) => m.media.source)).map((f) => f.split('/').pop()));

await test('Akun X: tombol Hubungkan → pilihan cara (Login X / pakai app brand lain / 4 kode manual / tutorial)', async () => {
  assert.ok(dataOf(await tap(ADMIN, 'm:acc')).includes('m:conn:dexvra'));
  const p = await tap(ADMIN, 'm:conn:dexvra');
  assert.match(p.text, /Hubungkan akun X Dexvra<\/b> — pilih cara/);
  assert.deepEqual(dataOf(p), ['m:ask:oauth:dexvra', 'm:oauthreuse:dexvra:fourtis', 'm:ask:keys:dexvra', 'm:guide', 'm:acc']);
  await tap(ADMIN, 'm:guide');
  assert.deepEqual(photosTo(ADMIN).at(-1), ['tutorial-1-izin.png', 'tutorial-2-kode.png', 'tutorial-3-pin.png']);
});

await test('gambar tutorial: PNG valid, ukuran wajar untuk Telegram', async () => {
  for (const n of ['tutorial-1-izin.png', 'tutorial-2-kode.png', 'tutorial-3-pin.png']) {
    const buf = fs.readFileSync(new URL(`../assets/${n}`, import.meta.url));
    assert.equal(buf.toString('latin1', 1, 4), 'PNG', n);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    assert.ok(w >= 800 && w + h <= 10000 && buf.length < 1e6, `${n}: ${w}x${h}, ${buf.length} byte`);
  }
});

await test('Akun X (4 kode manual): panduan sesuai console X, keempatnya sekaligus, pesan dihapus', async () => {
  const prompt = await tap(ADMIN, 'm:ask:keys:dexvra');
  assert.deepEqual(photosTo(ADMIN).at(-1), ['tutorial-1-izin.png', 'tutorial-2-kode.png']);
  assert.match(prompt.text, /lihat 2 gambar di atas/);
  assert.match(prompt.text, /OAuth 1\.0 Keys/);
  assert.match(prompt.text, /1\. Consumer Key \(API Key\)\n   2\. Secret Key \(API Key Secret\)/);
  assert.match(prompt.text, /3\. Access Token\n   4\. Access Token Secret/);
  assert.match(prompt.text, /Tidak dipakai: Bearer Token/);
  const dels = deletes();
  await dm(ADMIN, DK.join(' '));
  await until(() => db.brands.dexvra.x?.appKey === DK[0], 'akun Dexvra tersambung');
  assert.ok(deletes() > dels);
  assert.ok(messagesTo(ADMIN).some((m) => m.includes('Bot akan posting & berkomentar sebagai @dexvra_x')));
  await until(() => lastPanel(ADMIN)?.text?.includes('Akun X'), 'panel akun');
  assert.match(lastPanel(ADMIN).text, /Dexvra<\/b>: ✅ @dexvra_x/);
  const conf = await tap(ADMIN, 'm:accdel:dexvra');
  assert.match(conf.text, /Yakin lepas akun X/);
  await tap(ADMIN, 'm:acc'); // batal
  assert.ok(db.brands.dexvra.x);
});

await test('Akun X: kode SATU PER SATU (1/4 … 4/4) dan kode salah tempel langsung dikenali', async () => {
  await tap(ADMIN, 'm:ask:keys:fourtis');
  const dels = deletes();
  const clientId = Buffer.from('FakeClientIdValue0001:1:ci').toString('base64');
  assert.match(await dm(ADMIN, 'AAAAAAAAAAAAAAAAAAAAAFakeBearer%2Ftoken0000'), /Itu Bearer Token[\s\S]*Kirim lagi: <b>1\. Consumer Key/);
  assert.match(await dm(ADMIN, clientId), /Itu Client ID/);
  assert.match(await dm(ADMIN, FT[2]), /Ini Access Token[\s\S]*Consumer Key/);
  assert.match(await dm(ADMIN, FT[0]), /Consumer Key \(API Key\) diterima \(1\/4\)[\s\S]*Sekarang kirim: <b>2\. Secret Key \(API Key Secret\)<\/b>/);
  assert.match(await dm(ADMIN, 'pendek'), /terlalu pendek/);
  assert.match(await dm(ADMIN, FT[1]), /diterima \(2\/4\)[\s\S]*3\. Access Token/);
  assert.match(await dm(ADMIN, FT[3]), /bukan Access Token/);
  assert.match(await dm(ADMIN, FT[2]), /Access Token diterima \(3\/4\)[\s\S]*4\. Access Token Secret/);
  await dm(ADMIN, FT[3]);
  await until(() => messagesTo(ADMIN).some((m) => m.includes('Akun X Fourtis diganti: @fourtisbot')), 'akun Fourtis tersambung');
  assert.ok(deletes() - dels >= 9, 'semua pesan berisi kode dihapus');
  assert.deepEqual(db.brands.fourtis.x, { appKey: FT[0], appSecret: FT[1], accessToken: FT[2], accessSecret: FT[3] });
});

await test('Akun X: key ditolak X → petunjuk urutan & Read and write, key lama tetap dipakai', async () => {
  await tap(ADMIN, 'm:ask:keys:dexvra');
  await dm(ADMIN, BAD.slice(0, 2).join(' '));
  await dm(ADMIN, BAD.slice(2).join(' '));
  const r = messagesTo(ADMIN).find((m) => m.includes('Key tidak valid') && m.includes('Read and write'));
  assert.ok(r, 'pesan petunjuk');
  assert.match(r, /1\. Consumer Key \(API Key\), 2\. Secret Key \(API Key Secret\), 3\. Access Token[\s\S]*Key lama tetap dipakai/);
  assert.equal(db.brands.dexvra.x.appKey, DK[0]);
});

await test('Login X (PIN) pakai app Fourtis: link login → PIN → akun Dexvra tersambung', async () => {
  await tap(ADMIN, 'm:oauthreuse:dexvra:fourtis');
  assert.deepEqual(photosTo(ADMIN).at(-1), ['tutorial-3-pin.png']);
  assert.match(messagesTo(ADMIN).at(-1),
    /Login X untuk Dexvra[\s\S]*href="https:\/\/api\.x\.com\/oauth\/authorize\?oauth_token=reqtok&amp;force_login=true"[\s\S]*bukan akun pribadi[\s\S]*PIN/);
  const g = xcalls('generateAuthLink').at(-1);
  assert.equal(g[1], 'oob');
  assert.deepEqual(g[2], { linkMode: 'authorize', forceLogin: true });
  assert.equal(g[3], FT[0]);
  assert.match(await dm(ADMIN, '12'), /PIN berupa angka/);
  M.x.pinUser = 'dexvra_x';
  await dm(ADMIN, '1234567');
  await until(() => db.brands.dexvra.x.accessToken === '999-pin_dexvra_x', 'token dari PIN');
  assert.equal(db.brands.dexvra.x.appKey, FT[0]); // satu app, dua akun
  assert.ok(messagesTo(ADMIN).some((m) => m.includes('Akun X Dexvra diganti: @dexvra_x')));
});

await test('Login X (PIN): 2 kode app dulu; PIN salah ditolak; app key salah → pesan jelas', async () => {
  const p = await tap(ADMIN, 'm:ask:oauth:dexvra');
  const album = M.botCalls.filter((c) => c.method === 'sendMediaGroup').at(-1).payload.media;
  assert.match(album[1].caption, /cukup baris Consumer Key/);
  assert.match(p.text, /kirim 2 kode app[\s\S]*1\. Consumer Key \(API Key\)\n   2\. Secret Key \(API Key Secret\)/);
  assert.match(await dm(ADMIN, DK[0]), /diterima \(1\/2\)[\s\S]*2\. Secret Key/);
  await dm(ADMIN, DK[1]);
  assert.match(messagesTo(ADMIN).at(-1), /Login X untuk Dexvra/);
  assert.match(await dm(ADMIN, '7654321'), /PIN ditolak/);
  assert.equal(db.brands.dexvra.x.accessToken, '999-pin_dexvra_x'); // akun lama tetap
  await tap(ADMIN, 'm:ask:oauth:dexvra');
  await dm(ADMIN, BAD.slice(0, 2).join(' '));
  assert.match(messagesTo(ADMIN).at(-1), /Gagal membuat link login: Could not authenticate you[\s\S]*4 kode manual/);
});

await test('Brand baru lewat tombol: nama dulu, lalu pilih cara & hubungkan', async () => {
  await tap(ADMIN, 'm:ask:newbrand');
  assert.match(await dm(ADMIN, 'Nama Salah!'), /huruf kecil\/angka/);
  assert.match(await dm(ADMIN, 'dexvra'), /sudah ada/);
  await dm(ADMIN, 'nova');
  const p = lastPanel(ADMIN);
  assert.match(p.text, /Hubungkan akun X Nova<\/b> — pilih cara/);
  assert.ok(dataOf(p).includes('m:ask:keys:nova') && dataOf(p).includes('m:oauthreuse:nova:fourtis'));
  await tap(ADMIN, 'm:ask:keys:nova');
  await dm(ADMIN, NK.join(' '));
  await until(() => db.brands.nova?.x?.appKey === NK[0], 'brand Nova tersambung');
  assert.equal(db.brands.nova.username, 'nova_x');
  await dm(ADMIN, '/delaccount nova');
  assert.equal(db.brands.nova.x, null);
});

await test('Channel: tambah lewat tombol + pilih brand, ganti brand, hapus', async () => {
  M.botChats['@gamma'] = { id: -1001003, type: 'channel', username: 'gamma', title: 'Gamma' };
  M.botAdminIn.push(-1001003);
  await tap(ADMIN, 'm:ask:channel');
  assert.match(await dm(ADMIN, 'bukan channel'), /Format salah/);
  await dm(ADMIN, '@gamma');
  assert.deepEqual(dataOf(lastPanel(ADMIN)), ['m:chadd:fourtis:@gamma', 'm:chadd:dexvra:@gamma', 'm:chadd:nova:@gamma', 'm:chadd:*:@gamma']);
  let p = await tap(ADMIN, 'm:chadd:dexvra:@gamma');
  assert.ok(db.channels.includes('@gamma'));
  assert.equal(db.channelBrand['@gamma'], 'dexvra');
  assert.match(lastAnswer().text, /@gamma → Dexvra ditambahkan & sudah dipantau/);
  assert.match(p.text, /✅ @gamma → Dexvra/);
  p = await tap(ADMIN, 'm:chb:@gamma');
  assert.equal(db.channelBrand['@gamma'], 'nova');
  p = await tap(ADMIN, 'm:chb:@gamma');
  assert.equal(db.channelBrand['@gamma'], '*');
  assert.match(p.text, /✅ @gamma → Semua brand/);
  p = await tap(ADMIN, 'm:chb:@gamma');
  assert.equal(db.channelBrand['@gamma'], 'fourtis');
  p = await tap(ADMIN, 'm:chdel:@gamma');
  assert.ok(!db.channels.includes('@gamma'));
});

await test('Template: tambah (multi-baris), hapus, dan tweet bot ON/OFF lewat tombol', async () => {
  let p = await tap(ADMIN, 'm:tplb');
  assert.deepEqual(dataOf(p).slice(0, 3), ['m:tpl:fourtis', 'm:tpl:dexvra', 'm:tpl:nova']);
  p = await tap(ADMIN, 'm:tpl:dexvra');
  assert.match(p.text, /Template Dexvra/);
  await tap(ADMIN, 'm:ask:tpl:dexvra:t');
  await dm(ADMIN, '🚀 Baru: {name}\nx.com/{handle}');
  const list = db.brands.dexvra.tweetTemplates;
  assert.equal(list.at(-1), '🚀 Baru: {name}\nx.com/{handle}');
  p = await tap(ADMIN, `m:tdel:dexvra:t:${list.length}`);
  assert.ok(!db.brands.dexvra.tweetTemplates.includes('🚀 Baru: {name}\nx.com/{handle}'));
  await tap(ADMIN, 'm:twtog:dexvra');
  assert.equal(db.brands.dexvra.ownTweetEnabled, true);
  assert.match(lastAnswer().text, /Tweet bot Dexvra: ON/);
  let q = await tap(ADMIN, 'm:twtog:dexvra');
  assert.equal(db.brands.dexvra.ownTweetEnabled, false);
  assert.equal(dataOf(q)[0], 'm:twtog:dexvra'); // tombol ON/OFF paling atas
  assert.match(q.text, /T = Tweet bot: OFF<\/b>\n<i>Kalau ON:/);
  // dari panel Otomatis juga bisa, panel Otomatis tetap tampil
  q = await tap(ADMIN, 'm:twtog:dexvra:auto');
  assert.equal(db.brands.dexvra.ownTweetEnabled, true);
  assert.match(q.text, /Tweet bot: Fourtis ON · Dexvra ON/);
  assert.ok(dataOf(q).includes('m:twtog:fourtis:auto'));
  await tap(ADMIN, 'm:twtog:dexvra:auto');
  assert.equal(db.brands.dexvra.ownTweetEnabled, false);
});

await test('Opt-in manual & hapus lewat tombol', async () => {
  let p = await tap(ADMIN, 'm:opt');
  assert.match(p.text, /Bot HANYA berkomentar di tweet project yang ada di daftar ini/);
  assert.match(p.text, /Masih kosong — bot belum akan berkomentar/);
  await tap(ADMIN, 'm:ask:optin');
  await dm(ADMIN, '@PanelProj');
  assert.deepEqual(dataOf(lastPanel(ADMIN)), ['m:optadd:fourtis:panelproj', 'm:optadd:dexvra:panelproj', 'm:optadd:nova:panelproj']);
  await tap(ADMIN, 'm:optadd:dexvra:panelproj');
  assert.equal(db.optins.panelproj.brand, 'dexvra');
  p = await tap(ADMIN, 'm:opt');
  assert.match(p.text, /<b>Daftar \(1\)<\/b>\n@panelproj → Dexvra/);
  await tap(ADMIN, 'm:ask:deloptin');
  await dm(ADMIN, '@panelproj');
  assert.equal(db.optins.panelproj, undefined);
});

await test('/batal membatalkan input yang sedang ditunggu', async () => {
  await tap(ADMIN, 'm:ask:channel');
  assert.match(await dm(ADMIN, '/batal'), /Dibatalkan/);
  await dm(ADMIN, '@delta');
  assert.ok(!db.channels.includes('@delta'));
});

await test('Pause / jalankan lagi dari panel; bukan admin tidak bisa pakai panel', async () => {
  await tap(ADMIN, 'm:pause');
  assert.equal(db.paused, true);
  await tap(ADMIN, 'm:resume');
  assert.equal(db.paused, false);
  await tap(222, 'm:pause');
  assert.equal(db.paused, false);
  assert.equal(lastAnswer().text, 'Khusus admin');
  await tap(222, 'm:ask:channel');
  await dm(222, '@sneaky');
  assert.ok(!db.channels.includes('@sneaky'));
});

await test('bot privat: orang lain tidak bisa /optin; pesan privat maks. 1x per 10 menit', async () => {
  const n = messagesTo(333).length;
  assert.match(await dm(333, '/optin @SneakProj'), /Bot ini privat[\s\S]*333/);
  assert.equal(db.pending.sneakproj, undefined);
  await dm(333, '/menu');
  await dm(333, 'halo');
  assert.equal(messagesTo(333).length, n + 1);
});

await test('opt-in publik bisa dinyalakan dari panel (menu publik ikut muncul), lalu dimatikan lagi', async () => {
  const p = await tap(ADMIN, 'm:auto');
  assert.ok(buttonsOf(p).some((b) => b.text === 'Opt-in publik (/optin project): ❌ OFF'));
  await tap(ADMIN, 'm:tog:auto.publicOptin');
  assert.equal(db.auto.publicOptin, true);
  const pub = M.botCalls.filter((c) => c.method === 'setMyCommands' && !c.payload.scope).at(-1);
  assert.deepEqual(pub.payload.commands.map((c) => c.command), ['optin', 'verify', 'optout']);
  assert.match(await dm(444, '/optin @OpenProj fourtis'), /FTS-[A-Z0-9]+/);
  assert.ok(db.pending.openproj);
  assert.match(await dm(444, '/status'), /Bot ini privat/); // perintah admin tetap tertutup
  await tap(ADMIN, 'm:tog:auto.publicOptin');
  assert.equal(db.auto.publicOptin, false);
  delete db.pending.openproj;
});

await test('BOT_TOKEN kosong → berhenti dengan pesan jelas (TG API tidak diminta)', async () => {
  const r = spawnSync(process.execPath, [new URL('../src/index.js', import.meta.url).pathname], {
    cwd: tmp, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, BOT_TOKEN: '', ADMIN_IDS: '7176469093', DB_FILE: path.join(tmp, 'x.json') }
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.env belum lengkap: BOT_TOKEN kosong/);
  assert.doesNotMatch(r.stderr, /TG_API|TG_SESSION/);
});

// ---------- Tur lengkap: setiap perintah & setiap tombol ----------
await test('setiap perintah admin membalas tanpa error', async () => {
  const snap = JSON.stringify({ filter: db.filter, limits: db.limits, auto: db.auto });
  const cmds = [
    '/help', '/menu', '/status', '/accounts', '/xstatus', '/channels', '/tpls', '/tpls dexvra', '/optins',
    '/filter', '/filter minAgeDays 7', '/limits', '/limits maxPerDay 60', '/auto', '/auto dailyReportHour 8',
    '/jeda', '/jeda 2 4', '/jeda project 3', '/jeda abc',
    '/addtpl dexvra Tur {name} 🙌', '/deltpl dexvra 99', '/addtweet Tur {name}\nx.com/{handle}', '/deltweet 99',
    '/tweet off dexvra', '/tweet on dexvra', '/tweet maybe',
    '/addoptin @TourProj dexvra', '/addoptin bad-handle', '/deloptin @tourproj',
    '/addchannel @tourch', '/delchannel @tourch', '/addchannel', '/addchannel @x nobrand',
    '/pause', '/resume', '/resume dexvra', '/resume nobrand',
    '/delaccount', '/delaccount nobrand', '/setx', '/addaccount', '/addaccount dexvra bad b c d',
    '/optin', '/verify', '/optout', '/batal', '/start'
  ];
  const silent = [];
  for (const c of cmds) {
    const n = M.botCalls.filter((x) => x.method === 'sendMessage' && String(x.payload.chat_id) === String(ADMIN)).length;
    await dm(ADMIN, c);
    const m = M.botCalls.filter((x) => x.method === 'sendMessage' && String(x.payload.chat_id) === String(ADMIN)).length;
    if (m === n) silent.push(c);
  }
  assert.deepEqual(silent, [], 'perintah tanpa balasan');
  db.brands.dexvra.templates = db.brands.dexvra.templates.filter((t) => !t.startsWith('Tur '));
  db.brands.fourtis.tweetTemplates = db.brands.fourtis.tweetTemplates.filter((t) => !t.startsWith('Tur '));
  Object.assign(db, JSON.parse(snap));
  assert.equal(db.paused, false);
});

await test('/setreport di DM dan di channel (bot mode) mengatur channel laporan', async () => {
  await dm(ADMIN, '/setreport');
  assert.equal(db.reportChat, ADMIN);
  M.chatAdmins[-1007777] = [ADMIN];
  await M.bot.handleUpdate({ update_id: updateId++, channel_post: { message_id: 1, date: unix(Date.now()), chat: { id: -1007777, type: 'channel', title: 'Lap' }, text: '/setreport', entities: [{ type: 'bot_command', offset: 0, length: 10 }] } });
  await until(() => db.reportChat === -1007777, 'reportChat channel');
  db.reportChat = REPORT;
});

await test('Channel laporan lewat tombol: ID dicek dulu dengan pesan tes; ID salah / bot belum admin → ditolak, yang lama tetap', async () => {
  let p = await tap(ADMIN, 'm:home');
  assert.ok(dataOf(p).includes('m:ask:report'));
  await tap(ADMIN, 'm:ask:report');
  assert.match(lastPanel(ADMIN).text, /Jadikan bot ADMIN di channel laporan/);
  assert.match(await dm(ADMIN, 'bukan-id'), /Format salah/);
  M.unreachable = ['-1003976150269'];
  assert.match(await dm(ADMIN, '-1003976150269'), /Bot tidak bisa mengirim pesan ke -1003976150269 \(Bad Request: chat not found\)[\s\S]*Channel laporan lama tetap dipakai/);
  assert.equal(db.reportChat, REPORT);
  M.unreachable = [];
  M.botChats['-1003976150269'] = { id: -1003976150269, type: 'channel', title: 'Laporan Fourtis' };
  await dm(ADMIN, '-1003976150269'); // masih menunggu input: kirim lagi setelah bot dijadikan admin
  assert.equal(db.reportChat, -1003976150269);
  assert.ok(messagesTo(-1003976150269).some((m) => m.includes('Channel laporan aktif')));
  assert.ok(messagesTo(ADMIN).some((m) => m.includes('✅ Laporan sekarang dikirim ke Laporan Fourtis')));
  // lewat perintah juga dicek
  M.unreachable = ['-1009999999'];
  assert.match(await dm(ADMIN, '/setreport -1009999999'), /Bot tidak bisa mengirim/);
  assert.equal(db.reportChat, -1003976150269);
  assert.match(await dm(ADMIN, '/setreport abc'), /Format: \/setreport/);
  M.unreachable = [];
  db.reportChat = REPORT;
});

await test('telusuri SEMUA tombol panel: tiap tombol merespons tanpa error', async () => {
  const snap = JSON.stringify({ filter: db.filter, limits: db.limits, auto: db.auto, paused: db.paused, brands: db.brands, channelBrand: db.channelBrand });
  const skip = /^m:(accdelok|chdel|tdel|optadd|chadd):/; // aksi hapus/tambah diuji terpisah
  const seen = new Set(), queue = ['m:home'], noAnswer = [], noPanel = [];
  while (queue.length && seen.size < 300) {
    const d = queue.shift();
    if (seen.has(d) || skip.test(d)) continue;
    seen.add(d);
    const answers = M.botCalls.filter((c) => c.method === 'answerCallbackQuery').length;
    const p = await tap(ADMIN, d);
    if (M.botCalls.filter((c) => c.method === 'answerCallbackQuery').length === answers) noAnswer.push(d);
    if (!p?.text) noPanel.push(d);
    if (/^m:(ask|oauthreuse):/.test(d)) { await dm(ADMIN, '/batal'); continue; }
    for (const x of dataOf(p)) if (x?.startsWith('m:') && !seen.has(x)) queue.push(x);
  }
  Object.assign(db, JSON.parse(snap));
  await tap(ADMIN, 'm:home');
  assert.ok(seen.size > 60, `hanya ${seen.size} tombol ditelusuri`);
  assert.deepEqual(noAnswer, [], 'tombol tanpa respons (loading terus)');
  assert.deepEqual(noPanel, [], 'tombol tanpa tampilan');
  console.log(`     (${seen.size} tombol ditelusuri)`);
});

await test('data besar (40 template, 300 opt-in, 60 channel): daftar & panel tetap terkirim', async () => {
  const snap = JSON.stringify({ brands: db.brands, optins: db.optins, channels: db.channels, channelBrand: db.channelBrand });
  for (let i = 0; i < 40; i++) db.brands.dexvra.templates.push(`Template panjang nomor ${i} untuk {name} `.repeat(4));
  for (let i = 0; i < 300; i++) db.optins[`proj_${i}`] = { at: now, via: 'admin', brand: i % 2 ? 'dexvra' : 'fourtis' };
  for (let i = 0; i < 60; i++) db.channels.push(`@channel_nomor_${i}`);
  const n = M.botCalls.filter((c) => c.method === 'sendMessage').length;
  await dm(ADMIN, '/optins');
  await dm(ADMIN, '/tpls');
  await dm(ADMIN, '/channels');
  assert.ok(M.botCalls.filter((c) => c.method === 'sendMessage').length - n > 3, 'daftar panjang dipecah');
  for (const d of ['m:tpl:dexvra', 'm:opt', 'm:ch', 'm:acc', 'm:home', 'm:status']) assert.ok((await tap(ADMIN, d))?.text, d);
  Object.assign(db, JSON.parse(snap));
});

await test('semua pesan bot lolos aturan Telegram (HTML, panjang, tombol, perintah)', async () => {
  if (M.apiErrors.length) console.log(JSON.stringify(M.apiErrors, null, 1));
  assert.deepEqual(M.apiErrors, []);
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
