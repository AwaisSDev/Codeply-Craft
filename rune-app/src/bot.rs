//! Wisp and its helpers at interface sizes: a port of `wisp()` and its accessories from
//! design/icons/codeply-icons.js. A flat-topped rounded hexagon in the agent's colour (one smooth
//! gradient, a soft sheen, a thin light top edge and a faint deeper bottom edge), white pill eyes,
//! and one accessory. Rune draws an icon body that names its own colours as full SVG, so each
//! (colour, accessory, eyes) gets one `Icon`, made once and kept for the life of the app.
//!
//! The Office draws its own pixel versions of the same bots (`views::office_art`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write as _;

use rune::{Beat, El, Icon, LoopSpec, Sequence, el, icon};

use crate::model::{Agent, AgentState, Gear};

/// What the eyes do; the state is shown by them and by motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Eyes {
    Open,
    /// Waiting: narrowed.
    Half,
    /// Sleeping: shut.
    Closed,
    /// Thinking: three dots where the eyes were.
    Dots,
}

impl Eyes {
    pub fn for_state(state: AgentState) -> Eyes {
        match state {
            AgentState::Thinking => Eyes::Dots,
            AgentState::Waiting => Eyes::Half,
            AgentState::Sleeping => Eyes::Closed,
            _ => Eyes::Open,
        }
    }
}

// ---------- colour (hexToHsl, hsl and ramp in codeply-icons.js) ----------

pub fn rgb(hex: &str) -> [u8; 3] {
    let n = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0x2f6bff);
    [(n >> 16) as u8, (n >> 8) as u8, n as u8]
}

fn hex_to_hsl(hex: &str) -> [f64; 3] {
    let [r, g, b] = rgb(hex).map(|v| f64::from(v) / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.0;
    if max == min {
        return [0.0, 0.0, l];
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r { (g - b) / d + if g < b { 6.0 } else { 0.0 } } else if max == g { (b - r) / d + 2.0 } else { (r - g) / d + 4.0 };
    [h / 6.0, s, l]
}

fn hsl(h: f64, s: f64, l: f64) -> String {
    let h = h.rem_euclid(1.0);
    let (s, l) = (s.clamp(0.0, 1.0), l.clamp(0.0, 1.0));
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let f = |t: f64| {
        let t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 { p + (q - p) * 6.0 * t } else if t < 0.5 { q } else if t < 2.0 / 3.0 { p + (q - p) * (2.0 / 3.0 - t) * 6.0 } else { p }
    };
    let x = |v: f64| (v * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", x(f(h + 1.0 / 3.0)), x(f(h)), x(f(h - 1.0 / 3.0)))
}

struct Ramp {
    top: String,
    mid: String,
    bottom: String,
    edge: String,
}

#[derive(Clone, Copy)]
struct PartOpts {
    lift: f64,
    drop: f64,
    sheen: f64,
    glass: f64,
    base: f64,
}

const PART: PartOpts = PartOpts { lift: 0.28, drop: 0.82, sheen: 0.32, glass: 0.85, base: 0.35 };

fn ramp(hex: &str, o: PartOpts) -> Ramp {
    let [h, s, l] = hex_to_hsl(hex);
    let warm = !(0.2..=0.85).contains(&h);
    let toward = |t: f64, k: f64| {
        let mut d = t - h;
        if d > 0.5 { d -= 1.0 }
        if d < -0.5 { d += 1.0 }
        h + d * k
    };
    Ramp {
        top: hsl(toward(if warm { 0.14 } else { 0.52 }, 0.08), (s * 1.02).min(1.0), l + (1.0 - l) * o.lift),
        mid: hex.to_owned(),
        bottom: hsl(toward(if warm { 0.98 } else { 0.66 }, 0.06), (s * 1.05 + 0.04).min(1.0), l * o.drop),
        edge: hsl(toward(if warm { 0.98 } else { 0.66 }, 0.08), (s * 1.1).min(1.0), l * 0.62),
    }
}

// ---------- shapes ----------

fn rr(x: f64, y: f64, w: f64, h: f64, r: f64) -> String {
    format!(
        "M{} {}H{}A{r} {r} 0 0 1 {} {}V{}A{r} {r} 0 0 1 {} {}H{}A{r} {r} 0 0 1 {x} {}V{}A{r} {r} 0 0 1 {} {y}Z",
        x + r, y, x + w - r, x + w, y + r, y + h - r, x + w - r, y + h, x + r, y + h - r, y + r, x + r
    )
}

fn circle(cx: f64, cy: f64, r: f64) -> String {
    format!("M{} {cy}A{r} {r} 0 1 0 {} {cy}A{r} {r} 0 1 0 {} {cy}Z", cx - r, cx + r, cx - r)
}

fn rounded_polygon(pts: &[[f64; 2]], r: f64) -> String {
    let n = pts.len();
    let mut d = String::new();
    for i in 0..n {
        let ([x0, y0], [x1, y1], [x2, y2]) = (pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]);
        let (a, b) = ((x0 - x1).hypot(y0 - y1), (x2 - x1).hypot(y2 - y1));
        let s1 = [x1 + (x0 - x1) / a * r, y1 + (y0 - y1) / a * r];
        let s2 = [x1 + (x2 - x1) / b * r, y1 + (y2 - y1) / b * r];
        let _ = write!(d, "{}{:.2} {:.2}Q{x1:.2} {y1:.2} {:.2} {:.2}", if i == 0 { 'M' } else { 'L' }, s1[0], s1[1], s2[0], s2[1]);
    }
    d + "Z"
}

/// The hexagon's corners in the 100 x 100 box; the pixel bots use the same outline.
pub const HEX: [[f64; 2]; 6] = [[30.0, 15.0], [70.0, 15.0], [91.0, 53.0], [70.0, 91.0], [30.0, 91.0], [9.0, 53.0]];

struct Svg {
    body: String,
    uid: u32,
}

impl Svg {
    /// One filled shape: gradient body, soft sheen, thin light top edge, faint deep bottom edge.
    fn part(&mut self, d: &str, color: &str, o: PartOpts) {
        self.uid += 1;
        let id = format!("p{}", self.uid);
        let c = ramp(color, o);
        let _ = write!(
            self.body,
            r##"<defs><linearGradient id="{id}f" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="{}"/><stop offset="0.5" stop-color="{}"/><stop offset="1" stop-color="{}"/></linearGradient><radialGradient id="{id}s" cx="0.3" cy="0.12" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="{}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><linearGradient id="{id}e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="{}"/><stop offset="0.42" stop-color="#fff" stop-opacity="0"/></linearGradient><linearGradient id="{id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="{}" stop-opacity="0"/><stop offset="1" stop-color="{}" stop-opacity="{}"/></linearGradient><clipPath id="{id}c"><path d="{d}"/></clipPath></defs><path d="{d}" fill="url(#{id}f)"/><path d="{d}" fill="url(#{id}s)"/><path d="{d}" fill="none" stroke="url(#{id}b)" stroke-width="4" clip-path="url(#{id}c)"/><path d="{d}" fill="none" stroke="url(#{id}e)" stroke-width="3" clip-path="url(#{id}c)"/>"##,
            c.top, c.mid, c.bottom, o.sheen, o.glass, c.edge, c.edge, o.base
        );
    }
    fn flat(&mut self, d: &str, fill: &str) {
        let _ = write!(self.body, r#"<path d="{d}" fill="{fill}"/>"#);
    }
    fn line(&mut self, d: &str, stroke: &str, w: f64) {
        let _ = write!(self.body, r#"<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>"#);
    }
}

fn gear(svg: &mut Svg, kind: Gear) {
    let dark = "#1b2238";
    let soft = |glass| PartOpts { glass, ..PART };
    match kind {
        Gear::None => {}
        Gear::Beret => {
            svg.part("M28 18C30 6 70 4 74 16C66 22 36 24 28 18Z", "#ff3d6e", soft(0.5));
            svg.flat(&circle(52.0, 7.0, 3.4), "#ff3d6e");
        }
        Gear::Headphones => {
            svg.line("M16 40C16 10 84 10 84 40", "#2a3047", 5.0);
            svg.part(&rr(8.0, 36.0, 14.0, 24.0, 7.0), "#2a3047", soft(0.4));
            svg.part(&rr(78.0, 36.0, 14.0, 24.0, 7.0), "#2a3047", soft(0.4));
        }
        Gear::Glasses => svg.line("M30 50A8 8 0 1 0 46 50A8 8 0 1 0 30 50M54 50A8 8 0 1 0 70 50A8 8 0 1 0 54 50M46 50H54", dark, 3.0),
        Gear::Sprout => {
            svg.line("M50 16V4", "#1fa855", 3.6);
            svg.part("M50 8C42 2 32 4 30 10C38 14 46 12 50 8Z", "#22c55e", soft(0.4));
            svg.part("M50 6C56 -1 68 0 70 6C62 11 54 10 50 6Z", "#22c55e", soft(0.4));
        }
        Gear::Antennae => {
            svg.line("M38 16L32 3M62 16L68 3", dark, 3.0);
            svg.flat(&circle(31.0, 3.0, 4.0), "#ffcf2e");
            svg.flat(&circle(69.0, 3.0, 4.0), "#ffcf2e");
        }
        Gear::Cap => {
            svg.part("M26 20C28 4 72 4 74 20Z", "#1b2238", soft(0.5));
            svg.part(&rr(56.0, 15.0, 30.0, 7.0, 3.5), "#1b2238", soft(0.3));
        }
    }
}

/// The SVG body of one bot in a 100 x 100 box.
pub fn svg_body(color: &str, kind: Gear, eyes: Eyes) -> String {
    let mut svg = Svg { body: String::new(), uid: 0 };
    svg.part(&rounded_polygon(&HEX, 10.0), color, PartOpts { lift: 0.14, drop: 0.92, sheen: 0.16, ..PART });
    match eyes {
        Eyes::Open => {
            svg.flat(&rr(34.5, 43.0, 7.0, 14.0, 3.5), "#fff");
            svg.flat(&rr(52.5, 43.0, 7.0, 14.0, 3.5), "#fff");
        }
        Eyes::Half => {
            svg.flat(&rr(34.5, 46.85, 7.0, 6.3, 3.15), "#fff");
            svg.flat(&rr(52.5, 46.85, 7.0, 6.3, 3.15), "#fff");
        }
        Eyes::Closed => {
            svg.flat(&rr(34.5, 49.0, 7.0, 2.0, 1.0), "#fff");
            svg.flat(&rr(52.5, 49.0, 7.0, 2.0, 1.0), "#fff");
        }
        Eyes::Dots => {
            for cx in [38.0, 50.0, 62.0] {
                svg.flat(&circle(cx, 52.0, 5.6), "#fff");
            }
        }
    }
    gear(&mut svg, kind);
    svg.body
}

thread_local! {
    static MADE: RefCell<HashMap<(String, Gear, Eyes), &'static Icon>> = RefCell::new(HashMap::new());
}

/// The one `Icon` for this look. At most (agents x 4) are ever made, so leaking them is bounded.
pub fn icon_for(color: &str, kind: Gear, eyes: Eyes) -> &'static Icon {
    MADE.with_borrow_mut(|made| {
        *made.entry((color.to_owned(), kind, eyes)).or_insert_with(|| {
            let body: &'static str = Box::leak(svg_body(color, kind, eyes).into_boxed_str());
            Box::leak(Box::new(Icon { name: "wisp", view: 100.0, body }))
        })
    })
}

/// Plain Wisp, Codeply blue.
pub fn wisp(size: f32) -> El {
    icon(icon_for("#2f6bff", Gear::None, Eyes::Open), size)
}

/// The working hop at list sizes: a small stretch up from the bot's base and back, 0.9 s a beat.
/// (Rune's loops animate opacity and scale by keyframes; a there-and-back offset loop isn't one
/// of them, so the hop is a stretch. The Office moves its pixel bots by whole pixels instead.)
static HOP: [Beat; 3] = [Beat::new(0.0), Beat::new(0.45).scale(1.06), Beat::new(0.9)];

/// A helper at `size`, showing its state by its eyes and, while working, a small hop.
pub fn agent(a: &Agent, size: f32) -> El {
    let body = icon(icon_for(&a.color, a.gear, Eyes::for_state(a.state)), size);
    match a.state {
        AgentState::Working => el().size(size, size).child(body.origin(0.5, 1.0).looping(LoopSpec::sequence(Sequence::new(&HOP)))),
        _ => el().size(size, size).child(body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_round_trip_through_hsl() {
        let [h, s, l] = hex_to_hsl("#2f6bff");
        assert_eq!(hsl(h, s, l), "#2f6bff");
    }

    #[test]
    fn a_body_is_wellformed_svg() {
        for g in [Gear::None, Gear::Beret, Gear::Headphones, Gear::Glasses, Gear::Sprout, Gear::Antennae, Gear::Cap] {
            let b = svg_body("#ff5c9d", g, Eyes::Open);
            assert_eq!(b.matches("<path").count(), b.matches("/>").count() - b.matches("<stop").count(), "{g:?}");
        }
    }

    #[test]
    fn each_look_is_made_once() {
        let a = icon_for("#7b5cff", Gear::Sprout, Eyes::Closed) as *const Icon;
        let b = icon_for("#7b5cff", Gear::Sprout, Eyes::Closed) as *const Icon;
        assert_eq!(a, b);
    }
}
