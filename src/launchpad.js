// ---------- Launchpad: token baru dari launchpad besar → laporan X / Telegram ----------
// Modul data murni (tanpa Telegram / db): membaca token baru dari tiap launchpad beserta link X / Telegram / web-nya.
// index.js memasukkan link itu ke jalur yang SAMA dengan post channel target: link X → laporan "siap dikomentari"
// di channel laporan, link Telegram → channel Telegram (permintaan operator 18 Nov 2026).
//
// Sumber — bentuk datanya dicek langsung 18 Nov 2026, kecuali yang ditandai:
//   pumpfun      PumpFun (Solana): frontend-api-v3.pump.fun/coins urut terbaru. Dari server cloud diblokir Cloudflare,
//                jadi belum dicek dari sini; endpoint yang sama dipakai bot Python fourtisshill
//   launchlab    Raydium LaunchLab (Solana): launch-mint-v1.raydium.io. Platform letsbonk.fun = BonkFun (pad bonkfun),
//                platform lain = LaunchLab (pad launchlab)
//   fourmeme     Four.meme (BSC): four.meme/meme-api — diblokir per wilayah dari server cloud, BELUM terverifikasi.
//                Kolom link dibaca longgar (nama kolom berisi twitter / telegram / web; SDK four.meme: twitterUrl,
//                telegramUrl, webUrl, shortName). Cadangan: pad dexscreener
//   clanker      Clanker (Base, Robinhood, …): clanker.world/api/tokens (limit maks. 20), link di metadata.socialMediaUrls
//   pons         Pons (Robinhood Chain, chainId 4663): pool baru dari GeckoTerminal (dex "pons…"), link X / TG dibaca dari
//                kontrak token: getTokenInfo() lewat RPC Robinhood Chain (dokumentasi Mobula "Pons Launchpad Integration")
//   dexscreener  Cadangan: profil token DexScreener terbaru yang alamatnya berakhiran pump / bonk (Solana) atau
//                4444 / ffff (BSC) — dilaporkan atas nama launchpad-nya

export const PADS = ['pumpfun', 'bonkfun', 'launchlab', 'fourmeme', 'clanker', 'pons', 'dexscreener'];
export const PAD_LABELS = {
  pumpfun: 'PumpFun', bonkfun: 'BonkFun', launchlab: 'Raydium LaunchLab', fourmeme: 'Four.meme',
  clanker: 'Clanker', pons: 'Pons', dexscreener: 'DexScreener (cadangan)'
};
// Sumber → pad yang dihasilkannya (satu API LaunchLab melayani BonkFun dan LaunchLab)
export const SOURCE_PADS = {
  pumpfun: ['pumpfun'], launchlab: ['bonkfun', 'launchlab'], fourmeme: ['fourmeme'],
  clanker: ['clanker'], pons: ['pons'], dexscreener: ['dexscreener']
};
export const SOURCES = Object.keys(SOURCE_PADS);
export const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const CHAIN_NAMES = {
  solana: 'Solana', bsc: 'BSC', base: 'Base', robinhood: 'Robinhood', arbitrum: 'Arbitrum',
  ethereum: 'Ethereum', unichain: 'Unichain', monad: 'Monad', abstract: 'Abstract'
};
const CLANKER_CHAINS = { 8453: 'base', 4663: 'robinhood', 42161: 'arbitrum', 1: 'ethereum', 130: 'unichain', 143: 'monad', 2741: 'abstract', 56: 'bsc' };

export const URLS = {
  pumpfun: 'https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
  launchlab: 'https://launch-mint-v1.raydium.io/get/list?sort=new&size=100&mintType=default&includeNsfw=false',
  fourmeme: 'https://four.meme/meme-api/v1/private/token/query?orderBy=TimeDesc&tokenName=&listedPancake=false&pageIndex=1&pageSize=30',
  clanker: 'https://www.clanker.world/api/tokens?sort=desc&limit=20',
  pons: 'https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools?page=1&include=base_token',
  dexscreener: 'https://api.dexscreener.com/token-profiles/latest/v1',
  dexTokens: 'https://api.dexscreener.com/tokens/v1/'
};
const BONK_PLATFORM = 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1';
const SEL_GET_TOKEN_INFO = '0xabb1dc44'; // keccak256("getTokenInfo()")[:4]
const HEADERS = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };

// ---------- Link ----------
const X_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com(?:\/(.*))?$/i;
const X_RESERVED = new Set(['home', 'search', 'explore', 'intent', 'share', 'hashtag', 'settings', 'notifications',
  'messages', 'login', 'signup', 'tos', 'privacy', 'compose']);
const TG_URL = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)(?:\/(.*))?$/i;
const TG_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const TG_RESERVED = new Set(['c', 'addlist', 'boost', 'share', 'proxy', 'socks', 'addstickers', 'addemoji', 'setlanguage', 'iv', 'login', 'contact']);
const parts = (p = '') => p.split(/[?#]/)[0].split('/').filter(Boolean);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Link X yang bisa dibuka, atau '' kalau bukan link X. Profil → https://x.com/<handle>; tweet → …/status/<id>;
// komunitas → https://x.com/i/communities/<id>. Query (?s=20) dibuang
export function normX(value) {
  const v = str(value);
  if (!v) return '';
  const m = X_URL.exec(v);
  const p = m ? parts(m[1]) : /^@?[A-Za-z0-9_]{1,30}$/.test(v) ? [v.replace(/^@/, '')] : null;
  if (!p?.length) return '';
  const [head] = p;
  if (head.toLowerCase() === 'i') return p[1]?.toLowerCase() === 'communities' && /^\d+$/.test(p[2] || '') ? `https://x.com/i/communities/${p[2]}` : '';
  if (X_RESERVED.has(head.toLowerCase()) || !/^[A-Za-z0-9_]{1,30}$/.test(head)) return '';
  if (p[1]?.toLowerCase() === 'status' && /^\d+$/.test(p[2] || '')) return `https://x.com/${head}/status/${p[2]}`;
  return `https://x.com/${head}`;
}

// Link grup / channel Telegram yang bisa dibuka, atau ''. Bot (…bot, ?start=), t.me/c/…, folder, boost dibuang
export function normTg(value) {
  const v = str(value);
  if (!v) return '';
  const m = TG_URL.exec(v);
  const raw = m ? m[1] || '' : v.startsWith('@') || TG_NAME.test(v) ? v.replace(/^@/, '') : null;
  if (raw === null || /start=/i.test(raw)) return '';
  const p = parts(raw);
  if (!p.length) return '';
  let [head] = p;
  if (/^\+[\w-]{5,}$/.test(head)) return `https://t.me/${head}`;
  if (head.toLowerCase() === 'joinchat') return /^[\w-]{5,}$/.test(p[1] || '') ? `https://t.me/joinchat/${p[1]}` : '';
  if (head.toLowerCase() === 's' && p[1]) head = p[1];
  else if (TG_RESERVED.has(head.toLowerCase())) return '';
  if (!TG_NAME.test(head) || head.toLowerCase().endsWith('bot')) return '';
  return `https://t.me/${head}`;
}

export function normWeb(value) {
  let v = str(value);
  if (!v || /\s/.test(v)) return '';
  if (!/^https?:\/\//i.test(v)) {
    if (!v.includes('.')) return '';
    v = 'https://' + v;
  }
  return X_URL.test(v) || TG_URL.test(v) ? '' : v;
}

const num = (v) => {
  const f = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(f) || f < 0 ? null : f;
};
export function chartUrl(chain, ca) {
  if (['solana', 'bsc', 'base', 'arbitrum', 'ethereum'].includes(chain)) return `https://dexscreener.com/${chain}/${ca}`;
  if (chain === 'robinhood') return `https://robinhoodchain.blockscout.com/token/${ca}`;
  return '';
}
export const tokenKey = (t) => `${t.chain}:${t.ca.startsWith('0x') ? t.ca.toLowerCase() : t.ca}`;
export function fmtMc(mc) {
  if (mc === null || mc === undefined) return '-';
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(2)}M`;
  if (mc >= 1e3) return `$${(mc / 1e3).toFixed(1)}K`;
  return `$${Math.round(mc)}`;
}

export function makeToken(pad, chain, ca, { name, symbol, mc, x, tg, web, chart, label, ...extra } = {}) {
  const a = str(ca);
  return {
    pad, label: label || PAD_LABELS[pad] || pad, chain, ca: a,
    name: str(name).slice(0, 60) || '?', symbol: str(symbol).slice(0, 20) || '?', mc: num(mc),
    x: normX(x), tg: normTg(tg), web: normWeb(web), chart: chart || chartUrl(chain, a), ...extra
  };
}

// ---------- HTTP ----------
async function getJson(url, init = {}) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000), ...init });
  const body = await res.text();
  if (!res.ok) {
    const blocked = res.status === 403 || res.status === 451 || /<html/i.test(body.slice(0, 300));
    throw new Error(`HTTP ${res.status}${blocked ? ' (diblokir Cloudflare/wilayah)' : ''}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('jawaban bukan JSON (kemungkinan diblokir)');
  }
}
const postJson = (url, payload) => getJson(url, {
  method: 'POST', body: JSON.stringify(payload), headers: { ...HEADERS, 'content-type': 'application/json' }
});

// ---------- Sumber ----------
async function pumpfun() {
  const data = await getJson(URLS.pumpfun);
  const coins = Array.isArray(data) ? data : data?.coins || data?.data || [];
  return (Array.isArray(coins) ? coins : []).filter((c) => c?.mint).map((c) => makeToken('pumpfun', 'solana', c.mint, {
    name: c.name, symbol: c.symbol, mc: c.usd_market_cap, x: c.twitter, tg: c.telegram, web: c.website
  }));
}

async function launchlab() {
  const data = await getJson(URLS.launchlab);
  if (data?.success === false) throw new Error('LaunchLab: success=false');
  return (data?.data?.rows || []).filter((r) => r?.mint).map((r) => {
    const pi = r.platformInfo || {};
    const pname = str(pi.name);
    const bonk = pi.pubKey === BONK_PLATFORM || pname.toLowerCase() === 'letsbonk.fun';
    return makeToken(bonk ? 'bonkfun' : 'launchlab', 'solana', r.mint, {
      name: r.name, symbol: r.symbol, mc: r.marketCap, x: r.twitter, tg: r.telegram, web: r.website,
      label: bonk ? undefined : !pname || pname === 'Raydium' ? 'Raydium LaunchLab' : `LaunchLab · ${pname.slice(0, 30)}`
    });
  });
}

async function fourmeme() {
  const data = await getJson(URLS.fourmeme);
  if (data && !Array.isArray(data) && ![undefined, null, 0, '0'].includes(data.code)) {
    throw new Error(`four.meme code ${data.code}: ${data.msg || ''}`);
  }
  let items = Array.isArray(data) ? data : data?.data;
  if (items && !Array.isArray(items)) items = items.list || items.records || items.data || [];
  return (items || []).filter((it) => it?.address || it?.tokenAddress).map((it) => {
    let x = '', tg = '', web = '';
    for (const [k, v] of Object.entries(it)) {
      if (!str(v)) continue;
      const kl = k.toLowerCase();
      if (kl.includes('twitter')) x ||= v;
      else if (kl.includes('telegram')) tg ||= v;
      else if (['weburl', 'website', 'web', 'websiteurl'].includes(kl)) web ||= v;
    }
    return makeToken('fourmeme', 'bsc', it.address || it.tokenAddress, {
      name: it.name, symbol: it.shortName || it.symbol, mc: it.marketCapUsd ?? it.usdMarketCap, x, tg, web
    });
  });
}

async function clanker() {
  const data = await getJson(URLS.clanker);
  const items = Array.isArray(data) ? data : data?.data || [];
  return items.filter((it) => it?.contract_address).map((it) => {
    let x = '', tg = '', web = '';
    for (const s of it.metadata?.socialMediaUrls || []) {
      const plat = str(s?.platform).toLowerCase();
      const url = str(typeof s === 'string' ? s : s?.url);
      if (plat === 'twitter' || plat === 'x' || (!plat && normX(url))) x ||= url;
      else if (plat === 'telegram' || (!plat && normTg(url))) tg ||= url;
      else if (plat === 'website' || plat === 'web' || !plat) web ||= url;
    }
    let mc = null;
    try { mc = Number(it.priceUsd) * Number(BigInt(it.supply) / 10n ** 18n); } catch {}
    return makeToken('clanker', CLANKER_CHAINS[it.chain_id] || `chain${it.chain_id}`, it.contract_address, {
      name: it.name, symbol: it.symbol, mc: Number.isFinite(mc) ? mc : null, x, tg, web
    });
  });
}

async function pons() {
  const data = await getJson(URLS.pons);
  const toks = new Map((data?.included || []).filter((i) => i.type === 'token').map((i) => [i.id, i.attributes || {}]));
  const out = [];
  for (const p of data?.data || []) {
    const rel = p.relationships || {};
    if (!String(rel.dex?.data?.id || '').startsWith('pons')) continue;
    const tid = rel.base_token?.data?.id || '';
    const ca = tid.includes('_') ? tid.split('_').slice(1).join('_') : '';
    if (!ca) continue;
    const a = p.attributes || {};
    const ta = toks.get(tid) || {};
    out.push(makeToken('pons', 'robinhood', ca, {
      name: ta.name || String(a.name || '').split(' / ')[0], symbol: ta.symbol, mc: a.market_cap_usd ?? a.fdv_usd,
      chart: a.address ? `https://www.geckoterminal.com/robinhood/pools/${a.address}` : '', needsSocials: true
    }));
  }
  return out;
}

const dexPad = (chain, ca) => (chain === 'solana' && ca.endsWith('pump') ? 'pumpfun'
  : chain === 'solana' && ca.endsWith('bonk') ? 'bonkfun'
    : chain === 'bsc' && /(4444|ffff)$/i.test(ca) ? 'fourmeme' : null);

async function dexscreener() {
  const data = await getJson(URLS.dexscreener);
  const out = [];
  for (const it of Array.isArray(data) ? data : []) {
    const chain = it.chainId || '', ca = it.tokenAddress || '';
    const pad = dexPad(chain, ca);
    if (!pad) continue;
    let x = '', tg = '', web = '';
    for (const l of it.links || []) {
      const type = str(l.type).toLowerCase(), label = str(l.label).toLowerCase();
      if (type === 'twitter') x ||= l.url;
      else if (type === 'telegram') tg ||= l.url;
      else if (type === 'website' || label === 'website') web ||= l.url;
    }
    out.push(makeToken(pad, chain, ca, { x, tg, web, via: 'dexscreener' }));
  }
  return out;
}

// ---------- Pelengkap untuk token baru saja (bukan setiap putaran) ----------
const abiWord = (b, i) => Number(BigInt('0x' + (b.subarray(i * 32, (i + 1) * 32).toString('hex') || '0')));
function abiString(b, off) {
  const n = abiWord(b.subarray(off), 0);
  if (off + 32 + n > b.length) throw new Error('ABI string di luar data');
  return b.subarray(off + 32, off + 32 + n).toString('utf8');
}
// getTokenInfo() Pons → (address deployer, string logo, string description,
// (string twitter, telegram, discord, website, farcaster))
export function decodeTokenInfo(hex) {
  const b = Buffer.from(String(hex || '').replace(/^0x/, ''), 'hex');
  if (b.length < 128) throw new Error('getTokenInfo kosong — bukan token Pons?');
  const t = abiWord(b, 3);
  const tup = b.subarray(t);
  const [twitter, telegram, discord, website, farcaster] = [0, 1, 2, 3, 4].map((i) => abiString(b, t + abiWord(tup, i)).trim());
  return {
    twitter, telegram, discord, website, farcaster,
    deployer: '0x' + b.subarray(12, 32).toString('hex'), logo: abiString(b, abiWord(b, 1)), description: abiString(b, abiWord(b, 2))
  };
}
async function ponsSocials(tokens, { rpc } = {}) {
  for (const t of tokens) {
    try {
      const j = await postJson(rpc || ROBINHOOD_RPC, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: t.ca, data: SEL_GET_TOKEN_INFO }, 'latest'] });
      if (j.error) throw new Error(`RPC: ${j.error.message || JSON.stringify(j.error)}`);
      const info = decodeTokenInfo(j.result);
      Object.assign(t, { x: normX(info.twitter), tg: normTg(info.telegram), web: normWeb(info.website) });
      delete t.needsSocials;
    } catch (e) {
      t.retry = String(e.message || e).slice(0, 100); // dicoba lagi putaran berikutnya (maks. beberapa kali)
    }
  }
}
// Nama, simbol, MC dari DexScreener (30 alamat per panggilan). Gagal tidak menahan laporan — link sudah ada
async function dexNames(tokens) {
  const byChain = new Map();
  for (const t of tokens) byChain.set(t.chain, [...(byChain.get(t.chain) || []), t]);
  for (const [chain, list] of byChain) {
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      let pairs;
      try { pairs = await getJson(`${URLS.dexTokens}${chain}/${chunk.map((t) => t.ca).join(',')}`); } catch { continue; }
      const best = new Map();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const a = str(p?.baseToken?.address).toLowerCase();
        if (a && !best.has(a)) best.set(a, p);
      }
      for (const t of chunk) {
        const p = best.get(t.ca.toLowerCase());
        if (!p) continue;
        t.name = str(p.baseToken.name).slice(0, 60) || t.name;
        t.symbol = str(p.baseToken.symbol).slice(0, 20) || t.symbol;
        t.mc = num(p.marketCap ?? p.fdv);
      }
    }
  }
}

const FETCH = { pumpfun, launchlab, fourmeme, clanker, pons, dexscreener };
const ENRICH = { pons: ponsSocials, dexscreener: dexNames };
export const fetchSource = (src) => FETCH[src]();
export const hasEnrich = (src) => !!ENRICH[src];
export const enrichSource = (src, tokens, opts) => (ENRICH[src] ? ENRICH[src](tokens, opts) : undefined);
