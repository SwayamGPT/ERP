//! "Phones on Wi-Fi": a small HTTP server on the shop's local network.
//!
//! * `GET /…` serves the app's own files (so a phone browser can open `http://<computer>:8787`),
//!   with a marker in `index.html` that makes the page talk to this computer instead of keeping a
//!   database of its own.
//! * `POST /api/<op>` hands the JSON body to `relay` (the desktop app forwards it to its web view,
//!   where the shop's database lives) and returns the answer.
//!
//! The server knows nothing about the shop's data or users: pairing, sign-in and permissions are
//! checked by the app. It only limits request sizes and how often one address may try to pair.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tiny_http::{Header, Request, Response, Server};

/// Looks up one of the app's files: `(bytes, mime type)`.
pub type Assets = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;
/// Answers one API request: `(op, json body) -> json reply`.
pub type Relay = Arc<dyn Fn(&str, String) -> Result<String, String> + Send + Sync>;

const MAX_BODY: usize = 4 << 20;
/// Marker the page looks for (an inline script would be blocked by the app's content policy).
pub const LAN_MARKER: &str = r#"<meta name="hisaab-lan" content="1">"#;

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Api(String),
    File(String),
    Preflight,
    NotFound,
}

/// What a request is for. Only known API names and plain file paths are accepted.
pub fn route(method: &str, url: &str) -> Route {
    let path = url.split(['?', '#']).next().unwrap_or("/");
    if method == "OPTIONS" {
        return Route::Preflight;
    }
    if let Some(op) = path.strip_prefix("/api/") {
        return if method == "POST" && matches!(op, "pair" | "call" | "ping" | "print") { Route::Api(op.to_string()) } else { Route::NotFound };
    }
    if method != "GET" && method != "HEAD" {
        return Route::NotFound;
    }
    let file = path.trim_start_matches('/');
    if file.split('/').any(|p| p == ".." || p.starts_with('.')) {
        return Route::NotFound;
    }
    Route::File(if file.is_empty() { "index.html".into() } else { file.to_string() })
}

/// Add the phone marker to the app's index.html.
pub fn mark_index(html: &str) -> String {
    match html.find("<head>") {
        Some(i) => format!("{}{}{}", &html[..i + 6], LAN_MARKER, &html[i + 6..]),
        None => format!("{LAN_MARKER}{html}"),
    }
}

/// At most `max` attempts per address in each `window`.
pub struct RateLimit {
    max: usize,
    window: Duration,
    hits: Mutex<HashMap<IpAddr, Vec<Instant>>>,
}

impl RateLimit {
    pub fn new(max: usize, window: Duration) -> Self {
        RateLimit { max, window, hits: Mutex::new(HashMap::new()) }
    }
    pub fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut m = crate::guard::lock(&self.hits);
        let v = m.entry(ip).or_default();
        v.retain(|t| now.duration_since(*t) < self.window);
        if v.len() >= self.max {
            return false;
        }
        v.push(now);
        true
    }
}

/// This computer's address on the local network (what phones should open). No packet is sent.
pub fn local_addresses() -> Vec<String> {
    let mut out = Vec::new();
    for probe in ["192.168.0.1:80", "10.0.0.1:80", "8.8.8.8:80"] {
        if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
            if s.connect(probe).is_ok() {
                if let Ok(a) = s.local_addr() {
                    let ip = a.ip().to_string();
                    if !a.ip().is_loopback() && !a.ip().is_unspecified() && !out.contains(&ip) {
                        out.push(ip);
                    }
                }
            }
        }
    }
    out
}

pub struct LanServer {
    server: Arc<Server>,
    pub port: u16,
    thread: Option<JoinHandle<()>>,
}

impl LanServer {
    /// Listen on every network interface at `port` (0 = any free port, for tests).
    pub fn start(port: u16, assets: Assets, relay: Relay) -> Result<LanServer, String> {
        let server = Server::http(("0.0.0.0", port)).map_err(|e| format!("Could not open port {port} for phones ({e}). Is another program using it? Try another port."))?;
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
        let server = Arc::new(server);
        let s2 = server.clone();
        let pairing = Arc::new(RateLimit::new(10, Duration::from_secs(60)));
        let thread = std::thread::spawn(move || {
            for req in s2.incoming_requests() {
                let (assets, relay, pairing) = (assets.clone(), relay.clone(), pairing.clone());
                std::thread::spawn(move || handle(req, &assets, &relay, &pairing));
            }
        });
        Ok(LanServer { server, port, thread: Some(thread) })
    }

    pub fn stop(mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn cors<R: Read>(r: Response<R>) -> Response<R> {
    // The Android app's pages come from its own origin, so the API answers any origin. Every
    // request still needs a paired phone's token.
    r.with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(header("Access-Control-Allow-Headers", "content-type"))
}

fn json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    cors(Response::from_data(body.into_bytes()).with_status_code(status).with_header(header("Content-Type", "application/json")).with_header(header("Cache-Control", "no-store")))
}

fn error(status: u16, code: &str, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let msg = message.replace('\\', "\\\\").replace('"', "\\\"");
    json(status, format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"{msg}"}}}}"#))
}

fn handle(mut req: Request, assets: &Assets, relay: &Relay, pairing: &RateLimit) {
    let method = req.method().to_string();
    let url = req.url().to_string();
    let ip = req.remote_addr().map(|a| a.ip());
    let resp = match route(&method, &url) {
        Route::Preflight => cors(Response::from_data(Vec::new()).with_status_code(204)),
        Route::NotFound => error(404, "NOT_FOUND", "Not found."),
        Route::File(path) => {
            let found = assets(&path).or_else(|| if path.contains('.') { None } else { assets("index.html") });
            match found {
                Some((bytes, mime)) => {
                    let bytes = if mime.starts_with("text/html") { mark_index(&String::from_utf8_lossy(&bytes)).into_bytes() } else { bytes };
                    let cache = if mime.starts_with("text/html") { "no-cache" } else { "public, max-age=31536000, immutable" };
                    Response::from_data(bytes).with_header(header("Content-Type", &mime)).with_header(header("Cache-Control", cache))
                }
                None => error(404, "NOT_FOUND", "Not found."),
            }
        }
        Route::Api(op) => {
            if op == "pair" && ip.is_some_and(|ip| !pairing.allow(ip)) {
                error(429, "SLOW_DOWN", "Too many pairing attempts. Wait a minute and try again.")
            } else if req.body_length().unwrap_or(0) > MAX_BODY {
                error(413, "TOO_BIG", "Request too large.")
            } else {
                let mut body = String::new();
                match req.as_reader().take(MAX_BODY as u64 + 1).read_to_string(&mut body) {
                    Ok(n) if n <= MAX_BODY => match relay(&op, body) {
                        Ok(reply) => json(200, reply),
                        Err(e) => error(503, "UNAVAILABLE", &e),
                    },
                    _ => error(400, "BAD_REQUEST", "Could not read the request."),
                }
            }
        }
    };
    let _ = req.respond(resp);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    #[test]
    fn routes_only_known_things() {
        assert_eq!(route("POST", "/api/call"), Route::Api("call".into()));
        assert_eq!(route("GET", "/api/call"), Route::NotFound);
        assert_eq!(route("POST", "/api/shutdown"), Route::NotFound);
        assert_eq!(route("GET", "/"), Route::File("index.html".into()));
        assert_eq!(route("GET", "/assets/app.js?v=1"), Route::File("assets/app.js".into()));
        assert_eq!(route("GET", "/../secret"), Route::NotFound);
        assert_eq!(route("GET", "/.env"), Route::NotFound);
        assert_eq!(route("OPTIONS", "/api/call"), Route::Preflight);
        assert_eq!(route("DELETE", "/x"), Route::NotFound);
    }

    #[test]
    fn marks_index() {
        assert_eq!(mark_index("<html><head><title>x</title></head>"), format!("<html><head>{LAN_MARKER}<title>x</title></head>"));
    }

    #[test]
    fn rate_limits_per_address() {
        let r = RateLimit::new(2, Duration::from_secs(60));
        let a: IpAddr = "192.168.1.9".parse().unwrap();
        let b: IpAddr = "192.168.1.10".parse().unwrap();
        assert!(r.allow(a) && r.allow(a));
        assert!(!r.allow(a));
        assert!(r.allow(b));
    }

    fn http(port: u16, raw: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn serves_files_and_relays_api_calls() {
        let assets: Assets = Arc::new(|p: &str| match p {
            "index.html" => Some((b"<html><head></head><body>app</body></html>".to_vec(), "text/html".into())),
            "assets/a.js" => Some((b"console.log(1)".to_vec(), "text/javascript".into())),
            _ => None,
        });
        let relay: Relay = Arc::new(|op: &str, body: String| Ok(format!(r#"{{"ok":true,"result":{{"op":"{op}","len":{}}}}}"#, body.len())));
        let srv = LanServer::start(0, assets, relay).unwrap();
        let port = srv.port;

        let page = http(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains(LAN_MARKER));
        // deep links fall back to the app
        assert!(http(port, "GET /sales/5 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").contains("app"));
        assert!(http(port, "GET /assets/a.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").contains("console.log"));
        assert!(http(port, "GET /missing.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").starts_with("HTTP/1.1 404"));

        let body = r#"{"op":"ping"}"#;
        let api = http(port, &format!("POST /api/ping HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        assert!(api.starts_with("HTTP/1.1 200"), "{api}");
        assert!(api.contains(r#""op":"ping""#) && api.contains(&format!(r#""len":{}"#, body.len())));
        assert!(api.to_ascii_lowercase().contains("access-control-allow-origin: *"));

        // pairing is rate limited per address
        let pair = |_: usize| http(port, "POST /api/pair HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        let codes: Vec<bool> = (0..12).map(|i| pair(i).starts_with("HTTP/1.1 429")).collect();
        assert!(!codes[0] && codes[11]);
        srv.stop();
    }
}
