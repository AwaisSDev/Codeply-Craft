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

#[cfg(windows)]
mod native {
    //! WebView2 through wry, as child windows of the app's window.
    use std::cell::RefCell;
    use std::sync::mpsc::Sender;

    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::{NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

    use super::Event;

    thread_local! {
        static WINDOW: RefCell<Option<rune::WindowHandle>> = const { RefCell::new(None) };
        static VIEWS: RefCell<Vec<(u64, WebView)>> = const { RefCell::new(Vec::new()) };
        static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) };
    }

    pub fn set_window(handle: &rune::WindowHandle) {
        // Child windows (the web views) must not be painted over by the app's own frames.
        let _ = handle.with_raw_handle(|h| clip_children(h.as_raw()));
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
        let (t1, t2, t3, t4) = (tx.clone(), tx.clone(), tx.clone(), tx);
        let (w1, w2, w3, w4) = (wake.clone(), wake.clone(), wake.clone(), wake);
        CONTEXT.with_borrow_mut(|ctx| {
            let ctx = ctx.get_or_insert_with(|| WebContext::new(Some(data_dir())));
            window.with_raw_handle(|handle| {
                WebViewBuilder::new_with_web_context(ctx)
                    .with_url(url)
                    .with_bounds(bounds(rect))
                    .with_background_color((15, 15, 15, 255))
                    .with_devtools(true)
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
