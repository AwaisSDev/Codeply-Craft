"""The Codeply 3.0 launch score, made from scratch: 120 BPM, B minor (Bm - G - D - A), 60 s.

Shaped after the reference films: a filtered intro under the hook, a build with a riser and a snare roll
into the logo, the drop on the logo (8.0 s), a calm half-time groove under the features, a breakdown for
"Ambient intelligence." and a final drop on the end card (54.0 s). The film's own sound
cues (typing, clicks, pops, whooshes) come from cues.json, written by render.js.

    python3 make_music.py            -> score.wav (music only), mix.wav (music + sound design)
"""
import json, os, numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
DUR = 60.0
N = int(SR * DUR)
BPM = 120.0
BEAT = 60.0 / BPM          # 0.5 s
BAR = 4 * BEAT             # 2.0 s
HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20261109)


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def buf(ch=2):
    return np.zeros((ch, N))


def add(dst, sig, t0, gain=1.0, pan=0.0):
    """Mix a mono or stereo signal into dst at t0 seconds, with constant-power pan."""
    i0 = int(round(t0 * SR))
    if sig.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.vstack([sig * l * 1.4142, sig * r * 1.4142])
    if i0 < 0:
        sig = sig[:, -i0:]; i0 = 0
    n = min(sig.shape[1], N - i0)
    if n > 0:
        dst[:, i0:i0 + n] += sig[:, :n] * gain


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR * 0.45), 'low', fs=SR, output='sos'), x, axis=-1)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x, axis=-1)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, min(hi, SR * 0.45)], 'band', fs=SR, output='sos'), x, axis=-1)


def saw(freq, n, phase=0.0):
    """Band-limited sawtooth (polyBLEP). freq may be an array."""
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    dt = f / SR
    ph = (phase + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    # polyBLEP at the wrap
    m1 = ph < dt
    tt = ph[m1] / dt[m1]; y[m1] -= tt + tt - tt * tt - 1
    m2 = ph > 1 - dt
    tt = (ph[m2] - 1) / dt[m2]; y[m2] -= tt * tt + tt + tt + 1
    return y


def env_adsr(n, a, d, s, r, hold=None):
    t = np.arange(n) / SR
    hold = (n / SR - r) if hold is None else hold
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = np.clip((t - hold) / max(r, 1e-4), 0, 1)
    return e * (1 - rel) ** 2


def automate(points, n=N):
    """Piecewise-linear automation from [(t, value), ...]."""
    ts = np.array([p[0] for p in points]); vs = np.array([p[1] for p in points])
    return np.interp(np.arange(n) / SR, ts, vs)


def swept_lp(x, cutoff_curve, bands=(250, 400, 650, 1000, 1600, 2600, 4200, 7000, 11000)):
    """A lowpass whose cutoff follows a curve: crossfade between fixed filters in log space."""
    bands = np.array(bands, float)
    outs = [lp(x, b, 2) for b in bands]
    lc = np.log(np.clip(cutoff_curve, bands[0], bands[-1]))
    lb = np.log(bands)
    idx = np.clip(np.searchsorted(lb, lc) - 1, 0, len(bands) - 2)
    w = (lc - lb[idx]) / (lb[idx + 1] - lb[idx])
    y = np.zeros_like(x)
    for k in range(len(bands) - 1):
        m = idx == k
        if not m.any():
            continue
        y[..., m] = outs[k][..., m] * (1 - w[m]) + outs[k + 1][..., m] * w[m]
    return y


def reverb_ir(seconds=2.4, damp=5200, pre=0.012):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((2, n)) * np.exp(-t / (seconds / 6.5))
    ir = lp(ir, damp, 1)
    ir[:, :int(pre * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    return ir


IR_BIG = reverb_ir(2.8, 4800)
IR_SMALL = reverb_ir(0.9, 6500)


def verb(x, ir=IR_BIG, mix=0.3):
    wet = np.vstack([fftconvolve(x[0], ir[0])[:N], fftconvolve(x[1], ir[1])[:N]])
    return x * (1 - mix) + wet * mix


def delay(x, secs, fb=0.38, taps=6, pingpong=True):
    d = int(secs * SR)
    y = x.copy()
    for k in range(1, taps + 1):
        s = np.zeros_like(x)
        if d * k < N:
            s[:, d * k:] = x[:, :N - d * k]
            if pingpong and k % 2:
                s = s[::-1]
            y += s * fb ** k
    return y


# ─── the song's shape ───────────────────────────────────────────────────────
CHORDS = {  # pad voicings (MIDI) and bass root
    'Bm': ([59, 62, 66, 69], 35), 'G': ([55, 59, 62, 66], 31),
    'D': ([57, 62, 66, 69, 73], 38), 'A': ([57, 61, 64, 69], 33),
}
PROG = ['Bm', 'G', 'D', 'A']
def chord_at(bar):
    return PROG[bar % 4]

DROP1, BREAK, DROP2, END = 8.0, 50.0, 54.0, 58.0

# when the drums play
def drums_on(t):
    return (DROP1 <= t < 49.75) or (DROP2 <= t < END)


# ─── instruments ─────────────────────────────────────────────────────────────
def supersaw_chord(notes, dur, detune=0.16, voices=7):
    n = int(dur * SR)
    out = np.zeros((2, n))
    for m in notes:
        f = mtof(m)
        for v in range(voices):
            cents = (v - (voices - 1) / 2) / ((voices - 1) / 2) * detune * 100
            ff = f * 2 ** (cents / 1200)
            s = saw(ff, n, rng.random())
            pan = (v - (voices - 1) / 2) / ((voices - 1) / 2) * 0.8
            l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            out[0] += s * l; out[1] += s * r
    return out / (voices * len(notes)) * 2.2


def pluck(m, dur=0.4, bright=4200, decay=0.22, shape='saw'):
    n = int(dur * SR)
    f = mtof(m)
    x = saw(f, n) * 0.6 + np.sign(np.sin(2 * np.pi * f * np.arange(n) / SR)) * 0.25 + saw(f * 1.005, n) * 0.4
    t = np.arange(n) / SR
    e = np.exp(-t / decay) * np.clip(t / 0.003, 0, 1)
    # the filter closes with the note
    y = lp(x * e, bright, 2) * 0.6 + lp(x * e * np.exp(-t / 0.05), bright * 2.2, 2) * 0.4
    return y


def bell(m, dur=1.2, decay=0.5):
    n = int(dur * SR); t = np.arange(n) / SR; f = mtof(m)
    y = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2.0 * t) * np.exp(-t / 0.18)
         + 0.18 * np.sin(2 * np.pi * f * 3.01 * t) * np.exp(-t / 0.08) + 0.12 * np.sin(2 * np.pi * f * 4.2 * t) * np.exp(-t / 0.05))
    return y * np.exp(-t / decay) * np.clip(t / 0.002, 0, 1)


def piano(m, dur=2.5):
    n = int(dur * SR); t = np.arange(n) / SR; f = mtof(m)
    y = np.zeros(n)
    for k, a in enumerate([1, .55, .32, .22, .12, .08, .05], 1):
        y += a * np.sin(2 * np.pi * f * k * (1 + 0.0004 * k * k) * t) * np.exp(-t * (0.9 + k * 0.7))
    y += 0.08 * lp(rng.standard_normal(n), 3000) * np.exp(-t / 0.01)
    return y * np.clip(t / 0.003, 0, 1) * 0.5


def kick(level=1.0):
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 46 + 120 * np.exp(-t / 0.028) + 20 * np.exp(-t / 0.2)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.26)
    click = hp(rng.standard_normal(n), 2500) * np.exp(-t / 0.004) * 0.35
    return np.tanh((body + click) * 1.6) * 0.9 * level


def clap():
    n = int(0.5 * SR); t = np.arange(n) / SR
    nz = rng.standard_normal(n)
    e = np.zeros(n)
    for k, off in enumerate([0, 0.011, 0.023, 0.034]):
        e += np.where(t >= off, np.exp(-(t - off) / (0.006 if k < 3 else 0.14)), 0)
    return bp(nz * e, 900, 4200) * 0.9


def snare(pitch=1.0, n_s=0.22):
    n = int(n_s * SR); t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 190 * pitch * t) * np.exp(-t / 0.05)
    nz = bp(rng.standard_normal(n), 1500 * pitch, 8000) * np.exp(-t / 0.07)
    return (tone * 0.5 + nz) * 0.8


def hat(open_=False):
    n = int((0.35 if open_ else 0.08) * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7500, 2) * np.exp(-t / (0.12 if open_ else 0.022)) * (0.5 if open_ else 0.6)


def crash(dur=2.4):
    n = int(dur * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 4500, 2) * np.exp(-t / 0.7) * 0.5


def boom(dur=1.8, f0=70, f1=28):
    n = int(dur * SR); t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.35)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.6)
    y += lp(rng.standard_normal(n), 400) * np.exp(-t / 0.12) * 0.6
    return np.tanh(y * 1.5)


def reverse_cymbal(dur=1.6):
    return crash(dur)[::-1] * np.linspace(0, 1, int(dur * SR)) ** 1.5


# ─── build the score (v2: calmer, a half-time groove) ────────────────────────
#   0 – 8      intro under the hook: filtered pads, a heartbeat, the arp low; a build from 6
#   8          drop 1 on the logo
#   8 – 49.75  the groove under the features (lighter for "make it yours" and voice)
#   50 – 54    breakdown for "Ambient intelligence": pads and piano, no drums
#   54         drop 2 on the end card; the last chord rings out from 58
pad, arp, bass, lead, drums, fx, keys = buf(), buf(), buf(), buf(), buf(), buf(), buf()
GAPS = ((7.875, 8.0), (53.875, 54.0))
def in_gap(tt):
    return any(a <= tt < b for a, b in GAPS)

for bar in range(30):
    t0 = bar * BAR
    notes, _ = CHORDS[chord_at(bar)]
    if BREAK <= t0 < DROP2:
        notes = [n_ - 12 for n_ in notes] + [notes[0]]
    s = supersaw_chord(notes, BAR + 0.6)
    s *= env_adsr(s.shape[1], 0.3 if t0 < DROP1 or BREAK <= t0 < DROP2 else 0.05, 0.8, 0.85, 0.5)
    add(pad, s, t0)
pad_cut = automate([(0, 900), (4, 1100), (6, 1300), (7.85, 4200), (8.0, 2600), (10, 3000), (26, 3200), (38, 2800), (46, 2600), (49.6, 3600),
                    (50.0, 1000), (52, 1500), (53.85, 5200), (54.0, 3000), (57, 3200), (58, 2200), (60, 900)])
pad = swept_lp(pad, pad_cut)

ARP_ORDER = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 4, 3, 2, 1]
for bar in range(30):
    t0 = bar * BAR
    notes, _ = CHORDS[chord_at(bar)]
    tones = sorted(notes[:4]) + [notes[0] + 12]
    for k in range(16):
        tt = t0 + k * BEAT / 4
        if in_gap(tt) or (BREAK <= tt < 52.0) or tt >= 59.0:
            continue
        # 8ths only in the calm parts, 16ths in the groove
        if (tt < 4 or 38 <= tt < 50) and k % 2:
            continue
        m = tones[ARP_ORDER[k] % len(tones)] + 12
        add(arp, pluck(m, 0.35, 3800, 0.13), tt, 0.75 if k % 4 == 0 else 0.5, pan=0.35 * np.sin(k * 0.9))
arp_cut = automate([(0, 650), (4, 1000), (6, 1500), (7.9, 5500), (8.0, 3800), (38, 3000), (46, 2600), (49.7, 1200), (52, 1500), (53.9, 6000), (54, 4000), (58, 3000), (60, 600)])
arp = swept_lp(arp, arp_cut)
arp = delay(arp, BEAT * 0.75, 0.33, 5)

# bass: long notes in the intro, a syncopated line in the groove
BASS_HITS = [(0, 1.0), (3, 0.6), (4, 0.8), (6, 0.55)]   # 8th index, level
for bar in range(30):
    t0 = bar * BAR
    _, root = CHORDS[chord_at(bar)]
    if t0 < DROP1 or BREAK <= t0 < DROP2:
        if t0 < 2:
            continue
        n = int(BAR * SR); t = np.arange(n) / SR
        y = np.sin(2 * np.pi * mtof(root + 12) * t) * env_adsr(n, 0.3, 1, 0.8, 0.4)
        add(bass, y * 0.45, t0)
        continue
    for i8, lv in BASS_HITS:
        tt = t0 + i8 * BEAT / 2
        if tt >= END + 0.01 or in_gap(tt):
            continue
        n = int(0.42 * SR); t = np.arange(n) / SR
        f = mtof(root + 12)
        y = np.sin(2 * np.pi * f * t) * 0.85 + lp(saw(f, n), 800) * 0.3
        add(bass, y * np.clip(t / 0.004, 0, 1) * np.exp(-t / 0.28), tt, lv)

MEL = {
    'Bm': [(0, 78, 3), (3, 74, 1), (4, 76, 4)],
    'G': [(0, 74, 3), (3, 71, 1), (4, 74, 4)],
    'D': [(0, 69, 2), (2, 71, 2), (4, 74, 4)],
    'A': [(0, 73, 3), (3, 76, 1), (4, 73, 4)],
}
MEL2 = {
    'Bm': [(0, 81, 2), (2, 78, 2), (4, 74, 2), (6, 76, 2)],
    'G': [(0, 79, 3), (3, 78, 1), (4, 74, 4)],
    'D': [(0, 78, 2), (2, 76, 2), (4, 74, 2), (6, 78, 2)],
    'A': [(0, 76, 3), (3, 73, 1), (4, 69, 4)],
}
for bar in range(30):
    t0 = bar * BAR
    if not (12.0 <= t0 < 49.75 or DROP2 <= t0 < END):
        continue
    mel = MEL2 if 26 <= t0 < 38 else MEL
    for (i8, m, ln) in mel[chord_at(bar)]:
        tt = t0 + i8 * BEAT / 2
        quiet = 0.65 if 38 <= t0 < 50 else 1.0
        add(lead, pluck(m, ln * BEAT / 2 + 0.4, 4800, 0.25 + 0.06 * ln), tt, 0.5 * quiet, pan=-0.1)
        add(lead, bell(m + 12, 1.2, 0.4), tt, 0.12 * quiet, pan=0.25)
lead = delay(lead, BEAT * 0.75, 0.32, 4)

def chop(m, dur=0.26):
    n = int(dur * SR); t = np.arange(n) / SR
    f = mtof(m) * 2 ** ((-1.6 * np.exp(-t / 0.035)) / 12)
    x = saw(f, n) + 0.5 * saw(f * 1.004, n)
    y = bp(x, 650, 1100) * 1.0 + bp(x, 1500, 2600) * 0.55 + lp(x, 400) * 0.2
    return y * np.clip(t / 0.004, 0, 1) * np.exp(-t / 0.13)
chops = buf()
CHOP = [(3, 2), (7, 3)]
for bar in range(30):
    t0 = bar * BAR
    if not (DROP1 <= t0 < 38.0 or DROP2 <= t0 < END):
        continue
    notes, _ = CHORDS[chord_at(bar)]
    tones = sorted(notes[:4])
    for i8, ti in CHOP:
        add(chops, chop(tones[ti] + 12), t0 + i8 * BEAT / 2, 0.5, pan=0.3 if i8 % 4 == 3 else -0.3)

# piano: under "make it yours" (soft), the breakdown, and the last chord
for t0, name, g in [(38.0, 'Bm', 0.25), (42.0, 'D', 0.25), (50.0, 'Bm', 0.5), (52.0, 'G', 0.5)]:
    notes, root = CHORDS[name]
    for j, m in enumerate(notes):
        add(keys, piano(m, 3.0), t0 + j * 0.02, g)
    add(keys, piano(root + 12, 3.0), t0, g)
for j, m in enumerate([59, 62, 66, 71, 74]):
    add(keys, piano(m, 3.5), END + j * 0.02, 0.45)
    add(keys, bell(m + 12, 2.5, 0.9), END + j * 0.02, 0.06)
add(keys, piano(47, 3.5), END, 0.6)

# drums: a half-time groove. Kick on 1 and 3 (and a pickup), the clap on 3, 8th hats.
for b in range(int(DUR / BEAT)):
    tt = b * BEAT
    if not drums_on(tt) or in_gap(tt):
        continue
    pos = b % 4
    light = 38.0 <= tt < 46.0
    thin = 46.0 <= tt < 49.75
    if pos in (0, 2):
        add(drums, kick(), tt, 0.95 if not light else 0.7)
    if pos == 3 and b % 8 == 7 and not thin:
        add(drums, kick(0.7), tt + BEAT / 2, 0.5)
    if pos == 2 and not thin:
        add(drums, clap(), tt, 0.5 if not light else 0.35, pan=0.05)
    add(drums, hat(), tt + BEAT / 2, 0.3 if not light else 0.2, pan=0.3)
    if tt >= 12.0 and not light and not thin:
        add(drums, hat(), tt, 0.12, pan=-0.3)
    if tt >= 18.0 and pos == 1 and not light and not thin:
        add(drums, hat(True), tt + BEAT / 2, 0.14, pan=-0.2)
for b in range(0, 16):
    if b % 2 == 0:
        add(drums, kick(0.35), b * BEAT, 0.45 if b * BEAT < 4 else 0.55)
for b in range(8, 16):
    for q in (1, 3):
        add(drums, hat(), b * BEAT + q * BEAT / 4, 0.1, pan=0.4)
def roll(t_a, t_b, gain=0.5):
    tt = t_a
    while tt < t_b:
        k = (tt - t_a) / (t_b - t_a)
        step = BEAT / 2 if k < 0.45 else BEAT / 4 if k < 0.8 else BEAT / 8
        add(drums, snare(1 + k * 0.6, 0.14), tt, gain * (0.25 + 0.75 * k))
        tt += step
roll(6.5, 7.875, 0.38)
roll(53.0, 53.875, 0.3)
for tt, g in ((DROP1, 0.55), (26.0, 0.25), (38.0, 0.2), (DROP2, 0.55)):
    add(drums, crash(), tt, g)
for tt in (DROP1, DROP2):
    add(drums, boom(), tt, 0.8)
for tt in (DROP1, DROP2):
    rc = reverse_cymbal(1.4)
    add(fx, rc, tt - rc.shape[0] / SR, 0.35)

def riser(t_a, t_b, gain=0.35):
    n = int((t_b - t_a) * SR); t = np.arange(n) / SR; k = t / t[-1]
    nz = rng.standard_normal(n)
    sweep = sum(bp(nz, f, f * 1.6) * np.clip(1 - abs(k - j / 5) * 5, 0, 1) for j, f in enumerate([400, 800, 1500, 2800, 5000, 8000]))
    tone = saw(220 * 2 ** (2.6 * k), n) * 0.15
    y = (sweep * 0.45 + lp(tone, 2600)) * k ** 3
    add(fx, np.vstack([y, np.roll(y, 300)]), t_a, gain)
riser(6.2, 7.875, 0.18)
riser(52.4, 53.875, 0.2)

# sidechain: the melodic parts breathe with the kick
duck = np.ones(N)
for b in range(int(DUR / BEAT)):
    tt = b * BEAT
    if not drums_on(tt) or b % 4 not in (0, 2):
        continue
    i0 = int(tt * SR); n = min(int(BEAT * SR), N - i0)
    t = np.arange(n) / SR
    duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], 1 - 0.5 * np.exp(-t / 0.14))
for x in (pad, arp, bass, lead, chops):
    x *= duck
for a, b in GAPS:
    i0, i1 = int(a * SR), int(b * SR)
    fade = np.linspace(1, 0, i1 - i0) ** 2
    for x in (pad, arp, bass, lead, chops):
        x[:, i0:i1] *= fade

intro_lift = automate([(0, 1.8), (4, 1.5), (8, 1.0), (60, 1.0)])
pad *= intro_lift[None, :]
arp *= intro_lift[None, :]
music = (verb(pad, IR_BIG, 0.3) * 0.55 + verb(arp, IR_BIG, 0.3) * 0.3 + bass * 0.85 + verb(lead, IR_BIG, 0.34) * 0.45
         + verb(drums, IR_SMALL, 0.12) * 0.72 + verb(fx, IR_BIG, 0.2) * 0.8 + verb(keys, IR_BIG, 0.42) * 0.75 + verb(delay(chops, BEAT * 0.5, 0.25, 3), IR_BIG, 0.28) * 0.3)
music = music + lp(music, 160) * 0.18
music *= automate([(0, 0.0), (0.04, 1), (58.5, 1), (60, 0.0)])[None, :] ** 1.0


# ─── sound design from the film's cues ───────────────────────────────────────
def s_key(v):
    n = int(0.03 * SR); t = np.arange(n) / SR
    f = 2600 + 1400 * rng.random()
    y = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.004) * 0.5 + bp(rng.standard_normal(n), 2500, 9000) * np.exp(-t / 0.003)
    y += np.sin(2 * np.pi * 180 * t) * np.exp(-t / 0.01) * 0.4
    return y * v


def s_click():
    n = int(0.12 * SR); t = np.arange(n) / SR
    down = bp(rng.standard_normal(n), 1800, 7000) * np.exp(-t / 0.003) + np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.012) * 0.6
    up = np.zeros(n); i = int(0.065 * SR)
    up[i:] = bp(rng.standard_normal(n - i), 2500, 9000) * np.exp(-t[:n - i] / 0.002) * 0.6
    return down + up


def s_whoosh(dur=0.45, lo=300, hi=6000):
    n = int(dur * SR); t = np.arange(n) / SR; k = t / t[-1]
    nz = rng.standard_normal(n)
    y = sum(bp(nz, f, f * 1.8) * np.clip(1 - abs(k - j / 4) * 3.2, 0, 1) for j, f in enumerate(np.geomspace(lo, hi, 5)))
    e = np.sin(np.pi * k) ** 1.6
    return y * e


def s_pop(f0=900, f1=320, dur=0.09):
    n = int(dur * SR); t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.018)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.035) * np.clip(t / 0.001, 0, 1)


def s_tick():
    n = int(0.05 * SR); t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1900 * t) * 0.6 + np.sin(2 * np.pi * 3700 * t) * 0.2) * np.exp(-t / 0.012)


def s_notify():
    out = np.zeros(int(1.0 * SR))
    for j, m in enumerate([88, 95]):
        b = bell(m, 0.8, 0.25); i = int(j * 0.11 * SR); out[i:i + b.shape[0]] += b[:out.shape[0] - i]
    return out * 0.6


def s_thud():
    n = int(0.5 * SR); t = np.arange(n) / SR
    y = np.sin(2 * np.pi * (55 + 60 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.16)
    y += lp(rng.standard_normal(n), 900) * np.exp(-t / 0.03) * 0.3
    return y


sfx = buf()
cues = json.load(open(os.path.join(HERE, 'cues.json')))
for c in cues:
    t, k, v = c['t'], c['kind'], c['v']
    pan = float(rng.uniform(-0.3, 0.3))
    if k == 'key':
        add(sfx, s_key(v), t, 0.10, pan)
    elif k == 'click':
        add(sfx, s_click(), t - 0.01, 0.32, pan * 0.5)
    elif k == 'whoosh':
        add(sfx, s_whoosh(0.5), t - 0.25, 0.20 * v, pan)
    elif k in ('swish', 'swoosh'):
        add(sfx, s_whoosh(0.4, 600, 9000), t - 0.15, 0.18 * v, pan)
    elif k == 'send':
        add(sfx, s_whoosh(0.22, 1200, 9000), t, 0.16, 0.2)
    elif k == 'pop':
        add(sfx, s_pop(900 + 300 * rng.random(), 320), t, 0.22 * v, pan)
    elif k == 'note':
        add(sfx, s_pop(700, 260, 0.12), t, 0.2, 0.3)
    elif k == 'tick':
        add(sfx, s_tick(), t, 0.22 * v, pan)
    elif k == 'land':
        add(sfx, s_pop(600, 200, 0.14), t, 0.35)
    elif k == 'notify':
        add(sfx, s_notify(), t, 0.3, 0.25)
    elif k == 'thud':
        add(sfx, s_thud(), t, 0.5 * v)
    elif k == 'spin':
        # the carousel's ratchet: fast ticks that slow as it lands
        for j in range(16):
            add(sfx, s_tick(), t + 0.43 * (j / 16) ** 1.35, 0.12, float(rng.uniform(-.2, .2)))
sfx = verb(sfx, IR_SMALL, 0.18)


# ─── master ──────────────────────────────────────────────────────────────────
def master(x, target_rms_db=-15.5):
    x = hp(x, 28, 2)
    rms = np.sqrt(np.mean(x ** 2))
    x = x * (10 ** (target_rms_db / 20) / rms)
    # soft clip, then make sure peaks stay under -1 dBFS
    x = np.tanh(x * 1.1) / np.tanh(1.1)
    return x / max(1.0, np.max(np.abs(x)) / 0.89)


def write_wav(path, x):
    import wave
    y = (np.clip(x, -1, 1).T * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(y.tobytes())


score = master(music)
mix = master(music + sfx * 1.4)
write_wav(os.path.join(HERE, 'score.wav'), score)
write_wav(os.path.join(HERE, 'mix.wav'), mix)
print('wrote score.wav and mix.wav', score.shape[1] / SR, 's')
