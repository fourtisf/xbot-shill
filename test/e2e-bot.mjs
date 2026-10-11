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
      entities: [{ type: 'bot_command', offset: 0, length: cmd.length }]
    }
  });
  await sleep(30);
  return messagesTo(from).at(-1);
}

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
