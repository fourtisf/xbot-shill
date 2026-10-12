// fetch palsu untuk halaman web channel publik t.me/s/<channel> (tanpa jaringan).
// HTML-nya meniru struktur halaman pratinjau t.me (data contoh). Channel yang tidak ada di M.web
// dianggap privat: t.me mengalihkan ke t.me/<nama> yang tidak berisi daftar post.
const M = globalThis.__mock;
M.web ||= {}; // username -> { title, posts: [{ id, html, date, buttons?, replyTo? }], down? }
M.webCalls = [];

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
export function webPost(name, title, p) {
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${name}/${p.id}" data-view="eyJ4Ijo${p.id}">
  <div class="tgme_widget_message_user"><a href="https://t.me/${name}"><i class="tgme_widget_message_user_photo"><img src="https://cdn4.cdn-telegram.org/file/x.jpg"></i></a></div>
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/${name}"><span dir="auto">${title}</span></a></div>
    ${p.replyTo ? `<a class="tgme_widget_message_reply" href="https://t.me/${name}/${p.replyTo.id}"><div class="tgme_widget_message_author accent_color"><span class="tgme_widget_message_author_name">${title}</span></div><div class="tgme_widget_message_metatext js-message_reply_text" dir="auto">${p.replyTo.text}</div></a>` : ''}
    <div class="tgme_widget_message_text js-message_text" dir="auto">${p.html}</div>
    <div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info">
      <span class="tgme_widget_message_views">1.2K</span><span class="copyonly"> views</span>
      <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${name}/${p.id}"><time datetime="${iso(p.date)}" class="time">12:00</time></a></span>
    </div></div>
  </div>
  ${p.buttons ? `<div class="tgme_widget_message_inline_keyboard"><div class="tgme_widget_message_inline_row">${p.buttons.map(([t, u]) => `<a class="tgme_widget_message_inline_button url_button" href="${u}" target="_blank" rel="noopener"><div class="tgme_widget_message_inline_button_text">${t}</div></a>`).join('')}</div></div>` : ''}
</div></div>`;
}
export function webPage(name, ch) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ch.title} – Telegram</title>
<meta property="og:title" content="${ch.title}"><meta property="og:url" content="https://t.me/s/${name}"></head>
<body class="widget_frame_base tgme_webpreview_body"><header class="tgme_header"><div class="tgme_header_title"><a href="https://t.me/s/${name}">${ch.title}</a></div></header>
<main class="tgme_main"><div class="tgme_container"><section class="tgme_channel_history js-message_history">
${ch.posts.map((p) => webPost(name, ch.title, p)).join('\n')}
</section></div>
<div class="tgme_channel_info"><div class="tgme_channel_info_description">Follow us <a href="https://x.com/ChannelOwnX" target="_blank">x.com/ChannelOwnX</a> &amp; Telegram</div></div>
</main></body></html>`;
}
const PRIVATE = (name) => `<!DOCTYPE html><html><head><meta property="og:title" content="Telegram: Contact @${name}"></head>
<body><div class="tgme_page"><div class="tgme_page_title">If you have Telegram, you can contact @${name} right away.</div></div></body></html>`;

globalThis.fetch = async (url) => {
  url = String(url);
  M.webCalls.push(url);
  const m = /^https:\/\/t\.me\/s\/(\w+)$/.exec(url);
  if (!m) throw new Error(`fetch tidak di-mock: ${url}`);
  const ch = M.web[m[1].toLowerCase()];
  if (ch?.down) throw new TypeError('fetch failed');
  const body = ch ? webPage(m[1].toLowerCase(), ch) : PRIVATE(m[1]);
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};
