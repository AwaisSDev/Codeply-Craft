//! Site icons for links in chats ("open [Codeply](https://codeply.app)" shows Codeply's icon
//! and name, as the Electron app does). Each site's icon is fetched once, off the UI thread, as
//! a 64 px PNG, decoded, and kept for the life of the app.

use std::cell::RefCell;
use std::collections::HashMap;

use rune::Pixels;

thread_local! {
    static CACHE: RefCell<HashMap<String, Option<Pixels>>> = RefCell::new(HashMap::new());
}

/// Wakes the app when an icon lands, so views that show a stand-in until then (an app's
/// letter tile) build again with the image: `App::poll` sees [`take_landed`] and rebuilds.
static WAKER: std::sync::Mutex<Option<rune::Waker>> = std::sync::Mutex::new(None);
static LANDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_waker(waker: rune::Waker) {
    *WAKER.lock().unwrap_or_else(|e| e.into_inner()) = Some(waker);
}

/// Whether an icon has landed since the last call.
pub fn take_landed() -> bool {
    LANDED.swap(false, std::sync::atomic::Ordering::AcqRel)
}

/// The host of `url` without `www.` ("github.com"), or None when it isn't a web URL.
pub fn host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.split('@').next_back()?.split(':').next()?;
    let host = host.trim_start_matches("www.").to_ascii_lowercase();
    ((host.contains('.') || host == "localhost") && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')).then_some(host)
}

/// A server on this computer or the local network: localhost, an IP address, a `.local` name.
pub fn is_local(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// A link's name: the site's name for a bare URL ("github.com/x/y" reads "GitHub"), else the
/// host with its first letter raised ("Codeply" for codeply.app).
pub fn site_name(url: &str) -> String {
    let Some(h) = host(url) else { return url.to_owned() };
    // A local server reads as its address and port ("127.0.0.1:8080", "localhost:3000").
    if is_local(&h) {
        let rest = url.split_once("://").map_or(url, |(_, r)| r);
        let hostport = rest.split(['/', '?', '#']).next().unwrap_or(&h);
        return hostport.split('@').next_back().unwrap_or(hostport).to_owned();
    }
    let known = [
        ("github.com", "GitHub"), ("gitlab.com", "GitLab"), ("google.com", "Google"), ("youtube.com", "YouTube"),
        ("vercel.com", "Vercel"), ("vercel.app", "Vercel"), ("stackoverflow.com", "Stack Overflow"), ("npmjs.com", "npm"),
        ("crates.io", "crates.io"), ("docs.rs", "Docs.rs"), ("x.com", "X"), ("twitter.com", "X"), ("linkedin.com", "LinkedIn"),
        ("notion.so", "Notion"), ("figma.com", "Figma"), ("slack.com", "Slack"), ("openai.com", "OpenAI"), ("anthropic.com", "Anthropic"),
        ("wikipedia.org", "Wikipedia"), ("reddit.com", "Reddit"), ("medium.com", "Medium"), ("developer.mozilla.org", "MDN"),
    ];
    for (domain, name) in known {
        if h == domain || h.ends_with(&format!(".{domain}")) {
            return name.to_owned();
        }
    }
    // "codeply.app" -> "Codeply", "blog.example.com" -> "Example".
    let parts: Vec<&str> = h.split('.').collect();
    let main = if parts.len() >= 2 { parts[parts.len() - 2] } else { parts[0] };
    let mut c = main.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().collect::<String>() + c.as_str())
}

/// The icon for `url`'s site. The first call for a site starts fetching it; the pixels fill in
/// when it lands (they wake the window themselves), and stay empty if it can't be had.
pub fn get(url: &str) -> Option<Pixels> {
    let h = host(url).filter(|h| !is_local(h))?;
    load(vec![format!("https://www.google.com/s2/favicons?domain={h}&sz=64")])
}

/// An app's logo, as the Electron app shows one: its own icon URL when it has one, else its
/// domain's icon from Google's favicon service at 128 px when the icon can't be had (or is in
/// a format nothing here decodes). None when it has neither (the tile shows the app's first
/// letter instead).
pub fn app_logo(domain: &str, icon: &str) -> Option<Pixels> {
    let mut urls = Vec::new();
    if icon.starts_with("https://") {
        urls.push(icon.to_owned());
    }
    let d = domain.trim().trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.").split('/').next().unwrap_or_default().to_ascii_lowercase();
    if d.contains('.') && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        urls.push(format!("https://www.google.com/s2/favicons?domain={d}&sz=128"));
    }
    load(urls)
}

/// Pixels for the first of `urls` that downloads and decodes, fetched once and kept for the
/// life of the app. Empty until it lands.
fn load(urls: Vec<String>) -> Option<Pixels> {
    if rune::is_headless() || urls.is_empty() {
        return None;
    }
    let key = urls.join("\n");
    CACHE.with_borrow_mut(|cache| {
        if let Some(p) = cache.get(&key) {
            return p.clone();
        }
        let px = Pixels::new();
        cache.insert(key, Some(px.clone()));
        fetch(urls, px.clone());
        Some(px)
    })
}

#[cfg(feature = "live")]
fn fetch(urls: Vec<String>, px: Pixels) {
    use std::io::Read as _;
    std::thread::spawn(move || {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(8)).build();
        for url in urls {
            let Ok(resp) = agent.get(&url).call() else { continue };
            let mut bytes = Vec::new();
            if resp.into_reader().take(512 * 1024).read_to_end(&mut bytes).is_err() {
                continue;
            }
            if let Some((w, h, mut rgba)) = decode_image(&bytes) {
                clear_backdrop(w, h, &mut rgba);
                px.set(w, h, rgba);
                LANDED.store(true, std::sync::atomic::Ordering::Release);
                if let Some(wake) = WAKER.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    wake();
                }
                return;
            }
        }
    });
}

#[cfg(not(feature = "live"))]
fn fetch(_: Vec<String>, _: Pixels) {}

/// A logo drawn as a rounded square sitting on a flat backdrop (white or gray corners around it):
/// the backdrop becomes transparent, so the logo's own shape is the tile and no pale slivers show
/// at its corners when the app clips it to its own radius. Only that shape is touched: opaque,
/// matching corners, with the logo reaching the middle of every edge. A glyph on a plain square
/// (the corners and edges all backdrop) is left as it is.
pub fn clear_backdrop(w: u32, h: u32, rgba: &mut [u8]) {
    let (w, h) = (w as usize, h as usize);
    if w < 8 || h < 8 || rgba.len() != w * h * 4 {
        return;
    }
    let px = |rgba: &[u8], x: usize, y: usize| { let i = (y * w + x) * 4; [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]] };
    let at = |x: usize, y: usize| px(rgba, x, y);
    let bg = at(0, 0);
    let near = |p: [u8; 4], tol: i32| (0..3).all(|k| (i32::from(p[k]) - i32::from(bg[k])).abs() <= tol) && p[3] > 200;
    if bg[3] < 250 || ![at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)].into_iter().all(|p| near(p, 12)) {
        return;
    }
    // The logo must reach the middle of each edge (8% in): a rounded square, not a glyph on a field.
    let (ix, iy) = ((w * 8 / 100).max(1), (h * 8 / 100).max(1));
    if [at(w / 2, iy), at(w / 2, h - 1 - iy), at(ix, h / 2), at(w - 1 - ix, h / 2)].into_iter().any(|p| near(p, 40)) {
        return;
    }
    // Flood the backdrop from the four corners; its anti-aliased rim fades by how close it is.
    let bg = px(rgba, 0, 0);
    let mut seen = vec![false; w * h];
    let mut stack = vec![(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)];
    while let Some((x, y)) = stack.pop() {
        let i = y * w + x;
        if seen[i] {
            continue;
        }
        seen[i] = true;
        let p = px(rgba, x, y);
        let d = (0..3).map(|k| (i32::from(p[k]) - i32::from(bg[k])).abs()).max().unwrap_or(0);
        if d > 96 {
            continue;
        }
        // Fully backdrop: gone. Part backdrop (the rim): keep that much of the logo's own colour.
        let keep = ((d - 24).max(0) * 255 / 72).min(255) as u8;
        rgba[i * 4 + 3] = rgba[i * 4 + 3].min(keep);
        if d <= 24 {
            if x > 0 { stack.push((x - 1, y)); }
            if x + 1 < w { stack.push((x + 1, y)); }
            if y > 0 { stack.push((x, y - 1)); }
            if y + 1 < h { stack.push((x, y + 1)); }
        }
    }
}

/// An icon as straight RGBA: PNG, JPEG, GIF, WebP, BMP or ICO (the codecs Rune builds in), or
/// SVG rasterized at 128 px. Sites and app catalogues serve all of these.
pub fn decode_image(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if let Some(png) = decode_png(bytes) {
        return Some(png);
    }
    if let Ok(img) = image::load_from_memory(bytes) {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        return (w > 0 && h > 0).then(|| (w, h, rgba.into_raw()));
    }
    decode_svg(bytes, 128)
}

/// An SVG rasterized so its longer side is `size` px.
fn decode_svg(bytes: &[u8], size: u32) -> Option<(u32, u32, Vec<u8>)> {
    use resvg::{tiny_skia, usvg};
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    if !head.contains("<svg") {
        return None;
    }
    let tree = usvg::Tree::from_data(bytes, &usvg::Options::default()).ok()?;
    let (sw, sh) = (tree.size().width(), tree.size().height());
    let scale = size as f32 / sw.max(sh);
    let (w, h) = (((sw * scale).round() as u32).max(1), ((sh * scale).round() as u32).max(1));
    let mut pixmap = tiny_skia::Pixmap::new(w, h)?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    // tiny-skia keeps premultiplied pixels; Pixels wants straight alpha.
    let rgba = pixmap.pixels().iter().flat_map(|p| {
        let c = p.demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    }).collect();
    Some((w, h, rgba))
}

/// A PNG as straight RGBA.
pub fn decode_png(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width, info.height);
    let data = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => data.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return None,
    };
    (rgba.len() == (w * h * 4) as usize).then_some((w, h, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_names() {
        assert_eq!(host("https://www.codeply.app/x?y").as_deref(), Some("codeply.app"));
        assert_eq!(host("not a url"), None);
        assert_eq!(site_name("https://codeply.app"), "Codeply");
        assert_eq!(site_name("https://github.com/AwaisSDev/Codeply-Craft"), "GitHub");
        assert_eq!(site_name("https://blog.example.com/post"), "Example");
    }

    /// A white page with a black rounded square on it (a logo tile saved on white), and a black
    /// glyph on a plain white square.
    fn tile_on_white(glyph_only: bool) -> (u32, u32, Vec<u8>) {
        let n = 64usize;
        let mut v = vec![255u8; n * n * 4];
        for y in 0..n {
            for x in 0..n {
                let (dx, dy) = ((x as f32 - 31.5).abs(), (y as f32 - 31.5).abs());
                let inside = if glyph_only { dx < 10.0 && dy < 10.0 } else {
                    // A rounded square 2 px in from the edge, corner radius 14.
                    let (qx, qy) = ((dx - 15.5).max(0.0), (dy - 15.5).max(0.0));
                    dx <= 29.5 && dy <= 29.5 && (qx * qx + qy * qy).sqrt() <= 14.0
                };
                if inside {
                    v[(y * n + x) * 4..(y * n + x) * 4 + 3].copy_from_slice(&[0, 0, 0]);
                }
            }
        }
        (n as u32, n as u32, v)
    }

    #[test]
    fn a_tile_saved_on_white_loses_its_white_corners() {
        let (w, h, mut v) = tile_on_white(false);
        clear_backdrop(w, h, &mut v);
        let a = |x: usize, y: usize| v[(y * 64 + x) * 4 + 3];
        assert_eq!((a(0, 0), a(63, 63), a(3, 3)), (0, 0, 0), "corners clear");
        assert_eq!((a(32, 32), a(32, 3), a(3, 32)), (255, 255, 255), "the logo stays");
    }

    #[test]
    fn a_glyph_on_a_plain_square_is_left_alone() {
        let (w, h, mut v) = tile_on_white(true);
        let before = v.clone();
        clear_backdrop(w, h, &mut v);
        assert_eq!(v, before);
    }

    #[test]
    fn icons_decode_from_jpeg_and_svg_too() {
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(8, 8, image::Rgb([94, 106, 210])).write_to(&mut jpeg, image::ImageFormat::Jpeg).unwrap();
        let (w, h, rgba) = decode_image(jpeg.get_ref()).expect("jpeg");
        assert_eq!((w, h, rgba.len()), (8, 8, 8 * 8 * 4));
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect width="24" height="12" fill="#5e6ad2"/></svg>"##;
        let (w, h, rgba) = decode_image(svg).expect("svg");
        assert_eq!((w, h), (128, 64));
        assert_eq!(&rgba[..4], &[0x5e, 0x6a, 0xd2, 255]);
        assert!(decode_image(b"<html>not an image</html>").is_none());
    }
}
