//! Dictation: the composer's mic records you, Whisper on Groq turns it into text, and the text
//! lands in the composer the mic belongs to. Press once to start, again to stop and transcribe.
//!
//! Recording, per platform: Windows records through MCI (winmm, which every Windows has), macOS
//! through Rune's own `Recorder`, Linux through `pw-record`, `parecord` or `arecord`, whichever is
//! installed. Each writes a 16 kHz mono WAV in `~/.codeply/rune/voice/`, deleted once it's sent.
//!
//! The key is Settings > General > Voice's "Groq API key", else `GROQ_API_KEY`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::app::{App, EditKey};

/// Groq's OpenAI-compatible transcription endpoint, and the model it runs.
#[cfg(feature = "live")]
const ENDPOINT: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
#[cfg(feature = "live")]
const MODEL: &str = "whisper-large-v3-turbo";

/// Where the mic is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    /// Recording for this composer.
    Recording(EditKey),
    /// Sent to Groq; the text goes to this composer.
    Transcribing(EditKey),
}

type Landing = Arc<Mutex<Option<(EditKey, Result<String, String>)>>>;

#[derive(Default)]
pub struct Voice {
    pub phase: Phase,
    capture: Option<Capture>,
    landed: Landing,
    waker: Option<rune::Waker>,
}

impl Voice {
    pub fn set_waker(&mut self, waker: rune::Waker) {
        self.waker = Some(waker);
    }

    pub fn recording(&self, key: EditKey) -> bool {
        self.phase == Phase::Recording(key)
    }

    pub fn transcribing(&self, key: EditKey) -> bool {
        self.phase == Phase::Transcribing(key)
    }
}

/// The Groq key: Settings' field, else the environment.
pub fn api_key(prefs: &crate::prefs::Prefs) -> Option<String> {
    let k = prefs.groq_key.trim();
    if !k.is_empty() {
        return Some(k.to_owned());
    }
    std::env::var("GROQ_API_KEY").ok().map(|k| k.trim().to_owned()).filter(|k| !k.is_empty())
}

impl App {
    /// The composer's mic: starts recording, or stops and sends what was said to Whisper.
    pub fn toggle_voice(&mut self, key: EditKey) {
        match self.voice.phase {
            Phase::Recording(k) if k == key => self.stop_voice(),
            // A recording for another composer: that one stops first, then this one starts.
            Phase::Recording(_) => {
                self.stop_voice();
                self.start_voice(key);
            }
            // Still transcribing: wait for it.
            Phase::Transcribing(_) => {}
            Phase::Idle => self.start_voice(key),
        }
    }

    fn start_voice(&mut self, key: EditKey) {
        if api_key(&self.prefs).is_none() {
            self.notice = Some("Voice needs a Groq API key: add one in Settings > General > Voice.".into());
            return;
        }
        let dir = crate::prefs::data_dir().join("voice");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            self.notice = Some(format!("Couldn't record: {e}"));
            return;
        }
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let path = dir.join(format!("dictation-{stamp}.wav"));
        match Capture::start(path) {
            Ok(c) => {
                self.voice.capture = Some(c);
                self.voice.phase = Phase::Recording(key);
                self.notice = None;
            }
            Err(e) => self.notice = Some(format!("Couldn't record: {e}")),
        }
    }

    fn stop_voice(&mut self) {
        let Phase::Recording(key) = self.voice.phase else { return };
        let Some(capture) = self.voice.capture.take() else {
            self.voice.phase = Phase::Idle;
            return;
        };
        let file = match capture.stop() {
            Ok(f) => f,
            Err(e) => {
                self.voice.phase = Phase::Idle;
                self.notice = Some(format!("Couldn't record: {e}"));
                return;
            }
        };
        let Some(api) = api_key(&self.prefs) else {
            let _ = std::fs::remove_file(&file);
            self.voice.phase = Phase::Idle;
            return;
        };
        self.voice.phase = Phase::Transcribing(key);
        let landed = self.voice.landed.clone();
        let waker = self.voice.waker.clone();
        std::thread::spawn(move || {
            let result = transcribe(&file, &api);
            let _ = std::fs::remove_file(&file);
            *landed.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, result));
            if let Some(wake) = waker {
                wake();
            }
        });
    }

    /// Called from `poll`: puts finished dictation into its composer. True when something changed.
    pub fn step_voice(&mut self) -> bool {
        let Some((key, result)) = self.voice.landed.lock().unwrap_or_else(|e| e.into_inner()).take() else { return false };
        if self.voice.phase == Phase::Transcribing(key) {
            self.voice.phase = Phase::Idle;
        }
        match result {
            Ok(said) => {
                let said = said.trim();
                if said.is_empty() {
                    self.notice = Some("Didn't catch anything. Try again a little closer to the mic.".into());
                } else {
                    let before = self.edit(key).text.trim_end().to_owned();
                    let joined = if before.is_empty() { format!("{said} ") } else { format!("{before} {said} ") };
                    self.edit_mut(key).replace_text(joined);
                    self.notice = None;
                }
            }
            Err(e) => self.notice = Some(format!("Couldn't transcribe: {e}")),
        }
        true
    }
}

/// Sends a WAV to Whisper on Groq and returns what it heard.
#[cfg(feature = "live")]
fn transcribe(file: &std::path::Path, api: &str) -> Result<String, String> {
    let audio = std::fs::read(file).map_err(|e| format!("couldn't read the recording: {e}"))?;
    if audio.len() <= 44 {
        return Err("the recording is empty; check that a microphone is connected".into());
    }
    let boundary = format!("codeply-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    let body = multipart(&boundary, &[("model", MODEL), ("response_format", "json")], "dictation.wav", "audio/wav", &audio);
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(120)).build();
    let resp = agent.post(ENDPOINT)
        .set("Authorization", &format!("Bearer {api}"))
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .send_bytes(&body);
    match resp {
        Ok(r) => {
            let v: serde_json::Value = r.into_json().map_err(|e| format!("Groq's answer didn't read: {e}"))?;
            Ok(v["text"].as_str().unwrap_or_default().to_owned())
        }
        Err(ureq::Error::Status(code, r)) => {
            let v: serde_json::Value = r.into_json().unwrap_or_default();
            let msg = v["error"]["message"].as_str().map_or_else(|| format!("status {code}"), str::to_owned);
            Err(if code == 401 { format!("Groq turned the key down ({msg}). Check it in Settings > General > Voice.") } else { msg })
        }
        Err(e) => Err(format!("couldn't reach Groq: {e}")),
    }
}

#[cfg(not(feature = "live"))]
fn transcribe(_file: &std::path::Path, _api: &str) -> Result<String, String> {
    Err("this build has no network (built without the `live` feature)".into())
}

/// A `multipart/form-data` body: text fields, then one file.
#[cfg_attr(not(feature = "live"), allow(dead_code))]
fn multipart(boundary: &str, fields: &[(&str, &str)], name: &str, mime: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 512);
    for (k, v) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

// ---------- recording ----------

/// A recording in progress, writing to `path`.
struct Capture {
    path: PathBuf,
    #[cfg(target_os = "macos")]
    rec: rune::Recorder,
    #[cfg(not(any(windows, target_os = "macos")))]
    child: std::process::Child,
}

#[cfg(windows)]
impl Capture {
    const ALIAS: &'static str = "codeply_dictation";

    fn start(path: PathBuf) -> Result<Capture, String> {
        if rune::is_headless() {
            return Err("no microphone in a headless run".into());
        }
        // A recording left open by a crash would block this one.
        let _ = mci(&format!("close {}", Self::ALIAS));
        mci(&format!("open new type waveaudio alias {}", Self::ALIAS))?;
        // 16 kHz, 16-bit mono: what Whisper works at, and small to upload.
        let set = mci(&format!("set {} time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2", Self::ALIAS));
        if let Err(e) = set.and_then(|_| mci(&format!("record {}", Self::ALIAS))) {
            let _ = mci(&format!("close {}", Self::ALIAS));
            return Err(e);
        }
        Ok(Capture { path })
    }

    fn stop(self) -> Result<PathBuf, String> {
        let _ = mci(&format!("stop {}", Self::ALIAS));
        let saved = mci(&format!("save {} \"{}\"", Self::ALIAS, self.path.display()));
        let _ = mci(&format!("close {}", Self::ALIAS));
        saved.map(|_| self.path)
    }
}

/// One MCI command string; an error comes back as MCI's own message.
#[cfg(windows)]
#[allow(unsafe_code)]
fn mci(cmd: &str) -> Result<(), String> {
    use windows_sys::Win32::Media::Multimedia::{mciGetErrorStringW, mciSendStringW};
    let wide: Vec<u16> = cmd.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call; no return buffer
    // (null, length 0) and no window to notify (null), as mciSendStringW allows.
    let err = unsafe { mciSendStringW(wide.as_ptr(), std::ptr::null_mut(), 0, std::ptr::null_mut()) };
    if err == 0 {
        return Ok(());
    }
    let mut buf = [0u16; 256];
    // SAFETY: `buf` is a writable buffer of the length given.
    let ok = unsafe { mciGetErrorStringW(err, buf.as_mut_ptr(), buf.len() as u32) };
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let msg = if ok != 0 { String::from_utf16_lossy(&buf[..len]) } else { format!("MCI error {err}") };
    Err(if msg.is_empty() { format!("MCI error {err}") } else { msg })
}

#[cfg(target_os = "macos")]
impl Capture {
    fn start(path: PathBuf) -> Result<Capture, String> {
        let rec = rune::Recorder::to_file(&path);
        rec.start();
        if let rune::RecorderState::Failed(e) = rec.state() {
            return Err(e);
        }
        Ok(Capture { path, rec })
    }

    fn stop(self) -> Result<PathBuf, String> {
        self.rec.stop().map(|r| r.path).or_else(|e| if self.path.exists() { Ok(self.path) } else { Err(e) })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl Capture {
    fn start(path: PathBuf) -> Result<Capture, String> {
        use std::process::{Command, Stdio};
        if rune::is_headless() {
            return Err("no microphone in a headless run".into());
        }
        let p = path.to_string_lossy().into_owned();
        let tries: [(&str, Vec<&str>); 3] = [
            ("pw-record", vec!["--rate", "16000", "--channels", "1", "--format", "s16", &p]),
            ("parecord", vec!["--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav", &p]),
            ("arecord", vec!["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", &p]),
        ];
        for (prog, args) in tries {
            if let Ok(child) = Command::new(prog).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
                return Ok(Capture { path, child });
            }
        }
        Err("no recorder found; install PipeWire (pw-record), PulseAudio (parecord) or ALSA (arecord)".into())
    }

    fn stop(mut self) -> Result<PathBuf, String> {
        // SIGINT lets the recorder finish the WAV header; kill it if it doesn't stop.
        let _ = std::process::Command::new("kill").args(["-INT", &self.child.id().to_string()]).status();
        for _ in 0..40 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return Ok(self.path);
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if self.path.exists() { Ok(self.path) } else { Err("the recorder didn't write a file".into()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_has_the_fields_and_the_file() {
        let body = multipart("b", &[("model", "whisper")], "a.wav", "audio/wav", b"RIFF");
        let s = String::from_utf8(body).unwrap();
        assert!(s.starts_with("--b\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper\r\n"));
        assert!(s.contains("name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n--b--\r\n"));
    }

    #[test]
    fn the_mic_asks_for_a_key_first() {
        let mut app = App::with_mock();
        app.prefs.groq_key.clear();
        if std::env::var("GROQ_API_KEY").is_ok() {
            return;
        }
        app.toggle_voice(EditKey::ChatHome);
        assert_eq!(app.voice.phase, Phase::Idle);
        assert!(app.notice.as_deref().is_some_and(|n| n.contains("Groq API key")));
    }

    #[test]
    fn dictation_lands_in_its_composer() {
        let mut app = App::with_mock();
        app.edit_mut(EditKey::ChatHome).replace_text("Build");
        app.voice.phase = Phase::Transcribing(EditKey::ChatHome);
        *app.voice.landed.lock().unwrap() = Some((EditKey::ChatHome, Ok(" a landing page".into())));
        assert!(app.step_voice());
        assert_eq!(app.voice.phase, Phase::Idle);
        assert_eq!(app.edit(EditKey::ChatHome).text, "Build a landing page ");
    }
}
