// Mock twitter-api-v2. Bentuk respons mengikuti library asli (data / tweets / includes / meta)
const M = globalThis.__mock;

// failNext[name] = satu error, atau array error untuk beberapa panggilan berturut-turut
function failIfQueued(name) {
  const f = M.x.failNext[name];
  if (!f) return;
  const e = Array.isArray(f) ? f.shift() : f;
  if (!Array.isArray(f) || !f.length) delete M.x.failNext[name];
  throw e;
}

export class TwitterApi {
  constructor(creds) { this.creds = creds; }
  // Login X lewat PIN (OAuth 1.0a)
  async generateAuthLink(callback, opts) {
    M.x.calls.push(['generateAuthLink', callback, opts, this.creds.appKey]);
    if (String(this.creds.appKey).startsWith('bad')) {
      throw Object.assign(new Error('Request failed with code 401'), { code: 401, data: { errors: [{ code: 32, message: 'Could not authenticate you.' }] } });
    }
    return { oauth_token: 'reqtok', oauth_token_secret: 'reqsecret', oauth_callback_confirmed: 'true', url: 'https://api.x.com/oauth/authorize?oauth_token=reqtok&force_login=true' };
  }
  async login(pin) {
    M.x.calls.push(['login', pin, this.creds.accessToken]);
    if (pin !== '1234567') throw Object.assign(new Error('Request failed with code 401'), { code: 401, data: { detail: 'Invalid oauth_verifier' } });
    const who = M.x.pinUser || 'dexvra_x';
    return { userId: '42', screenName: who, accessToken: `999-pin_${who}`, accessSecret: 'pinsecret', client: null };
  }
  get readWrite() {
    const { creds } = this;
    const call = (...c) => M.x.calls.push(c);
    return {
      v2: {
        async me() {
          call('me');
          if (String(creds.appKey).startsWith('bad')) throw Object.assign(new Error('Unauthorized'), { code: 401, data: { detail: 'Unauthorized' } });
          // Akun ditentukan oleh token PIN, atau awalan app key (dk = Dexvra, nk = Nova, lainnya Fourtis)
          const pin = /pin_(\w+)$/.exec(creds.accessToken || '');
          const byKey = Object.entries({ dk: 'dexvra_x', nk: 'nova_x' }).find(([pre]) => String(creds.appKey).startsWith(pre))?.[1];
          return { data: { id: creds.appKey, username: pin ? pin[1] : byKey || 'fourtisbot' } };
        },
        async userByUsername(h) {
          call('userByUsername', h);
          failIfQueued('userByUsername');
          const u = M.x.users[h.toLowerCase()];
          return u ? { data: u } : { errors: [{ title: 'Not Found Error' }] };
        },
        async usersByUsernames(hs) {
          call('usersByUsernames', hs);
          return { data: hs.map((h) => M.x.users[h]).filter(Boolean) };
        },
        async userTimeline(id, opts = {}) {
          call('userTimeline', id, opts);
          return { tweets: (M.x.timelines[id] || []).slice(0, opts.max_results ?? 10) };
        },
        async reply(text, id) {
          call('reply', text, id, Date.now(), creds.appKey); // akun yang dipakai: elemen terakhir
          failIfQueued('reply');
          return { data: { id: 'r' + ++M.x.n, text } };
        },
        async like(userId, tweetId) {
          call('like', userId, tweetId, creds.appKey);
          failIfQueued('like');
          return { data: { liked: true } };
        },
        async follow(userId, targetId) {
          call('follow', userId, targetId, creds.appKey);
          failIfQueued('follow');
          return { data: { following: true } };
        },
        async tweet(text) {
          call('tweet', text, Date.now(), creds.appKey);
          failIfQueued('tweet');
          return { data: { id: 't' + ++M.x.n, text } };
        },
        async search(q, opts) {
          call('search', q, opts);
          failIfQueued('search');
          const r = M.x.searchResults.shift() || { tweets: [], users: [] };
          const newest = r.tweets.map((t) => t.id).sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1))[0];
          return { tweets: r.tweets, includes: { users: r.users }, meta: newest ? { newest_id: newest } : { result_count: 0 } };
        }
      }
    };
  }
}
