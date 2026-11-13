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

use crate::model::{Agent, AgentState, Face, Gear, Look, Shape};

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

/// Where a silhouette's top edge and its face's centre sit in the 100 x 100 box. Accessories are
/// drawn for the hexagon and moved by the difference.
fn frame(shape: Shape) -> (f64, f64) {
    match shape {
        Shape::Hex => (15.0, 53.0),
        Shape::Round => (19.0, 56.0),
        Shape::Square => (20.0, 56.0),
    }
}

fn body_path(shape: Shape) -> String {
    match shape {
        Shape::Hex => rounded_polygon(&HEX, 10.0),
        // A soft blob: a circle, a touch wider than tall, sitting on its base.
        Shape::Round => "M50 19C73 19 89 33 89 54C89 76 72 91 50 91C28 91 11 76 11 54C11 33 27 19 50 19Z".to_owned(),
        // A squircle: straight-ish sides that round off generously.
        Shape::Square => "M50 20C76 20 86 24 87 44C88 52 88 60 87 68C86 87 76 91 50 91C24 91 14 87 13 68C12 60 12 52 13 44C14 24 24 20 50 20Z".to_owned(),
    }
}

impl Svg {
    fn open(&mut self, dy: f64) {
        let _ = write!(self.body, r#"<g transform="translate(0 {dy})">"#);
    }
    fn close(&mut self) {
        self.body.push_str("</g>");
    }
    fn next_id(&mut self) -> String {
        self.uid += 1;
        format!("g{}", self.uid)
    }
    /// Glossy black "ink", the dark accessories' material: a soft shadow on the body under it, a
    /// body that darkens toward the bottom, and (from the caller) a sheen line.
    fn ink(&mut self, d: &str) {
        let id = self.next_id();
        let _ = write!(
            self.body,
            r##"<defs><linearGradient id="{id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#45454b"/><stop offset="0.45" stop-color="#1c1c20"/><stop offset="1" stop-color="#08080a"/></linearGradient></defs><path d="{d}" fill="#000" fill-opacity="0.18" transform="translate(0.6 2)"/><path d="{d}" fill="url(#{id})"/>"##
        );
    }
    /// A filled shape with a top-lit gradient between two colours.
    fn lit(&mut self, d: &str, top: &str, bottom: &str) {
        let id = self.next_id();
        let _ = write!(
            self.body,
            r##"<defs><linearGradient id="{id}" x1="0.2" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient></defs><path d="{d}" fill="#000" fill-opacity="0.14" transform="translate(0.5 1.6)"/><path d="{d}" fill="url(#{id})"/>"##
        );
    }
    fn sheen(&mut self, d: &str, w: f64, opacity: f64) {
        let _ = write!(self.body, r##"<path d="{d}" fill="none" stroke="#ffffff" stroke-opacity="{opacity}" stroke-width="{w}" stroke-linecap="round"/>"##);
    }
}

/// The eyes, centred on the face line `fy`. `on_light` is false for Wisp's white pill eyes.
fn eyes(svg: &mut Svg, face: Face, eyes: Eyes, fy: f64, body: &str) {
    let ink = if face == Face::Pill { "#ffffff" } else { "#141416" };
    let closed = |svg: &mut Svg, cx: f64| svg.line(&format!("M{} {}Q{cx} {} {} {}", cx - 5.0, fy - 1.0, fy + 4.6, cx + 5.0, fy - 1.0), ink, 3.2);
    let xs = if face == Face::Googly { [39.0, 61.0] } else { [41.0, 59.0] };
    match (eyes, face) {
        (Eyes::Dots, _) => {
            for cx in [38.0, 50.0, 62.0] {
                svg.flat(&circle(cx, fy, 4.4), ink);
            }
        }
        (Eyes::Closed, _) | (_, Face::Content) => {
            for cx in xs {
                closed(svg, cx);
            }
        }
        (half, Face::Pill) => {
            let h = if half == Eyes::Half { 6.3 } else { 14.0 };
            for cx in xs {
                svg.flat(&rr(cx - 3.5, fy - 10.0 + (14.0 - h), 7.0, h, h.min(7.0) / 2.0), "#fff");
            }
        }
        (half, Face::Glossy) => {
            let id = svg.next_id();
            let _ = write!(svg.body, r##"<defs><radialGradient id="{id}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#4a4a52"/><stop offset="0.55" stop-color="#121214"/><stop offset="1" stop-color="#000"/></radialGradient></defs>"##);
            let (top, h) = if half == Eyes::Half { (fy - 1.5, 8.0) } else { (fy - 6.5, 13.0) };
            for cx in xs {
                let _ = write!(svg.body, r##"<path d="{}" fill="url(#{id})"/>"##, rr(cx - 4.5, top, 9.0, h, 4.0));
                let _ = write!(svg.body, r##"<ellipse cx="{}" cy="{}" rx="1.7" ry="2.3" fill="#fff" fill-opacity="0.95"/><circle cx="{}" cy="{}" r="0.9" fill="#fff" fill-opacity="0.5"/>"##, cx - 1.5, top + 3.2, cx + 1.8, top + h - 2.6);
            }
        }
        (half, Face::Googly) => {
            let (ball, pupil) = (svg.next_id(), svg.next_id());
            let _ = write!(svg.body, r##"<defs><radialGradient id="{ball}" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#f1f3f7"/><stop offset="1" stop-color="#c9cfda"/></radialGradient><radialGradient id="{pupil}" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#3a3a42"/><stop offset="1" stop-color="#050506"/></radialGradient></defs>"##);
            for cx in xs {
                let _ = write!(svg.body, r##"<circle cx="{}" cy="{}" r="9.6" fill="#000" fill-opacity="0.15"/><circle cx="{cx}" cy="{fy}" r="9.2" fill="url(#{ball})"/><circle cx="{}" cy="{}" r="5.2" fill="url(#{pupil})"/><circle cx="{}" cy="{}" r="1.8" fill="#fff"/>"##, cx + 0.4, fy + 1.0, cx + 0.8, fy + 1.4, cx - 0.8, fy - 0.6);
                if half == Eyes::Half {
                    // A heavy lid: the body's colour over the eye's top half.
                    let _ = write!(svg.body, r##"<path d="M{} {}A9.6 9.6 0 0 1 {} {}Z" fill="{body}"/><path d="M{} {}H{}" stroke="#000" stroke-opacity="0.25" stroke-width="1.2" stroke-linecap="round"/>"##, cx - 9.6, fy + 0.5, cx + 9.6, fy + 0.5, cx - 9.0, fy + 0.5, cx + 9.0);
                }
            }
        }
    }
}

/// An accessory, drawn for the hexagon (top at 15, face at 53); `top` and `face` move it to the
/// silhouette it's on.
fn gear(svg: &mut Svg, kind: Gear, top: f64, face: f64) {
    let head = top - 15.0;
    let at_face = face - 53.0;
    match kind {
        Gear::Beret => {
            svg.open(head);
            // The stalk, then the felt disc tipped over to one side, a darker band and a sheen.
            svg.ink(&rr(57.0, -1.0, 6.0, 9.0, 3.0));
            svg.ink("M17 25C13 13 39 3 63 6C84 9 92 19 84 27C72 36 29 37 17 25Z");
            svg.line("M20 26C33 33 69 33 82 27", "#000000", 2.2);
            svg.sheen("M30 14C41 8 57 7 70 11", 2.2, 0.38);
            svg.close();
        }
        Gear::Bow => {
            svg.open(at_face);
            // Two full, rounded lobes pinched into a knot, glossy black, at the chin.
            svg.ink("M50 81C44 74 33 70 27 73C22 76 22 88 27 91C33 94 44 90 50 85Z");
            svg.ink("M50 81C56 74 67 70 73 73C78 76 78 88 73 91C67 94 56 90 50 85Z");
            svg.ink(&rr(45.5, 78.0, 9.0, 10.0, 4.0));
            svg.sheen("M29 76.5C33 74.5 38 74.5 42 76.5", 1.6, 0.45);
            svg.sheen("M58 76.5C62 74.5 67 74.5 71 76.5", 1.6, 0.45);
            svg.sheen("M48 80.5H51.5", 1.4, 0.5);
            svg.close();
        }
        Gear::Headphones => {
            svg.open(head);
            svg.line("M15 50C15 12 85 12 85 50", "#000000", 7.6);
            svg.line("M15 50C15 12 85 12 85 50", "#1c1c20", 6.0);
            svg.sheen("M23 29C32 18 47 15 58 16", 1.8, 0.4);
            for x in [6.0, 79.0] {
                svg.ink(&rr(x, 41.0, 15.0, 25.0, 7.5));
                svg.sheen(&format!("M{} 46V60", x + 4.0), 1.8, 0.4);
            }
            svg.close();
        }
        Gear::Glasses => {
            svg.open(at_face);
            for cx in [38.0, 62.0] {
                let _ = write!(svg.body, r##"<circle cx="{}" cy="54.6" r="11" fill="none" stroke="#000" stroke-opacity="0.16" stroke-width="3.4"/><circle cx="{cx}" cy="53" r="11" fill="#ffffff" fill-opacity="0.08" stroke="#141416" stroke-width="3.2"/>"##, cx + 0.5);
                svg.sheen(&format!("M{} 47A7.5 7.5 0 0 1 {} 45.2", cx - 6.0, cx - 1.0), 1.5, 0.55);
            }
            svg.line("M48.5 51Q50 48 51.5 51", "#141416", 3.0);
            svg.line("M27 51.5L19 49.5M73 51.5L81 49.5", "#141416", 3.0);
            svg.close();
        }
        Gear::Shades => {
            svg.open(at_face);
            for cx in [38.0, 62.0] {
                svg.ink(&circle(cx, 53.0, 10.0));
                svg.sheen(&format!("M{} 48.5A6.5 6.5 0 0 1 {} 46.5", cx - 5.5, cx - 0.5), 1.8, 0.5);
            }
            svg.line("M47.5 50.5Q50 48 52.5 50.5", "#141416", 3.0);
            svg.close();
        }
        Gear::Sprout => {
            svg.open(head);
            svg.line("M50 18C50 13 50 10 51 6", "#1f9d4f", 3.6);
            svg.lit("M50 10C44 2 33 1 29 7C34 14 45 15 50 10Z", "#5fe08f", "#1f9d4f");
            svg.lit("M51 8C56 -1 68 -2 72 4C67 11 57 13 51 8Z", "#5fe08f", "#1f9d4f");
            svg.sheen("M34 6.5C38 5 43 5.5 46 8", 1.3, 0.5);
            svg.close();
        }
        Gear::Flower => {
            svg.open(head);
            let (cx, cy) = (30.0, 22.0);
            for k in 0..5 {
                let a = std::f64::consts::TAU * f64::from(k) / 5.0 - std::f64::consts::FRAC_PI_2;
                svg.lit(&circle(cx + a.cos() * 6.2, cy + a.sin() * 6.2, 5.2), "#ffffff", "#e3e6ee");
            }
            svg.lit(&circle(cx, cy, 3.8), "#ffd65a", "#f2a516");
            svg.close();
        }
        Gear::Star => {
            svg.open(head);
            let pts: Vec<[f64; 2]> = (0..10)
                .map(|k| {
                    let a = std::f64::consts::TAU * f64::from(k) / 10.0 - std::f64::consts::FRAC_PI_2;
                    let r = if k % 2 == 0 { 11.5 } else { 5.4 };
                    [31.0 + a.cos() * r, 22.0 + a.sin() * r]
                })
                .collect();
            svg.lit(&rounded_polygon(&pts, 1.8), "#ffe066", "#f5a623");
            svg.sheen("M28 17.5L30.5 14", 1.4, 0.6);
            svg.close();
        }
        Gear::Cap => {
            svg.open(head);
            svg.lit("M58 21C70 18 87 20 93 26C86 30 70 29 58 26Z", "#3d6ff0", "#1f45b8");
            svg.lit("M23 26C22 6 78 5 77 26Z", "#4a7dff", "#2147c0");
            svg.line("M50 7.5V25", "#1a3a9e", 1.4);
            svg.lit(&circle(50.0, 7.5, 3.0), "#4a7dff", "#2147c0");
            svg.sheen("M32 14C38 9 46 8 52 8.5", 1.8, 0.4);
            svg.close();
        }
        Gear::Antennae => {
            svg.open(head);
            svg.line("M38 17C36 11 33 7 30 4M62 17C64 11 67 7 70 4", "#141416", 2.8);
            for x in [29.0, 71.0] {
                svg.lit(&circle(x, 3.0, 4.8), "#ffe066", "#f5a623");
                svg.sheen(&format!("M{} 1.2L{} 0.4", x - 2.0, x - 0.6), 1.2, 0.7);
            }
            svg.close();
        }
    }
}

/// The SVG body of one bot in a 100 x 100 box: its silhouette, eyes and accessories.
pub fn svg_body(color: &str, look: &Look, state_eyes: Eyes) -> String {
    let mut svg = Svg { body: String::new(), uid: 0 };
    let (top, face) = frame(look.shape);
    svg.part(&body_path(look.shape), color, PartOpts { lift: 0.14, drop: 0.92, sheen: 0.16, ..PART });
    // Glasses and shades go over the eyes; everything else is drawn after them anyway.
    eyes(&mut svg, look.face, state_eyes, face, &ramp(color, PART).mid);
    for g in &look.gear {
        gear(&mut svg, *g, top, face);
    }
    svg.body
}

thread_local! {
    static MADE: RefCell<HashMap<(String, Look, Eyes), &'static Icon>> = RefCell::new(HashMap::new());
}

/// The one `Icon` for this look. At most (agents x 4 states) are ever made, so leaking is bounded.
pub fn icon_for(color: &str, look: &Look, eyes: Eyes) -> &'static Icon {
    MADE.with_borrow_mut(|made| {
        *made.entry((color.to_owned(), look.clone(), eyes)).or_insert_with(|| {
            let body: &'static str = Box::leak(svg_body(color, look, eyes).into_boxed_str());
            Box::leak(Box::new(Icon { name: "wisp", view: 100.0, body }))
        })
    })
}

/// Plain Wisp, Codeply blue.
pub fn wisp(size: f32) -> El {
    icon(icon_for("#2f6bff", &Look::new(Shape::Hex, Face::Pill, &[]), Eyes::Open), size)
}

/// The working hop at list sizes: a small stretch up from the bot's base and back, 0.9 s a beat.
/// (Rune's loops animate opacity and scale by keyframes; a there-and-back offset loop isn't one
/// of them, so the hop is a stretch. The Office moves its pixel bots by whole pixels instead.)
static HOP: [Beat; 3] = [Beat::new(0.0), Beat::new(0.45).scale(1.06), Beat::new(0.9)];

/// A helper at `size`, showing its state by its eyes and, while working, a small hop.
pub fn agent(a: &Agent, size: f32) -> El {
    let body = icon(icon_for(&a.color, &a.look, Eyes::for_state(a.state)), size);
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
        for g in [Gear::Beret, Gear::Bow, Gear::Headphones, Gear::Glasses, Gear::Shades, Gear::Sprout, Gear::Flower, Gear::Star, Gear::Cap, Gear::Antennae] {
            let b = svg_body("#ff5c9d", &Look::new(Shape::Round, Face::Googly, &[g]), Eyes::Open);
            assert_eq!(b.matches("<g ").count(), b.matches("</g>").count(), "{g:?}");
            assert!(!b.contains("NaN") && !b.contains("inf"), "{g:?}: {b}");
        }
    }

    #[test]
    fn each_look_is_made_once() {
        let look = Look::new(Shape::Round, Face::Googly, &[Gear::Sprout]);
        let a = icon_for("#7b5cff", &look, Eyes::Closed) as *const Icon;
        let b = icon_for("#7b5cff", &look.clone(), Eyes::Closed) as *const Icon;
        assert_eq!(a, b);
    }
}
