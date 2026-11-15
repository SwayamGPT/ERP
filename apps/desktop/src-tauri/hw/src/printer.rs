use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Where raw bytes go.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// A network printer, usually on port 9100 ("RAW" / JetDirect).
    Network { host: String, port: u16 },
    /// A printer installed in Windows / macOS / Linux, by its name.
    System { name: String },
}

impl Target {
    /// Parse "192.168.1.50", "192.168.1.50:9100", "tcp://host:9100" or a system printer name.
    pub fn parse(s: &str) -> Result<Target, String> {
        let t = s.trim();
        if t.is_empty() {
            return Err("No printer chosen.".into());
        }
        let t2 = t.strip_prefix("tcp://").unwrap_or(t);
        let looks_network = t.starts_with("tcp://") || t2.split(':').next().map_or(false, |h| h.split('.').count() == 4 && h.split('.').all(|p| p.parse::<u8>().is_ok()));
        if looks_network {
            let mut parts = t2.rsplitn(2, ':');
            let last = parts.next().unwrap_or("");
            return Ok(match (parts.next(), last.parse::<u16>()) {
                (Some(host), Ok(port)) => Target::Network { host: host.to_string(), port },
                _ => Target::Network { host: t2.to_string(), port: 9100 },
            });
        }
        Ok(Target::System { name: t.to_string() })
    }
}

/// Send bytes exactly as given (no driver formatting).
pub fn send_raw(target: &Target, bytes: &[u8]) -> Result<(), String> {
    match target {
        Target::Network { host, port } => {
            let addr = (host.as_str(), *port)
                .to_socket_addrs()
                .map_err(|e| format!("Printer address {host}: {e}"))?
                .next()
                .ok_or_else(|| format!("Printer address {host} not found"))?;
            let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("Cannot reach the printer at {host}:{port} ({e}). Check it is on and on the same network."))?;
            s.set_write_timeout(Some(Duration::from_secs(10))).ok();
            s.write_all(bytes).map_err(|e| format!("Printing failed: {e}"))?;
            s.flush().map_err(|e| format!("Printing failed: {e}"))
        }
        Target::System { name } => system_raw(name, bytes),
    }
}

#[cfg(windows)]
fn system_raw(name: &str, bytes: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let pname = wide(name);
    let doc = wide("Hisaab");
    let raw = wide("RAW");
    unsafe {
        let mut h: HANDLE = std::ptr::null_mut();
        if OpenPrinterW(pname.as_ptr(), &mut h, std::ptr::null()) == 0 {
            return Err(format!("Printer “{name}” not found in Windows."));
        }
        let info = DOC_INFO_1W { pDocName: doc.as_ptr() as *mut u16, pOutputFile: std::ptr::null_mut(), pDatatype: raw.as_ptr() as *mut u16 };
        let mut ok = StartDocPrinterW(h, 1, &info) != 0 && StartPagePrinter(h) != 0;
        let mut written: u32 = 0;
        ok = ok && WritePrinter(h, bytes.as_ptr() as *const _, bytes.len() as u32, &mut written) != 0 && written as usize == bytes.len();
        EndPagePrinter(h);
        EndDocPrinter(h);
        ClosePrinter(h);
        if ok { Ok(()) } else { Err(format!("Windows could not send the job to “{name}”.")) }
    }
}

#[cfg(not(windows))]
fn system_raw(name: &str, bytes: &[u8]) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new("lp")
        .args(["-d", name, "-o", "raw"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot start the print system (lp): {e}"))?;
    child.stdin.as_mut().ok_or("no stdin")?.write_all(bytes).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(format!("Printer “{name}”: {}", String::from_utf8_lossy(&out.stderr).trim())) }
}

/// Printers installed in the operating system.
pub fn list_system_printers() -> Vec<String> {
    #[cfg(windows)]
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"])
        .output();
    #[cfg(not(windows))]
    let out = std::process::Command::new("lpstat").arg("-e").output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn parses_targets() {
        assert_eq!(Target::parse("192.168.1.50").unwrap(), Target::Network { host: "192.168.1.50".into(), port: 9100 });
        assert_eq!(Target::parse("192.168.1.50:9101").unwrap(), Target::Network { host: "192.168.1.50".into(), port: 9101 });
        assert_eq!(Target::parse("tcp://printer.local:9100").unwrap(), Target::Network { host: "printer.local".into(), port: 9100 });
        assert_eq!(Target::parse("EPSON TM-T82").unwrap(), Target::System { name: "EPSON TM-T82".into() });
        assert!(Target::parse("  ").is_err());
    }

    #[test]
    fn sends_bytes_to_a_network_printer() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut got = vec![];
            c.read_to_end(&mut got).unwrap();
            got
        });
        let bytes = [0x1b, 0x40, b'H', b'i', 0x1d, 0x56, 0x00];
        send_raw(&Target::Network { host: "127.0.0.1".into(), port }, &bytes).unwrap();
        assert_eq!(h.join().unwrap(), bytes);
    }

    #[test]
    fn unreachable_printer_says_so() {
        let e = send_raw(&Target::Network { host: "127.0.0.1".into(), port: 1 }, b"x").unwrap_err();
        assert!(e.contains("Cannot reach the printer"), "{e}");
    }
}
