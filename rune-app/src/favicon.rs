//! Site icons for links in chats ("open [Codeply](https://codeply.app)" shows Codeply's icon
//! and name, as the Electron app does). Each site's icon is fetched once, off the UI thread, as
//! a 64 px PNG, decoded, and kept for the life of the app.

use std::cell::RefCell;
use std::collections::HashMap;

use rune::Pixels;

thread_local! {
    static CACHE: RefCell<HashMap<String, Option<Pixels>>> = RefCell::new(HashMap::new());
}

/// The host of `url` without `www.` ("github.com"), or None when it isn't a web URL.
pub fn host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?.split('@').next_back()?.split(':').next()?;
    let host = host.trim_start_matches("www.").to_ascii_lowercase();
    (host.contains('.') && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')).then_some(host)
}

/// A link's name: the site's name for a bare URL ("github.com/x/y" reads "GitHub"), else the
/// host with its first letter raised ("Codeply" for codeply.app).
pub fn site_name(url: &str) -> String {
    let Some(h) = host(url) else { return url.to_owned() };
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
    let h = host(url)?;
    if rune::is_headless() {
        return None;
    }
    CACHE.with_borrow_mut(|cache| {
        if let Some(p) = cache.get(&h) {
            return p.clone();
        }
        let px = Pixels::new();
        cache.insert(h.clone(), Some(px.clone()));
        fetch(h, px.clone());
        Some(px)
    })
}

#[cfg(feature = "live")]
fn fetch(host: String, px: Pixels) {
    use std::io::Read as _;
    std::thread::spawn(move || {
        let url = format!("https://www.google.com/s2/favicons?domain={host}&sz=64");
        let Ok(resp) = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(8)).build().get(&url).call() else { return };
        let mut bytes = Vec::new();
        if resp.into_reader().take(512 * 1024).read_to_end(&mut bytes).is_err() {
            return;
        }
        if let Some((w, h, rgba)) = decode_png(&bytes) {
            px.set(w, h, rgba);
        }
    });
}

#[cfg(not(feature = "live"))]
fn fetch(_: String, _: Pixels) {}

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
}
