// Login sekali untuk akun Telegram "listener" (pembaca channel target).
// Hasilnya TG_SESSION langsung disimpan ke .env (tidak ditampilkan: isinya akses penuh ke akun Telegram)
import 'dotenv/config';
import fs from 'fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

if (!Number(process.env.TG_API_ID) || !process.env.TG_API_HASH) {
  console.error('❌ Isi TG_API_ID dan TG_API_HASH di .env dulu (dari https://my.telegram.org → API development tools)');
  process.exit(1);
}

const client = new TelegramClient(
  new StringSession(''),
  Number(process.env.TG_API_ID),
  process.env.TG_API_HASH,
  { connectionRetries: 5 }
);

await client.start({
  phoneNumber: () => input.text('Nomor HP (+62...): '),
  password: () => input.text('Password 2FA (kosongkan jika tidak ada): '),
  phoneCode: () => input.text('Kode dari Telegram: '),
  onError: (e) => console.error(e)
});

function withSession(env, session) {
  const line = 'TG_SESSION=' + session;
  return /^TG_SESSION=.*$/m.test(env)
    ? env.replace(/^TG_SESSION=.*$/m, () => line)
    : env.replace(/\n?$/, '\n') + line + '\n';
}

const file = '.env';
const env = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
fs.writeFileSync(file, withSession(env, client.session.save()), { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log('\n✅ Login berhasil. TG_SESSION sudah disimpan ke .env');
await client.disconnect();
process.exit(0);
