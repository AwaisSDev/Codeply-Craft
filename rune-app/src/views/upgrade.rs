//! Upgrading from inside the app: the card a chat shows when Haze 2's free limit ends a reply,
//! the upgrade sheet (Pro or Max), and "Finish on Whop" while you pay in the browser. Only the
//! payment is on Whop: the engine makes a checkout for your account (`sidecar/ext-billing.mjs`),
//! the app opens it, and the engine watches the account until the plan changes.

use rune::{Color, El, Icon, col, el, icon, row, text};

use crate::app::{App, EditKey, SettingsPage, View};
use crate::icons::ico_s;
use crate::model::{BillingOp, ButtonKind, CheckoutState};
use crate::theme::{self, Theme, mono, ui};
use crate::ui::btn;

/// The sheet's own state: whether it's open, and the plan picked ("starter" is Pro, "pro" is Max).
#[derive(Clone, Debug, PartialEq)]
pub struct Upgrade {
    pub open: bool,
    pub pick: &'static str,
}

impl Default for Upgrade {
    fn default() -> Upgrade {
        Upgrade { open: false, pick: "starter" }
    }
}

/// What a plan key is called in the app.
pub fn plan_name(key: &str) -> &'static str {
    if key == "pro" { "Max" } else { "Pro" }
}

impl App {
    /// Opens the upgrade sheet on Pro, and reads the plan afresh (are you signed in?).
    /// The upgrade sheet with `plan` ("starter" or "pro") already chosen (a locked model in the menu).
    pub fn open_upgrade_for(&mut self, plan: &'static str) {
        self.open_upgrade();
        self.upgrade.pick = if plan == "pro" { "pro" } else { "starter" };
    }

    pub fn open_upgrade(&mut self) {
        self.menu = None;
        self.upgrade = Upgrade { open: true, pick: "starter" };
        // A checkout that ended (or failed) earlier starts over.
        if self.data.extra.billing.checkout.as_ref().is_some_and(|c| !matches!(c.state, CheckoutState::Opening | CheckoutState::Waiting)) {
            self.data.extra.billing.checkout = None;
        }
        self.store.billing(BillingOp::Load, &mut self.data);
    }

    /// "Not now", "Cancel" or Escape: closes the sheet, and stops waiting for a checkout.
    pub fn close_upgrade(&mut self) {
        self.upgrade.open = false;
        if self.data.extra.billing.checkout.is_some() {
            self.store.billing(BillingOp::Cancel, &mut self.data);
        }
        self.data.extra.billing.checkout = None;
    }

    pub fn pick_plan(&mut self, key: &'static str) {
        // Not while a checkout is being made for the other one.
        if !self.checkout_busy() {
            self.upgrade.pick = key;
            if matches!(self.data.extra.billing.checkout.as_ref().map(|c| &c.state), Some(CheckoutState::Failed(_))) {
                self.data.extra.billing.checkout = None;
            }
        }
    }

    /// "Start free trial" / "Continue to payment": the engine makes a checkout for this account,
    /// and the app opens it in the browser.
    pub fn start_checkout(&mut self) {
        if !self.checkout_busy() {
            let plan = self.upgrade.pick.to_owned();
            self.store.billing(BillingOp::Checkout(plan), &mut self.data);
        }
    }

    pub fn reopen_checkout(&mut self) {
        self.store.billing(BillingOp::Reopen, &mut self.data);
    }

    fn checkout_busy(&self) -> bool {
        matches!(self.data.extra.billing.checkout.as_ref().map(|c| &c.state), Some(CheckoutState::Opening | CheckoutState::Waiting))
    }

    /// Signing in comes first: Settings > Profile.
    pub fn sign_in_to_upgrade(&mut self) {
        self.close_upgrade();
        self.open_settings(SettingsPage::Profile);
    }

    /// From `poll`: once the plan changed, the sheet closes and the plan shows wherever it's named.
    pub fn step_billing(&mut self) -> bool {
        if !matches!(self.data.extra.billing.checkout.as_ref().map(|c| &c.state), Some(CheckoutState::Done)) {
            return false;
        }
        self.data.extra.billing.checkout = None;
        self.upgrade.open = false;
        if let Some(p) = self.data.extra.billing.plan.as_ref().filter(|p| !p.name.is_empty()) {
            self.data.plan = format!("{} plan", p.name);
        }
        true
    }

    /// The composer whose model menu "Your model" opens: the one under the transcript on screen.
    fn model_menu_here(&mut self) {
        let key = match self.view {
            View::Code => EditKey::CodeAgent,
            View::Agents => EditKey::AgentThread,
            _ => EditKey::ChatThread,
        };
        self.menu = None;
        self.toggle_menu(&format!("model:{}", key.name()));
    }
}

/// `.btn.blue` with its icon after the label ("Start free trial ↗").
fn blue(t: &Theme, label: &str, icon_after: Option<&str>) -> El {
    row().h(32.0).px(13.0).gap(7.0).radius(9.0).continuous_corners().center_y().fill(t.accent).hover(t.press)
        .role("button").label(label.to_owned())
        .child(text(label.to_owned()).font(ui(13.5, 600.0)).color(t.on_accent))
        .children(icon_after.map(|i| ico_s(i, 15.0, t.on_accent)))
}

// ---------- the card in a chat ----------

/// "You've used Codeply's free limit for now": when it comes back, and two ways on. In a narrow
/// column (the code view's agent) the buttons go under the words.
pub fn limit_card(s: &App, t: &Theme, resets: &str, narrow: bool) -> El {
    let plan = s.data.extra.billing.plan.as_ref().filter(|p| p.paid());
    let line = match plan {
        Some(p) => format!("You're on {} now, so send your message again to keep going.", p.name),
        None if resets.is_empty() => "It resets in a few hours. Upgrade for more, or switch to your own model.".to_owned(),
        None => format!("It resets at {resets}. Upgrade for more, or switch to your own model."),
    };
    let buttons = row().gap(8.0).center_y()
        .child(btn(t, "Your model", Some("chip"), ButtonKind::Plain).key("limit-model").on_press(|s: &mut App| s.model_menu_here()))
        .children(plan.is_none().then(|| btn(t, "Upgrade", Some("sparkle"), ButtonKind::Blue).key("limit-upgrade").on_press(|s: &mut App| s.open_upgrade())));
    let words = col().grow(1.0).min_w(0.0).gap(3.0)
        .child(text("You've used Yune's free limit for now").font(ui(14.5, 600.0)).color(t.text).wrap())
        .child(text(line).font(ui(13.0, 400.0)).color(t.dim).wrap());
    let badge = el().size(36.0, 36.0).radius(10.0).continuous_corners().center().fill(t.control).child(ico_s("clock", 18.0, t.dim));
    let card = |e: El| e.key("limit-card").w_full().px(16.0).py(14.0).gap(14.0).radius(12.0).continuous_corners().fill(t.card).border(1.0, t.card_border).role("group").label("Free limit");
    if narrow {
        return card(col()).child(row().w_full().gap(14.0).items_start().child(badge).child(words)).child(buttons.pl(50.0));
    }
    card(row()).center_y().child(badge).child(words).child(buttons)
}

/// Room the transcript leaves under it for the card, so its last lines stay clear of it.
const CARD_ROOM: f32 = 104.0;

/// A transcript with its composer, as `thread::with_composer` draws it, and, while the chat's
/// last reply ended on Haze 2's free limit, the limit card just above the composer.
#[allow(clippy::too_many_arguments)]
pub fn with_composer(s: &App, t: &Theme, chat: &str, who: &str, key: EditKey, target: crate::store::Target, placeholder: &str, width: f32) -> El {
    let Some((_, resets)) = s.data.extra.limits.iter().find(|(c, _)| c == chat) else {
        return crate::thread::with_composer(s, t, chat, who, key, target, placeholder, width);
    };
    // Narrow: the code view's agent, or a chat beside the browser or the terminal.
    let narrow = width < 600.0 || (key == EditKey::ChatThread && (s.panes.browser || s.panes.terminal));
    let room = if narrow { CARD_ROOM + 40.0 } else { CARD_ROOM };
    let dock = col().pin(Some(0.0), None, Some(0.0), Some(0.0)).px(24.0).pt(14.0).pb(18.0).items_center()
        .linear_gradient(std::f32::consts::PI, [(0.0, t.bg.alpha(0.0)), (0.35, t.bg), (1.0, t.bg)])
        .child(col().w_full().max_w(width).gap(12.0)
            .child(limit_card(s, t, resets, narrow))
            .child(crate::ui::composer(s, t, key, target, placeholder, false, false)));
    el().w_full().h_full()
        .child(col().w_full().h_full().pb(room).child(crate::thread::transcript(s, t, chat, who, width)))
        .child(dock)
}

// ---------- the sheet ----------

/// The upgrade sheet, over the window, while it's open.
pub fn sheet(s: &App, t: &Theme) -> Option<El> {
    if !s.upgrade.open {
        return None;
    }
    let checkout = s.data.extra.billing.checkout.as_ref();
    // Escape closes it (and stops waiting); a click outside closes only the plan picker, so a
    // stray click doesn't stop watching a payment.
    let (card, outside) = match checkout {
        Some(c) if c.state == CheckoutState::Waiting => (waiting(t, plan_name(&c.plan), &c.url), false),
        _ => (picker(s, t), true),
    };
    Some(col().key("upgrade-scrim").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).center()
        .fill(theme::rgba(0, 0, 0, 0.45))
        .child(card.fill(t.card).border(1.0, t.control_border).radius(14.0).continuous_corners().shadow(16.0, 48.0, theme::rgba(0, 0, 0, 0.5)).role("dialog")
            .transition(crate::ui::fade_in()).motion(crate::ui::ENTER)
            .modal(outside, |s: &mut App| s.close_upgrade())))
}

/// One plan to pick: its name (and a tag), price, and what it gives.
fn plan_card(t: &Theme, key: &'static str, on: bool, tag: Option<&str>, price: &str, lines: &[(&str, bool)]) -> El {
    let radio = if on {
        el().size(18.0, 18.0).radius(9.0).center().fill(t.accent).child(el().size(7.0, 7.0).radius(3.5).fill(Color::WHITE))
    } else {
        el().size(18.0, 18.0).radius(9.0).border(1.5, t.dim.alpha(0.55))
    };
    let tag_ink = if t.dark { theme::hex("#8db8ff") } else { t.accent };
    let head = row().w_full().gap(8.0).center_y()
        .child(text(plan_name(key)).font(ui(15.0, 700.0)).color(t.text))
        .children(tag.map(|g| row().h(20.0).px(8.0).radius(6.0).continuous_corners().center_y().fill(t.accent.alpha(0.2)).child(text(g.to_owned()).font(ui(12.0, 600.0)).color(tag_ink))))
        .child(el().grow(1.0))
        .child(radio);
    let price = row().gap(6.0).items_end().pt(10.0)
        .child(text(price.to_owned()).font(ui(26.0, 700.0).tracking(-0.4)).color(t.text))
        .child(text("/ month").font(ui(13.0, 500.0)).color(t.dim).pb(4.0));
    let list = col().w_full().gap(8.0).pt(12.0).children(lines.iter().map(|&(l, soon)| {
        row().w_full().gap(8.0).items_start()
            .child(ico_s("check", 15.0, t.accent).mt(1.0))
            .child(text(l.to_owned()).font(ui(13.5, 400.0)).color(t.text).wrap().shrink().min_w(0.0))
            .children(soon.then(|| row().h(18.0).px(6.0).radius(5.0).continuous_corners().center_y().fill(t.hover).child(text("Soon").font(ui(11.5, 500.0)).color(t.faint))))
    }));
    // The picked one has a 2 pt accent edge; the padding gives back the extra point.
    let (edge, pad) = if on { (2.0, 15.0) } else { (1.0, 16.0) };
    col().key(format!("upgrade-plan/{key}")).w(280.0).padding(pad).radius(12.0).continuous_corners()
        .fill(if on { t.accent.alpha(0.09) } else { t.field }).border(edge, if on { t.accent } else { t.control_border })
        .role("radio").checked(on).label(plan_name(key))
        .child(head).child(price).child(list)
        .on_press(move |s: &mut App| s.pick_plan(key))
}

/// Pro or Max, and the button that goes to payment.
fn picker(s: &App, t: &Theme) -> El {
    let b = &s.data.extra.billing;
    let state = b.checkout.as_ref().map(|c| &c.state);
    let pick = s.upgrade.pick;
    let head = row().w_full().gap(14.0).items_start()
        .child(crate::logo::mark(40.0))
        .child(col().grow(1.0).min_w(0.0).gap(6.0)
            .child(text("Upgrade Yune").font(ui(19.0, 700.0).tracking(-0.2)).color(t.text))
            .child(text("Our best models, no API key needed. Cancel any time.").font(ui(14.0, 400.0).lh(20.0)).color(t.dim).wrap()));
    let plans = row().w_full().gap(12.0).items_stretch().mt(20.0)
        .child(plan_card(t, "starter", pick == "starter", Some("3 days free"), "$20", &[
            ("Opus 5.5, Sonnet 5.5 and Haiku 5.5", false),
            ("Usage that resets every 5 hours", false),
            ("ChatGPT Tera and Luna", true),
        ]))
        .child(plan_card(t, "pro", pick == "pro", None, "$100", &[
            ("Everything in Pro, 5x the usage", false),
            ("Claude Fable 5.2", false),
            ("ChatGPT Sol and Astra", true),
        ]));
    let sign_in = b.signed_out || state == Some(&CheckoutState::SignIn);
    let opening = state == Some(&CheckoutState::Opening);
    let problem = match state {
        Some(CheckoutState::Failed(e)) => Some(e.clone()),
        _ => None,
    };
    let note = if sign_in {
        row().gap(6.0).center_y().shrink().min_w(0.0)
            .child(ico_s("user", 14.0, t.dim))
            .child(text("Sign in to Yune first, so your plan lands on your account.").font(ui(12.5, 400.0)).color(t.dim).wrap().shrink().min_w(0.0))
    } else {
        row().gap(6.0).center_y()
            .child(ico_s("lock", 14.0, t.faint))
            .child(text("You'll pay securely on Whop").font(ui(12.5, 400.0)).color(t.faint))
    };
    let go = if sign_in {
        blue(t, "Sign in", None).key("upgrade-sign-in").on_press(|s: &mut App| s.sign_in_to_upgrade())
    } else if opening {
        row().key("upgrade-go").h(32.0).px(13.0).radius(9.0).continuous_corners().center_y().fill(t.accent.alpha(0.6)).role("button").label("Opening checkout")
            .child(crate::ui::wave("Opening checkout", ui(13.5, 600.0), t.on_accent))
    } else {
        blue(t, if pick == "starter" { "Start free trial" } else { "Continue to payment" }, Some("external")).key("upgrade-go")
            .on_press(|s: &mut App| s.start_checkout())
    };
    let foot = row().w_full().gap(12.0).center_y().mt(20.0).pt(16.0).border_sides([1.0, 0.0, 0.0, 0.0], t.card_border)
        .child(note)
        .child(el().grow(1.0))
        .child(btn(t, "Not now", None, ButtonKind::Plain).key("upgrade-later").on_press(|s: &mut App| s.close_upgrade()))
        .child(go);
    col().key("upgrade-sheet").w(620.0).padding(24.0).label("Upgrade Yune")
        .child(head)
        .child(plans)
        .children(problem.map(|e| row().w_full().gap(8.0).mt(14.0).items_start()
            .child(ico_s("warning", 15.0, t.red).mt(1.0))
            .child(text(e).font(ui(13.0, 400.0)).color(t.red).wrap().grow(1.0).min_w(0.0))))
        .child(foot)
}

/// A ring's quarter, for the spinner (it turns; the track under it stays).
static ARC: Icon = Icon {
    name: "spinner-arc",
    view: 24.0,
    body: r#"<path d="M12 2.25A9.75 9.75 0 0 1 21.75 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>"#,
};

fn spinner(t: &Theme, size: f32) -> El {
    el().key("upgrade-spinner").size(size, size)
        .child(el().absolute(0.0, 0.0).size(size, size).radius(size / 2.0).border(size * 0.1, t.control_border))
        .child(el().absolute(0.0, 0.0).size(size, size).child(icon(&ARC, size).color(t.accent)).looping(rune::LoopSpec::rotation(0.9)))
}

/// "whop.com/checkout/…": where checkout is, without the session in its address.
pub fn short_url(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let host = parts.next().unwrap_or_default().trim_start_matches("www.");
    match (parts.next(), parts.next()) {
        (Some(first), Some(_)) => format!("{host}/{first}/…"),
        (Some(first), None) => format!("{host}/{first}"),
        _ => host.to_owned(),
    }
}

/// While you pay on Whop: the engine watches the account and the sheet closes on its own.
fn waiting(t: &Theme, plan: &str, url: &str) -> El {
    col().key("upgrade-waiting").w(460.0).px(28.0).pt(34.0).pb(26.0).items_center().label("Finish on Whop")
        .child(spinner(t, 34.0))
        .child(text("Finish on Whop").font(ui(19.0, 700.0).tracking(-0.2)).color(t.text).mt(16.0))
        .child(text(format!("We opened checkout in your browser. Yune switches to {plan} as soon as you're done.")).font(ui(14.0, 400.0).lh(20.0)).color(t.dim).wrap().align(rune::Align::Center).mt(6.0))
        .children((!url.is_empty()).then(|| row().mt(14.0).h(28.0).px(10.0).gap(6.0).radius(8.0).continuous_corners().center_y().fill(t.well).border(1.0, t.field_border).help(url.to_owned())
            .child(ico_s("lock", 13.0, t.dim))
            .child(text(short_url(url)).font(mono(12.5, 16.0)).color(t.dim))))
        .child(row().mt(20.0).gap(8.0).justify_center()
            .child(btn(t, "Cancel", None, ButtonKind::Plain).key("upgrade-cancel").on_press(|s: &mut App| s.close_upgrade()))
            .child(btn(t, "Open checkout again", None, ButtonKind::Plain).key("upgrade-reopen").on_press(|s: &mut App| s.reopen_checkout())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_addresses_shorten_without_their_session() {
        assert_eq!(short_url("https://whop.com/checkout/plan_abc?session=secret"), "whop.com/checkout/…");
        assert_eq!(short_url("https://www.whop.com/c/x/y"), "whop.com/c/…");
        assert_eq!(short_url("https://whop.com/checkout"), "whop.com/checkout");
        assert_eq!(short_url("whop.com"), "whop.com");
    }
}
