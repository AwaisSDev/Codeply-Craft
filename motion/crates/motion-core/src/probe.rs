//! Seeing a frame without a screenshot. A PNG in an agent's context costs ~1–2k tokens; these
//! stats cost ~100 and answer most questions ("is it black?", "is the title there?", "did the
//! grade change?", "did that edit change the picture?").

use serde_json::{Value, json};

pub struct Rgba<'a> {
    pub w: u32,
    pub h: u32,
    pub px: &'a [u8],
}

fn luma(p: &[u8]) -> f64 {
    0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64
}

/// Stats for one frame. `ascii` > 0 adds a luma thumbnail that many characters wide.
pub fn stats(img: &Rgba, ascii: u32) -> Value {
    let n = (img.w as usize * img.h as usize).max(1);
    let px = img.px.as_chunks::<4>().0;
    let (mut sum, mut sum2) = ([0f64; 3], 0f64);
    let (mut lsum, mut lmin, mut lmax) = (0f64, 255f64, 0f64);
    let (mut black, mut white, mut clear) = (0usize, 0usize, 0usize);
    let mut buckets = std::collections::HashMap::<u16, usize>::new();
    for p in px {
        let l = luma(p);
        lsum += l;
        sum2 += l * l;
        lmin = lmin.min(l);
        lmax = lmax.max(l);
        for c in 0..3 {
            sum[c] += p[c] as f64;
        }
        black += usize::from(l < 16.0);
        white += usize::from(l > 235.0);
        clear += usize::from(p[3] < 8);
        *buckets.entry(((p[0] as u16 >> 5) << 6) | ((p[1] as u16 >> 5) << 3) | (p[2] as u16 >> 5)).or_default() += 1;
    }
    let nf = n as f64;
    let mean = lsum / nf;
    let mut top: Vec<(u16, usize)> = buckets.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let palette: Vec<Value> = top
        .iter()
        .take(4)
        .filter(|(_, c)| *c * 50 >= n)
        .map(|(k, c)| {
            let ch = |s: u16| ((((k >> s) & 7) << 5) | 16) as u8;
            json!([format!("#{:02x}{:02x}{:02x}", ch(6), ch(3), ch(0)), pct(*c, n)])
        })
        .collect();
    let mut v = json!({
        "size": [img.w, img.h],
        "luma": [r1(mean), r1((sum2 / nf - mean * mean).max(0.0).sqrt()), r1(lmin), r1(lmax)],
        "rgb": [r1(sum[0] / nf), r1(sum[1] / nf), r1(sum[2] / nf)],
        "black": pct(black, n),
        "white": pct(white, n),
        "detail": r1(detail(img)),
        "grid": grid(img),
        "palette": palette,
        "hash": format!("{:016x}", dhash(img)),
    });
    if clear > 0 {
        v["clear"] = json!(pct(clear, n));
    }
    if mean < 2.0 && lmax < 8.0 {
        v["note"] = json!("frame is black");
    } else if lmax - lmin < 2.0 {
        v["note"] = json!("frame is a flat colour");
    }
    if ascii > 0 {
        v["ascii"] = json!(ascii_art(img, ascii));
    }
    v
}

fn r1(f: f64) -> f64 {
    (f * 10.0).round() / 10.0
}

fn pct(c: usize, n: usize) -> f64 {
    r1(c as f64 * 100.0 / n as f64)
}

/// Mean luma in a 3×3 grid, row by row: where the bright and dark parts of the frame are.
fn grid(img: &Rgba) -> Vec<u8> {
    let mut acc = [(0f64, 0usize); 9];
    let (w, h) = (img.w.max(1) as usize, img.h.max(1) as usize);
    for y in (0..h).step_by((h / 90).max(1)) {
        for x in (0..w).step_by((w / 160).max(1)) {
            let i = (y * 3 / h) * 3 + x * 3 / w;
            let o = (y * w + x) * 4;
            acc[i].0 += luma(&img.px[o..o + 4]);
            acc[i].1 += 1;
        }
    }
    acc.iter().map(|(s, c)| (s / (*c).max(1) as f64).round() as u8).collect()
}

/// Mean absolute luma gradient (0 for a flat frame; text and texture push it up).
fn detail(img: &Rgba) -> f64 {
    let (w, h) = (img.w as usize, img.h as usize);
    if w < 2 || h < 2 {
        return 0.0;
    }
    let (sx, sy) = ((w / 320).max(1), (h / 180).max(1));
    let (mut s, mut c) = (0f64, 0usize);
    for y in (0..h - sy).step_by(sy) {
        for x in (0..w - sx).step_by(sx) {
            let o = (y * w + x) * 4;
            let l = luma(&img.px[o..o + 4]);
            let r = luma(&img.px[o + sx * 4..o + sx * 4 + 4]);
            let d = luma(&img.px[o + sy * w * 4..o + sy * w * 4 + 4]);
            s += (l - r).abs() + (l - d).abs();
            c += 1;
        }
    }
    s / c.max(1) as f64
}

fn sample(img: &Rgba, gw: usize, gh: usize) -> Vec<f64> {
    let (w, h) = (img.w as usize, img.h as usize);
    let mut out = vec![0f64; gw * gh];
    for gy in 0..gh {
        for gx in 0..gw {
            let (x0, x1) = (gx * w / gw, ((gx + 1) * w / gw).max(gx * w / gw + 1).min(w));
            let (y0, y1) = (gy * h / gh, ((gy + 1) * h / gh).max(gy * h / gh + 1).min(h));
            let (mut s, mut c) = (0f64, 0usize);
            for y in (y0..y1).step_by(((y1 - y0) / 4).max(1)) {
                for x in (x0..x1).step_by(((x1 - x0) / 4).max(1)) {
                    let o = (y * w + x) * 4;
                    s += luma(&img.px[o..o + 4]);
                    c += 1;
                }
            }
            out[gy * gw + gx] = s / c.max(1) as f64;
        }
    }
    out
}

/// 64-bit difference hash: frames that look alike have hashes a few bits apart.
pub fn dhash(img: &Rgba) -> u64 {
    if img.w == 0 || img.h == 0 {
        return 0;
    }
    let g = sample(img, 9, 8);
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h = (h << 1) | u64::from(g[y * 9 + x] < g[y * 9 + x + 1]);
        }
    }
    h
}

/// Hamming distance between two `dhash` hex strings (0 = same picture, >10 = clearly different).
pub fn hash_distance(a: &str, b: &str) -> Option<u32> {
    Some((u64::from_str_radix(a, 16).ok()? ^ u64::from_str_radix(b, 16).ok()?).count_ones())
}

fn ascii_art(img: &Rgba, cols: u32) -> String {
    const RAMP: &[u8] = b" .:-=+*#%@";
    if img.w == 0 || img.h == 0 {
        return String::new();
    }
    let cols = cols.clamp(8, 120) as usize;
    // terminal cells are about twice as tall as wide
    let rows = ((cols as f64 * img.h as f64 / img.w as f64) / 2.0).round().max(1.0) as usize;
    let g = sample(img, cols, rows);
    let mut s = String::with_capacity((cols + 1) * rows);
    for r in 0..rows {
        for c in 0..cols {
            s.push(RAMP[((g[r * cols + c] / 256.0) * RAMP.len() as f64) as usize % RAMP.len()] as char);
        }
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> Vec<u8> {
        (0..w * h).flat_map(|_| c).collect()
    }

    #[test]
    fn black_frame_is_called_out() {
        let px = solid(64, 36, [0, 0, 0, 255]);
        let s = stats(&Rgba { w: 64, h: 36, px: &px }, 0);
        assert_eq!(s["note"], "frame is black");
        assert_eq!(s["black"], 100.0);
        assert_eq!(s["palette"][0][0], "#101010");
    }

    #[test]
    fn hash_tells_pictures_apart() {
        let mut a = solid(64, 36, [0, 0, 0, 255]);
        for y in 0..36 {
            for x in 32..64 {
                a[(y * 64 + x) * 4..(y * 64 + x) * 4 + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let b = solid(64, 36, [128, 128, 128, 255]);
        let (ha, hb) = (dhash(&Rgba { w: 64, h: 36, px: &a }), dhash(&Rgba { w: 64, h: 36, px: &b }));
        assert_ne!(ha, hb);
        assert_eq!(hash_distance(&format!("{ha:016x}"), &format!("{ha:016x}")), Some(0));
        let s = stats(&Rgba { w: 64, h: 36, px: &a }, 16);
        assert_eq!(s["grid"][0], 0);
        assert_eq!(s["grid"][2], 255);
        assert!(s["ascii"].as_str().unwrap().contains('@'));
    }
}
