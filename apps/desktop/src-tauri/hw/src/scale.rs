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
    let l = line.trim();
    if l.is_empty() {
        return None;
    }
    let upper = l.to_ascii_uppercase();
    let stable = !(upper.starts_with("US") || upper.contains("UNSTABLE") || upper.contains("MOTION"));
    let start = l.find(|c: char| c.is_ascii_digit())?;
    let num: String = l[start..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut v: f64 = num.parse().ok()?;
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
    }

    #[test]
    fn waits_for_a_steady_weight() {
        let data = b"US,GS,+  0.400kg\r\nUS,GS,+  0.730kg\r\nST,GS,+  0.750kg\r\nST,GS,+  0.750kg\r\nST,GS,+  0.900kg\r\n";
        let r = read_from(&mut &data[..], Duration::from_secs(1)).unwrap();
        assert_eq!(r, Reading { kg: 0.75, stable: true });
        assert!(read_from(&mut &b""[..], Duration::from_millis(50)).is_err());
    }
}
