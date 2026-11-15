use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The shop's database files on disk: each save goes to a temporary file that is flushed and then
/// renamed over the old one (a power cut leaves either the old or the new file, never half a file).
/// The previous version is kept as `<name>.prev`, and the first save of each day is copied to
/// `backups/<name>-<date>`; the newest `keep` daily copies are kept.
pub struct Store {
    dir: PathBuf,
    keep: usize,
}

fn clean(key: &str) -> Result<String, String> {
    let k: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect();
    if k.is_empty() || k.starts_with('.') {
        return Err("bad name".into());
    }
    Ok(k)
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>, keep: usize) -> Result<Store, String> {
        let dir = dir.into();
        fs::create_dir_all(dir.join("backups")).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        Ok(Store { dir, keep })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let p = self.dir.join(clean(key)?);
        match fs::read(&p) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // A crash between "move old aside" and "rename new in" can't happen with rename-over,
                // but fall back to the previous copy if the main file is missing anyway.
                match fs::read(self.dir.join(format!("{}.prev", clean(key)?))) {
                    Ok(b) => Ok(Some(b)),
                    Err(_) => Ok(None),
                }
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn write(&self, key: &str, bytes: &[u8], today: &str) -> Result<(), String> {
        let name = clean(key)?;
        let path = self.dir.join(&name);
        let tmp = self.dir.join(format!("{name}.tmp"));
        {
            let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(bytes).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        if path.exists() {
            let daily = self.dir.join("backups").join(format!("{name}-{today}"));
            if !daily.exists() {
                let _ = fs::copy(&path, &daily);
                self.prune(&name);
            }
            let _ = fs::copy(&path, self.dir.join(format!("{name}.prev")));
        }
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        let name = clean(key)?;
        for p in [self.dir.join(&name), self.dir.join(format!("{name}.prev"))] {
            let _ = fs::remove_file(p);
        }
        Ok(())
    }

    fn prune(&self, name: &str) {
        let Ok(rd) = fs::read_dir(self.dir.join("backups")) else { return };
        let mut v: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with(&format!("{name}-")))).collect();
        v.sort();
        while v.len() > self.keep {
            let _ = fs::remove_file(v.remove(0));
        }
    }

    pub fn backups(&self, key: &str) -> Vec<String> {
        let Ok(name) = clean(key) else { return vec![] };
        let Ok(rd) = fs::read_dir(self.dir.join("backups")) else { return vec![] };
        let mut v: Vec<String> = rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.starts_with(&format!("{name}-"))).collect();
        v.sort();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_atomically_and_keeps_daily_backups() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path(), 2).unwrap();
        assert_eq!(s.read("db:abc").unwrap(), None);
        s.write("db:abc", b"v1", "2026-11-13").unwrap();
        s.write("db:abc", b"v2", "2026-11-13").unwrap();
        assert_eq!(s.read("db:abc").unwrap().unwrap(), b"v2");
        assert_eq!(fs::read(d.path().join("db_abc.prev")).unwrap(), b"v1");
        s.write("db:abc", b"v3", "2026-11-14").unwrap();
        s.write("db:abc", b"v4", "2026-11-15").unwrap();
        assert_eq!(s.backups("db:abc"), vec!["db_abc-2026-11-14", "db_abc-2026-11-15"]); // keeps 2
        assert_eq!(fs::read(d.path().join("backups/db_abc-2026-11-15")).unwrap(), b"v3");
        assert!(!d.path().join("db_abc.tmp").exists());
        fs::remove_file(d.path().join("db_abc")).unwrap();
        assert_eq!(s.read("db:abc").unwrap().unwrap(), b"v3"); // falls back to .prev
        s.delete("db:abc").unwrap();
        assert_eq!(s.read("db:abc").unwrap(), None);
        assert!(s.write("../evil", b"x", "d").is_err() || !d.path().parent().unwrap().join("evil").exists());
    }
}
