// Test end-to-end mode bot saja: TG_API_ID / TG_API_HASH / TG_SESSION kosong,
// bot membaca post dari channel tempat dia jadi admin. Jalankan: npm test
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
  limits: { minDelaySec: 0, maxDelaySec: 0, maxPerHour: 1000, maxPerDay: 1000 },
  auto: { catchUpMin: 1, watchIntervalMin: 1, verifyIntervalMin: 1, dailyReportHour: 23, replyGapMin: 0 },
  lastDaily: new Date().toDateString()
}));

// Hanya BOT_TOKEN + ADMIN_IDS; TG_* sengaja kosong (string kosong supaya .env di server tidak ikut terbaca)
Object.assign(process.env, {
  DB_FILE, BOT_TOKEN: '123:test', ADMIN_IDS: String(ADMIN), TG_API_ID: '', TG_API_HASH: '', TG_SESSION: '', TICK_MS: '100'
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

await test('/addchannel: bot belum admin → diberi tahu, lalu terdeteksi otomatis setelah jadi admin', async () => {
  assert.match(await dm(ADMIN, '/addchannel @beta dexvra'), /bot BELUM jadi admin di channel ini/);
  assert.match(await dm(ADMIN, '/channels'), /⚠️ bot belum admin @beta/);
  M.botAdminIn.push(beta.id);
  await until(() => reports().find((r) => r.includes('Bot sudah admin di @beta')), 'deteksi admin', 8000);
  assert.match(await dm(ADMIN, '/channels'), /✅ @beta → Dexvra/);
});

await test('/status menampilkan mode bot saja', async () => {
  const s = await dm(ADMIN, '/status');
  assert.match(s, /Mode: bot saja/);
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
  assert.match(p.text, /Jeda & Batas/);
  p = await tap(ADMIN, 'm:set:limits.maxPerHour:30');
  assert.equal(db.limits.maxPerHour, 30);
  assert.ok(buttonsOf(p).some((b) => b.text === '✅30'));
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

await test('Akun X: hubungkan Dexvra lewat tombol, pesan berisi key langsung dihapus', async () => {
  const prompt = await tap(ADMIN, 'm:ask:keys:dexvra');
  assert.match(prompt.text, /APP_KEY APP_SECRET ACCESS_TOKEN ACCESS_SECRET/);
  const dels = M.botCalls.filter((c) => c.method === 'deleteMessage').length;
  await dm(ADMIN, 'dk ds dt da');
  await until(() => db.brands.dexvra.x?.appKey === 'dk', 'akun Dexvra tersambung');
  assert.ok(M.botCalls.filter((c) => c.method === 'deleteMessage').length > dels);
  await until(() => lastPanel(ADMIN)?.text?.includes('Akun X'), 'panel akun');
  assert.match(lastPanel(ADMIN).text, /Dexvra<\/b>: ✅ @dexvra_x/);
  const conf = await tap(ADMIN, 'm:accdel:dexvra');
  assert.match(conf.text, /Yakin lepas akun X/);
  await tap(ADMIN, 'm:acc'); // batal
  assert.ok(db.brands.dexvra.x);
});

await test('Channel: tambah lewat tombol + pilih brand, ganti brand, hapus', async () => {
  M.botChats['@gamma'] = { id: -1001003, type: 'channel', username: 'gamma', title: 'Gamma' };
  M.botAdminIn.push(-1001003);
  await tap(ADMIN, 'm:ask:channel');
  assert.match(await dm(ADMIN, 'bukan channel'), /Format salah/);
  await dm(ADMIN, '@gamma');
  assert.deepEqual(dataOf(lastPanel(ADMIN)), ['m:chadd:fourtis:@gamma', 'm:chadd:dexvra:@gamma']);
  let p = await tap(ADMIN, 'm:chadd:dexvra:@gamma');
  assert.ok(db.channels.includes('@gamma'));
  assert.equal(db.channelBrand['@gamma'], 'dexvra');
  assert.match(lastAnswer().text, /@gamma → Dexvra ditambahkan & sudah dipantau/);
  assert.match(p.text, /✅ @gamma → Dexvra/);
  p = await tap(ADMIN, 'm:chb:@gamma');
  assert.equal(db.channelBrand['@gamma'], 'fourtis');
  p = await tap(ADMIN, 'm:chdel:@gamma');
  assert.ok(!db.channels.includes('@gamma'));
});

await test('Template: tambah (multi-baris), hapus, dan tweet bot ON/OFF lewat tombol', async () => {
  let p = await tap(ADMIN, 'm:tplb');
  assert.deepEqual(dataOf(p).slice(0, 2), ['m:tpl:fourtis', 'm:tpl:dexvra']);
  p = await tap(ADMIN, 'm:tpl:dexvra');
  assert.match(p.text, /Template Dexvra/);
  await tap(ADMIN, 'm:ask:tpl:dexvra:t');
  await dm(ADMIN, '🚀 Baru: {name}\nx.com/{handle}');
  const list = db.brands.dexvra.tweetTemplates;
  assert.equal(list.at(-1), '🚀 Baru: {name}\nx.com/{handle}');
  p = await tap(ADMIN, `m:tdel:dexvra:t:${list.length}`);
  assert.ok(!db.brands.dexvra.tweetTemplates.includes('🚀 Baru: {name}\nx.com/{handle}'));
  await tap(ADMIN, 'm:twtog:dexvra');
  assert.equal(db.brands.dexvra.ownTweetEnabled, false);
  await tap(ADMIN, 'm:twtog:dexvra');
  assert.equal(db.brands.dexvra.ownTweetEnabled, true);
});

await test('Opt-in manual & hapus lewat tombol', async () => {
  await tap(ADMIN, 'm:ask:optin');
  await dm(ADMIN, '@PanelProj');
  assert.deepEqual(dataOf(lastPanel(ADMIN)), ['m:optadd:fourtis:panelproj', 'm:optadd:dexvra:panelproj']);
  await tap(ADMIN, 'm:optadd:dexvra:panelproj');
  assert.equal(db.optins.panelproj.brand, 'dexvra');
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

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
