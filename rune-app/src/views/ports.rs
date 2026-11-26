//! The Ports tab of the terminal pane, as VS Code's Ports panel: the ports dev servers in the
//! terminal said they listen on, Live Server's, and the ones you added; each opens in the
//! browser, copies its link, or is shared outside this computer through a tunnel.

use rune::{Color, El, ScrollSpec, col, el, row, text, text_input};

use crate::app::{App, EditKey};
use crate::icons::ico_s;
use crate::model::ButtonKind;
use crate::theme::{Theme, mono, ui};
use crate::ui::{btn, wave};

/// A small icon button for a port's row.
fn act(t: &Theme, key: String, icon: &str, label: &str) -> El {
    el().key(key).size(28.0, 28.0).radius(7.0).continuous_corners().center().hover(t.hover).role("button").label(label.to_owned()).help(label.to_owned())
        .child(ico_s(icon, 15.0, t.dim))
}

pub fn panel(s: &App, t: &Theme) -> El {
    let ports = &s.data.extra.ports;
    let rows: Vec<El> = s.port_rows().into_iter().map(|r| {
        let port = r.port;
        let local = format!("http://localhost:{port}");
        let fwd = ports.forwards.iter().find(|f| f.port == port);
        let shared = fwd.is_some_and(|f| f.state != "error");
        let public = fwd.filter(|f| f.state == "open").map(|f| f.url.clone());
        let (open_url, copy_url) = (local.clone(), public.clone().unwrap_or_else(|| local.clone()));
        let main = row().w_full().gap(10.0).center_y()
            .child(el().size(7.0, 7.0).radius(3.5).fill(if r.what == "Added by you" { t.faint } else { t.green }))
            .child(text(port.to_string()).font(mono(13.0, 19.0)).color(t.text).w(52.0))
            .child(text(local.clone()).font(mono(12.5, 19.0)).color(t.dim).w(190.0).truncate())
            .child(text(r.what.clone()).font(ui(12.5, 400.0)).color(t.faint).grow(1.0).min_w(0.0).truncate())
            .child(act(t, format!("port-open/{port}"), "globe", "Open in browser").on_press(move |s: &mut App| s.browse(&open_url)))
            .child(act(t, format!("port-copy/{port}"), "copy", if public.is_some() { "Copy public link" } else { "Copy link" })
                .on_press_tx(move |_: &mut App, tx| tx.copy(copy_url.clone())))
            .child(if shared {
                act(t, format!("port-unshare/{port}"), "stop", "Stop sharing").on_press(move |s: &mut App| s.unshare_port(port))
            } else {
                act(t, format!("port-share/{port}"), "link", "Share outside this computer").on_press(move |s: &mut App| s.share_port(port))
            })
            .child(act(t, format!("port-remove/{port}"), "close", "Remove").on_press(move |s: &mut App| s.remove_port(port)));
        // The tunnel, under its port: starting, its public address, or what went wrong.
        let sub = fwd.map(|f| {
            let line = row().w_full().pl(17.0).gap(8.0).center_y();
            match f.state.as_str() {
                "open" => {
                    let u = f.url.clone();
                    line.child(ico_s("external", 13.0, t.accent))
                        .child(text(f.url.clone()).font(mono(12.5, 18.0)).color(t.accent).truncate().min_w(0.0).selectable(true))
                        .child(text(f.message.clone()).font(ui(12.0, 400.0)).color(t.faint).truncate().grow(1.0).min_w(0.0))
                        .child(act(t, format!("port-open-public/{port}"), "arrow-up-right", "Open the public link").on_press(move |s: &mut App| s.browse(&u)))
                }
                "starting" => line.child(wave("Starting a tunnel", ui(12.5, 400.0), t.dim)),
                _ => line.child(text(f.message.clone()).font(ui(12.5, 400.0)).color(t.red).wrap().grow(1.0).min_w(0.0)),
            }
        });
        col().key(format!("port/{port}")).w_full().px(12.0).py(5.0).gap(2.0).border_sides([0.0, 0.0, 1.0, 0.0], t.border)
            .child(main)
            .children(sub)
    }).collect();
    let empty = rows.is_empty().then(|| {
        col().px(12.0).py(14.0).gap(4.0)
            .child(text("No ports yet").font(ui(13.0, 500.0)).color(t.text))
            .child(text("Start a dev server with Run and its port shows here. You can also add one.").font(ui(12.5, 400.0)).color(t.faint).wrap())
    });

    let add = row().w_full().px(12.0).py(8.0).gap(8.0).center_y().border_sides([1.0, 0.0, 0.0, 0.0], t.border)
        .child(row().grow(1.0).min_w(0.0).max_w(260.0).h(30.0).px(10.0).radius(8.0).continuous_corners().clip_rounded(8.0).center_y().fill(t.field).border(1.0, t.field_border)
            .child(text_input(s.edit(EditKey::PortAdd), mono(12.5, 18.0)).key("port-add").single_line().grow(1.0).min_w(0.0).color(t.text)
                .placeholder("Add a port, like 3000", t.faint).caret(t.accent, t.accent.alpha(0.3)).label("Add a port")
                .on_edit(|s: &mut App| s.edit_mut(EditKey::PortAdd))
                .on_submit(|s: &mut App, _| s.add_port())))
        .child(btn(t, "Add", Some("plus"), ButtonKind::Plain).key("port-add-button").on_press(|s: &mut App| s.add_port()))
        .child(el().grow(1.0))
        .children((ports.tools == Some((false, false))).then(|| {
            text("Sharing needs cloudflared or OpenSSH.").font(ui(12.0, 400.0)).color(t.faint).truncate().help(
                "Install cloudflared (Windows: winget install --id Cloudflare.cloudflared, Mac: brew install cloudflared), or OpenSSH for localhost.run.".to_owned())
        }));
    let error = (!ports.error.is_empty()).then(|| {
        row().w_full().px(12.0).py(6.0).gap(8.0).center_y()
            .child(text(ports.error.clone()).font(ui(12.5, 400.0)).color(t.red).wrap().grow(1.0).min_w(0.0))
            .child(act(t, "ports-error-close".into(), "close", "Dismiss").on_press(|s: &mut App| s.data.extra.ports.error.clear()))
    });
    col().key("ports-pane").w_full().grow(1.0).min_h(0.0).fill(Color::TRANSPARENT)
        .child(col().w_full().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).children(empty).children(rows))
        .children(error)
        .child(add)
}
