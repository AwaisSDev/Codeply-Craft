//! Yune's motion pieces, drawn natively after libraries.dev's (MIT): the thinking orb (a dotted
//! globe turning, with particles on orbits), the voice ring (a spectrum ribbon running round the
//! mic), the border beam (light riding a box's edges while it works) and the send wave (colour
//! rising out of the composer when a message goes). All of them run on Rune's own loops, so
//! nothing rebuilds while they move, and each holds still under reduced motion.

use rune::{Color, El, Shape, canvas, el};

use crate::theme::hex;

/// Yune's palette, the orb's: blue, sky, teal, mint.
fn palette() -> [Color; 4] {
    [hex("#1556d6"), hex("#1fa2e0"), hex("#3fd6b0"), hex("#d6fbe9")]
}

/// A colour along the palette, `t` from 0 to 1 and round again.
fn along(t: f32) -> Color {
    let p = palette();
    let t = t.rem_euclid(1.0) * 4.0;
    let i = t.floor() as usize % 4;
    let f = t - t.floor();
    let (a, b) = (p[i], p[(i + 1) % 4]);
    a.mix(b, f)
}

/// The thinking orb ("working"): a globe of dots in the logo's colours (blue at the bottom to mint
/// at the top), a brighter band sweeping round it so it seems to turn, and two particles on their
/// own orbits. `size` points.
#[allow(dead_code)] // the working row shows thinking_orb.rs, the library's own orb
pub fn thinking_orb(size: f32, still: bool) -> El {
    const TURN: f64 = 0.85; // one turn of the globe, seconds
    let r = size * 0.38;
    let c = size / 2.0;
    let dot = (size * 0.075).max(1.1);
    let mut orb = el().size(size, size).inert();
    // Dots spread evenly over the half of a sphere that faces you (a Fibonacci spiral), so they
    // crowd toward the rim as a globe's do; nearer ones are bigger and brighter.
    const N: usize = 46;
    let golden = std::f32::consts::PI * (3.0 - 5f32.sqrt());
    for i in 0..N {
        let yv = 1.0 - (i as f32 + 0.5) / N as f32 * 2.0; // -1..1, top to bottom
        let ring = (1.0 - yv * yv).max(0.0).sqrt();
        let theta = golden * i as f32;
        let (xv, zv) = (ring * theta.cos(), ring * theta.sin());
        if zv < -0.05 {
            continue; // the far side
        }
        let depth = (zv + 0.05) / 1.05; // 0 at the rim, 1 facing you
        let d = dot * (0.65 + 0.45 * depth);
        let (x, y) = (c + r * xv - d / 2.0, c - r * yv - d / 2.0);
        let base = 0.45 + 0.55 * depth;
        // The logo's gradient, bottom to top: blue, sky, teal, mint.
        let ink = along((yv + 1.0) / 2.0 * 0.75);
        let e = el().absolute(x, y).size(d, d).radius(d / 2.0).fill(ink.alpha(base));
        // The bright band crosses the globe by longitude, so it seems to turn.
        let lon = xv.atan2(zv.max(0.001)); // -pi/2 left .. pi/2 right
        let delay = (f64::from(lon) / std::f64::consts::PI + 0.5) * TURN * 0.5;
        orb = orb.child(if still { e } else { e.looping(rune::LoopSpec::opacity(TURN, delay, 0.3, 1.0)) });
    }
    // Particles on orbits round it, at two speeds and tilts.
    for (radius, period, start, w, ink) in [(size * 0.5, 0.7_f64, 0.0_f32, dot * 1.3, palette()[3]), (size * 0.44, 1.1, 2.2, dot * 1.1, palette()[1])] {
        let p = el().absolute(c - w / 2.0, c - radius - w / 2.0).size(w, w).radius(w / 2.0).fill(ink);
        let ring = el().absolute(0.0, 0.0).size(size, size).rotate(start).child(p);
        orb = orb.child(if still { ring } else { ring.looping(rune::LoopSpec::rotation(period)) });
    }
    orb
}

/// The spectrum ribbon: a ring of short arcs, each a step along the palette.
fn ribbon(size: f32, radius: f32, width: f32, alpha: f32, offset: f32) -> El {
    const STEPS: usize = 48;
    let c = size / 2.0;
    let mut shape = Shape::new();
    for i in 0..STEPS {
        let (a, b) = (i as f32 / STEPS as f32, (i + 1) as f32 / STEPS as f32);
        let pts: Vec<[f32; 2]> = (0..=3).map(|j| {
            let u = (a + (b - a) * j as f32 / 3.0) * std::f32::consts::TAU;
            [c + radius * u.cos(), c + radius * u.sin()]
        }).collect();
        // The spectrum fades round the back, so it reads as a light running round.
        let fade = 0.35 + 0.65 * (1.0 - (a * 2.0 - 1.0).abs());
        shape = shape.stroke(pts, width, along(a + offset).alpha(alpha * fade));
    }
    canvas(shape).absolute(0.0, 0.0).size(size, size)
}

/// The voice ring round the mic: the spectrum running round it, a second, fainter ribbon the
/// other way, and a soft halo that breathes. `busy` (transcribing) spins it faster.
pub fn voice_ring(size: f32, busy: bool, still: bool) -> El {
    let outer = ribbon(size, size * 0.46, 2.4, 1.0, 0.0);
    let inner = ribbon(size, size * 0.38, 1.4, 0.55, 0.5);
    let halo = el().absolute(0.0, 0.0).size(size, size).radius(size / 2.0)
        .radial_gradient([0.5, 0.5], size * 0.6, [(0.55, palette()[1].alpha(0.0)), (0.75, palette()[1].alpha(0.35)), (1.0, palette()[2].alpha(0.0))]);
    let (fast, slow) = if busy { (0.9, 1.6) } else { (2.4, 4.0) };
    let (outer, inner, halo) = if still {
        (outer, inner, halo)
    } else {
        (outer.looping(rune::LoopSpec::rotation(fast)), inner.rotate(std::f32::consts::PI).looping(rune::LoopSpec::rotation(slow)),
            halo.looping(rune::LoopSpec::opacity(1.4, 0.0, 0.35, 1.0)))
    };
    el().size(size, size).inert().child(halo).child(inner).child(outer)
}

/// The border beam: light riding a rounded box's bottom edge one way and its top edge the other,
/// a bright line on the edge and a soft glow just inside it. An overlay to put last in the box
/// (it takes no clicks); `radius` is the box's corner radius.
#[allow(dead_code)] // the composer stays minimal; kept for a place that wants it
pub fn border_beam(radius: f32, still: bool) -> El {
    const LAP: f64 = 2.2;
    let band = |alpha: f32| -> Vec<(f32, Color)> {
        let p = palette();
        vec![(0.28, p[0].alpha(0.0)), (0.38, p[0].alpha(alpha)), (0.47, p[1].alpha(alpha)), (0.55, p[2].alpha(alpha)),
            (0.62, p[3].alpha(alpha * 0.9)), (0.72, p[3].alpha(0.0))]
    };
    let edge = |bottom: bool, delay: f64| {
        let (from, to) = if bottom { ([-0.7, 0.0], [0.7, 0.0]) } else { ([0.7, 0.0], [-0.7, 0.0]) };
        let line = el().w_full().h(1.5).linear_gradient(std::f32::consts::FRAC_PI_2, band(1.0));
        let glow = el().w_full().h(10.0).radial_gradient([0.5, if bottom { 1.0 } else { 0.0 }], [160.0, 10.0],
            [(0.0, palette()[1].alpha(0.45)), (0.6, palette()[2].alpha(0.15)), (1.0, palette()[2].alpha(0.0))]);
        let strip = rune::col().w_full().h(10.0).children(if bottom { [glow.mt(-1.5), line] } else { [line, glow.mt(-1.5)] });
        let strip = if bottom { strip.pin(Some(0.0), None, Some(0.0), Some(0.0)) } else { strip.pin(Some(0.0), Some(0.0), Some(0.0), None) };
        if still {
            strip
        } else {
            let mut spec = rune::LoopSpec::slide(LAP, from, to).easing(rune::Easing::LINEAR);
            spec.delay = delay;
            strip.looping(spec)
        }
    };
    el().key("border-beam").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).radius(radius).continuous_corners().clip_rounded(radius).inert()
        .child(edge(true, 0.0))
        .child(edge(false, LAP / 2.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_palette_runs_round() {
        let (a, b) = (along(0.0), along(1.0));
        assert!((a.r - b.r).abs() < 1e-4 && (a.g - b.g).abs() < 1e-4 && (a.b - b.b).abs() < 1e-4);
        let mid = along(0.125);
        let (p0, p1) = (palette()[0], palette()[1]);
        assert!((mid.g - (p0.g + p1.g) / 2.0).abs() < 1e-3);
    }
}
