//! The Office's pixel art, drawn here in code (no sprite sheets): warm wood floors, checkered
//! kitchen tiles, a carpeted lounge, wallpapered back walls with windows and posters, desks with
//! monitors, bookshelves, plants, a coffee machine, a sofa, a rug and the Needs you counter.
//!
//! The art is 300 x 180 art pixels, one per 4 units of the prototype's 1200 x 720 office
//! (design/workspace/views.js), so rooms and agents sit where the prototype puts them. It is
//! scaled up by a whole number of device pixels with nearest-neighbour, so every art pixel is a
//! crisp square. Agents are "actors": a small canvas per agent with its bot and its effects
//! (thinking dots, steam, z's), redrawn only when its frame changes, at 8 frames a second.

use std::cell::{Cell, RefCell};

use rune::{Live, Pixels, Tx};

use crate::bot::rgb;
use crate::model::{AgentState, Gear, Snapshot};
use crate::views::warp::upscale;

pub const W: u32 = 300;
pub const H: u32 = 180;
/// World units (the prototype's 1200 x 720 office) per art pixel.
pub const UNIT: f32 = 4.0;
/// An actor's canvas, and where the bot's centre sits in it.
pub const ACTOR_W: u32 = 32;
pub const ACTOR_H: u32 = 30;
pub const BOT_CENTRE: (f32, f32) = (16.0, 20.0);
const FPS: f64 = 8.0;

type Rgb = [u8; 3];

fn c(hex: u32) -> Rgb {
    [(hex >> 16) as u8, (hex >> 8) as u8, hex as u8]
}

fn shade(p: Rgb, k: f32) -> Rgb {
    p.map(|v| (f32::from(v) * k).clamp(0.0, 255.0) as u8)
}

fn mix(a: Rgb, b: Rgb, t: f32) -> Rgb {
    [0, 1, 2].map(|i| (f32::from(a[i]) + (f32::from(b[i]) - f32::from(a[i])) * t) as u8)
}

/// A small deterministic hash for texture noise, so the art is the same every launch.
fn hash(x: i32, y: i32) -> u32 {
    let mut h = (x as u32).wrapping_mul(374_761_393) ^ (y as u32).wrapping_mul(668_265_263);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^ (h >> 16)
}

/// An RGBA canvas in art pixels.
pub struct Canvas {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

impl Canvas {
    pub fn new(w: u32, h: u32) -> Canvas {
        Canvas { w, h, px: vec![0; (w * h * 4) as usize] }
    }
    pub fn set(&mut self, x: i32, y: i32, p: Rgb) {
        if x >= 0 && y >= 0 && (x as u32) < self.w && (y as u32) < self.h {
            let o = ((y as u32 * self.w + x as u32) * 4) as usize;
            self.px[o..o + 4].copy_from_slice(&[p[0], p[1], p[2], 255]);
        }
    }
    #[cfg(test)]
    pub fn get(&self, x: i32, y: i32) -> Option<Rgb> {
        if x >= 0 && y >= 0 && (x as u32) < self.w && (y as u32) < self.h {
            let o = ((y as u32 * self.w + x as u32) * 4) as usize;
            (self.px[o + 3] > 0).then(|| [self.px[o], self.px[o + 1], self.px[o + 2]])
        } else {
            None
        }
    }
    pub fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, p: Rgb) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.set(xx, yy, p);
            }
        }
    }
    /// A filled ellipse centred at (cx, cy).
    pub fn ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, p: Rgb) {
        for yy in (cy - ry).floor() as i32..=(cy + ry).ceil() as i32 {
            for xx in (cx - rx).floor() as i32..=(cx + rx).ceil() as i32 {
                let (dx, dy) = ((xx as f32 + 0.5 - cx) / rx, (yy as f32 + 0.5 - cy) / ry);
                if dx * dx + dy * dy <= 1.0 {
                    self.set(xx, yy, p);
                }
            }
        }
    }
    /// A rectangle outline one art pixel wide.
    pub fn frame(&mut self, x: i32, y: i32, w: i32, h: i32, p: Rgb) {
        self.rect(x, y, w, 1, p);
        self.rect(x, y + h - 1, w, 1, p);
        self.rect(x, y, 1, h, p);
        self.rect(x + w - 1, y, 1, h, p);
    }
}

// ---------- palette ----------

const OUTSIDE: u32 = 0x14110f;
const WALL_EDGE: u32 = 0x231b16;
const SKIRT: u32 = 0x3b2a1f;
const WOOD: u32 = 0x6e4a2d;
const WOOD_B: u32 = 0x664429;
const SEAM: u32 = 0x4b311c;
const HALL: u32 = 0x3e2d21;
const DESK: u32 = 0xa9784a;
const DESK_FRONT: u32 = 0x7a5232;
const MONITOR: u32 = 0x1d1f26;
const SCREEN_OFF: u32 = 0x10141c;
const SCREEN_ON: u32 = 0x10224a;
const LEAF: u32 = 0x3f8f57;
const LEAF_B: u32 = 0x2f6b42;
const POT: u32 = 0xb5643c;

/// A room: where it is in art pixels, its wallpaper and its floor.
#[derive(Clone, Copy)]
pub struct Room {
    pub name: &'static str,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub paper: (u32, u32),
    pub floor: Floor,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Floor {
    Wood,
    Tiles,
    Carpet,
}

/// Wall height (the wallpapered back wall) in art pixels.
pub const WALL: i32 = 15;

/// The prototype's rooms (views.js `scene()`), in art pixels.
pub const ROOMS: [Room; 5] = [
    Room { name: "Studio", x: 5, y: 5, w: 140, h: 105, paper: (0x2e4b4a, 0x335453), floor: Floor::Wood },
    Room { name: "Wisp", x: 150, y: 5, w: 70, h: 60, paper: (0x263457, 0x2b3a61), floor: Floor::Wood },
    Room { name: "Kitchen", x: 225, y: 5, w: 70, h: 60, paper: (0x3b4b3b, 0x415341), floor: Floor::Tiles },
    Room { name: "Lounge", x: 150, y: 70, w: 145, h: 105, paper: (0x4a2b3b, 0x523042), floor: Floor::Carpet },
    Room { name: "Needs you", x: 5, y: 115, w: 140, h: 60, paper: (0x5a4527, 0x624b2b), floor: Floor::Wood },
];

fn floor(cv: &mut Canvas, r: &Room) {
    let (x0, y0, x1, y1) = (r.x + 1, r.y + WALL, r.x + r.w - 1, r.y + r.h - 1);
    for y in y0..y1 {
        for x in x0..x1 {
            let p = match r.floor {
                Floor::Wood => {
                    // Planks 4 pixels tall, staggered seams, a little grain.
                    let row = (y - y0) / 4;
                    let len = 22 + (hash(row, r.x) % 9) as i32;
                    let off = (hash(row, 7) % 30) as i32;
                    if (y - y0) % 4 == 3 || (x - x0 + off) % len == 0 {
                        c(SEAM)
                    } else {
                        let base = if row % 2 == 0 { c(WOOD) } else { c(WOOD_B) };
                        if hash(x, y).is_multiple_of(23) { shade(base, 0.9) } else { base }
                    }
                }
                Floor::Tiles => {
                    let on = ((x - x0) / 5 + (y - y0) / 5) % 2 == 0;
                    let base = if on { c(0xa79f8f) } else { c(0x3e3d45) };
                    if (x - x0) % 5 == 4 || (y - y0) % 5 == 4 { shade(base, 0.86) } else { base }
                }
                Floor::Carpet => {
                    let n = hash(x, y) % 9;
                    if n == 0 { c(0x3a5170) } else if n == 1 { c(0x2c3d56) } else { c(0x33475f) }
                }
            };
            cv.set(x, y, p);
        }
    }
}

fn wall(cv: &mut Canvas, r: &Room) {
    let (a, b) = (c(r.paper.0), c(r.paper.1));
    for y in r.y + 1..r.y + WALL - 2 {
        for x in r.x + 1..r.x + r.w - 1 {
            // Stripes, and a small diamond on every other stripe.
            let stripe = ((x - r.x) / 3) % 2 == 0;
            let mut p = if stripe { a } else { b };
            if !stripe && (x + y) % 6 == 0 && (y - r.y) % 6 == 3 {
                p = shade(b, 1.18);
            }
            cv.set(x, y, p);
        }
    }
    // A picture rail at the top and the skirting board at the bottom.
    cv.rect(r.x + 1, r.y + 1, r.w - 2, 1, shade(a, 0.75));
    cv.rect(r.x + 1, r.y + WALL - 2, r.w - 2, 2, c(SKIRT));
    cv.rect(r.x + 1, r.y + WALL - 2, r.w - 2, 1, shade(c(SKIRT), 1.3));
}

fn outline(cv: &mut Canvas, r: &Room) {
    cv.frame(r.x, r.y, r.w, r.h, c(WALL_EDGE));
}

fn window(cv: &mut Canvas, x: i32, y: i32, w: i32, h: i32) {
    cv.rect(x - 1, y - 1, w + 2, h + 2, c(0x2b2019));
    for yy in 0..h {
        let t = yy as f32 / h as f32;
        cv.rect(x, y + yy, w, 1, mix(c(0x2f4f86), c(0x8fb3d9), t));
    }
    // Two clouds and a cross-bar.
    cv.rect(x + 2, y + 3, 4, 1, c(0xdce8f5));
    cv.rect(x + w - 6, y + 2, 3, 1, c(0xdce8f5));
    cv.rect(x + w / 2, y, 1, h, c(0x2b2019));
    cv.rect(x, y + h / 2, w, 1, c(0x2b2019));
    cv.rect(x - 1, y + h + 1, w + 2, 1, c(0x8a6a4a));
}

fn poster(cv: &mut Canvas, x: i32, y: i32, w: i32, h: i32, bg: u32, ink: u32) {
    cv.rect(x - 1, y - 1, w + 2, h + 2, c(0x1a1512));
    cv.rect(x, y, w, h, c(bg));
    // A little Wisp hexagon on it.
    let (cx, cy) = (x + w / 2, y + h / 2);
    cv.rect(cx - 2, cy - 2, 4, 5, c(ink));
    cv.rect(cx - 3, cy - 1, 6, 3, c(ink));
    cv.set(cx - 1, cy, c(bg));
    cv.set(cx + 1, cy, c(bg));
}

fn bookshelf(cv: &mut Canvas, x: i32, y: i32, w: i32, h: i32) {
    cv.rect(x, y, w, h, c(0x5a3b24));
    cv.frame(x, y, w, h, c(0x3c2716));
    let spines = [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c45a, 0x8064a2, 0x4bacc6, 0xe0884a];
    let mut sy = y + 1;
    while sy + 4 < y + h {
        let mut sx = x + 1;
        let mut k = (sx + sy) as usize;
        while sx < x + w - 1 {
            let bh = 3 + (hash(sx, sy) % 2) as i32;
            cv.rect(sx, sy + 4 - bh, 1, bh, c(spines[k % spines.len()]));
            sx += 1;
            k += 3;
        }
        cv.rect(x + 1, sy + 4, w - 2, 1, c(0x3c2716));
        sy += 5;
    }
}

fn plant(cv: &mut Canvas, x: i32, y: i32, big: bool) {
    let s = if big { 1 } else { 0 };
    cv.rect(x - 2 - s, y, 5 + 2 * s, 4 + s, c(POT));
    cv.rect(x - 2 - s, y, 5 + 2 * s, 1, shade(c(POT), 1.2));
    cv.rect(x - 2 - s, y + 3 + s, 5 + 2 * s, 1, shade(c(POT), 0.7));
    let leaves: &[(i32, i32)] = &[(0, -1), (-1, -2), (1, -2), (-2, -3), (2, -3), (0, -3), (-3, -4), (3, -4), (-1, -4), (1, -5), (0, -6), (-2, -5), (2, -6)];
    for (i, (dx, dy)) in leaves.iter().enumerate() {
        let p = if i % 3 == 0 { c(LEAF_B) } else { c(LEAF) };
        cv.rect(x + dx * (1 + s), y + dy - s, 1 + s, 1 + s, p);
    }
}

/// A desk seen from the front and a little above: a top, a front face with a drawer, legs, a
/// monitor (lit or not) and a keyboard. The animated screen glow is drawn over it by the view.
fn desk(cv: &mut Canvas, x: i32, y: i32, w: i32, on: bool) {
    cv.rect(x, y, w, 6, c(DESK));
    cv.rect(x, y, w, 1, shade(c(DESK), 1.15));
    cv.rect(x, y + 6, w, 4, c(DESK_FRONT));
    cv.rect(x + w - 10, y + 7, 6, 1, shade(c(DESK_FRONT), 1.3));
    cv.rect(x + 1, y + 10, 2, 3, shade(c(DESK_FRONT), 0.7));
    cv.rect(x + w - 3, y + 10, 2, 3, shade(c(DESK_FRONT), 0.7));
    let mx = x + w / 2 - 6;
    cv.rect(mx, y - 7, 12, 8, c(MONITOR));
    cv.rect(mx + 1, y - 6, 10, 6, if on { c(SCREEN_ON) } else { c(SCREEN_OFF) });
    cv.rect(mx + 5, y + 1, 2, 1, c(MONITOR));
    cv.rect(mx + 2, y + 2, 8, 2, c(0xd9d4cc));
    cv.rect(mx + 2, y + 3, 8, 1, c(0xb9b2a8));
}

/// The screen rectangle of the monitor on a desk at (x, y) of width w, for the glow overlay.
pub fn screen_rect(x: i32, y: i32, w: i32) -> [i32; 4] {
    [x + w / 2 - 5, y - 6, 10, 6]
}

fn chair(cv: &mut Canvas, cx: i32, cy: i32) {
    cv.ellipse(cx as f32, cy as f32, 4.5, 3.0, c(0x2f2f3a));
    cv.ellipse(cx as f32, cy as f32 - 0.6, 3.5, 2.0, c(0x3b3b49));
    cv.rect(cx, cy + 3, 1, 2, c(0x1d1d24));
}

fn sofa(cv: &mut Canvas, x: i32, y: i32, w: i32) {
    let (fabric, dark) = (c(0x8d4a5a), c(0x6a3443));
    cv.rect(x, y, w, 8, dark);
    cv.rect(x + 1, y + 1, w - 2, 1, shade(dark, 1.2));
    cv.rect(x, y + 8, w, 8, fabric);
    cv.rect(x - 3, y + 3, 4, 13, dark);
    cv.rect(x + w - 1, y + 3, 4, 13, dark);
    for k in 1..3 {
        cv.rect(x + k * w / 3, y + 8, 1, 7, dark);
    }
    cv.rect(x, y + 15, w, 1, shade(dark, 0.7));
    cv.rect(x + 2, y + 16, 2, 2, c(0x2a1c14));
    cv.rect(x + w - 4, y + 16, 2, 2, c(0x2a1c14));
}

fn counter(cv: &mut Canvas, x: i32, y: i32, w: i32, h: i32, top: u32, front: u32) {
    cv.rect(x, y, w, 3, c(top));
    cv.rect(x, y, w, 1, shade(c(top), 1.15));
    cv.rect(x, y + 3, w, h - 3, c(front));
    let mut dx = x + 2;
    while dx + 8 < x + w {
        cv.frame(dx, y + 4, 8, h - 5, shade(c(front), 0.8));
        cv.set(dx + 6, y + 6, shade(c(front), 1.4));
        dx += 10;
    }
}

/// A 3 x 5 pixel digit, for the Needs you queue display.
fn digit(cv: &mut Canvas, x: i32, y: i32, n: u32, p: Rgb) {
    const D: [u16; 10] = [0x7b6f, 0x2c97, 0x73e7, 0x73cf, 0x5bc9, 0x79cf, 0x79ef, 0x7249, 0x7bef, 0x7bcf];
    let bits = D[(n % 10) as usize];
    for i in 0..15 {
        if bits & (1 << (14 - i)) != 0 {
            cv.set(x + i % 3, y + i / 3, p);
        }
    }
}

/// The whole office without its agents. `waiting` is the number on the Needs you display.
pub fn render_scene(waiting: u32) -> Canvas {
    let mut cv = Canvas::new(W, H);
    for y in 0..H as i32 {
        for x in 0..W as i32 {
            let p = if hash(x, y).is_multiple_of(17) { shade(c(OUTSIDE), 1.25) } else { c(OUTSIDE) };
            cv.set(x, y, p);
        }
    }
    // The hallway: between the Studio and the rooms on the right, and under Wisp and the Kitchen.
    cv.rect(145, 5, 5, 170, c(HALL));
    cv.rect(145, 65, 150, 5, c(HALL));
    cv.rect(5, 110, 140, 5, c(HALL));
    for r in &ROOMS {
        floor(&mut cv, r);
        wall(&mut cv, r);
        outline(&mut cv, r);
    }
    // Doorways where the hallway meets a room.
    cv.rect(144, 78, 2, 12, c(HALL));
    cv.rect(254, 64, 14, 2, c(HALL));
    cv.rect(160, 64, 14, 2, c(HALL));
    cv.rect(160, 69, 14, 2, c(HALL));
    cv.rect(60, 109, 14, 2, c(HALL));
    cv.rect(60, 114, 14, 2, c(HALL));

    // Studio: two windows, a poster, a clock, a bookshelf, four desks and plants.
    // Room labels sit at the top-left of each wall, so wall art starts to their right.
    window(&mut cv, 32, 7, 16, 7);
    poster(&mut cv, 58, 7, 9, 6, 0x1d2a44, 0x4f86ff);
    cv.ellipse(80.5, 9.5, 3.0, 3.0, c(0xe8e2d6));
    cv.set(80, 8, c(0x222222));
    cv.set(81, 9, c(0x222222));
    window(&mut cv, 94, 7, 16, 7);
    bookshelf(&mut cv, 116, 9, 16, 22);
    for (dx, dy, on) in [(20, 35, true), (80, 35, true), (20, 77, false), (80, 77, false)] {
        desk(&mut cv, dx, dy, 45, on);
        chair(&mut cv, dx + 23, dy + 19);
    }
    plant(&mut cv, 139, 26, true);
    plant(&mut cv, 10, 100, false);
    plant(&mut cv, 138, 102, false);

    // Wisp: the lead desk under a window, a lamp, a plant and a Codeply poster.
    window(&mut cv, 176, 7, 14, 6);
    poster(&mut cv, 198, 6, 8, 7, 0x2f6bff, 0xffffff);
    desk(&mut cv, 167, 34, 45, true);
    cv.rect(206, 27, 1, 7, c(0x2a2a30));
    cv.rect(204, 25, 5, 2, c(0xf2c45a));
    plant(&mut cv, 213, 17, false);

    // Kitchen: a counter with a sink and the coffee machine, a fridge, a round table, stools.
    counter(&mut cv, 228, 15, 40, 9, 0xd9d4cc, 0x6c7b6c);
    cv.rect(236, 15, 7, 2, c(0x8c96a0));
    cv.rect(270, 11, 10, 12, c(0x2a2b30));
    cv.rect(271, 12, 8, 4, c(0x3a3c44));
    cv.rect(273, 17, 4, 2, c(0x15161a));
    cv.rect(281, 6, 12, 18, c(0xe4e7ea));
    cv.rect(281, 13, 12, 1, c(0xb5bac0));
    cv.rect(291, 8, 1, 3, c(0x9aa0a6));
    cv.rect(291, 15, 1, 4, c(0x9aa0a6));
    cv.ellipse(247.5, 47.5, 8.5, 6.0, c(0xb48655));
    cv.ellipse(247.5, 46.8, 7.5, 4.8, c(0xc99a66));
    cv.rect(247, 52, 1, 4, c(0x5c4128));
    for sx in [235.0, 260.0] {
        cv.ellipse(sx, 48.0, 3.0, 2.0, c(0x8a5a34));
        cv.rect(sx as i32, 50, 1, 3, c(0x4b311c));
    }

    // Lounge: a big window, a framed picture, a floor lamp, the rug, a coffee table, the sofa,
    // a beanbag, a bookshelf and two plants.
    window(&mut cv, 176, 73, 28, 8);
    poster(&mut cv, 232, 74, 12, 7, 0x2b3a2b, 0xf2c45a);
    bookshelf(&mut cv, 268, 74, 16, 22);
    cv.rect(261, 82, 1, 22, c(0x2a2a30));
    cv.rect(258, 79, 7, 4, c(0xf0d9a0));
    cv.ellipse(220.0, 120.0, 50.0, 20.5, c(0x7a3f3a));
    cv.ellipse(220.0, 120.0, 46.0, 17.5, c(0x9a5a48));
    cv.ellipse(220.0, 120.0, 38.0, 12.5, c(0x7a3f3a));
    cv.ellipse(220.0, 120.0, 34.0, 10.0, c(0xa86a52));
    cv.rect(210, 112, 23, 6, c(0x5c3d26));
    cv.rect(210, 112, 23, 1, c(0x7a5232));
    cv.rect(211, 118, 2, 3, c(0x3c2716));
    cv.rect(230, 118, 2, 3, c(0x3c2716));
    cv.rect(214, 113, 3, 2, c(0xe8e2d6));
    sofa(&mut cv, 162, 140, 72);
    cv.ellipse(272.5, 108.0, 9.0, 7.0, c(0x4a7a6a));
    cv.ellipse(271.0, 106.0, 6.0, 4.0, c(0x5c9180));
    plant(&mut cv, 287, 88, true);
    plant(&mut cv, 287, 166, true);

    // Needs you: an ochre waiting room. A sign with the queue count, a counter with in and out
    // trays and a bell, and a bench.
    cv.rect(58, 118, 26, 9, c(0x1a1512));
    cv.rect(59, 119, 24, 7, c(0x101318));
    cv.rect(61, 121, 1, 3, c(0xf0883e));
    cv.rect(60, 122, 3, 1, c(0xf0883e));
    digit(&mut cv, 76, 120, waiting, c(0xf0883e));
    window(&mut cv, 108, 119, 18, 6);
    poster(&mut cv, 94, 119, 9, 6, 0x3b2b1b, 0xf2c45a);
    counter(&mut cv, 15, 156, 120, 12, 0xd8c3a0, 0x7a5a3a);
    for tx in [100, 116] {
        cv.rect(tx, 154, 14, 3, c(0x3a3a42));
        cv.rect(tx + 1, 153, 12, 1, c(0xeeeeee));
    }
    cv.rect(40, 153, 5, 2, c(0xd9b45a));
    cv.set(42, 152, c(0xd9b45a));
    cv.rect(20, 136, 28, 3, c(0x7a5232));
    cv.rect(21, 139, 1, 3, c(0x4b311c));
    cv.rect(46, 139, 1, 3, c(0x4b311c));
    plant(&mut cv, 139, 146, false);
    cv
}

/// Where each lit monitor's screen is, and whether it shows code.
pub fn screens() -> [([i32; 4], bool); 3] {
    [(screen_rect(20, 35, 45), true), (screen_rect(80, 35, 45), true), (screen_rect(167, 34, 45), false)]
}

/// Where each room's label goes (inside the top-left of its wall).
pub fn label_at(r: &Room) -> (f32, f32) {
    (r.x as f32 + 3.0, r.y as f32 + 3.0)
}

// ---------- bots ----------

/// The hexagon, one span per row (16 wide, 14 tall): flat top and bottom, points at the sides.
const HEX_ROWS: [(i32, i32); 14] = [(5, 10), (3, 12), (3, 12), (2, 13), (2, 13), (1, 14), (0, 15), (0, 15), (1, 14), (2, 13), (2, 13), (3, 12), (3, 12), (5, 10)];

/// One frame of an actor: what the bot does and which frame of its loop it is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Pose {
    pub state: AgentState,
    pub frame: u32,
    /// Walking: which way it faces (eyes look that way).
    pub left: bool,
}

/// Draws an actor: the bot at its pose, with its accessory and its state's effects.
pub fn render_actor(color: &str, gear: Gear, pose: Pose) -> Canvas {
    let mut cv = Canvas::new(ACTOR_W, ACTOR_H);
    let base = rgb(color);
    let f = pose.frame;
    let (ox, mut oy) = (8, 13);
    // Lean for the waiting sway: the top half shifts a pixel left or right.
    let mut lean = 0;
    match pose.state {
        AgentState::Working => oy -= [0, 1, 2, 1, 0, 0, 0][(f % 7) as usize],
        AgentState::Walking => oy -= (f % 2) as i32,
        AgentState::Waiting => lean = [0, -1, -1, 0, 1, 1][((f / 3) % 6) as usize],
        AgentState::Sleeping => oy += 1,
        _ => {}
    }
    let edge = shade(base, 0.62);
    let light = mix(base, [255, 255, 255], 0.28);
    let dark = shade(base, 0.82);
    for (row, (a, b)) in HEX_ROWS.iter().enumerate() {
        let r = row as i32;
        let dx = if r < 7 { lean } else { 0 };
        // Breathing while asleep: the body is a row shorter on the out-breath.
        if pose.state == AgentState::Sleeping && (f / 12) % 2 == 1 && r == 0 {
            continue;
        }
        for x in *a..=*b {
            let mut p = if r <= 2 { light } else if r >= 11 { dark } else { base };
            if x == *a || x == *b || r == 0 || r == 13 {
                p = edge;
            }
            if r == 1 && (5..=7).contains(&x) {
                p = mix(base, [255, 255, 255], 0.5);
            }
            cv.set(ox + x + dx, oy + r, p);
        }
    }
    // Eyes: pill eyes, a little left of centre. They say the state.
    let white = [255, 255, 255];
    let look = match pose.state {
        AgentState::Working => [0, -1, 0, 1, 0, 0][((f / 4) % 6) as usize],
        AgentState::Walking => if pose.left { -1 } else { 1 },
        _ => 0,
    };
    let eye_x = [ox + 5 + look + lean, ox + 9 + look + lean];
    match pose.state {
        AgentState::Thinking => {
            for (i, x) in [ox + 4, ox + 7, ox + 10].iter().enumerate() {
                let up = (f + 3 - i as u32).is_multiple_of(4) as i32;
                cv.rect(*x, oy + 6 - up, 2, 2, white);
            }
        }
        AgentState::Sleeping => {
            for x in eye_x {
                cv.rect(x, oy + 7, 2, 1, mix(base, white, 0.75));
            }
        }
        AgentState::Waiting => {
            for x in eye_x {
                cv.rect(x, oy + 6, 2, 2, white);
            }
        }
        AgentState::Idle if f % 37 == 36 => {
            for x in eye_x {
                cv.rect(x, oy + 7, 2, 1, white);
            }
        }
        _ => {
            for x in eye_x {
                cv.rect(x, oy + 5, 2, 3, white);
            }
        }
    }
    gear_pixels(&mut cv, gear, ox + lean, oy);
    effects(&mut cv, pose, ox, oy);
    cv
}

fn gear_pixels(cv: &mut Canvas, gear: Gear, ox: i32, oy: i32) {
    let dark = c(0x1b2238);
    match gear {
        Gear::None => {}
        Gear::Beret => {
            let (p, hi, lo) = (c(0xff3d6e), c(0xff7aa0), c(0xb8264d));
            cv.rect(ox + 4, oy - 2, 9, 2, p);
            cv.rect(ox + 3, oy - 1, 11, 1, p);
            cv.rect(ox + 5, oy - 3, 6, 1, p);
            cv.rect(ox + 5, oy - 3, 3, 1, hi);
            cv.rect(ox + 3, oy, 11, 1, lo);
            cv.set(ox + 8, oy - 4, p);
        }
        Gear::Headphones => {
            let (p, hi) = (c(0x2a3047), c(0x4a5373));
            cv.rect(ox + 2, oy - 2, 12, 1, p);
            cv.set(ox + 1, oy - 1, p);
            cv.set(ox + 14, oy - 1, p);
            cv.rect(ox, oy, 1, 4, p);
            cv.rect(ox + 15, oy, 1, 4, p);
            cv.rect(ox - 1, oy + 4, 3, 5, p);
            cv.rect(ox + 14, oy + 4, 3, 5, p);
            cv.set(ox - 1, oy + 4, hi);
            cv.set(ox + 14, oy + 4, hi);
        }
        Gear::Glasses => {
            for x in [ox + 4, ox + 8] {
                cv.frame(x, oy + 4, 4, 5, dark);
            }
            cv.set(ox + 12, oy + 6, dark);
            cv.set(ox + 3, oy + 6, dark);
        }
        Gear::Sprout => {
            let (stem, leaf, hi) = (c(0x1fa855), c(0x22c55e), c(0x6fe39a));
            cv.rect(ox + 8, oy - 3, 1, 3, stem);
            cv.rect(ox + 5, oy - 4, 3, 1, leaf);
            cv.rect(ox + 6, oy - 3, 2, 1, leaf);
            cv.rect(ox + 9, oy - 5, 3, 1, leaf);
            cv.rect(ox + 9, oy - 4, 2, 1, leaf);
            cv.set(ox + 10, oy - 5, hi);
        }
        Gear::Antennae => {
            cv.set(ox + 5, oy - 1, dark);
            cv.set(ox + 4, oy - 2, dark);
            cv.set(ox + 10, oy - 1, dark);
            cv.set(ox + 11, oy - 2, dark);
            cv.rect(ox + 3, oy - 4, 2, 2, c(0xffcf2e));
            cv.rect(ox + 11, oy - 4, 2, 2, c(0xffcf2e));
        }
        Gear::Cap => {
            cv.rect(ox + 4, oy - 2, 8, 2, dark);
            cv.rect(ox + 3, oy, 13, 1, dark);
            cv.rect(ox + 5, oy - 3, 5, 1, dark);
            cv.set(ox + 6, oy - 3, c(0x3a4466));
        }
    }
}

fn effects(cv: &mut Canvas, pose: Pose, ox: i32, oy: i32) {
    let f = pose.frame;
    match pose.state {
        AgentState::Thinking => {
            // A steaming mug in hand.
            let (mug, rim) = (c(0xececec), c(0xc9c9c9));
            cv.rect(ox + 17, oy + 7, 4, 4, mug);
            cv.rect(ox + 17, oy + 10, 4, 1, rim);
            cv.rect(ox + 21, oy + 8, 1, 2, mug);
            cv.rect(ox + 18, oy + 7, 2, 1, c(0x6b4226));
            for k in 0..3u32 {
                let phase = (f + k * 5) % 15;
                if phase < 10 {
                    let y = oy + 5 - (phase / 2) as i32;
                    let x = ox + 17 + k as i32 + ((phase / 3) % 2) as i32;
                    cv.set(x, y, mix(c(0x1a1a1a), [220, 220, 220], 1.0 - phase as f32 / 12.0));
                }
            }
        }
        AgentState::Sleeping => {
            // Three z's drift up and to the right, one after another.
            const Z: [[u8; 3]; 3] = [[1, 1, 1], [0, 1, 0], [1, 1, 1]];
            for k in 0..3u32 {
                let phase = (f + k * 8) % 24;
                let (x, y) = (ox + 15 + (phase / 4) as i32, oy - 2 - (phase / 3) as i32);
                let ink = mix([20, 20, 20], [200, 200, 210], 1.0 - phase as f32 / 26.0);
                for (r, bits) in Z.iter().enumerate() {
                    for (cc, b) in bits.iter().enumerate() {
                        if *b == 1 {
                            cv.set(x + cc as i32, y + r as i32, ink);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

// ---------- the walk ----------

/// The prototype's walk (views.css `@keyframes walk`): from a Studio desk out to the hallway,
/// along the corridor and into the kitchen, a pause, and back. 16 s a lap. World units.
const WALK: [(f64, f32, f32); 10] = [
    (0.00, 430.0, 340.0), (0.06, 430.0, 340.0), (0.14, 590.0, 340.0), (0.20, 590.0, 270.0), (0.38, 1040.0, 270.0),
    (0.42, 1040.0, 236.0), (0.58, 1040.0, 236.0), (0.62, 1040.0, 270.0), (0.80, 590.0, 270.0), (0.86, 590.0, 340.0),
];
const LAP: f64 = 16.0;

/// Where the walker is at `t` seconds, in world units, and whether it is heading left.
pub fn walk_at(t: f64) -> ((f32, f32), bool, bool) {
    let u = (t / LAP).rem_euclid(1.0);
    let mut pts: Vec<(f64, f32, f32)> = WALK.to_vec();
    pts.push((0.94, 430.0, 340.0));
    pts.push((1.00, 430.0, 340.0));
    for w in pts.windows(2) {
        let ((t0, x0, y0), (t1, x1, y1)) = (w[0], w[1]);
        if u >= t0 && u <= t1 {
            let k = if t1 > t0 { ((u - t0) / (t1 - t0)) as f32 } else { 0.0 };
            let moving = (x0, y0) != (x1, y1);
            return ((x0 + (x1 - x0) * k, y0 + (y1 - y0) * k), x1 < x0, moving);
        }
    }
    ((430.0, 340.0), false, false)
}

// ---------- the live part, kept in app state ----------

pub struct Actor {
    pub pixels: Pixels,
    /// Device-pixel offset from the actor's resting place (walking).
    pub offset: Live<[f32; 2]>,
    last: Cell<Option<(Pose, u32)>>,
}

pub struct OfficeArt {
    pub scene: Pixels,
    /// (device pixels per art pixel, waiting count) the scene was last drawn for.
    scene_made: Cell<(u32, u32)>,
    pub actors: RefCell<Vec<(String, Actor)>>,
    /// Device pixels per art pixel, as the view last laid the office out.
    pub px: Cell<u32>,
    /// Device pixels per point.
    pub scale: Cell<f32>,
    pub reduced: Cell<bool>,
    /// The "Needs your OK" bubble's nudge, in points.
    pub nudge: Live<[f32; 2]>,
    /// The roaming pointer in a drawer's live view, in points from its resting place.
    pub cursor: Live<[f32; 2]>,
}

/// The drawer's live view, in points (the drawer is 420 wide with 16 pt of padding each side).
pub const LIVE_VIEW: (f32, f32) = (386.0, 150.0);

/// The live view's pointer path (views.css `@keyframes roam`), as fractions of the view, 5 s a lap.
const ROAM: [(f64, f32, f32); 5] = [(0.0, 0.6, 0.4), (0.25, 0.3, 0.6), (0.5, 0.7, 0.7), (0.75, 0.45, 0.3), (1.0, 0.6, 0.4)];

/// Where the pointer is at `t`, as fractions of the view, eased in and out between stops.
pub fn roam_at(t: f64) -> (f32, f32) {
    let u = (t / 5.0).rem_euclid(1.0);
    for w in ROAM.windows(2) {
        let ((t0, x0, y0), (t1, x1, y1)) = (w[0], w[1]);
        if u <= t1 {
            let k = ((u - t0) / (t1 - t0)) as f32;
            let k = k * k * (3.0 - 2.0 * k);
            return (x0 + (x1 - x0) * k, y0 + (y1 - y0) * k);
        }
    }
    (0.6, 0.4)
}

impl Default for OfficeArt {
    fn default() -> Self {
        OfficeArt {
            scene: Pixels::new(),
            scene_made: Cell::new((0, 0)),
            actors: RefCell::new(Vec::new()),
            px: Cell::new(3),
            scale: Cell::new(1.0),
            reduced: Cell::new(false),
            nudge: Live::new([0.0, 0.0]),
            cursor: Live::new([0.0, 0.0]),
        }
    }
}

impl OfficeArt {
    /// Draws the scene at `k` device pixels per art pixel, if it isn't already.
    pub fn ensure_scene(&self, k: u32, waiting: u32) {
        if self.scene_made.get() != (k, waiting) {
            self.scene_made.set((k, waiting));
            let cv = render_scene(waiting);
            self.scene.set(W * k, H * k, upscale(&cv.px, W, H, k));
        }
    }

    /// The actor for agent `id`, made on first use.
    pub fn actor<R>(&self, id: &str, f: impl FnOnce(&Actor) -> R) -> R {
        let mut actors = self.actors.borrow_mut();
        if !actors.iter().any(|(k, _)| k == id) {
            actors.push((id.to_owned(), Actor { pixels: Pixels::new(), offset: Live::new([0.0, 0.0]), last: Cell::new(None) }));
        }
        let (_, a) = actors.iter().find(|(k, _)| k == id).unwrap_or_else(|| unreachable!());
        f(a)
    }

    /// Advances every actor to `now` and asks for the next step. Pixels and live offsets wake
    /// the window themselves, so this never rebuilds the view.
    pub fn step(&self, snap: &Snapshot, now: f64, tx: &mut Tx) {
        let reduced = self.reduced.get();
        let frame = if reduced { 0 } else { (now * FPS) as u32 };
        let k = self.px.get();
        let pt = k as f32 / self.scale.get().max(1.0);
        for a in &snap.team {
            let (pose, offset) = if a.state == AgentState::Walking {
                let t = if reduced { 0.0 } else { now };
                let ((x, y), left, moving) = walk_at(t);
                // Snap to whole art pixels so the walker moves on the art's grid.
                let dx = ((x - a.pos.0) / UNIT).round() * pt;
                let dy = ((y - a.pos.1) / UNIT).round() * pt;
                let state = if moving { AgentState::Walking } else { AgentState::Idle };
                (Pose { state, frame, left }, [dx, dy])
            } else {
                (Pose { state: a.state, frame, left: false }, [0.0, 0.0])
            };
            self.actor(&a.id, |actor| {
                if actor.last.get() != Some((pose, k)) {
                    actor.last.set(Some((pose, k)));
                    let cv = render_actor(&a.color, a.gear, pose);
                    actor.pixels.set(ACTOR_W * k, ACTOR_H * k, upscale(&cv.px, ACTOR_W, ACTOR_H, k));
                }
                actor.offset.set(offset);
            });
        }
        if !reduced {
            // The bubble rises 3 pt and settles, every 2 s (views.css `nudge`).
            let up = 0.5 - 0.5 * (now * std::f64::consts::TAU / 2.0).cos();
            self.nudge.set([0.0, (-3.0 * up) as f32]);
            let (x, y) = roam_at(now);
            self.cursor.set([x * LIVE_VIEW.0, y * LIVE_VIEW.1]);
            tx.wake_after(std::time::Duration::from_secs_f64(1.0 / FPS));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rooms_match_the_prototype() {
        // views.js: Studio at (20, 20) 560 x 420, Lounge at (600, 280) 580 x 420.
        assert_eq!((ROOMS[0].x as f32 * UNIT, ROOMS[0].w as f32 * UNIT), (20.0, 560.0));
        assert_eq!((ROOMS[3].y as f32 * UNIT, ROOMS[3].h as f32 * UNIT), (280.0, 420.0));
    }

    #[test]
    fn the_scene_is_opaque_and_full_size() {
        let cv = render_scene(1);
        assert_eq!(cv.px.len() as u32, W * H * 4);
        assert!(cv.px.chunks(4).all(|p| p[3] == 255));
    }

    #[test]
    fn the_walker_goes_to_the_kitchen_and_back() {
        assert_eq!(walk_at(0.0).0, (430.0, 340.0));
        assert_eq!(walk_at(LAP * 0.5).0, (1040.0, 236.0));
        assert!(!walk_at(LAP * 0.5).2, "it pauses in the kitchen");
        assert!(walk_at(LAP * 0.3).2);
        assert_eq!(walk_at(LAP * 0.97).0, (430.0, 340.0));
    }

    #[test]
    fn a_working_bot_hops_and_a_sleeping_one_breathes() {
        let pose = |state, frame| Pose { state, frame, left: false };
        let a = render_actor("#ff5c9d", Gear::Beret, pose(AgentState::Working, 0)).px;
        let b = render_actor("#ff5c9d", Gear::Beret, pose(AgentState::Working, 2)).px;
        assert_ne!(a, b);
        let z0 = render_actor("#7b5cff", Gear::Sprout, pose(AgentState::Sleeping, 0)).px;
        let z1 = render_actor("#7b5cff", Gear::Sprout, pose(AgentState::Sleeping, 5)).px;
        assert_ne!(z0, z1, "the z's drift");
    }

    #[test]
    fn digits_draw() {
        let mut cv = Canvas::new(3, 5);
        digit(&mut cv, 0, 0, 1, [255, 255, 255]);
        assert!(cv.get(1, 0).is_some() && cv.get(1, 4).is_some());
    }
}
