//! A whole agent session through both engines: the regression test for engine upgrades.

use reel_core::Studio;
use serde_json::Value;

fn ok(s: &mut Studio, script: &str) -> Value {
    let r = s.run(script);
    assert_eq!(r["ok"], true, "{script}\n→ {r}");
    r["r"].clone()
}

#[test]
fn title_comp_goes_through_the_bridge_and_exports() {
    let dir = std::env::temp_dir().join(format!("reel-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = Studio::new(dir.join("work"));

    ok(&mut s, "cut.file.newSequence width=640 height=360 name=Main");
    ok(&mut s, "fx.comp.new name=Title width=640 height=360 duration=2 frameRate=24 ; fx.layer.newSolid color=#1a2b6d ; fx.layer.newText text=\"REEL\" size=90 fill=#ffffff");

    let fx = ok(&mut s, "reel.probe comp=Title t=1");
    assert!(fx["white"].as_f64().unwrap() > 0.5, "title text is visible: {fx}");
    assert!(fx.get("note").is_none(), "not black or flat: {fx}");

    ok(&mut s, "reel.state _select=rev");
    let bridged = ok(&mut s, "reel.fx2cut comp=Title track=V1");
    assert!(bridged["item"].is_number(), "{bridged}");

    // the cut shows the same picture the comp rendered
    let cut = ok(&mut s, "reel.probe engine=cut t=1");
    let same = ok(&mut s, &format!("reel.compare a={} b={}", fx["hash"].as_str().unwrap(), cut["hash"].as_str().unwrap()));
    assert_eq!(same["same"], true, "fx {fx}\ncut {cut}");

    // the diff reports the new clip by id, not the whole sequence
    let d = ok(&mut s, "reel.diff");
    let paths: Vec<&str> = d["changes"].as_array().unwrap().iter().filter_map(|c| c[0].as_str()).collect();
    assert!(paths.iter().any(|p| p.contains("items.[clip=")), "{d}");

    // refs carry results between steps; a razor through the clip makes two
    ok(&mut s, "cut.sequence.inspect _select=duration ; cut.timeline.razor seconds=1");
    let clips = ok(&mut s, "cut.sequence.inspect _select=video.*.items.*.clip");
    let n: usize = clips["video"].as_array().unwrap().iter().map(|t| t.get("items").and_then(Value::as_array).map_or(0, Vec::len)).sum();
    assert_eq!(n, 2, "{clips}");

    let out = dir.join("out.mp4");
    let e = ok(&mut s, &format!("cut.file.exportMedia path={} wait=true _select=result.frames", serde_json::to_string(&out).unwrap()));
    assert!(e["result"]["frames"].as_u64().unwrap() > 0, "{e}");
    assert!(std::fs::metadata(&out).unwrap().len() > 1000);

    // the workspace round-trips
    let ws = dir.join("ws");
    ok(&mut s, &format!("reel.save dir={}", serde_json::to_string(&ws).unwrap()));
    let mut s2 = Studio::new(dir.join("work2"));
    ok(&mut s2, &format!("reel.open dir={}", serde_json::to_string(&ws).unwrap()));
    let again = ok(&mut s2, "reel.probe comp=Title t=1");
    assert_eq!(again["hash"], fx["hash"]);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn failures_stop_the_script_and_say_where() {
    let mut s = Studio::new(std::env::temp_dir().join("reel-e2e-fail"));
    let r = s.run("fx.comp.new name=A ; timeline.razor seconds=1 ; fx.layer.newNull");
    assert_eq!(r["ok"], false);
    assert_eq!(r["at"], 2);
    assert!(r["err"].as_str().unwrap().contains("no sequence"), "{r}");
    assert_eq!(r["r"].as_array().unwrap().len(), 1);

    let r = s.run("file.import paths=[/x.mp4]");
    assert!(r["err"].as_str().unwrap().contains("both engines"), "{r}");

    let r = s.run("timeline.razr");
    assert!(r["err"].as_str().unwrap().contains("did you mean"), "{r}");
}
