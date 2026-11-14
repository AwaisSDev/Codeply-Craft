//! Settings > Cloud & devices: one Codeply across this PC, your phone, the web and the cloud
//! (`sidecar/ext-cloud.mjs`). Your account, the sync of your team and its jobs, the phone and the
//! web reaching this PC, GitHub, and Craft Cloud per project: run there, keep going there when this
//! PC turns off, and back up as you work.

use rune::{El, row, text};
use serde_json::Value;

use crate::app::{App, SettingsPage};
use crate::model::{ButtonKind, CloudOp};
use crate::theme::{Theme, ui};
use crate::ui::{btn, toggle, wave};
use crate::views::settings::{group, item, note};

fn dim(t: &Theme, v: impl Into<String>) -> El {
    text(v.into()).font(ui(13.5, 400.0)).color(t.dim)
}

/// A dot and a word: green when it's on, grey when it isn't.
fn state(t: &Theme, on: bool, word: &str) -> El {
    row().gap(7.0).center_y()
        .child(rune::el().size(7.0, 7.0).radius(3.5).fill(if on { t.green } else { t.faint }))
        .child(dim(t, word))
}

pub fn groups(s: &App, t: &Theme) -> Vec<El> {
    let c = &s.data.extra.cloud;
    if c.is_null() {
        return vec![row().w_full().py(30.0).center().child(wave("Asking the engine", ui(13.5, 400.0), t.dim))];
    }
    let b = |v: &Value| v.as_bool().unwrap_or(false);
    let st = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let mut out = Vec::new();

    // Your account.
    let signed_in = b(&c["signedIn"]);
    out.push(group(t, "Account", vec![
        item(t, if signed_in { "Signed in" } else { "Not signed in" },
            Some(&if signed_in { format!("{} on {}", st(&c["email"]), st(&c["device"])) } else { "Sign in to sync with your phone, the web and the cloud.".to_owned() }),
            if signed_in { state(t, true, "Connected") } else {
                btn(t, "Sign in", None, ButtonKind::Blue).key("cloud-sign-in").on_press(|s: &mut App| s.open_settings(SettingsPage::Profile))
            }),
    ]));

    // The team and its jobs, in the account.
    let sync = &c["sync"];
    let (sync_on, sync_word) = match sync["state"].as_str() {
        Some("on") => (true, "Synced".to_owned()),
        Some("setup") => (false, "The account isn't set up for sync yet".to_owned()),
        Some("error") => (false, format!("Couldn't sync: {}", st(&sync["error"]))),
        _ => (false, if signed_in { "Waiting".to_owned() } else { "Off until you sign in".to_owned() }),
    };
    out.push(group(t, "Sync", vec![
        item(t, "Your team and its loops", Some("Agents you make and the jobs they run on a schedule, the same on this PC, your phone and the web. A job runs once, wherever it's claimed first."),
            row().gap(12.0).center_y().child(state(t, sync_on, &sync_word))
                .child(btn(t, "Sync now", Some("refresh"), ButtonKind::Plain).key("cloud-sync").on_press(|s: &mut App| s.cloud_op(CloudOp::Sync)))),
    ]));

    // The phone and the web reaching this PC.
    let phone = &c["phone"];
    let relay = b(&phone["relay"]);
    let lan = b(&phone["lan"]);
    let urls: Vec<String> = phone["urls"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|u| u.as_str().map(str::to_owned)).collect();
    let phones = phone["phones"].as_u64().unwrap_or(0);
    let mobile = st(&phone["mobileUrl"]);
    let open = mobile.clone();
    out.push(group(t, "Phone and web", vec![
        item(t, "Through your account", Some("Your phone and codeply.app reach this PC's chats, approvals and agents from anywhere, while Codeply is open."),
            state(t, relay, if relay { "On" } else if signed_in { "Connecting" } else { "Off" })),
        item(t, "On the same Wi-Fi", Some(&if urls.is_empty() { "A faster way in when your phone is on this network.".to_owned() } else { urls.join("  ") }),
            state(t, lan, if lan { "On" } else { "Off" })),
        item(t, &format!("{phones} phone{} connected", if phones == 1 { "" } else { "s" }), Some(&format!("Open {mobile} on your phone and sign in with the same account.")),
            btn(t, "Open", Some("external"), ButtonKind::Plain).key("cloud-mobile").on_press_tx(move |_: &mut App, tx| { let _ = tx.open_url(&open); })),
    ]));

    // GitHub, which Craft Cloud runs on.
    let gh = &c["github"];
    out.push(group(t, "GitHub", vec![
        item(t, if b(&gh["connected"]) { "Connected" } else { "Not connected" },
            Some(&if b(&gh["connected"]) { format!("As {}. Cloud runs happen on GitHub Actions in your own account.", st(&gh["userName"])) } else { "Craft Cloud runs on GitHub Actions in your own account: connect GitHub in Settings > Connections.".to_owned() }),
            state(t, b(&gh["connected"]), if b(&gh["connected"]) { "Ready" } else { "Needed for the cloud" })),
    ]));

    // Craft Cloud, per project.
    let projects = c["projects"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut rows = Vec::new();
    for p in projects {
        let cwd = st(&p["cwd"]);
        let name = st(&p["name"]);
        if !b(&p["ready"]) {
            let at = cwd.clone();
            rows.push(item(t, &name, Some("Not set up for the cloud yet. Codeply makes a private repo in your GitHub that holds snapshots of this project."),
                btn(t, "Set up", Some("oai-cloud"), ButtonKind::Blue).key(format!("cloud-setup/{name}")).on_press(move |s: &mut App| s.cloud_op(CloudOp::Setup(at.clone())))));
            continue;
        }
        let switch = |key: &'static str, label: &str, desc: &str| {
            let (at, on) = (cwd.clone(), b(&p[key]));
            item(t, label, Some(desc), toggle(t, format!("cloud/{name}/{key}"), on, label)
                .on_press(move |s: &mut App| s.cloud_op(CloudOp::Options(at.clone(), key, !on))))
        };
        rows.push(item(t, &name, Some(&format!("In {}.", st(&p["repo"]))), state(t, true, "Set up")));
        rows.push(switch("cloudOn", "Run new messages in the cloud", "Each new message in this project runs on GitHub's machines, so it keeps going with this PC off."));
        rows.push(switch("handoff", "Keep going in the cloud if this PC turns off", "A run here hands over to the cloud when the PC goes away, and comes back when it returns."));
        rows.push(switch("autoBackup", "Back up as you work", "The working tree goes up to the private repo a moment after each change."));
    }
    if rows.is_empty() {
        rows.push(item(t, "No projects yet", Some("Start a chat in a folder and it shows up here."), rune::el()));
    }
    out.push(group(t, "Craft Cloud", rows));
    if !b(&c["available"]) {
        out.push(note(t, "This engine can't reach the cloud libraries; reinstall Codeply if this stays."));
    }
    out
}
