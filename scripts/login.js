// Login sekali untuk akun Telegram "listener" (pembaca channel target).
// Hasilnya string TG_SESSION yang ditempel ke .env
import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

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

console.log('\nTempel baris ini ke file .env:\n');
console.log('TG_SESSION=' + client.session.save());
await client.disconnect();
process.exit(0);
