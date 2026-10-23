//! # motion-core
//!
//! Codeply Motion's engine layer: FilmCraft (editing) and EffectCraft (motion graphics) in one
//! process, driven by a terse command language and replying in as few tokens as possible.

pub mod compact;
pub mod dsl;
pub mod probe;
pub mod studio;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

pub use studio::{HELP, LogEntry, Studio, Telemetry};

/// A Studio on its own thread. Cheap to clone; every caller's scripts run one at a time, in the
/// order they arrive.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<(String, mpsc::Sender<Value>)>,
    pub tele: Arc<Mutex<Telemetry>>,
}

impl Handle {
    pub fn spawn(work: PathBuf) -> Handle {
        let (tx, rx) = mpsc::channel::<(String, mpsc::Sender<Value>)>();
        let (ttx, trx) = mpsc::channel();
        std::thread::Builder::new()
            .name("motion-studio".into())
            // deep effect stacks and expression evaluation recurse; give them room
            .stack_size(64 << 20)
            .spawn(move || {
                let mut s = Studio::new(work);
                let _ = ttx.send(s.tele.clone());
                for (src, reply) in rx {
                    let _ = reply.send(s.run(&src));
                }
            })
            .unwrap_or_else(|e| panic!("cannot start the studio thread: {e}"));
        let tele = trx.recv().unwrap_or_else(|_| Arc::new(Mutex::new(Telemetry::default())));
        Handle { tx, tele }
    }

    /// Run a script and wait for its reply.
    pub fn run(&self, src: &str) -> Value {
        let (rtx, rrx) = mpsc::channel();
        if self.tx.send((src.to_string(), rtx)).is_err() {
            return json!({"ok": false, "err": "studio thread is gone"});
        }
        rrx.recv().unwrap_or_else(|_| json!({"ok": false, "err": "studio thread is gone"}))
    }
}

/// Where renders and bridge files go by default.
pub fn default_work_dir() -> PathBuf {
    std::env::var_os("MOTION_WORK").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("codeply-motion"))
}
