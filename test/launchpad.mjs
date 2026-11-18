// Test src/launchpad.js — modul data launchpad, tanpa jaringan (fetch palsu). Jalankan: node test/launchpad.mjs
// Fixture dipangkas dari jawaban API asli (18 Nov 2026): baris LaunchLab letsbonk.fun, token Clanker, pool Pons dari
// GeckoTerminal, hasil getTokenInfo() token Pons dari RPC Robinhood Chain, profil DexScreener.
import assert from 'node:assert/strict';
import * as lp from '../src/launchpad.js';

const PONS_INFO_HEX = '0x' + [
  '0000000000000000000000009a62c45e4e231fde3a1af956aed1772734c4d94d',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0000000000000000000000000000000000000000000000000000000000000120',
  '0000000000000000000000000000000000000000000000000000000000000140',
  '0000000000000000000000000000000000000000000000000000000000000063',
  '68747470733a2f2f63646e2e64657873637265656e65722e636f6d2f636d732f',
  '696d616765732f5449683778564d6e5f44324471556b723f77696474683d3830',
  '30266865696768743d383030267175616c6974793d383026666f726d61743d61',
  '75746f0000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000000000000000000000000000000000a0',
  '00000000000000000000000000000000000000000000000000000000000000e0',
  '0000000000000000000000000000000000000000000000000000000000000120',
  '0000000000000000000000000000000000000000000000000000000000000140',
  '0000000000000000000000000000000000000000000000000000000000000180',
  '000000000000000000000000000000000000000000000000000000000000001d',
  '68747470733a2f2f782e636f6d2f646163697479636f696e5f67746136000000',
  '000000000000000000000000000000000000000000000000000000000000001b',
  '68747470733a2f2f742e6d652f446163697479436f696e5f4754410000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000016',
  '68747470733a2f2f61756461636974792e6d656d652f00000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000'
].join('');
const GATO = '0xd36a4a5cedf7ebbd1df4a2f7b4b2e2f53805f1b8';
const GT_PONS = {
  data: [
    { id: 'robinhood_0xb3b9', type: 'pool', attributes: { address: '0xb3b967590a038f9e636dd3934812c3e80f21966a', name: 'GATO / TTWO', fdv_usd: '4900.53', market_cap_usd: null },
      relationships: { base_token: { data: { id: `robinhood_${GATO}`, type: 'token' } }, dex: { data: { id: 'pons-v2', type: 'dex' } } } },
    { id: 'robinhood_0xant', type: 'pool', attributes: { address: '0xant', name: 'ANT / WETH 1%', fdv_usd: '173069' },
      relationships: { base_token: { data: { id: 'robinhood_0x7ca7c84b8e42a2789f203e73b7a7fbb930f1f0aa', type: 'token' } }, dex: { data: { id: 'uniswap-v4-robinhood', type: 'dex' } } } }
  ],
  included: [{ id: `robinhood_${GATO}`, type: 'token', attributes: { address: GATO, name: 'GTA6 Cat Mascot', symbol: 'GATO' } }]
};
const BONK_ROW = { mint: '9jSS162QcnzV1hzQreeZAgSwXfqEXkx33ETFTqrfbonk', name: 'BEANS', symbol: 'BEANS', twitter: 'https://x.com/beansbzr',
  website: 'https://x.com/beansbzr', marketCap: 2096.85, platformInfo: { name: 'letsbonk.fun', pubKey: 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1' } };
const STONK_ROW = { mint: '4E876tZAhSm', name: 'Rhinovx', symbol: 'RHX', twitter: 'https://x.com/Rhinovx', telegram: 'https://t.me/RhinovxCoin',
  marketCap: 2097.66, platformInfo: { name: 'StonkFun', pubKey: '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7' } };
const CLANKER = { contract_address: '0x20641E4790423744b42d5aF39C7A50bc1d815931', name: 'Wrapped BMY', symbol: 'wBMYx', chain_id: 8453,
  priceUsd: 1.79e-05, supply: '1000000000000000000000000000', metadata: { socialMediaUrls: [
    { url: 'https://xstocks.fi', platform: 'website' }, { url: 'https://twitter.com/xstocksfi', platform: 'twitter' },
    { url: ' https://t.me/xstocksfi', platform: 'telegram' }] } };

// ---------- fetch palsu ----------
let routes = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, body: init.body });
  const key = Object.keys(routes).find((k) => url.startsWith(k));
  if (!key) throw new TypeError(`fetch tidak di-mock: ${url}`);
  let v = routes[key];
  if (typeof v === 'function') v = v(url, init);
  if (v?.httpStatus) return new Response(v.text || '', { status: v.httpStatus });
  return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
};

const results = [];
async function test(name, fn) {
  routes = {}; calls.length = 0;
  try { await fn(); results.push(true); console.log('  ✔', name); } catch (e) { results.push(false); console.log('  ✘', name, '\n    ', e.message); }
}
console.log('Launchpad — test modul data\n');

await test('link X: profil, @handle, tweet, komunitas; search/intent/home & domain lain dibuang', () => {
  assert.equal(lp.normX('https://twitter.com/Foo_Bar?s=21'), 'https://x.com/Foo_Bar');
  assert.equal(lp.normX('@foo'), 'https://x.com/foo');
  assert.equal(lp.normX('https://x.com/a/status/123?t=1'), 'https://x.com/a/status/123');
  assert.equal(lp.normX('x.com/i/communities/1950/'), 'https://x.com/i/communities/1950');
  for (const v of ['https://x.com/search?q=$A', 'https://twitter.com/intent/tweet', 'x.com/home', 'https://t.me/foo', 'https://foo.io', '', null]) {
    assert.equal(lp.normX(v), '', String(v));
  }
});

await test('link Telegram: grup, @nama, undangan, t.me/s/, link pesan; bot / ?start / t.me/c / folder dibuang', () => {
  assert.equal(lp.normTg(' https://t.me/xstocksfi'), 'https://t.me/xstocksfi');
  assert.equal(lp.normTg('@DacityCoin_GTA'), 'https://t.me/DacityCoin_GTA');
  assert.equal(lp.normTg('https://t.me/+AbCdEf123'), 'https://t.me/+AbCdEf123');
  assert.equal(lp.normTg('https://t.me/s/mychan'), 'https://t.me/mychan');
  assert.equal(lp.normTg('https://t.me/mychan/55'), 'https://t.me/mychan');
  for (const v of ['https://t.me/PumpBot', 'https://t.me/foo_x?start=r1', 'https://t.me/c/123/4', 'https://t.me/addlist/abc', 'https://t.me/']) {
    assert.equal(lp.normTg(v), '', v);
  }
  assert.equal(lp.normWeb('https://x.com/beansbzr'), '', 'website yang ternyata link X');
  assert.equal(lp.normWeb('audacity.meme'), 'https://audacity.meme');
});

await test('PumpFun: mint, nama, MC, link dari API pump.fun (daftar atau {coins})', async () => {
  routes[lp.URLS.pumpfun] = [{ mint: 'M1pump', name: 'Tok', symbol: 'TOK', twitter: 'x.com/tok', telegram: '@tokgrp', website: '', usd_market_cap: 3 }];
  const [t] = await lp.fetchSource('pumpfun');
  assert.deepEqual([t.pad, t.label, t.chain, t.ca, t.symbol, t.mc, t.x, t.tg], ['pumpfun', 'PumpFun', 'solana', 'M1pump', 'TOK', 3, 'https://x.com/tok', 'https://t.me/tokgrp']);
  routes[lp.URLS.pumpfun] = { coins: [{ mint: 'M2pump', name: 'B' }] };
  assert.equal((await lp.fetchSource('pumpfun'))[0].ca, 'M2pump');
});

await test('diblokir (403 Cloudflare / halaman HTML) → error yang jelas', async () => {
  routes[lp.URLS.pumpfun] = { httpStatus: 403, text: '<!DOCTYPE html><html><title>Just a moment...</title>' };
  await assert.rejects(lp.fetchSource('pumpfun'), /HTTP 403 \(diblokir Cloudflare\/wilayah\)/);
  routes[lp.URLS.fourmeme] = '<html>maintenance</html>';
  await assert.rejects(lp.fetchSource('fourmeme'), /bukan JSON/);
});

await test('LaunchLab: letsbonk.fun = BonkFun, platform lain = "LaunchLab · nama"', async () => {
  routes[lp.URLS.launchlab] = { success: true, data: { rows: [STONK_ROW, BONK_ROW] } };
  const [stonk, bonk] = await lp.fetchSource('launchlab');
  assert.deepEqual([stonk.pad, stonk.label, stonk.tg], ['launchlab', 'LaunchLab · StonkFun', 'https://t.me/RhinovxCoin']);
  assert.deepEqual([bonk.pad, bonk.label, bonk.x, bonk.web], ['bonkfun', 'BonkFun', 'https://x.com/beansbzr', '']);
});

await test('Four.meme: kolom link dibaca longgar (twitterUrl / telegramUrl / webUrl), shortName = simbol', async () => {
  routes[lp.URLS.fourmeme] = { code: 0, data: [{ address: '0xabc4444', name: 'Four', shortName: 'FOUR', symbol: 'BNB',
    twitterUrl: 'https://x.com/fourtok', telegramUrl: 'https://t.me/fourgrp', webUrl: 'four.io' }] };
  const [t] = await lp.fetchSource('fourmeme');
  assert.deepEqual([t.chain, t.symbol, t.x, t.tg, t.web], ['bsc', 'FOUR', 'https://x.com/fourtok', 'https://t.me/fourgrp', 'https://four.io']);
  routes[lp.URLS.fourmeme] = { code: 401, msg: 'forbidden' };
  await assert.rejects(lp.fetchSource('fourmeme'), /four\.meme code 401/);
});

await test('Clanker: socialMediaUrls (spasi di depan URL), chain dari chain_id, MC = harga × supply', async () => {
  routes[lp.URLS.clanker] = { data: [CLANKER] };
  const [t] = await lp.fetchSource('clanker');
  assert.deepEqual([t.chain, t.x, t.tg, t.web, lp.fmtMc(t.mc)], ['base', 'https://x.com/xstocksfi', 'https://t.me/xstocksfi', 'https://xstocks.fi', '$17.9K']);
});

await test('Pons: hanya pool dex pons*, nama dari GeckoTerminal, link X/TG dari getTokenInfo() di RPC', async () => {
  const info = lp.decodeTokenInfo(PONS_INFO_HEX);
  assert.deepEqual([info.twitter, info.telegram, info.website], ['https://x.com/dacitycoin_gta6', 'https://t.me/DacityCoin_GTA', 'https://audacity.meme/']);
  routes[lp.URLS.pons] = GT_PONS;
  routes[lp.ROBINHOOD_RPC] = (url, init) => {
    const req = JSON.parse(init.body);
    assert.deepEqual(req.params[0], { to: GATO, data: '0xabb1dc44' });
    return { jsonrpc: '2.0', id: 1, result: PONS_INFO_HEX };
  };
  const toks = await lp.fetchSource('pons');
  assert.equal(toks.length, 1);
  const [t] = toks;
  assert.deepEqual([t.name, t.symbol, t.chain, t.x, t.needsSocials], ['GTA6 Cat Mascot', 'GATO', 'robinhood', '', true]);
  await lp.enrichSource('pons', toks, {});
  assert.deepEqual([t.x, t.tg, t.web, t.needsSocials], ['https://x.com/dacitycoin_gta6', 'https://t.me/DacityCoin_GTA', 'https://audacity.meme/', undefined]);
  assert.match(t.chart, /geckoterminal\.com\/robinhood\/pools\/0xb3b9/);
});

await test('Pons: RPC error / token tanpa getTokenInfo → ditandai retry, bukan crash', async () => {
  routes[lp.URLS.pons] = GT_PONS;
  routes[lp.ROBINHOOD_RPC] = { jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } };
  const toks = await lp.fetchSource('pons');
  await lp.enrichSource('pons', toks, {});
  assert.match(toks[0].retry, /RPC: rate limited/);
  routes[lp.ROBINHOOD_RPC] = { jsonrpc: '2.0', id: 1, result: '0x' };
  const again = await lp.fetchSource('pons');
  await lp.enrichSource('pons', again, {});
  assert.match(again[0].retry, /bukan token Pons/);
});

await test('DexScreener cadangan: hanya alamat pump / bonk / 4444 / ffff, nama & MC dari tokens API', async () => {
  routes[lp.URLS.dexscreener] = [
    { chainId: 'solana', tokenAddress: '2JjcwB1vRGoGQbj8y9WQEBwCqeZDCdbugk3AhjeMpump', links: [{ type: 'twitter', url: 'https://x.com/ilyonpf?s=11' }] },
    { chainId: 'bsc', tokenAddress: '0x1234d058FffF', links: [{ label: 'Website', url: 'https://w.io' }, { type: 'telegram', url: 'https://t.me/fourgrp' }] },
    { chainId: 'base', tokenAddress: '0xabc31EB34E4', links: [{ type: 'twitter', url: 'https://x.com/random' }] }
  ];
  routes[`${lp.URLS.dexTokens}solana/`] = [{ baseToken: { address: '2JjcwB1vRGoGQbj8y9WQEBwCqeZDCdbugk3AhjeMpump', name: 'There is no Meme', symbol: 'ILY' }, marketCap: 15300 }];
  routes[`${lp.URLS.dexTokens}bsc/`] = { httpStatus: 500 };
  const toks = await lp.fetchSource('dexscreener');
  assert.deepEqual(toks.map((t) => t.pad), ['pumpfun', 'fourmeme']);
  await lp.enrichSource('dexscreener', toks, {});
  assert.deepEqual([toks[0].name, toks[0].symbol, lp.fmtMc(toks[0].mc), toks[0].x], ['There is no Meme', 'ILY', '$15.3K', 'https://x.com/ilyonpf']);
  assert.deepEqual([toks[1].name, toks[1].tg], ['?', 'https://t.me/fourgrp'], 'tokens API gagal: laporan tetap jalan dengan link');
});

await test('kunci token: alamat EVM huruf kecil, Solana apa adanya', () => {
  assert.equal(lp.tokenKey({ chain: 'base', ca: '0xAbC' }), 'base:0xabc');
  assert.equal(lp.tokenKey({ chain: 'solana', ca: 'AbCpump' }), 'solana:AbCpump');
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
