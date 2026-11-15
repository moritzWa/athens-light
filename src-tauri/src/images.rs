use std::{fs, io, path::Path};

pub fn copy_image(document: &Path, image: &Path) -> Result<String, String> {
    let extension = image
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].contains(&extension.as_str()) {
        return Err("Choose a PNG, JPEG, GIF, WebP, SVG or AVIF image".into());
    }
    let mut input = fs::File::open(image).map_err(|error| error.to_string())?;
    let folder = document
        .parent()
        .ok_or("Document has no parent folder")?
        .join("assets");
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let stem = image
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("Invalid image filename")?;
    for index in 0..10000 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        let target = folder.join(&name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut output) => {
                if let Err(error) = io::copy(&mut input, &mut output) {
                    drop(output);
                    let _ = fs::remove_file(&target);
                    return Err(error.to_string());
                }
                return Ok(format!("assets/{name}"));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Too many images with this filename".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_images_beside_document_without_overwriting_files() {
        let folder = std::env::temp_dir().join(format!(
            "athens-images-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&folder).unwrap();
        let document = folder.join("fixture.md");
        let source = folder.join("my photo.png");
        fs::write(&document, "Untouched prose\n").unwrap();
        fs::write(&source, b"image fixture").unwrap();
        assert_eq!(
            copy_image(&document, &source).unwrap(),
            "assets/my photo.png"
        );
        assert_eq!(
            copy_image(&document, &source).unwrap(),
            "assets/my photo-1.png"
        );
        assert_eq!(
            fs::read(folder.join("assets/my photo.png")).unwrap(),
            b"image fixture"
        );
        assert_eq!(fs::read_to_string(&document).unwrap(), "Untouched prose\n");
        assert!(copy_image(&document, &document).is_err());
        fs::remove_dir_all(folder).unwrap();
    }
}
