//! The thinking orb, as libraries.dev's Thinking Orbs draw their "working" state (MIT, Jakub
//! Antalik): particles running on tilted orbits round a sphere, each orbit's path a ghost of fine
//! dots, the whole slowly turning, honestly 3D (rotated, depth-shaded, z-sorted, near dots bigger
//! and brighter). The geometry is a straight port of `engine/orbits.ts` and `engine/core.ts` at
//! the 20 pt preset; the ink is Yune's, the logo's blue to mint.
//!
//! Rune has no per-frame drawing hook, so a thread rasterizes frames into a `Pixels` image while
//! a reply is on its way and the element shows the latest one.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rune::{El, el};

/// The pixels drawn per point, so the orb stays sharp on high-density screens.
const DENSITY: f32 = 3.0;
/// The orb's size in points (the library's inline size).
pub const SIZE: f32 = 20.0;
/// The library's speed for the 20 pt "working" preset, and a little more.
const SPEED: f32 = 3.9 * 1.35;

/// One dot of a frame: where, how far back, how big, and its ink (0 darkest, as the library has it).
struct Dot {
    x: f32,
    y: f32,
    z: f32,
    r: f32,
    white: f32,
    a: f32,
}

/// The library's deterministic hash, in [0, 1).
fn hash_d(a: f32, b: f32) -> f32 {
    let h = ((a * 12.9898 + b * 78.233).sin() * 43_758.547) as f64;
    (h - h.floor()) as f32
}

/// Spin, tilt and orthographic projection (`makeProj`).
fn project(yaw: f32, tilt: f32, cx: f32, cy: f32, p: [f32; 3]) -> [f32; 3] {
    let (sy, cyw, st, ct) = (yaw.sin(), yaw.cos(), tilt.sin(), tilt.cos());
    let [x, y, z] = p;
    let x1 = x * cyw + z * sy;
    let z1 = -x * sy + z * cyw;
    let y1 = y * ct - z1 * st;
    let z2 = y * st + z1 * ct;
    [cx + x1, cy - y1, z2]
}

/// One frame of `frameOrbits` at `size` points and time `t` (already scaled by the speed).
fn frame(size: f32, t: f32) -> Vec<Dot> {
    // The 20 pt preset: counts x0.238, radii x2.4, over the base profile.
    let (orbit_n, ghost_n, particles) = (3_usize, 10_usize, 3_usize);
    let (ghost_r, ghost_a, part_r, part_r_depth, r_min) = (0.9 * 2.4, 0.5, 1.2 * 2.4, 1.6 * 2.4, 0.3);
    let c = size / 2.0;
    let big_r = c * 0.82;
    let rs = (size / 300.0).powf(0.6);
    let mut dots = Vec::new();
    for orb in 0..orbit_n {
        let o = orb as f32;
        let (h1, h2, h3) = (hash_d(o, 1.7), hash_d(o, 5.2), hash_d(o, 8.9));
        let ro = big_r * (0.45 + 0.52 * h1);
        let th = h1 * std::f32::consts::TAU;
        let phi = (2.0 * h2 - 1.0).acos();
        let (nx, ny, nz) = (phi.sin() * th.cos(), phi.cos(), phi.sin() * th.sin());
        let (mut ux, mut uy, uz) = (-ny, nx, 0.0_f32);
        let ul = (ux * ux + uy * uy).sqrt().max(1e-6);
        ux /= ul;
        uy /= ul;
        let (vx, vy, vz) = (ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux);
        let speed = (0.25 + 0.55 * h3) * if h3 > 0.5 { 1.0 } else { -1.0 };
        let at = |a: f32| {
            let p = [(ux * a.cos() + vx * a.sin()) * ro, (uy * a.cos() + vy * a.sin()) * ro, (uz * a.cos() + vz * a.sin()) * ro];
            project(t * 0.12, 0.3, c, c, p)
        };
        for k in 0..ghost_n {
            let [x, y, z] = at(k as f32 / ghost_n as f32 * std::f32::consts::TAU);
            let depth = (z / ro + 1.0) / 2.0;
            dots.push(Dot { x, y, z, r: ghost_r * rs, white: 0.72, a: ghost_a * (0.4 + 0.6 * depth) });
        }
        for m in 0..particles {
            let a = t * speed + m as f32 / particles as f32 * std::f32::consts::TAU + h2 * 6.0;
            let [x, y, z] = at(a);
            let depth = (z / ro + 1.0) / 2.0;
            dots.push(Dot { x, y, z, r: (part_r + part_r_depth * depth) * rs, white: 0.3 - 0.22 * depth, a: 1.0 });
        }
    }
    // `finalizeFrame`: drop the invisible, clamp radii, draw far to near.
    dots.retain(|d| d.a >= 0.02);
    for d in &mut dots {
        d.r = d.r.max(r_min);
    }
    dots.sort_by(|a, b| a.z.total_cmp(&b.z));
    dots
}

/// The ink a dot takes at height `y` (0 top, 1 bottom): the logo's gradient, lifted so it reads on dark.
fn tint(y: f32, dark: bool) -> [f32; 3] {
    let stops: [[f32; 3]; 4] = if dark {
        [[214.0, 251.0, 233.0], [63.0, 214.0, 176.0], [31.0, 162.0, 224.0], [79.0, 139.0, 255.0]]
    } else {
        [[31.0, 162.0, 224.0], [20.0, 150.0, 130.0], [21.0, 110.0, 214.0], [21.0, 86.0, 214.0]]
    };
    let f = y.clamp(0.0, 1.0) * 3.0;
    let i = (f.floor() as usize).min(2);
    let k = f - i as f32;
    std::array::from_fn(|j| stops[i][j] + (stops[i + 1][j] - stops[i][j]) * k)
}

/// Rasterizes a frame: antialiased round dots, the library's ink ramp on the tint (toward black
/// with depth on dark, toward white on light). Straight-alpha RGBA, `px` pixels square.
fn raster(size: f32, t: f32, dark: bool) -> (u32, Vec<u8>) {
    let px = (size * DENSITY).round() as usize;
    let mut acc = vec![[0.0_f32; 4]; px * px]; // premultiplied
    for d in frame(size, t) {
        let w = d.white.clamp(0.0, 1.0);
        let base = tint(d.y / size, dark);
        let rgb: [f32; 3] = std::array::from_fn(|j| if dark { base[j] * (1.0 - w) } else { base[j] + (255.0 - base[j]) * w } / 255.0);
        let (cx, cy, r) = (d.x * DENSITY, d.y * DENSITY, d.r * DENSITY);
        let (x0, x1) = (((cx - r - 1.0).floor().max(0.0)) as usize, ((cx + r + 1.0).ceil() as usize).min(px));
        let (y0, y1) = (((cy - r - 1.0).floor().max(0.0)) as usize, ((cy + r + 1.0).ceil() as usize).min(px));
        for yy in y0..y1 {
            for xx in x0..x1 {
                let dist = ((xx as f32 + 0.5 - cx).powi(2) + (yy as f32 + 0.5 - cy).powi(2)).sqrt();
                let cover = (r - dist + 0.5).clamp(0.0, 1.0) * d.a;
                if cover <= 0.0 {
                    continue;
                }
                let p = &mut acc[yy * px + xx];
                for j in 0..3 {
                    p[j] = rgb[j] * cover + p[j] * (1.0 - cover);
                }
                p[3] = cover + p[3] * (1.0 - cover);
            }
        }
    }
    let mut out = Vec::with_capacity(px * px * 4);
    for p in acc {
        let a = p[3];
        for j in 0..3 {
            out.push(if a > 0.0 { (p[j] / a * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 });
        }
        out.push((a * 255.0).round() as u8);
    }
    (px as u32, out)
}

/// The orb's frames: a thread draws one every ~33 ms while `running`, into the image the view shows.
pub struct OrbPlayer {
    pixels: rune::Pixels,
    running: Arc<AtomicBool>,
    dark: Arc<AtomicBool>,
    started: AtomicBool,
}

impl Default for OrbPlayer {
    fn default() -> Self {
        OrbPlayer { pixels: rune::Pixels::new(), running: Arc::new(AtomicBool::new(false)), dark: Arc::new(AtomicBool::new(true)), started: AtomicBool::new(false) }
    }
}

impl OrbPlayer {
    /// Plays while a reply is on its way, rests otherwise.
    pub fn set_running(&self, on: bool) {
        self.running.store(on, Ordering::Relaxed);
        if on && !self.started.swap(true, Ordering::Relaxed) {
            let (pixels, running, dark) = (self.pixels.clone(), self.running.clone(), self.dark.clone());
            std::thread::Builder::new().name("thinking-orb".into()).spawn(move || {
                let start = std::time::Instant::now();
                loop {
                    if running.load(Ordering::Relaxed) {
                        let (n, rgba) = raster(SIZE, start.elapsed().as_secs_f32() * SPEED, dark.load(Ordering::Relaxed));
                        pixels.set(n, n, rgba);
                        std::thread::sleep(std::time::Duration::from_millis(33));
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                    }
                }
            }).ok();
        }
    }

    /// The orb, `SIZE` points square. Still (reduced motion), it's one fixed frame.
    pub fn view(&self, dark: bool, still: bool) -> El {
        self.dark.store(dark, Ordering::Relaxed);
        if still || self.pixels.size().0 == 0 {
            let (n, rgba) = raster(SIZE, 0.6 * SPEED, dark);
            if still {
                let px = rune::Pixels::new();
                px.set(n, n, rgba);
                return el().size(SIZE, SIZE).inert().pixels(&px);
            }
            self.pixels.set(n, n, rgba);
        }
        el().size(SIZE, SIZE).inert().pixels(&self.pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_the_librarys_orbits_at_twenty_points() {
        let dots = frame(SIZE, 1.0);
        // Three orbits of ten ghost dots and three particles.
        assert_eq!(dots.len(), 3 * (10 + 3));
        assert!(dots.windows(2).all(|w| w[0].z <= w[1].z), "drawn far to near");
        assert!(dots.iter().all(|d| d.x > 0.0 && d.x < SIZE && d.y > 0.0 && d.y < SIZE));
        let (n, rgba) = raster(SIZE, 1.0, true);
        assert_eq!(rgba.len(), (n * n * 4) as usize);
        assert!(rgba.chunks(4).any(|p| p[3] > 200), "particles show");
    }

    #[test]
    fn it_moves() {
        let a: Vec<f32> = frame(SIZE, 0.0).iter().map(|d| d.x).collect();
        let b: Vec<f32> = frame(SIZE, 0.5).iter().map(|d| d.x).collect();
        assert_ne!(a, b);
    }
}
