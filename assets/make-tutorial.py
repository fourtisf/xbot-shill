# Membuat gambar tutorial yang dikirim bot saat menghubungkan akun X.
# Ilustrasi tiruan console.x.com (tanpa data asli). Jalankan: python3 assets/make-tutorial.py
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
f = lambda size, bold=False: ImageFont.truetype(BOLD if bold else FONT, size)

BG, PANEL, LINE, TEXT, MUTED = (10, 10, 12), (24, 24, 28), (55, 55, 62), (235, 235, 240), (140, 140, 150)
GREEN, RED, ORANGE, BLUE = (34, 210, 105), (240, 70, 70), (255, 160, 0), (29, 155, 240)
W = 1280


def canvas(h, step, title, path):
    im = Image.new('RGB', (W, h), BG)
    d = ImageDraw.Draw(im, 'RGBA')
    d.rectangle((0, 0, W, 96), fill=(16, 70, 40))
    d.text((40, 22), step, font=f(22, True), fill=(160, 255, 200))
    d.text((40, 50), title, font=f(32, True), fill=(255, 255, 255))
    d.rounded_rectangle((40, 112, W - 40, 156), radius=22, fill=(30, 30, 36))
    d.text((64, 122), path, font=f(21), fill=(200, 200, 210))
    return im, d


def section(d, y, label):
    d.text((60, y), label, font=f(21), fill=MUTED)


def row(d, y, h, label, value='', button=None, value2=None):
    d.rectangle((40, y, W - 40, y + h), fill=PANEL, outline=LINE)
    d.text((64, y + h / 2 - 15), label, font=f(26, True), fill=TEXT)
    if value:
        d.text((360, y + (10 if value2 else h / 2 - 13)), value, font=f(22), fill=(200, 200, 210))
    if value2:
        d.text((360, y + 44), value2, font=f(20), fill=MUTED)
    if button:
        bw = d.textlength(button, font=f(22, True)) + 40
        d.rounded_rectangle((W - 64 - bw, y + h / 2 - 24, W - 64, y + h / 2 + 24), radius=12, fill=(40, 40, 46), outline=(90, 90, 98))
        d.text((W - 64 - bw + 20, y + h / 2 - 14), button, font=f(22, True), fill=TEXT)


def badge(d, x, y, n, color=GREEN):
    d.ellipse((x, y, x + 44, y + 44), fill=color)
    tw = d.textlength(str(n), font=f(26, True))
    d.text((x + 22 - tw / 2, y + 6), str(n), font=f(26, True), fill=(0, 0, 0))


def keep(d, box):
    d.rounded_rectangle(box, radius=12, outline=GREEN, width=6)


def skip(d, box, text='TIDAK DIPAKAI'):
    d.rectangle(box, fill=(0, 0, 0, 185), outline=RED, width=4)
    tw = d.textlength(text, font=f(30, True))
    d.text(((box[0] + box[2] - tw) / 2, (box[1] + box[3]) / 2 - 18), text, font=f(30, True), fill=RED)


def callout(d, y, parts, color=GREEN, x=40):
    # parts: [(teks, warna|None)] digabung satu baris
    total = sum(d.textlength(t, font=f(23, True)) for t, _ in parts)
    d.rounded_rectangle((x, y, x + total + 40, y + 46), radius=10, fill=(color[0] // 6, color[1] // 6, color[2] // 6), outline=color, width=3)
    cx = x + 20
    for t, c in parts:
        d.text((cx, y + 10), t, font=f(23, True), fill=c or (255, 255, 255))
        cx += d.textlength(t, font=f(23, True))


def radio(d, y, label, sub, on):
    d.rectangle((40, y, W - 40, y + 76), fill=PANEL if not on else (22, 40, 30), outline=LINE)
    d.ellipse((64, y + 24, 92, y + 52), outline=TEXT, width=3)
    if on:
        d.ellipse((71, y + 31, 85, y + 45), fill=TEXT)
    d.text((112, y + 10), label, font=f(25, True), fill=TEXT)
    d.text((112, y + 42), sub, font=f(19), fill=MUTED)
    if on:
        keep(d, (40, y, W - 40, y + 76))
        tw = d.textlength('PILIH INI', font=f(22, True))
        d.rounded_rectangle((W - 90 - tw, y + 18, W - 60, y + 58), radius=10, fill=GREEN)
        d.text((W - 75 - tw, y + 25), 'PILIH INI', font=f(22, True), fill=(0, 0, 0))


def field(d, y, label, value):
    d.text((60, y), label, font=f(21), fill=MUTED)
    d.text((60 + d.textlength(label, font=f(21)) + 10, y), '(required)', font=f(21), fill=BLUE)
    d.rounded_rectangle((40, y + 34, 900, y + 86), radius=8, fill=(18, 18, 22), outline=GREEN, width=4)
    d.text((60, y + 46), value, font=f(23), fill=(160, 255, 200))


# ---------- 1. Izin app ----------
im, d = canvas(1060, 'LANGKAH 1  (sekali saja per app)', 'Atur izin app: Read and write',
               'console.x.com  ›  Apps  ›  app Anda  ›  User authentication settings  ›  Set up / Edit')
section(d, 180, 'App permissions')
radio(d, 212, 'Read', 'Read Posts and profile information', False)
radio(d, 292, 'Read and write', 'Read and Post Posts and profile information', True)
radio(d, 372, 'Read and write and Direct message', 'Read and post Direct messages', False)
section(d, 470, 'Type of App')
radio(d, 502, 'Native App', 'Public client', False)
radio(d, 582, 'Web App, Automated App or Bot', 'Confidential client', True)
section(d, 680, 'App info')
field(d, 712, 'Callback URI / Redirect URL', 'https://website-anda.com')
field(d, 812, 'Website URL', 'https://website-anda.com')
d.text((930, 760), 'isi alamat website', font=f(22, True), fill=GREEN)
d.text((930, 790), 'brand Anda (bebas)', font=f(22, True), fill=GREEN)
d.rounded_rectangle((W - 330, 930, W - 60, 990), radius=12, fill=(60, 60, 66))
d.text((W - 292, 944), 'Save Changes', font=f(26, True), fill=TEXT)
keep(d, (W - 336, 924, W - 54, 996))
d.text((60, 945), 'Lalu klik Save Changes  →', font=f(26, True), fill=GREEN)
d.text((60, 1012), 'Lakukan ini SEBELUM membuat Access Token (token lama tidak ikut berubah).', font=f(21, True), fill=ORANGE)
im.save(os.path.join(OUT, 'tutorial-1-izin.png'), optimize=True)

# ---------- 2. Ambil 4 kode ----------
im, d = canvas(1110, 'LANGKAH 2', 'Ambil 4 kode — hanya dari bagian OAuth 1.0 Keys',
               'console.x.com  ›  Apps  ›  app Anda  (gulir ke bagian Keys)')
section(d, 180, 'App-Only Authentication')
row(d, 212, 70, 'Bearer Token', 'Generated …', 'Regenerate')
skip(d, (40, 212, W - 40, 282))
section(d, 306, 'OAuth 1.0 Keys')
row(d, 338, 76, 'Consumer Key', '• • • • • • • • • • • •', 'Regenerate')
keep(d, (40, 338, W - 40, 414))
badge(d, 920, 354, 1)
badge(d, 970, 354, 2)
callout(d, 424, [('Klik ', None), ('Regenerate', GREEN), (' → salin ', None), ('1. Consumer Key', GREEN), ('  dan  ', None), ('2. Secret Key', GREEN)])
d.text((60, 478), '(nama lama: API Key & API Key Secret)', font=f(20), fill=MUTED)
row(d, 514, 86, 'Access Token', 'Generated …', 'Regenerate', 'For @akun-brand-anda    Read and write')
keep(d, (40, 514, W - 40, 600))
badge(d, 920, 536, 3)
badge(d, 970, 536, 4)
d.ellipse((350, 552, 610, 590), outline=ORANGE, width=4)
callout(d, 610, [('Klik ', None), ('Regenerate', GREEN), (' → salin ', None), ('3. Access Token', GREEN), ('  dan  ', None), ('4. Access Token Secret', GREEN)])
callout(d, 666, [('"For @…" HARUS akun X brand Anda — kalau bukan, pakai Login X di bot', ORANGE)], color=ORANGE)
section(d, 740, 'OAuth 2.0 Keys')
row(d, 772, 66, 'Client ID', 'xxxxxxxxxxxxxxxx')
row(d, 838, 66, 'Client Secret', '• • • • • • • • • •', 'Regenerate')
row(d, 904, 66, 'Access Token', 'Generate an access token …', 'Generate')
skip(d, (40, 772, W - 40, 970), 'TIDAK DIPAKAI (semua OAuth 2.0)')
d.rounded_rectangle((40, 1000, W - 40, 1080), radius=14, fill=(16, 70, 40))
d.text((70, 1012), 'Kirim ke bot satu per satu:', font=f(24, True), fill=(160, 255, 200))
d.text((70, 1044), '1 Consumer Key  →  2 Secret Key  →  3 Access Token  →  4 Access Token Secret', font=f(23, True), fill=(255, 255, 255))
im.save(os.path.join(OUT, 'tutorial-2-kode.png'), optimize=True)

# ---------- 3. Login X: Authorize + PIN ----------
im, d = canvas(800, 'LOGIN X', 'Buka link dari bot → Authorize → kirim PIN ke bot',
               'x.com/oauth/authorize?…  (link dari bot, berlaku ±15 menit)')
# kiri: halaman authorize
d.rounded_rectangle((40, 190, 610, 720), radius=18, fill=PANEL, outline=LINE)
d.text((300, 214), 'X', font=f(48, True), fill=TEXT)
d.text((70, 292), 'Authorize app to access', font=f(26, True), fill=TEXT)
d.text((70, 326), 'your account?', font=f(26, True), fill=TEXT)
d.rounded_rectangle((70, 384, 580, 444), radius=30, fill=(32, 32, 38), outline=ORANGE, width=4)
d.text((96, 398), '@akun-brand-anda', font=f(24, True), fill=TEXT)
d.text((70, 454), 'Pastikan akun BRAND (bukan pribadi).', font=f(20, True), fill=ORANGE)
d.text((70, 480), 'Kalau salah akun: Log out / ganti akun.', font=f(20), fill=ORANGE)
d.rounded_rectangle((70, 540, 580, 610), radius=35, fill=(235, 235, 240))
d.text((222, 557), 'Authorize app', font=f(28, True), fill=(0, 0, 0))
keep(d, (62, 532, 588, 618))
badge(d, 30, 550, 1)
d.text((70, 640), 'Klik Authorize app', font=f(24, True), fill=GREEN)
# panah
d.polygon([(660, 440), (632, 420), (632, 460)], fill=GREEN)
d.rectangle((614, 434, 634, 446), fill=GREEN)
# kanan: halaman PIN
d.rounded_rectangle((670, 190, W - 40, 720), radius=18, fill=PANEL, outline=LINE)
d.text((700, 220), "You've granted access to app!", font=f(25, True), fill=TEXT)
d.text((700, 262), 'Next, return to app and enter this PIN', font=f(20), fill=MUTED)
d.text((700, 288), 'to complete the authorization process:', font=f(20), fill=MUTED)
d.rounded_rectangle((760, 350, 1150, 450), radius=14, fill=(18, 18, 22))
d.text((812, 368), '1234567', font=f(56, True), fill=TEXT)
keep(d, (752, 342, 1158, 458))
badge(d, 1170, 376, 2)
d.text((700, 484), 'Salin angka PIN ini,', font=f(26, True), fill=GREEN)
d.text((700, 518), 'lalu kirim ke bot.', font=f(26, True), fill=GREEN)
d.text((700, 576), '(PIN di gambar hanya contoh)', font=f(20), fill=MUTED)
d.text((40, 742), 'Tidak perlu Access Token: bot mendapatkannya sendiri dari PIN.', font=f(22, True), fill=(160, 255, 200))
im.save(os.path.join(OUT, 'tutorial-3-pin.png'), optimize=True)
print('ok')
