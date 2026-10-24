"""The sign-in Security Check: 2 letters + 2 numbers in a mixed order, drawn as
a small picture the QMP portal's way (the store, 23 Oct 2026) — each character
in its own font, size, tilt and colour, with a line struck through them.

The SERVER draws the code and checks it. The session keeps only an HMAC of it
(Flask's session is a signed cookie the browser can read, so the code itself
must never be in it), and a code is good for one try only: right or wrong, the
next sign-in needs a new one.
"""
import hashlib
import hmac
import random
import secrets
import time

LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"   # no I / L / O — they read as 1 / 1 / 0
DIGITS = "23456789"                   # no 0 / 1 — same reason
SESSION_KEY = "login_captcha"
_FONTS = ("Georgia, 'Times New Roman', serif", "'Courier New', Courier, monospace",
          "Verdana, Arial, sans-serif", "'Times New Roman', Times, serif")
_COLOURS = ("#1f2937", "#7f1d1d", "#334155", "#991b1b")


def make_code():
    """Two letters and two numbers, shuffled (e.g. 8N4F)."""
    rnd = secrets.SystemRandom()
    chars = [rnd.choice(LETTERS), rnd.choice(LETTERS), rnd.choice(DIGITS), rnd.choice(DIGITS)]
    rnd.shuffle(chars)
    return "".join(chars)


def render_svg(code):
    """The code as an SVG picture, 160 x 48."""
    rnd = random.Random(secrets.randbits(64))
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48">',
             '<rect width="160" height="48" fill="#e5e7eb"/>']
    for _ in range(18):   # speckle
        parts.append(f'<circle cx="{rnd.uniform(0, 160):.1f}" cy="{rnd.uniform(0, 48):.1f}" '
                     f'r="{rnd.uniform(0.6, 1.4):.1f}" fill="#9ca3af" opacity="0.6"/>')
    x = 22
    for ch in code:
        size = rnd.randint(24, 31)
        y = rnd.randint(31, 38)
        tilt = rnd.randint(-18, 18)
        parts.append(
            f'<text x="{x}" y="{y}" font-family="{rnd.choice(_FONTS)}" font-size="{size}" '
            f'font-weight="{rnd.choice(("700", "800", "900"))}" fill="{rnd.choice(_COLOURS)}" '
            f'transform="rotate({tilt} {x} {y})">{ch}</text>')
        x += rnd.randint(28, 33)
    y1, y2 = rnd.uniform(26, 32), rnd.uniform(26, 32)
    parts.append(f'<line x1="8" y1="{y1:.1f}" x2="152" y2="{y2:.1f}" stroke="#374151" stroke-width="1.6" opacity="0.75"/>')
    parts.append("</svg>")
    return "".join(parts)


def _digest(secret, code):
    return hmac.new(str(secret).encode(), code.strip().upper().encode(), hashlib.sha256).hexdigest()


def issue(session, secret, code=None):
    """A new code for this session; returns its picture."""
    code = code or make_code()
    session[SESSION_KEY] = {"h": _digest(secret, code), "t": int(time.time())}
    return render_svg(code)


def check(session, secret, answer, ttl):
    """True when `answer` is this session's code (any case) and not too old.
    Used up either way."""
    held = session.pop(SESSION_KEY, None)
    if not held or not answer or int(time.time()) - int(held.get("t", 0)) > ttl:
        return False
    return hmac.compare_digest(held.get("h", ""), _digest(secret, answer))
