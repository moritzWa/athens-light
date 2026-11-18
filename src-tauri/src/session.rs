use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};

const MAX_RECENT: usize = 30;

#[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
struct Saved {
    // Documents that had a window when the app last quit or lost its windows.
    open: Vec<String>,
    // Most recently opened or edited first.
    recent: Vec<String>,
}

pub struct Session {
    file: PathBuf,
    saved: Mutex<Saved>,
}

#[derive(Serialize)]
pub struct RecentFile {
    path: String,
    name: String,
    dir: String,
}

impl Session {
    pub fn load(file: PathBuf) -> Self {
        let saved = fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Session {
            file,
            saved: Mutex::new(saved),
        }
    }

    // Write to a sibling file and rename so a crash never leaves half a file.
    fn persist(&self, saved: &Saved) {
        let Ok(text) = serde_json::to_string_pretty(saved) else {
            return;
        };
        if let Some(parent) = self.file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.file.with_extension("json.tmp");
        if fs::write(&tmp, text).is_ok() {
            if let Err(error) = fs::rename(&tmp, &self.file) {
                eprintln!("Could not save session: {error}");
            }
        }
    }

    pub fn open_documents(&self) -> Vec<String> {
        self.saved.lock().unwrap().open.clone()
    }

    pub fn document_opened(&self, path: &str) {
        let mut saved = self.saved.lock().unwrap();
        if !saved.open.iter().any(|p| p == path) {
            saved.open.push(path.to_string());
        }
        move_to_front(&mut saved.recent, path);
        self.persist(&saved);
    }

    pub fn document_closed(&self, path: &str) {
        let mut saved = self.saved.lock().unwrap();
        saved.open.retain(|p| p != path);
        self.persist(&saved);
    }

    pub fn document_edited(&self, path: &str) {
        let mut saved = self.saved.lock().unwrap();
        if saved.recent.first().map(String::as_str) == Some(path) {
            return;
        }
        move_to_front(&mut saved.recent, path);
        self.persist(&saved);
    }

    pub fn document_renamed(&self, old: &str, new: &str) {
        let mut guard = self.saved.lock().unwrap();
        let saved = &mut *guard;
        for list in [&mut saved.open, &mut saved.recent] {
            for path in list.iter_mut() {
                if path == old {
                    *path = new.to_string();
                }
            }
        }
        saved.recent.dedup();
        self.persist(&saved);
    }

    pub fn forget(&self, path: &str) {
        let mut saved = self.saved.lock().unwrap();
        saved.open.retain(|p| p != path);
        saved.recent.retain(|p| p != path);
        self.persist(&saved);
    }

    pub fn recent_files(&self, limit: usize) -> Vec<RecentFile> {
        let home = std::env::var("HOME").unwrap_or_default();
        self.saved
            .lock()
            .unwrap()
            .recent
            .iter()
            .filter(|path| std::path::Path::new(path).is_file())
            .take(limit)
            .map(|path| {
                let p = std::path::Path::new(path);
                let dir = p.parent().map(|d| d.to_string_lossy().to_string());
                let dir = dir.unwrap_or_default();
                let dir = match dir.strip_prefix(&home) {
                    Some(rest) if !home.is_empty() => format!("~{rest}"),
                    _ => dir,
                };
                RecentFile {
                    path: path.clone(),
                    name: p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone()),
                    dir,
                }
            })
            .collect()
    }
}

fn move_to_front(list: &mut Vec<String>, path: &str) {
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(MAX_RECENT);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("athens-light-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn open_documents_survive_a_restart() {
        let dir = scratch("restart");
        let file = dir.join("session.json");
        let session = Session::load(file.clone());
        session.document_opened("/a.md");
        session.document_opened("/b.md");
        session.document_closed("/a.md");

        let reloaded = Session::load(file);
        assert_eq!(reloaded.open_documents(), vec!["/b.md".to_string()]);
    }

    #[test]
    fn recent_is_most_recent_first_without_duplicates() {
        let dir = scratch("recent");
        let a = dir.join("a.md");
        let b = dir.join("b.md");
        fs::write(&a, "").unwrap();
        fs::write(&b, "").unwrap();
        let (a, b) = (a.to_string_lossy().to_string(), b.to_string_lossy().to_string());

        let session = Session::load(dir.join("session.json"));
        session.document_opened(&a);
        session.document_opened(&b);
        session.document_edited(&a);
        let names: Vec<_> = session.recent_files(10).into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["a.md", "b.md"]);
    }

    #[test]
    fn deleted_files_are_not_listed() {
        let dir = scratch("deleted");
        let session = Session::load(dir.join("session.json"));
        session.document_opened(&dir.join("gone.md").to_string_lossy());
        assert!(session.recent_files(10).is_empty());
    }

    #[test]
    fn rename_keeps_open_and_recent_entries() {
        let dir = scratch("rename");
        let session = Session::load(dir.join("session.json"));
        session.document_opened("/old.md");
        session.document_renamed("/old.md", "/new.md");
        assert_eq!(session.open_documents(), vec!["/new.md".to_string()]);
    }

    #[test]
    fn corrupt_file_starts_empty() {
        let dir = scratch("corrupt");
        let file = dir.join("session.json");
        fs::write(&file, "{nope").unwrap();
        assert!(Session::load(file).open_documents().is_empty());
    }
}
