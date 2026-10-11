// Telegraf asli, tapi semua panggilan Bot API dicatat dan dijawab lokal (tanpa jaringan).
// Pesan diperiksa dengan aturan Telegram asli (HTML, panjang, tombol); yang melanggar ditolak
// seperti Telegram menolaknya (400) dan dicatat di M.apiErrors.
import { Telegraf as RealTelegraf, Telegram, Markup } from 'telegraf';

const M = globalThis.__mock;
M.apiErrors ||= [];

// Aturan HTML Telegram: hanya tag tertentu, tag harus berpasangan, < > & di luar tag wajib di-escape
const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'span', 'tg-spoiler', 'tg-emoji', 'blockquote']);
export function checkHtml(s) {
  const stack = [];
  for (let i = 0; i < s.length;) {
    const rest = s.slice(i);
    if (s[i] === '<') {
      const m = /^<(\/?)([a-z-]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/i.exec(rest);
      if (!m) return `"<" bukan tag: ${JSON.stringify(rest.slice(0, 25))}`;
      const tag = m[2].toLowerCase();
      if (!TAGS.has(tag)) return `tag tidak didukung Telegram: <${tag}>`;
      if (m[1]) { if (stack.pop() !== tag) return `</${tag}> tidak cocok`; } else stack.push(tag);
      i += m[0].length;
    } else if (s[i] === '>') {
      return `">" harus di-escape: ${JSON.stringify(s.slice(Math.max(0, i - 15), i + 10))}`;
    } else if (s[i] === '&') {
      const m = /^&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i.exec(rest);
      if (!m) return `"&" harus di-escape: ${JSON.stringify(s.slice(Math.max(0, i - 15), i + 10))}`;
      i += m[0].length;
    } else i++;
  }
  return stack.length ? `tag belum ditutup: ${stack.join(', ')}` : null;
}
const visible = (s) => s.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot);/g, 'x').replace(/&#x?[0-9a-f]+;/gi, 'x');

function validate(method, p) {
  const errs = [];
  if (method === 'sendMessage' || method === 'editMessageText') {
    if (!p.text) errs.push('teks kosong');
    else {
      const html = p.parse_mode === 'HTML';
      const bad = html && checkHtml(p.text);
      if (bad) errs.push(`can't parse entities: ${bad}`);
      if ((html ? visible(p.text) : p.text).length > 4096) errs.push(`message is too long (${p.text.length})`);
    }
    const kb = p.reply_markup?.inline_keyboard;
    if (kb) {
      if (kb.flat().length > 100) errs.push(`terlalu banyak tombol (${kb.flat().length})`);
      for (const row of kb) {
        if (row.length > 8) errs.push(`baris tombol > 8 (${row.length})`);
        for (const b of row) {
          if (!b.text) errs.push('teks tombol kosong');
          if (b.callback_data !== undefined && (!b.callback_data || Buffer.byteLength(b.callback_data) > 64)) {
            errs.push(`callback_data tidak valid (${Buffer.byteLength(b.callback_data || '')} byte): ${b.callback_data}`);
          }
        }
      }
    }
  }
  if (method === 'answerCallbackQuery' && p.text && p.text.length > 200) errs.push(`teks answerCbQuery > 200 (${p.text.length})`);
  if (method === 'setMyCommands') {
    if (p.commands.length > 100) errs.push('perintah > 100');
    for (const c of p.commands) {
      if (!/^[a-z0-9_]{1,32}$/.test(c.command)) errs.push(`nama perintah tidak valid: ${c.command}`);
      if (!c.description || c.description.length > 256) errs.push(`deskripsi perintah tidak valid: ${c.command}`);
    }
  }
  return errs;
}

Telegram.prototype.callApi = async function (method, payload = {}) {
  M.botCalls.push({ method, payload });
  const errs = validate(method, payload);
  if (errs.length) {
    M.apiErrors.push({ method, errs, text: String(payload.text || '').slice(0, 80) });
    throw Object.assign(new Error(`400: Bad Request: ${errs.join('; ')}`), { code: 400 });
  }
  switch (method) {
    case 'getMe':
      return { id: 999, is_bot: true, first_name: 'Fourtis', username: 'fourtisbot' };
    case 'getChatAdministrators':
      return (M.chatAdmins[payload.chat_id] || []).map((id) => ({ status: 'administrator', user: { id, is_bot: false, first_name: 'a' } }));
    case 'getChat': {
      const chat = (M.botChats || {})[payload.chat_id];
      if (!chat) throw Object.assign(new Error('400: Bad Request: chat not found'), { code: 400 });
      return chat;
    }
    case 'getChatMember':
      return { status: (M.botAdminIn || []).includes(payload.chat_id) ? 'administrator' : 'left', user: { id: payload.user_id } };
    case 'sendMessage':
      return { message_id: M.botCalls.length, date: 0, chat: { id: payload.chat_id }, text: payload.text };
    default:
      return true;
  }
};

export class Telegraf extends RealTelegraf {
  constructor(...args) {
    super(...args);
    M.bot = this;
  }
  async launch() {
    this.botInfo ??= await this.telegram.getMe();
    return new Promise(() => {}); // polling asli tidak pernah selesai
  }
  stop() {}
}

export { Markup, Telegram };
