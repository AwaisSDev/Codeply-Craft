//! Builds Codeply.exe's icon on Windows: renders `assets/codeply-app-icon.svg` (the app icon
//! from codeply.app) at every size Windows asks for, packs them into one .ico, and embeds it as
//! the exe's icon (resource 1), so Explorer, the taskbar and Alt Tab show the Codeply logo.

fn main() {
    println!("cargo:rerun-if-changed=assets/codeply-app-icon.svg");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let ico = out.join("codeply.ico");
    if let Err(e) = make_ico(&ico) {
        println!("cargo:warning=no app icon: {e}");
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon(ico.to_str().expect("utf-8 path"));
    res.set("FileDescription", "Codeply");
    res.set("ProductName", "Codeply");
    if let Err(e) = res.compile() {
        println!("cargo:warning=couldn't embed the app icon: {e}");
    }
}

fn make_ico(path: &std::path::Path) -> Result<(), String> {
    use resvg::{tiny_skia, usvg};
    let svg = std::fs::read_to_string("assets/codeply-app-icon.svg").map_err(|e| e.to_string())?;
    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).map_err(|e| e.to_string())?;
    let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
    for size in [16u32, 20, 24, 32, 40, 48, 64, 128, 256] {
        let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("bad size")?;
        let scale = size as f32 / tree.size().width();
        resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
        // tiny-skia keeps premultiplied pixels; an .ico wants straight alpha.
        let rgba: Vec<u8> = pixmap.pixels().iter().flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        }).collect();
        let image = ico::IconImage::from_rgba_data(size, size, rgba);
        dir.add_entry(ico::IconDirEntry::encode(&image).map_err(|e| e.to_string())?);
    }
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    dir.write(file).map_err(|e| e.to_string())
}
