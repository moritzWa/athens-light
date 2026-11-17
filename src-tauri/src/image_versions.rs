use std::{fs, path::Path};

// Stat paths rather than holding file descriptors: editors commonly save by
// replacing the file, and missing files must recover when they reappear.
fn version(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let version = format!("{}:{:?}", metadata.len(), metadata.modified().ok()?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!(
            "{version}:{}:{}:{}",
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        ))
    }
    #[cfg(not(unix))]
    Some(version)
}

#[tauri::command]
pub fn image_versions(paths: Vec<String>) -> Vec<Option<String>> {
    paths.iter().map(|path| version(Path::new(path))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn tracks_overwrites_replacements_deletion_and_recreation() {
        let directory = std::env::temp_dir().join(format!(
            "athens-image-versions-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        for name in ["image.png", "diagram.svg"] {
            let path = directory.join(name);
            assert_eq!(version(&path), None);
            fs::write(&path, b"old image").unwrap();
            let old = version(&path).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
            fs::write(&path, b"new image").unwrap();
            let overwritten = version(&path).unwrap();
            assert_ne!(old, overwritten, "same-size overwrite");
            let replacement = directory.join("replacement");
            fs::write(&replacement, b"new image").unwrap();
            fs::rename(replacement, &path).unwrap();
            assert_ne!(Some(overwritten), version(&path), "atomic replacement");
            fs::remove_file(&path).unwrap();
            assert_eq!(version(&path), None);
            fs::write(&path, b"restored").unwrap();
            assert!(version(&path).is_some());
            fs::remove_file(&path).unwrap();
        }
        assert_eq!(version(&directory), None);
        fs::remove_dir(directory).unwrap();
    }
}
