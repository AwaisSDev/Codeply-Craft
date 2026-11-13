//! The Chat home's dithered space art: a soft warp band sweeping up from the lower left, fine
//! dithered sparks, blue above the core and red below, and a few stars. A port of `drawArt` in
//! design/workspace/index.html, drawn once per window size on the CPU into a `rune::Pixels`.
//!
//! Each art pixel is 3 points. The image is scaled up here with nearest-neighbour to whole device
//! pixels, so the dots stay square (Rune filters images bilinearly).

use std::cell::Cell;

use rune::{Cx, El, Pixels, el};

use crate::app::App;

const PX: f32 = 3.0;
const BAYER: [f32; 16] = [0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0];

pub struct Warp {
    pixels: Pixels,
    /// The (art width, art height, device pixels per art pixel) last drawn.
    made: Cell<(u32, u32, u32)>,
}

impl Default for Warp {
    fn default() -> Self {
        Warp { pixels: Pixels::new(), made: Cell::new((0, 0, 0)) }
    }
}

/// The art at `w x h` art pixels, straight-alpha RGBA.
pub fn render(w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (w * h * 4) as usize];
    let mut seed: u64 = 11;
    let mut rnd = || {
        seed = (seed * 16807) % 2_147_483_647;
        seed as f32 / 2_147_483_647.0
    };
    for j in 0..h {
        for i in 0..w {
            let (u, v) = (i as f32 / w as f32, j as f32 / h as f32);
            let centre = 0.62 + 0.22 * (u * 2.2 - 0.9).sin();
            let band = v - centre;
            let g = (-(band * band) / 0.012).exp();
            let n = rnd();
            let streak = 0.55 + 0.45 * (u * 48.0 + v * 12.0 + (u * 5.0).sin() * 2.0).sin();
            let k = g * streak * (0.35 + 0.65 * n);
            let (r, gg, b) = if band.abs() < 0.012 { (235.0, 238.0, 245.0) } else if band < 0.0 { (70.0, 110.0, 255.0) } else { (225.0, 55.0, 70.0) };
            let t = (BAYER[((j % 4) * 4 + (i % 4)) as usize] + 0.5) / 16.0;
            let on = k > t * 0.95 + 0.08;
            let dim = if on { 0.35 + 0.5 * k } else { 0.0 };
            let o = ((j * w + i) * 4) as usize;
            let mut px = [(r * dim) as u8, (gg * dim) as u8, (b * dim) as u8, 255];
            if rnd() < 0.0025 {
                let w = (120.0 + rnd() * 110.0) as u8;
                px = [w, w, w, 255];
            }
            out[o..o + 4].copy_from_slice(&px);
        }
    }
    out
}

/// `src` (w x h) scaled up `k` times with nearest-neighbour.
pub fn upscale(src: &[u8], w: u32, h: u32, k: u32) -> Vec<u8> {
    let (ow, oh) = (w * k, h * k);
    let mut out = vec![0u8; (ow * oh * 4) as usize];
    for y in 0..oh {
        let sy = y / k;
        let row = &src[(sy * w * 4) as usize..((sy + 1) * w * 4) as usize];
        let dst = &mut out[(y * ow * 4) as usize..((y + 1) * ow * 4) as usize];
        for x in 0..w as usize {
            let p = &row[x * 4..x * 4 + 4];
            for d in 0..k as usize {
                let o = (x * k as usize + d) * 4;
                dst[o..o + 4].copy_from_slice(p);
            }
        }
    }
    out
}

impl Warp {
    /// The art, covering the main area.
    pub fn element(&self, cx: &mut Cx<App>) -> El {
        let size = cx.layout_size("main").unwrap_or([1112.0, 856.0]);
        let scale = cx.env().scale.max(1.0);
        let (w, h) = ((size[0] / PX).ceil() as u32, (size[1] / PX).ceil() as u32);
        let k = (PX * scale).round().max(1.0) as u32;
        if self.made.get() != (w, h, k) && w > 0 && h > 0 {
            self.made.set((w, h, k));
            self.pixels.set(w * k, h * k, upscale(&render(w, h), w, h, k));
        }
        let pts = k as f32 / scale;
        el().key("chat-art").pin(Some(0.0), Some(0.0), None, None).size(w as f32 * pts, h as f32 * pts).pixels(&self.pixels).inert()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upscaling_keeps_pixels_square() {
        let src = [1, 2, 3, 255, 9, 8, 7, 255];
        let out = upscale(&src, 2, 1, 3);
        assert_eq!(out.len(), 6 * 3 * 4);
        assert_eq!(&out[8..12], &[1, 2, 3, 255]);
        assert_eq!(&out[12..16], &[9, 8, 7, 255]);
        assert_eq!(&out[(6 * 4 * 2)..(6 * 4 * 2 + 4)], &[1, 2, 3, 255]);
    }

    #[test]
    fn the_band_lights_some_pixels_and_not_others() {
        let art = render(120, 80);
        let lit = art.chunks(4).filter(|p| p[0] > 0 || p[2] > 0).count();
        assert!(lit > 50 && lit < 120 * 80 / 2, "{lit}");
    }
}
