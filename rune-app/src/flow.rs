//! "Flowing dots": the chat home's background as a live halftone. Clouds of dots drift slowly
//! behind it. A thread draws each frame into one `Pixels`, which redraws only that layer, never
//! the app's layout.
//!
//! The field is domain-warped value noise sampled once per dot; each dot's radius follows it.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rune::Pixels;

/// The frame drawn, in pixels: the backdrop scales it to the window (Fill).
const W: usize = 1600;
const H: usize = 1000;
/// Distance between dot centres, in frame pixels.
const PITCH: usize = 8;
const COLS: usize = W / PITCH;
const ROWS: usize = H / PITCH;
/// The colours a frame is drawn in: the page behind, and the dots.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub bg: [u8; 3],
    pub ink: [u8; 3],
}

/// A running animation: its image, and the switches its thread reads.
pub struct Flow {
    pub px: Pixels,
    palette: Palette,
    stop: Arc<AtomicBool>,
    /// Frames per second the thread aims for (30, fewer while the window isn't in front).
    fps: Arc<AtomicU32>,
}

impl Flow {
    /// Starts drawing in `palette`. `still`: one frame and no motion (reduce motion).
    pub fn start(palette: Palette, still: bool) -> Flow {
        let px = Pixels::new();
        let stop = Arc::new(AtomicBool::new(false));
        let fps = Arc::new(AtomicU32::new(30));
        let field = Field::new(palette);
        // The first frame now, so the backdrop never shows empty.
        px.set(W as u32, H as u32, field.frame(0.0));
        if !still {
            let (px2, stop2, fps2) = (px.clone(), stop.clone(), fps.clone());
            let _ = std::thread::Builder::new().name("flowing-dots".into()).spawn(move || run(field, px2, stop2, fps2));
        }
        Flow { px, palette, stop, fps }
    }

    pub fn palette(&self) -> Palette {
        self.palette
    }

    /// 30 frames a second while the window is in front (the clouds drift slowly), 12 behind others.
    pub fn set_focused(&self, focused: bool) {
        self.fps.store(if focused { 30 } else { 12 }, Ordering::Relaxed);
    }
}

impl Drop for Flow {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn run(field: Field, px: Pixels, stop: Arc<AtomicBool>, fps: Arc<AtomicU32>) {
    let start = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let began = Instant::now();
        px.set(W as u32, H as u32, field.frame(start.elapsed().as_secs_f32()));
        let every = Duration::from_secs_f64(1.0 / f64::from(fps.load(Ordering::Relaxed).max(1)));
        if let Some(rest) = every.checked_sub(began.elapsed()) {
            std::thread::sleep(rest);
        }
    }
}

/// The noise and the colours: everything a frame needs.
struct Field {
    palette: Palette,
    perm: [u8; 512],
    rnd: [f32; 256],
    /// The disc of each radius step, as coverage per pixel of one cell (anti-aliased).
    discs: Vec<[u8; PITCH * PITCH]>,
    /// An empty frame in the background colour, copied at the start of each frame.
    blank: Vec<u8>,
}

const STEPS: usize = 16;

impl Field {
    fn new(palette: Palette) -> Field {
        // A fixed shuffle, so the clouds look the same from run to run.
        let mut perm = [0u8; 512];
        let mut seed: u32 = 0x9E37_79B9;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let mut p: Vec<u8> = (0..=255).collect();
        for i in (1..256).rev() {
            p.swap(i, (next() as usize) % (i + 1));
        }
        for i in 0..512 {
            perm[i] = p[i & 255];
        }
        let mut rnd = [0f32; 256];
        for r in &mut rnd {
            *r = (next() % 10_000) as f32 / 10_000.0;
        }
        let max_r = PITCH as f32 * 0.42;
        let centre = PITCH as f32 / 2.0;
        let discs = (0..=STEPS).map(|s| {
            let r = max_r * s as f32 / STEPS as f32;
            let mut d = [0u8; PITCH * PITCH];
            for y in 0..PITCH {
                for x in 0..PITCH {
                    let dist = ((x as f32 + 0.5 - centre).powi(2) + (y as f32 + 0.5 - centre).powi(2)).sqrt();
                    d[y * PITCH + x] = ((r - dist + 0.5).clamp(0.0, 1.0) * 255.0) as u8;
                }
            }
            d
        }).collect();
        let blank = [palette.bg[0], palette.bg[1], palette.bg[2], 255].repeat(W * H);
        Field { palette, perm, rnd, discs, blank }
    }

    fn hash(&self, x: i32, y: i32) -> f32 {
        let a = self.perm[(x & 255) as usize] as usize;
        self.rnd[self.perm[(a + (y & 255) as usize) & 511] as usize]
    }

    fn noise(&self, x: f32, y: f32) -> f32 {
        let (xi, yi) = (x.floor(), y.floor());
        let (xf, yf) = (x - xi, y - yi);
        let (u, v) = (xf * xf * (3.0 - 2.0 * xf), yf * yf * (3.0 - 2.0 * yf));
        let (xi, yi) = (xi as i32, yi as i32);
        let a = self.hash(xi, yi);
        let b = self.hash(xi + 1, yi);
        let c = self.hash(xi, yi + 1);
        let d = self.hash(xi + 1, yi + 1);
        let top = a + (b - a) * u;
        let bottom = c + (d - c) * u;
        top + (bottom - top) * v
    }

    fn fbm(&self, x: f32, y: f32, octaves: u32) -> f32 {
        let (mut sum, mut amp, mut f, mut norm) = (0.0, 0.5, 1.0, 0.0);
        for _ in 0..octaves {
            sum += amp * self.noise(x * f, y * f);
            norm += amp;
            amp *= 0.5;
            f *= 2.03;
        }
        sum / norm
    }

    /// The frame at `t` seconds, RGBA.
    fn frame(&self, t: f32) -> Vec<u8> {
        let Palette { ink, .. } = self.palette;
        let mut out = self.blank.clone();
        // The cloud field on every other dot, smoothed in between: a quarter of the noise.
        let (gw, gh) = (COLS / 2 + 2, ROWS / 2 + 2);
        let mut grid = vec![0f32; gw * gh];
        for gy in 0..gh {
            for gx in 0..gw {
                let (sx, sy) = (((gx * 2 * PITCH) as f32 + PITCH as f32 / 2.0) / 260.0, ((gy * 2 * PITCH) as f32 + PITCH as f32 / 2.0) / 260.0);
                // The clouds fold and drift slowly up and to the left.
                let wx = self.fbm(sx + 0.05 * t, sy - 0.03 * t, 3);
                let wy = self.fbm(sx + 5.2 - 0.04 * t, sy + 1.3 + 0.02 * t, 3);
                grid[gy * gw + gx] = self.fbm(sx + 1.6 * wx + 0.06 * t, sy + 1.6 * wy - 0.035 * t, 4);
            }
        }
        for row in 0..ROWS {
            for colm in 0..COLS {
                let cx = (colm * PITCH) as f32 + PITCH as f32 / 2.0;
                let cy = (row * PITCH) as f32 + PITCH as f32 / 2.0;
                let (gx, gy) = (colm / 2, row / 2);
                let (fx, fy) = ((colm % 2) as f32 * 0.5, (row % 2) as f32 * 0.5);
                let g = |x: usize, y: usize| grid[y * gw + x];
                let top = g(gx, gy) + (g(gx + 1, gy) - g(gx, gy)) * fx;
                let bottom = g(gx, gy + 1) + (g(gx + 1, gy + 1) - g(gx, gy + 1)) * fx;
                let f = top + (bottom - top) * fy;
                // Clouds where the field is high, thinning to single small dots at their edges.
                let dens = ((f - 0.52) / 0.2).clamp(0.0, 1.0);
                let mut r = dens.powf(0.85) * 0.86;
                if dens == 0.0 && f > 0.44 && self.noise(cx * 0.37 / PITCH as f32 * 8.0 + t * 0.6, cy * 0.41 / PITCH as f32 * 8.0) > 0.86 {
                    r = 0.22; // a speck just outside a cloud
                }
                if r <= 0.01 {
                    continue;
                }
                let step = ((r * STEPS as f32).round() as usize).min(STEPS);
                if step == 0 {
                    continue;
                }
                let shade = 0.5 + 0.5 * dens;
                let colour = [0, 1, 2].map(|i| (f32::from(ink[i]) * shade) as u8);
                let disc = &self.discs[step];
                for y in 0..PITCH {
                    let base = ((row * PITCH + y) * W + colm * PITCH) * 4;
                    for x in 0..PITCH {
                        let a = u32::from(disc[y * PITCH + x]);
                        if a == 0 {
                            continue;
                        }
                        let o = base + x * 4;
                        for i in 0..3 {
                            out[o + i] = ((u32::from(out[o + i]) * (255 - a) + colour[i] as u32 * a) / 255) as u8;
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DARK: Palette = Palette { bg: [15, 15, 15], ink: [92, 92, 96] };

    #[test]
    fn a_frame_fills_the_image_and_has_dots() {
        let f = Field::new(DARK);
        let px = f.frame(1.0);
        assert_eq!(px.len(), W * H * 4);
        let lit = px.chunks_exact(4).filter(|p| p[0] > 30).count();
        assert!(lit > W * H / 50, "some dots are drawn ({lit})");
        assert!(lit < W * H / 2, "and most of it is background ({lit})");
    }

    /// Writes a few frames to PNG for looking at: `cargo test --release flow -- --ignored`.
    #[test]
    #[ignore]
    fn write_frames() {
        let f = Field::new(DARK);
        for (name, t) in [("a", 2.0), ("b", 3.2), ("c", 4.0)] {
            let px = f.frame(t);
            let path = std::env::temp_dir().join(format!("flow-{name}.png"));
            let file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
            let mut enc = png::Encoder::new(file, W as u32, H as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().unwrap().write_image_data(&px).unwrap();
            let lit = px.chunks_exact(4).filter(|p| p[0] > 30).count() as f32 / (W * H) as f32;
            println!("{} lit {:.3}", path.display(), lit);
        }
    }

    /// How long a frame takes: `cargo test --release flow -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn frame_time() {
        let f = Field::new(DARK);
        let start = std::time::Instant::now();
        for i in 0..30 {
            std::hint::black_box(f.frame(i as f32 / 30.0));
        }
        println!("frame {:.2} ms", start.elapsed().as_secs_f64() * 1000.0 / 30.0);
        let start = std::time::Instant::now();
        for _ in 0..30 {
            std::hint::black_box(f.blank.clone());
        }
        println!("blank copy {:.2} ms", start.elapsed().as_secs_f64() * 1000.0 / 30.0);
    }

}
