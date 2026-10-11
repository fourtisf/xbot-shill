// Mock twitter-api-v2. Bentuk respons mengikuti library asli (data / tweets / includes / meta)
const M = globalThis.__mock;

function failIfQueued(name) {
  const e = M.x.failNext[name];
  if (e) { delete M.x.failNext[name]; throw e; }
}

export class TwitterApi {
  constructor(creds) { this.creds = creds; }
  get readWrite() {
    const { creds } = this;
    const call = (...c) => M.x.calls.push(c);
    return {
      v2: {
        async me() {
          call('me');
          if (creds.appKey === 'bad') throw Object.assign(new Error('Unauthorized'), { code: 401, data: { detail: 'Unauthorized' } });
          return { data: { id: '1', username: 'fourtisbot' } };
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
          call('reply', text, id, Date.now());
          failIfQueued('reply');
          return { data: { id: 'r' + ++M.x.n, text } };
        },
        async tweet(text) {
          call('tweet', text, Date.now());
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
