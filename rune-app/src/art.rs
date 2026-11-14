//! Backgrounds made from a picture or from text: a picture is softened (blur) and shrunk, and
//! ASCII and dotted art are drawn from one shared grid of brightness levels (160 x 90 cells, 0 to
//! 9). The grid is also what the app saves, as ten-character-ramp text lines, so a picture, a
//! generated ASCII drawing and a halftone are all the same data in different clothes.

use image::{ImageBuffer, Rgba, imageops};

/// Brightness ramp: level 0 is empty, 9 the densest glyph.
pub const RAMP: &str = " .:-=+*#%@";
pub const COLS: usize = 160;
pub const ROWS: usize = 90;
/// Pixel size of the art images (16:9; they are scaled to cover the window).
pub const W: u32 = 1920;
pub const H: u32 = 1080;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grid {
    pub lv: Vec<u8>,
}

impl Grid {
    /// The grid as text lines of the ramp's characters.
    pub fn to_lines(&self) -> Vec<String> {
        let ramp: Vec<char> = RAMP.chars().collect();
        self.lv.chunks(COLS).map(|r| r.iter().map(|&l| ramp[l.min(9) as usize]).collect()).collect()
    }

    /// A grid from text art of any size, stretched to the canvas. Characters count by how much
    /// ink they carry, so any ASCII drawing works, not only the ramp's.
    pub fn from_lines(lines: &[String]) -> Option<Grid> {
        let rows: Vec<Vec<char>> = lines.iter().map(|l| l.chars().collect()).collect();
        let (h, w) = (rows.len(), rows.iter().map(Vec::len).max().unwrap_or(0));
        if h == 0 || w == 0 {
            return None;
        }
        let mut lv = vec![0u8; COLS * ROWS];
        for y in 0..ROWS {
            for x in 0..COLS {
                // The source cells this cell covers, averaged.
                let (x0, x1) = (x * w / COLS, ((x + 1) * w).div_ceil(COLS).max(x * w / COLS + 1).min(w));
                let (y0, y1) = (y * h / ROWS, ((y + 1) * h).div_ceil(ROWS).max(y * h / ROWS + 1).min(h));
                let (mut sum, mut n) = (0u32, 0u32);
                for row in &rows[y0..y1] {
                    for xx in x0..x1 {
                        sum += u32::from(ink(row.get(xx).copied().unwrap_or(' ')));
                        n += 1;
                    }
                }
                lv[y * COLS + x] = (sum / n.max(1)) as u8;
            }
        }
        Some(Grid { lv })
    }

    /// A grid from the lines `to_lines` wrote (exactly the canvas size), or any other art.
    pub fn from_saved(lines: &[String]) -> Option<Grid> {
        Grid::from_lines(lines)
    }

    /// A grid from a picture's pixels: cropped to 16:9 around the centre, averaged into cells,
    /// and stretched so the darkest and brightest parts use the whole ramp.
    pub fn from_rgba(rgba: &[u8], w: u32, h: u32) -> Option<Grid> {
        let (w, h) = (w as usize, h as usize);
        if w < 2 || h < 2 || rgba.len() < w * h * 4 {
            return None;
        }
        // Cover-crop to 16:9.
        let (cw, ch) = if w * 9 > h * 16 { (h * 16 / 9, h) } else { (w, w * 9 / 16) };
        let (ox, oy) = ((w - cw) / 2, (h - ch) / 2);
        let mut lum = vec![0f32; COLS * ROWS];
        for y in 0..ROWS {
            for x in 0..COLS {
                let (x0, x1) = (ox + x * cw / COLS, ox + ((x + 1) * cw / COLS).max(x * cw / COLS + 1));
                let (y0, y1) = (oy + y * ch / ROWS, oy + ((y + 1) * ch / ROWS).max(y * ch / ROWS + 1));
                let (mut sum, mut n) = (0.0f32, 0.0f32);
                for yy in y0..y1.min(h) {
                    for xx in x0..x1.min(w) {
                        let p = &rgba[(yy * w + xx) * 4..];
                        let a = f32::from(p[3]) / 255.0;
                        sum += (0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])) * a;
                        n += 1.0;
                    }
                }
                lum[y * COLS + x] = sum / n.max(1.0);
            }
        }
        let mut sorted = lum.clone();
        sorted.sort_by(f32::total_cmp);
        let lo = sorted[sorted.len() / 50];
        let hi = sorted[sorted.len() - 1 - sorted.len() / 50].max(lo + 1.0);
        let lv = lum.iter().map(|&l| {
            // A little gamma so midtones keep some presence on a dark canvas.
            let t = ((l - lo) / (hi - lo)).clamp(0.0, 1.0).powf(1.3);
            (t * 9.0).round() as u8
        }).collect();
        Some(Grid { lv })
    }

    fn at(&self, x: usize, y: usize) -> u8 {
        self.lv[y.min(ROWS - 1) * COLS + x.min(COLS - 1)]
    }
}

/// How much ink a character carries, 0 to 9.
fn ink(c: char) -> u8 {
    if let Some(i) = RAMP.find(c) {
        return i as u8;
    }
    match c {
        '`' | '\'' | ',' | '\u{2591}' => 1,
        ';' | '"' | '_' | '^' | '\u{2592}' => 2,
        '~' | '!' | 'i' | 'l' | 'I' | '|' | '/' | '\\' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' => 3,
        'x' | 'v' | 'o' | 'c' | 'r' | 't' | 'j' | 'z' | 'n' | 'u' | 's' | 'a' | 'e' | '1' | '7' | '\u{2593}' => 4,
        '$' | '&' | 'B' | 'M' | 'W' | '8' | '\u{2588}' => 9,
        c if c.is_alphanumeric() => 6,
        c if c.is_whitespace() => 0,
        _ => 5,
    }
}

/// 5 x 7 glyphs for ramp levels 1 to 9 (`.`, `:`, `-`, `=`, `+`, `*`, `#`, `%`, `@`), a bit per
/// pixel, top row first.
const GLYPHS: [[u8; 7]; 9] = [
    [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100], // .
    [0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000], // :
    [0b00000, 0b00000, 0b00000, 0b01110, 0b00000, 0b00000, 0b00000], // -
    [0b00000, 0b00000, 0b01110, 0b00000, 0b01110, 0b00000, 0b00000], // =
    [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000], // +
    [0b00000, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0b00000], // *
    [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010], // #
    [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011], // %
    [0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110], // @
];

/// ASCII art as an image: each 12 x 22 cell holds the glyph for its brightness. `ink` is the
/// glyph colour; `gain` (0..1) its strongest opacity. `invert` swaps dense and empty, for art on
/// paper.
pub fn ascii_image(grid: &Grid, ink: [u8; 3], gain: f32, invert: bool) -> (u32, u32, Vec<u8>) {
    let mut px = vec![0u8; (W * H * 4) as usize];
    for p in px.chunks_exact_mut(4) {
        p[..3].copy_from_slice(&ink);
    }
    let (cw, chh) = (12usize, 22usize);
    let (cols, rows) = (W as usize / cw, H as usize / chh);
    for ry in 0..rows {
        for rx in 0..cols {
            // Average the grid rows under this text row.
            let (y0, y1) = (ry * ROWS / rows, ((ry + 1) * ROWS).div_ceil(rows).min(ROWS));
            let mut sum = 0u32;
            for y in y0..y1.max(y0 + 1) {
                sum += u32::from(grid.at(rx * COLS / cols, y));
            }
            let mut level = (sum / (y1.max(y0 + 1) - y0) as u32) as usize;
            if invert {
                level = 9 - level.min(9);
            }
            if level == 0 {
                continue;
            }
            let glyph = &GLYPHS[level.min(9) - 1];
            for (gy, bits) in glyph.iter().enumerate() {
                for gx in 0..5 {
                    if bits >> (4 - gx) & 1 == 0 {
                        continue;
                    }
                    // Each glyph pixel is 2 x 2, centred in the cell.
                    let (px0, py0) = (rx * cw + 1 + gx * 2, ry * chh + 4 + gy * 2);
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let i = ((py0 + dy) * W as usize + px0 + dx) * 4 + 3;
                            px[i] = (255.0 * gain) as u8;
                        }
                    }
                }
            }
        }
    }
    (W, H, px)
}

/// Dotted (halftone) art as an image: one round dot per cell, bigger where brighter.
pub fn dots_image(grid: &Grid, ink: [u8; 3], gain: f32, invert: bool) -> (u32, u32, Vec<u8>) {
    let mut px = vec![0u8; (W * H * 4) as usize];
    for p in px.chunks_exact_mut(4) {
        p[..3].copy_from_slice(&ink);
    }
    let cell = (W as usize / COLS) as f32; // 12 px
    for cy in 0..ROWS {
        for cx in 0..COLS {
            let mut level = grid.at(cx, cy);
            if invert {
                level = 9 - level.min(9);
            }
            if level == 0 {
                continue;
            }
            let r = 0.9 + f32::from(level) / 9.0 * (cell * 0.5 - 0.6);
            let (mx, my) = ((cx as f32 + 0.5) * cell, (cy as f32 + 0.5) * cell);
            let (x0, x1) = ((mx - r - 1.0).floor().max(0.0) as usize, ((mx + r + 1.0).ceil() as usize).min(W as usize));
            let (y0, y1) = ((my - r - 1.0).floor().max(0.0) as usize, ((my + r + 1.0).ceil() as usize).min(H as usize));
            for y in y0..y1 {
                for x in x0..x1 {
                    let d = ((x as f32 + 0.5 - mx).powi(2) + (y as f32 + 0.5 - my).powi(2)).sqrt();
                    let cov = (r - d + 0.5).clamp(0.0, 1.0);
                    if cov > 0.0 {
                        px[(y * W as usize + x) * 4 + 3] = (255.0 * cov * gain) as u8;
                    }
                }
            }
        }
    }
    (W, H, px)
}

/// A picture ready to draw: shrunk to at most `max_w` wide and, for `blur` above 0, softened
/// (the blur works on a smaller copy, which is both quick and smooth).
pub fn prepare(rgba: Vec<u8>, w: u32, h: u32, blur: f32, max_w: u32) -> Option<(u32, u32, Vec<u8>)> {
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(w, h, rgba)?;
    let target_w = if blur > 0.0 { max_w.min(640) } else { max_w };
    let img = if w > target_w {
        imageops::resize(&img, target_w, (h * target_w / w).max(1), imageops::FilterType::Triangle)
    } else {
        img
    };
    let img = if blur > 0.0 { imageops::blur(&img, blur) } else { img };
    let (w, h) = img.dimensions();
    Some((w, h, img.into_raw()))
}

/// A made-up dusk landscape for headless renders and tests, which never fetch or read files.
pub fn sample_picture() -> (u32, u32, Vec<u8>) {
    let (w, h) = (640u32, 360u32);
    let mut px = vec![255u8; (w * h * 4) as usize];
    let mix = |a: [f32; 3], b: [f32; 3], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            // Sky: indigo at the top to a warm horizon.
            let mut c = mix([22.0, 26.0, 74.0], [255.0, 140.0, 90.0], (fy / 0.72).min(1.0).powf(1.6));
            // Sun.
            let d = ((fx - 0.68).powi(2) * 2.2 + (fy - 0.56).powi(2) * 3.5).sqrt();
            if d < 0.1 {
                c = mix(c, [255.0, 236.0, 190.0], 1.0 - d / 0.1 * 0.2);
            } else if d < 0.28 {
                c = mix(c, [255.0, 190.0, 120.0], (1.0 - (d - 0.1) / 0.18) * 0.5);
            }
            // Three ridges, far to near.
            for (i, (base, tone)) in [(0.66f32, [92.0f32, 68.0, 120.0]), (0.74, [58.0, 46.0, 92.0]), (0.84, [30.0, 28.0, 60.0])].into_iter().enumerate() {
                let k = i as f32 + 1.0;
                let ridge = base + 0.045 * (fx * 7.0 * k + k).sin() + 0.03 * (fx * 17.0 * k).sin() * 0.5;
                if fy > ridge {
                    c = tone;
                }
            }
            // A few stars.
            if fy < 0.35 && ((x * 7919 + y * 104_729) % 997) == 0 {
                c = [255.0, 255.0, 255.0];
            }
            let i = ((y * w + x) * 4) as usize;
            px[i] = c[0] as u8;
            px[i + 1] = c[1] as u8;
            px[i + 2] = c[2] as u8;
        }
    }
    (w, h, px)
}

/// A line of ASCII art for the generator's examples and tests: a hill and a moon.
#[cfg(test)]
fn sample_lines() -> Vec<String> {
    vec![
        "        @@@@        ".into(),
        "       @@@@@@       ".into(),
        "        @@@@        ".into(),
        "                    ".into(),
        "  ....::::----====  ".into(),
        "++++****####%%%%@@@@".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_make_a_grid_and_back() {
        let g = Grid::from_lines(&sample_lines()).expect("grid");
        assert_eq!(g.lv.len(), COLS * ROWS);
        let lines = g.to_lines();
        assert_eq!((lines.len(), lines[0].chars().count()), (ROWS, COLS));
        // The moon sits at the top middle, the ground fills the bottom.
        assert!(g.at(80, 2) >= 8 && g.at(5, 2) == 0 && g.at(150, 89) >= 8);
        // The saved text reads back to the same grid.
        assert_eq!(Grid::from_saved(&lines).expect("again"), g);
    }

    #[test]
    fn a_picture_becomes_a_grid_using_the_whole_ramp() {
        let (w, h, px) = sample_picture();
        let g = Grid::from_rgba(&px, w, h).expect("grid");
        assert!(g.lv.contains(&0) && g.lv.contains(&9));
    }

    #[test]
    fn ascii_and_dots_draw_something() {
        let g = Grid::from_lines(&sample_lines()).expect("grid");
        for (w, h, px) in [ascii_image(&g, [200, 200, 200], 0.6, false), dots_image(&g, [200, 200, 200], 0.6, false)] {
            assert_eq!(px.len(), (w * h * 4) as usize);
            assert!(px.chunks_exact(4).any(|p| p[3] > 0));
        }
    }

    #[test]
    fn blur_shrinks_and_softens() {
        let (w, h, px) = sample_picture();
        let (bw, bh, b) = prepare(px, w, h, 4.0, 1600).expect("blur");
        assert_eq!((bw, bh), (640, 360));
        assert_eq!(b.len(), (bw * bh * 4) as usize);
    }
}
