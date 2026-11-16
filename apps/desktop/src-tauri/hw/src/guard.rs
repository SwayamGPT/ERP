//! Keep cheap, misbehaving hardware from taking the shop counter down.
//!
//! Every device call runs through [`guarded`]: on its own thread, with a hard deadline, and with
//! panics caught. A printer driver that hangs, a serial port that blocks forever or a bug that
//! panics becomes a plain error message for the bill screen — the app and the sale carry on.
//! Every call is also written to a small in-memory log ([`events`]) shown in Settings → Hardware →
//! Diagnostics, so support can see what the printer or scale actually did.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// One hardware call, for the diagnostics page.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    /// Milliseconds since 1970.
    pub at: u64,
    pub device: String,
    pub ok: bool,
    pub detail: String,
    pub ms: u64,
}

const KEEP: usize = 50;

fn log() -> &'static Mutex<VecDeque<Event>> {
    static LOG: OnceLock<Mutex<VecDeque<Event>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(KEEP)))
}

/// Lock a mutex even if a thread panicked while holding it (the data is still usable for us).
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn record(device: &str, ok: bool, detail: impl Into<String>, ms: u64) {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut l = lock(log());
    if l.len() == KEEP {
        l.pop_front();
    }
    l.push_back(Event { at, device: device.to_string(), ok, detail: detail.into(), ms });
}

/// The last 50 hardware calls, newest first.
pub fn events() -> Vec<Event> {
    lock(log()).iter().rev().cloned().collect()
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "unknown error".into())
}

/// Run `f` on its own thread with a deadline. Panics and hangs become errors; the result is logged
/// under `device`. A call that overruns is abandoned (its thread finishes or dies on its own).
pub fn guarded<T, F>(device: &str, deadline: Duration, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let t0 = Instant::now();
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name(format!("hw-{device}")).spawn(move || {
        let r = catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|p| Err(format!("The device driver crashed ({}).", panic_text(p.as_ref()))));
        let _ = tx.send(r);
    });
    let out = match spawned {
        Err(e) => Err(format!("Could not start the {device} job: {e}")),
        Ok(_) => match rx.recv_timeout(deadline) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("The {device} did not respond within {} s. Check it is switched on and connected.", deadline.as_secs().max(1))),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("The {device} job stopped unexpectedly.")),
        },
    };
    let ms = t0.elapsed().as_millis() as u64;
    match &out {
        Ok(_) => record(device, true, "ok", ms),
        Err(e) => record(device, false, e.clone(), ms),
    }
    out
}

/// Try `f` up to `attempts` times, waiting `backoff`, 2×`backoff`, … between tries.
/// `retry_if` decides whether an error is worth retrying (e.g. "printer busy" yes, "no such printer" no).
pub fn retry<T>(attempts: u32, backoff: Duration, retry_if: impl Fn(&str) -> bool, mut f: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut last = String::new();
    for i in 0..attempts.max(1) {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let again = retry_if(&e);
                last = e;
                if !again || i + 1 == attempts {
                    break;
                }
                std::thread::sleep(backoff * (i + 1));
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_panic_becomes_an_error() {
        let r: Result<(), String> = guarded("printer", Duration::from_secs(2), || panic!("bad bytes"));
        let e = r.unwrap_err();
        assert!(e.contains("crashed") && e.contains("bad bytes"), "{e}");
        assert!(events().iter().any(|ev| !ev.ok && ev.detail.contains("bad bytes")));
    }

    #[test]
    fn a_hang_hits_the_deadline() {
        let t0 = Instant::now();
        let r: Result<(), String> = guarded("scale", Duration::from_millis(200), || {
            std::thread::sleep(Duration::from_secs(5));
            Ok(())
        });
        assert!(r.unwrap_err().contains("did not respond"));
        assert!(t0.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn passes_results_through() {
        assert_eq!(guarded("printer", Duration::from_secs(1), || Ok(7)).unwrap(), 7);
    }

    #[test]
    fn retries_only_what_is_worth_retrying() {
        let n = Arc::new(AtomicU32::new(0));
        let c = n.clone();
        let r = retry(3, Duration::from_millis(1), |_| true, move || if c.fetch_add(1, Ordering::SeqCst) < 2 { Err("busy".to_string()) } else { Ok("printed") });
        assert_eq!(r.unwrap(), "printed");
        assert_eq!(n.load(Ordering::SeqCst), 3);

        let m = AtomicU32::new(0);
        let r: Result<(), String> = retry(3, Duration::from_millis(1), |e| !e.contains("not found"), || {
            m.fetch_add(1, Ordering::SeqCst);
            Err("printer not found".into())
        });
        assert!(r.is_err());
        assert_eq!(m.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn poisoned_locks_still_work() {
        let m = Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert_eq!(*lock(&m), 1);
    }

    #[test]
    fn keeps_only_the_last_fifty() {
        for i in 0..60 {
            record("test", true, format!("n{i}"), 0);
        }
        let ev = events();
        assert!(ev.len() <= KEEP);
        assert_eq!(ev.iter().find(|e| e.device == "test").unwrap().detail, "n59");
    }
}
