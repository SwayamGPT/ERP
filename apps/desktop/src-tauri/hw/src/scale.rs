use std::io::Read;
use std::time::{Duration, Instant};

/// A reading from the scale, in kilograms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub kg: f64,
    pub stable: bool,
}

/// Understand the common continuous-output formats of retail scales:
/// `ST,GS,+  1.250kg`, `US,GS,  0.98 kg` (unstable), `  1250 g`, `W: 1.250`, `+001.250`.
pub fn parse_line(line: &str) -> Option<Reading> {
    // STX/ETX framing and other control bytes some scales wrap each reading in.
    let cleaned: String = line.chars().filter(|c| !c.is_control()).collect();
    let l = cleaned.trim();
    if l.is_empty() {
        return None;
    }
    // At the wrong baud rate a port gives junk: refuse lines that are mostly not plain text.
    let printable = l.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').count();
    if printable * 10 < l.chars().count() * 8 {
        return None;
    }
    let upper = l.to_ascii_uppercase();
    let stable = !(upper.starts_with("US") || upper.contains("UNSTABLE") || upper.contains("MOTION"));
    let start = l.find(|c: char| c.is_ascii_digit())?;
    let num: String = l[start..].chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    let num = num.trim_end_matches([',', '.']).to_string();
    // "1,250 kg" from scales set to a comma decimal; "1,250.5" keeps the comma as a thousands mark.
    let as_number = if num.contains(',') && !num.contains('.') && num.matches(',').count() == 1 { num.replace(',', ".") } else { num.replace(',', "") };
    let mut v: f64 = as_number.parse().ok()?;
    let rest = upper[start + num.len()..].trim_start();
    let neg = l[..start].trim_end().ends_with('-');
    if rest.starts_with('G') && !rest.starts_with("GS") {
        v /= 1000.0; // grams
    } else if rest.starts_with("LB") {
        v *= 0.453_592_37;
    }
    if neg {
        v = -v;
    }
    Some(Reading { kg: (v * 1000.0).round() / 1000.0, stable })
}

/// Serial ports present on this computer.
#[cfg(not(target_os = "android"))]
pub fn list_ports() -> Vec<String> {
    serialport::available_ports().map(|v| v.into_iter().map(|p| p.port_name).collect()).unwrap_or_default()
}

/// Phones have no serial ports.
#[cfg(target_os = "android")]
pub fn list_ports() -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "android")]
pub fn read(_port: &str, _baud: u32, _wait: Duration, _request: Option<&[u8]>) -> Result<Reading, String> {
    Err("Weighing scales connect to the shop computer, not the phone.".into())
}

/// Read the scale for up to `wait`: returns the first stable reading seen twice in a row, else the last one.
#[cfg(not(target_os = "android"))]
pub fn read(port: &str, baud: u32, wait: Duration, request: Option<&[u8]>) -> Result<Reading, String> {
    let mut p = serialport::new(port, baud).timeout(Duration::from_millis(200)).open().map_err(|e| format!("Cannot open the scale on {port}: {e}"))?;
    if let Some(req) = request {
        p.write_all(req).map_err(|e| e.to_string())?;
    }
    read_from(&mut p, wait)
}

/// What "Find my scale" found.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub port: String,
    pub baud: u32,
    pub request: Option<String>,
    pub reading: Reading,
}

/// Common speeds of shop scales, most common first.
pub const BAUDS: [u32; 6] = [9600, 2400, 4800, 19200, 1200, 38400];
/// What scales that only answer when asked expect.
pub const REQUESTS: [&str; 3] = ["W", "P\r", "\x05"];

/// Two matching readings in a row within `wait`, or nothing: used when guessing settings, where a
/// single lucky line of junk must not count.
pub fn read_confirmed<R: Read>(src: &mut R, wait: Duration) -> Option<Reading> {
    let t0 = Instant::now();
    let mut buf = Vec::new();
    let mut last: Option<Reading> = None;
    let mut chunk = [0u8; 256];
    while t0.elapsed() < wait {
        match src.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => return None,
        }
        while let Some(pos) = buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(r) = parse_line(&String::from_utf8_lossy(&line)) {
                if last.map_or(false, |p| (p.kg - r.kg).abs() < 0.0005) {
                    return Some(r);
                }
                last = Some(r);
            }
        }
        if buf.len() > 4096 {
            return None; // a torrent of bytes with no line ends: wrong settings
        }
    }
    None
}

/// Try every port × speed, first listening (most scales send all the time), then asking with the
/// usual request bytes. `open(port, baud, request)` opens the port and sends the request.
pub fn find_with<R: Read>(ports: &[String], per_try: Duration, mut open: impl FnMut(&str, u32, Option<&str>) -> Result<R, String>) -> Option<Found> {
    let requests: Vec<Option<&str>> = std::iter::once(None).chain(REQUESTS.iter().map(|r| Some(*r))).collect();
    for req in &requests {
        for port in ports {
            for baud in BAUDS {
                let Ok(mut src) = open(port, baud, *req) else { continue };
                if let Some(reading) = read_confirmed(&mut src, per_try) {
                    return Some(Found { port: port.clone(), baud, request: req.map(str::to_string), reading });
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "android"))]
pub fn find(per_try: Duration) -> Option<Found> {
    let ports = list_ports();
    find_with(&ports, per_try, |port, baud, req| {
        let mut p = serialport::new(port, baud).timeout(Duration::from_millis(100)).open().map_err(|e| e.to_string())?;
        if let Some(r) = req {
            p.write_all(r.as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok(p)
    })
}

#[cfg(target_os = "android")]
pub fn find(_per_try: Duration) -> Option<Found> {
    None
}

/// The reading loop, on any byte source (tests use a fake one).
pub fn read_from<R: Read>(src: &mut R, wait: Duration) -> Result<Reading, String> {
    let t0 = Instant::now();
    let mut buf = Vec::new();
    let mut last: Option<Reading> = None;
    let mut chunk = [0u8; 256];
    while t0.elapsed() < wait {
        match src.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => return Err(e.to_string()),
        }
        while let Some(pos) = buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(r) = parse_line(&String::from_utf8_lossy(&line)) {
                if r.stable && last.map_or(false, |p| p.stable && (p.kg - r.kg).abs() < 0.0005) {
                    return Ok(r);
                }
                last = Some(r);
            }
        }
    }
    last.ok_or_else(|| "No weight from the scale. Check the cable, port and baud rate.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_scale_formats() {
        assert_eq!(parse_line("ST,GS,+  1.250kg"), Some(Reading { kg: 1.25, stable: true }));
        assert_eq!(parse_line("US,GS,+  0.980kg"), Some(Reading { kg: 0.98, stable: false }));
        assert_eq!(parse_line("  1250 g"), Some(Reading { kg: 1.25, stable: true }));
        assert_eq!(parse_line("W: 0.755"), Some(Reading { kg: 0.755, stable: true }));
        assert_eq!(parse_line("+001.500"), Some(Reading { kg: 1.5, stable: true }));
        assert_eq!(parse_line("ST,NT,-  0.020kg"), Some(Reading { kg: -0.02, stable: true }));
        assert_eq!(parse_line("2.2 lb").map(|r| r.kg), Some(0.998));
        assert_eq!(parse_line("ERR"), None);
        assert_eq!(parse_line("\x02ST,GS, 1.234kg\x03"), Some(Reading { kg: 1.234, stable: true }));
        assert_eq!(parse_line("W1.234"), Some(Reading { kg: 1.234, stable: true }));
        assert_eq!(parse_line("+0001.234"), Some(Reading { kg: 1.234, stable: true }));
        assert_eq!(parse_line("   1234 g"), Some(Reading { kg: 1.234, stable: true }));
        assert_eq!(parse_line("1,250 kg"), Some(Reading { kg: 1.25, stable: true }));
        assert_eq!(parse_line("N.W. 2.500 KG"), Some(Reading { kg: 2.5, stable: true }));
        // Junk from the wrong baud rate
        assert_eq!(parse_line("\u{fffd}\u{fffd}3\u{fffd}\u{fffd}\u{fffd}"), None);
    }

    #[test]
    fn finds_the_scale_by_trying_speeds() {
        // The scale is on COM4 at 2400 baud and only answers when sent "W".
        let ports = vec!["COM3".to_string(), "COM4".to_string()];
        let mut tries = 0;
        let found = find_with(&ports, Duration::from_millis(50), |port, baud, req| {
            tries += 1;
            let data: &'static [u8] = if port == "COM4" && baud == 2400 && req == Some("W") {
                b"ST,GS,+  0.500kg\r\nST,GS,+  0.500kg\r\n"
            } else if port == "COM4" {
                b"\xff\xfe\x13\x99\r\n\x80\x81\r\n" // junk at the wrong speed
            } else {
                b""
            };
            Ok(data)
        })
        .unwrap();
        assert_eq!((found.port.as_str(), found.baud, found.request.as_deref()), ("COM4", 2400, Some("W")));
        assert_eq!(found.reading.kg, 0.5);
        assert!(tries > 6);
        // Nothing there at all
        assert!(find_with(&ports, Duration::from_millis(10), |_, _, _| Ok(&b""[..])).is_none());
    }

    #[test]
    fn waits_for_a_steady_weight() {
        let data = b"US,GS,+  0.400kg\r\nUS,GS,+  0.730kg\r\nST,GS,+  0.750kg\r\nST,GS,+  0.750kg\r\nST,GS,+  0.900kg\r\n";
        let r = read_from(&mut &data[..], Duration::from_secs(1)).unwrap();
        assert_eq!(r, Reading { kg: 0.75, stable: true });
        assert!(read_from(&mut &b""[..], Duration::from_millis(50)).is_err());
    }
}
