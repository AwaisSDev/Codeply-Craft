//! The built-in browser: tabs, an address bar, back, forward and reload, and on Windows a real
//! web view (WebView2, the Edge engine every Windows 10 and 11 PC has) docked in the Browser
//! view. Rune has no web view of its own, so the page is a native child window laid exactly over
//! the element the view marks (`Browser::rect`, from `El::on_layout`), shown only while the
//! Browser view is up and no menu covers it.
//!
//! Elsewhere (Linux, macOS, headless renders) the view shows the tabs and opens pages in the
//! system browser instead.

use std::sync::mpsc::{Receiver, Sender, channel};

/// What a web view tells the app, from its own callbacks.
#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Event {
    Title(u64, String),
    Url(u64, String),
    Loading(u64, bool),
    /// A page asked for a new window (a link with `target=_blank`): open it in a new tab.
    NewTab(String),
    /// The element picker: what was clicked, ready for the chat ("`selector` on url: text").
    Picked(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub loading: bool,
}

pub struct Browser {
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// Where the page goes, in window points `[x, y, w, h]` (the view's `on_layout`).
    pub rect: Option<[f32; 4]>,
    next: u64,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    waker: Option<rune::Waker>,
    /// What the native views were last told: (visible, rect, active tab).
    synced: Option<(bool, [f32; 4], u64)>,
    /// Why there is no native view, if it failed (shown in the view).
    pub problem: Option<String>,
    /// The page's zoom, 1.0 is 100%.
    pub zoom: f64,
    /// Whether the element picker is waiting for a click.
    pub picking: bool,
    /// Something the picker picked, for the app to put in the chat's composer.
    pub picked: Option<String>,
}

/// A URL from what was typed: a URL as it is, `example.com` with https, anything else a search.
pub fn resolve(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() {
        return "about:blank".into();
    }
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("about:") || s.starts_with("file:") {
        return s.to_owned();
    }
    let looks_like_host = !s.contains(' ') && (s.contains('.') || s.starts_with("localhost")) && !s.ends_with('.');
    if looks_like_host {
        let local = s.starts_with("localhost") || s.starts_with("127.0.0.1");
        return format!("{}://{s}", if local { "http" } else { "https" });
    }
    let q: String = s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        b' ' => "+".to_owned(),
        _ => format!("%{b:02X}"),
    }).collect();
    format!("https://duckduckgo.com/?q={q}")
}

impl Browser {
    pub fn new(home: &str) -> Browser {
        let (tx, rx) = channel();
        Browser {
            tabs: vec![Tab { id: 1, url: home.to_owned(), title: crate::favicon::site_name(home), loading: false }],
            active: 0,
            rect: None,
            next: 2,
            tx,
            rx,
            waker: None,
            synced: None,
            problem: None,
            zoom: 1.0,
            picking: false,
            picked: None,
        }
    }

    /// Codeply's element picker: the next click on the page picks that element for the chat.
    pub fn pick(&mut self) {
        if let Some(t) = self.current() {
            native::script(t.id, "window.__codeplyPick && window.__codeplyPick()");
            self.picking = true;
        }
    }

    /// Zooms the page by `step` (0.1 is ten percent), between 30% and 300%; 0 resets it.
    pub fn zoom_by(&mut self, step: f64) {
        self.zoom = if step == 0.0 { 1.0 } else { (self.zoom + step).clamp(0.3, 3.0) };
        if let Some(t) = self.current() {
            native::zoom(t.id, self.zoom);
        }
    }

    pub fn devtools(&self) {
        if let Some(t) = self.current() {
            native::devtools(t.id);
        }
    }

    pub fn clear_data(&self) {
        if let Some(t) = self.current() {
            native::clear_data(t.id);
        }
    }

    pub fn set_waker(&mut self, waker: rune::Waker) {
        self.waker = Some(waker);
    }

    pub fn current(&self) -> Option<&Tab> {
        self.tabs.get(self.active)
    }

    /// Opens `input` (a URL or a search) in the current tab.
    pub fn navigate(&mut self, input: &str) {
        let url = resolve(input);
        if self.tabs.is_empty() {
            self.new_tab(&url);
            return;
        }
        let tab = &mut self.tabs[self.active];
        tab.url = url.clone();
        tab.title = crate::favicon::site_name(&url);
        tab.loading = true;
        native::load(tab.id, &url);
    }

    pub fn new_tab(&mut self, url: &str) {
        let url = resolve(url);
        self.tabs.push(Tab { id: self.next, url: url.clone(), title: crate::favicon::site_name(&url), loading: true });
        self.next += 1;
        self.active = self.tabs.len() - 1;
        self.synced = None;
    }

    pub fn close_tab(&mut self, i: usize) {
        if i >= self.tabs.len() {
            return;
        }
        native::close(self.tabs[i].id);
        self.tabs.remove(i);
        if self.active >= self.tabs.len() {
            self.active = self.tabs.len().saturating_sub(1);
        }
        self.synced = None;
    }

    pub fn select(&mut self, i: usize) {
        if i < self.tabs.len() {
            self.active = i;
            self.synced = None;
        }
    }

    pub fn back(&self) {
        if let Some(t) = self.current() {
            native::script(t.id, "history.back()");
        }
    }

    pub fn forward(&self) {
        if let Some(t) = self.current() {
            native::script(t.id, "history.forward()");
        }
    }

    pub fn reload(&self) {
        if let Some(t) = self.current() {
            native::reload(t.id);
        }
    }

    /// Whether this build shows pages in the app (Windows) or hands them to the system browser.
    pub fn is_native() -> bool {
        cfg!(windows) && !rune::is_headless()
    }

    /// Folds in what the web views said and puts the active one where the view wants it.
    /// `visible`: the Browser view is up with nothing over it. True when the view must rebuild.
    pub fn poll(&mut self, visible: bool) -> bool {
        let mut changed = false;
        while let Ok(e) = self.rx.try_recv() {
            changed = true;
            match e {
                Event::Title(id, title) => {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) && !title.trim().is_empty() {
                        t.title = title;
                    }
                }
                Event::Url(id, url) => {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) {
                        t.url = url;
                    }
                }
                Event::Loading(id, loading) => {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) {
                        t.loading = loading;
                    }
                }
                Event::NewTab(url) => self.new_tab(&url),
                Event::Picked(what) => {
                    self.picking = false;
                    self.picked = Some(what);
                }
            }
        }
        if !Browser::is_native() {
            return changed;
        }
        let (Some(rect), Some(tab)) = (self.rect, self.current().cloned()) else {
            if self.synced.is_some_and(|(v, _, _)| v) {
                native::hide_all();
                self.synced = None;
            }
            return changed;
        };
        let want = (visible, rect, tab.id);
        if self.synced == Some(want) {
            return changed;
        }
        if visible {
            match native::show(tab.id, &tab.url, rect, self.tx.clone(), self.waker.clone()) {
                Ok(()) => self.problem = None,
                Err(e) => {
                    self.problem = Some(e);
                    changed = true;
                }
            }
        } else {
            native::hide_all();
        }
        self.synced = Some(want);
        changed
    }
}

/// Remembers the app's window so web views can be made inside it (from `App::on_window`).
pub fn set_window(handle: &rune::WindowHandle) {
    native::set_window(handle);
}


/// Injected into every page: Codeply's element picker. While picking, the element under the
/// pointer gets an outline; a click sends its selector and text to the app (and is swallowed).
#[cfg_attr(not(windows), allow(dead_code))]
const PICKER_JS: &str = r#"(() => {
  if (window.__codeplyPicker) return;
  window.__codeplyPicker = true;
  let on = false, box = null;
  const sel = (el) => {
    if (el.id) return '#' + el.id;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      let p = el.tagName.toLowerCase();
      if (el.classList.length) p += '.' + [...el.classList].slice(0, 2).join('.');
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const show = (e) => {
    if (!on) return;
    if (!box) { box = document.createElement('div'); box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3d8bfd;background:rgba(61,139,253,.12);border-radius:4px;transition:all .06s'; document.documentElement.appendChild(box); }
    const r = e.target.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
  };
  const pick = (e) => {
    if (!on) return;
    e.preventDefault(); e.stopPropagation();
    on = false; if (box) box.style.display = 'none';
    const t = (e.target.innerText || e.target.alt || '').trim().slice(0, 160);
    window.ipc.postMessage(JSON.stringify({ type: 'picked', selector: sel(e.target), text: t, url: location.href }));
  };
  document.addEventListener('mousemove', show, true);
  document.addEventListener('click', pick, true);
  window.__codeplyPick = () => { on = true; };
})();"#;

#[cfg(windows)]
mod native {
    //! WebView2 through wry, as child windows of the app's window.
    use std::cell::RefCell;
    use std::sync::mpsc::Sender;

    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

    use super::{Event, PICKER_JS};

    thread_local! {
        static WINDOW: RefCell<Option<rune::WindowHandle>> = const { RefCell::new(None) };
        static VIEWS: RefCell<Vec<(u64, WebView)>> = const { RefCell::new(Vec::new()) };
        static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) };
    }

    pub fn set_window(handle: &rune::WindowHandle) {
        // Child windows (the web views) must not be painted over by the app's own frames.
        let _ = handle.with_raw_handle(|h| {
            clip_children(h.as_raw());
            set_icon(h.as_raw());
        });
        WINDOW.with_borrow_mut(|w| *w = Some(handle.clone()));
    }

    /// Adds WS_CLIPCHILDREN to the app's window, so its CPU frames (a BitBlt each) skip the
    /// area the web view covers instead of flickering over it.
    #[allow(unsafe_code)]
    fn clip_children(raw: rune::raw_window_handle::RawWindowHandle) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_STYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_CLIPCHILDREN};
        if let rune::raw_window_handle::RawWindowHandle::Win32(h) = raw {
            let hwnd = h.hwnd.get() as windows_sys::Win32::Foundation::HWND;
            // SAFETY: `hwnd` is the app's live top-level window, borrowed for this call on the UI
            // thread that owns it; reading and setting its style is what these calls are for.
            unsafe {
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_CLIPCHILDREN as isize);
            }
        }
    }

    /// Gives the window the exe's icon (resource 1, the Codeply logo build.rs embeds), big and
    /// small, so the taskbar and Alt Tab show it.
    #[allow(unsafe_code)]
    fn set_icon(raw: rune::raw_window_handle::RawWindowHandle) {
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTSIZE, LoadImageW, SendMessageW, WM_SETICON};
        let rune::raw_window_handle::RawWindowHandle::Win32(h) = raw else { return };
        let hwnd = h.hwnd.get() as windows_sys::Win32::Foundation::HWND;
        // SAFETY: plain Win32 calls on the app's own live window, on its UI thread; resource 1
        // is a MAKEINTRESOURCE ordinal, and a null handle (no icon embedded) is simply skipped.
        unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            for (which, size) in [(ICON_BIG, 32), (ICON_SMALL, 16)] {
                let icon = LoadImageW(module, 1usize as *const u16, IMAGE_ICON, size, size, LR_DEFAULTSIZE);
                if !icon.is_null() {
                    SendMessageW(hwnd, WM_SETICON, which as usize, icon as isize);
                }
            }
        }
    }

    fn bounds(r: [f32; 4]) -> Rect {
        Rect {
            position: LogicalPosition::new(f64::from(r[0]), f64::from(r[1])).into(),
            size: LogicalSize::new(f64::from(r[2].max(1.0)), f64::from(r[3].max(1.0))).into(),
        }
    }

    fn data_dir() -> std::path::PathBuf {
        let home = std::env::var_os("USERPROFILE").map_or_else(|| std::path::PathBuf::from("."), std::path::PathBuf::from);
        home.join(".codeply").join("rune").join("browser")
    }

    fn create(id: u64, url: &str, rect: [f32; 4], tx: Sender<Event>, wake: Option<rune::Waker>) -> Result<WebView, String> {
        let window = WINDOW.with_borrow(|w| w.clone()).ok_or("the window isn't ready yet")?;
        let ping = move |tx: &Sender<Event>, e: Event, wake: &Option<rune::Waker>| {
            let _ = tx.send(e);
            if let Some(w) = wake {
                w();
            }
        };
        let (t1, t2, t3, t4, t5) = (tx.clone(), tx.clone(), tx.clone(), tx.clone(), tx);
        let (w1, w2, w3, w4, w5) = (wake.clone(), wake.clone(), wake.clone(), wake.clone(), wake);
        CONTEXT.with_borrow_mut(|ctx| {
            let ctx = ctx.get_or_insert_with(|| WebContext::new(Some(data_dir())));
            window.with_raw_handle(|handle| {
                WebViewBuilder::new_with_web_context(ctx)
                    .with_url(url)
                    .with_bounds(bounds(rect))
                    .with_background_color((15, 15, 15, 255))
                    .with_devtools(true)
                    .with_initialization_script(PICKER_JS)
                    .with_ipc_handler(move |req| {
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(req.body()) else { return };
                        if v["type"] == "picked" {
                            let text = v["text"].as_str().unwrap_or_default();
                            let what = format!("`{}` on {}{}", v["selector"].as_str().unwrap_or("element"), v["url"].as_str().unwrap_or_default(), if text.is_empty() { String::new() } else { format!(": \"{text}\"") });
                            ping(&t5, Event::Picked(what), &w5);
                        }
                    })
                    .with_document_title_changed_handler(move |title| ping(&t1, Event::Title(id, title), &w1))
                    .with_on_page_load_handler(move |e, url| {
                        ping(&t2, Event::Loading(id, matches!(e, PageLoadEvent::Started)), &w2);
                        ping(&t2, Event::Url(id, url), &w2);
                    })
                    .with_navigation_handler(move |url| {
                        ping(&t3, Event::Url(id, url), &w3);
                        true
                    })
                    .with_new_window_req_handler(move |url, _features| {
                        ping(&t4, Event::NewTab(url), &w4);
                        NewWindowResponse::Deny
                    })
                    .build_as_child(&handle)
                    .map_err(|e| format!("couldn't open a web view: {e}"))
            })?
        })
    }

    /// Shows tab `id` at `rect`, making its web view the first time, and hides the others.
    pub fn show(id: u64, url: &str, rect: [f32; 4], tx: Sender<Event>, wake: Option<rune::Waker>) -> Result<(), String> {
        let exists = VIEWS.with_borrow(|v| v.iter().any(|(k, _)| *k == id));
        if !exists {
            let view = create(id, url, rect, tx, wake)?;
            VIEWS.with_borrow_mut(|v| v.push((id, view)));
        }
        VIEWS.with_borrow(|views| {
            for (k, v) in views {
                if *k == id {
                    let _ = v.set_bounds(bounds(rect));
                    let _ = v.set_visible(true);
                } else {
                    let _ = v.set_visible(false);
                }
            }
        });
        Ok(())
    }

    pub fn hide_all() {
        VIEWS.with_borrow(|views| {
            for (_, v) in views {
                let _ = v.set_visible(false);
            }
        });
    }

    pub fn load(id: u64, url: &str) {
        VIEWS.with_borrow(|views| {
            if let Some((_, v)) = views.iter().find(|(k, _)| *k == id) {
                let _ = v.load_url(url);
            }
        });
    }

    pub fn script(id: u64, js: &str) {
        VIEWS.with_borrow(|views| {
            if let Some((_, v)) = views.iter().find(|(k, _)| *k == id) {
                let _ = v.evaluate_script(js);
            }
        });
    }

    pub fn reload(id: u64) {
        VIEWS.with_borrow(|views| {
            if let Some((_, v)) = views.iter().find(|(k, _)| *k == id) {
                let _ = v.reload();
            }
        });
    }

    pub fn close(id: u64) {
        VIEWS.with_borrow_mut(|views| views.retain(|(k, _)| *k != id));
    }

    fn with(id: u64, f: impl FnOnce(&WebView)) {
        VIEWS.with_borrow(|views| {
            if let Some((_, v)) = views.iter().find(|(k, _)| *k == id) {
                f(v);
            }
        });
    }

    pub fn zoom(id: u64, scale: f64) {
        with(id, |v| {
            let _ = v.zoom(scale);
        });
    }

    pub fn devtools(id: u64) {
        with(id, |v| v.open_devtools());
    }

    pub fn clear_data(id: u64) {
        with(id, |v| {
            let _ = v.clear_all_browsing_data();
        });
    }
}

#[cfg(not(windows))]
mod native {
    //! No web view here: pages open in the system browser.
    use std::sync::mpsc::Sender;

    use super::Event;

    pub fn set_window(_: &rune::WindowHandle) {}
    pub fn show(_: u64, _: &str, _: [f32; 4], _: Sender<Event>, _: Option<rune::Waker>) -> Result<(), String> {
        Ok(())
    }
    pub fn hide_all() {}
    pub fn load(_: u64, _: &str) {}
    pub fn script(_: u64, _: &str) {}
    pub fn reload(_: u64) {}
    pub fn close(_: u64) {}
    pub fn zoom(_: u64, _: f64) {}
    pub fn devtools(_: u64) {}
    pub fn clear_data(_: u64) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_resolves_to_a_url_or_a_search() {
        assert_eq!(resolve("github.com"), "https://github.com");
        assert_eq!(resolve("localhost:3000"), "http://localhost:3000");
        assert_eq!(resolve("https://x.dev/a"), "https://x.dev/a");
        assert_eq!(resolve("rust web views"), "https://duckduckgo.com/?q=rust+web+views");
    }

    #[test]
    fn tabs_open_select_and_close() {
        let mut b = Browser::new("https://www.codeply.app");
        b.new_tab("github.com");
        assert_eq!((b.tabs.len(), b.active), (2, 1));
        b.select(0);
        b.close_tab(0);
        assert_eq!((b.tabs.len(), b.active), (1, 0));
        assert_eq!(b.tabs[0].url, "https://github.com");
    }
}
