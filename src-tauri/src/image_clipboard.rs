use std::time::Duration;

const MAX_BYTES: usize = 20 * 1024 * 1024;

async fn image_bytes(source: &str) -> Result<Vec<u8>, String> {
    if source.starts_with("https://") || source.starts_with("http://") {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(source)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err("Image is too large to copy".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    } else {
        let path = std::path::Path::new(source);
        if !path.is_absolute() {
            return Err("Unsupported image source".into());
        }
        use std::io::Read;
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("Image is too large to copy".into());
        }
        Ok(bytes)
    }
}

#[tauri::command]
pub async fn copy_image_to_clipboard(app: tauri::AppHandle, source: String) -> Result<(), String> {
    let bytes = image_bytes(&source).await?;
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let result = (|| {
                let tiff = tiff_data(&bytes)?;
                let clipboard = objc2_app_kit::NSPasteboard::generalPasteboard();
                clipboard.clearContents();
                let kind = unsafe { objc2_app_kit::NSPasteboardTypeTIFF };
                if clipboard.setData_forType(Some(&tiff), kind) {
                    Ok(())
                } else {
                    Err("Could not write image to clipboard".to_string())
                }
            })();
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
        receiver.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, bytes);
        Err("Image clipboard is only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
fn tiff_data(bytes: &[u8]) -> Result<objc2::rc::Retained<objc2_foundation::NSData>, String> {
    use objc2::AnyThread;
    let data = objc2_foundation::NSData::with_bytes(bytes);
    let image = objc2_app_kit::NSImage::initWithData(objc2_app_kit::NSImage::alloc(), &data)
        .ok_or("Could not decode image")?;
    image
        .TIFFRepresentation()
        .ok_or("Could not convert image".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_images_and_http_errors() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for status in ["200 OK", "404 Not Found"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nPNG!").as_bytes()).unwrap();
            }
        });
        tauri::async_runtime::block_on(async {
            assert_eq!(
                image_bytes(&format!("http://{address}/image"))
                    .await
                    .unwrap(),
                b"PNG!"
            );
            assert!(image_bytes(&format!("http://{address}/missing"))
                .await
                .is_err());
        });
        server.join().unwrap();
    }

    #[test]
    fn local_image_loading_and_invalid_sources() {
        tauri::async_runtime::block_on(async {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../app-icon.png");
            let bytes = image_bytes(path.to_str().unwrap()).await.unwrap();
            assert!(bytes.starts_with(b"\x89PNG"));
            assert!(image_bytes("assets/missing.png").await.is_err());
            assert!(image_bytes("file:///missing.png").await.is_err());
            assert!(image_bytes("/nonexistent-athens-image.png").await.is_err());
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn clipboard_payload_is_a_decoded_bitmap() {
        let bytes = include_bytes!("../../app-icon.png");
        let tiff = tiff_data(bytes).unwrap();
        assert!(tiff.len() > 8);
        assert!(tiff_data(b"not an image").is_err());
    }
}
