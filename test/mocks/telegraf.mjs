// Telegraf asli, tapi semua panggilan Bot API dicatat dan dijawab lokal (tanpa jaringan)
import { Telegraf as RealTelegraf, Telegram, Markup } from 'telegraf';

const M = globalThis.__mock;

Telegram.prototype.callApi = async function (method, payload = {}) {
  M.botCalls.push({ method, payload });
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
