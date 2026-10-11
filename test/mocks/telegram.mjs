// Mock gramjs (akun listener). State dikendalikan test lewat globalThis.__mock
const M = globalThis.__mock;

export class StringSession {
  constructor(s) { this.s = s; }
  save() { return this.s; }
}

export class NewMessage {}

export class TelegramClient {
  constructor() {
    M.tg = this;
    this.handlers = [];
    this.connected = false;
  }
  async connect() {
    if (M.tgFailConnect) throw new Error('network down');
    this.connected = true;
  }
  async checkAuthorization() { return true; }
  addEventHandler(fn) { this.handlers.push(fn); }
  async getDialogs() {
    return M.channels.filter((c) => c.joined).map((c) => ({ isChannel: true, entity: c.entity }));
  }
  async getMessages(entity, { minId = 0, limit = 100 } = {}) {
    if (!this.connected) throw new Error('not connected');
    const ch = M.channels.find((c) => c.entity === entity);
    return ch.history.filter((m) => m.id > minId).sort((a, b) => b.id - a.id).slice(0, limit);
  }
  async disconnect() { this.connected = false; }
}
