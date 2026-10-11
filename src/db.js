import fs from 'fs';

const FILE = process.env.DB_FILE || './data.json';

const defaults = {
  x: null, // { appKey, appSecret, accessToken, accessSecret }
  channels: [], // '@username' atau id numerik
  reportChat: null,
  paused: false,
  templates: [
    'Big things happening at {name} 🔥 watching this one closely',
    'Love seeing {name} keep shipping 🚀',
    '{name} is one to watch 👀 tracking it on Fourtis'
  ],
  ownTweetEnabled: true,
  ownTweetTemplate: '🚀 New project spotted: {name}\nVia {channel}\nx.com/{handle}',
  optins: {}, // handle -> { at, via }
  pending: {}, // handle -> { code, by }
  history: {}, // handle -> timestamp terakhir diproses
  filter: {
    minFollowers: 500,
    minAgeDays: 14,
    blacklist: ['scam', 'rug'],
    cooldownDays: 7,
    tweetsPerProject: 1,
    maxTweetAgeHours: 48,
    useMentions: false
  },
  limits: { minDelaySec: 30, maxDelaySec: 90, maxPerHour: 20 }
};

function load() {
  if (!fs.existsSync(FILE)) return structuredClone(defaults);
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return {
    ...structuredClone(defaults),
    ...saved,
    filter: { ...defaults.filter, ...(saved.filter || {}) },
    limits: { ...defaults.limits, ...(saved.limits || {}) }
  };
}

export const db = load();

export function save() {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}
