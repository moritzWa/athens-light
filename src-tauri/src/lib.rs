mod images;
mod image_clipboard;
mod image_versions;
mod speech;

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle, Emitter, Manager, RunEvent, TitleBarStyle, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct OpenFiles(Mutex<HashMap<String, String>>);

// NSWindow's represented URL is exposed as AXDocument to accessibility clients
// such as Cronus. A title alone identifies the name, but not the document path.
fn publish_document_url(window: &WebviewWindow, path: &std::path::Path) {
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        let path = path.to_path_buf();
        let dispatcher = window.clone();
        if let Err(error) = dispatcher.run_on_main_thread(move || {
            let Ok(native) = window.ns_window() else {
                return;
            };
            let Some(url) = objc2_foundation::NSURL::from_file_path(&path) else {
                return;
            };
            // Tauri owns the NSWindow; keep the WebviewWindow alive and access
            // AppKit only on the main thread.
            let native = unsafe { &*native.cast::<objc2_app_kit::NSWindow>() };
            native.setRepresentedURL(Some(&url));
        }) {
            eprintln!("Could not publish document metadata: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, path);
}

// Use AppKit's persistent frame storage so positions remain in macOS screen
// coordinates and AppKit can handle a display disappearing between launches.
fn restore_document_frame(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        let dispatcher = window.clone();
        let _ = dispatcher.run_on_main_thread(move || {
            if let Ok(native) = window.ns_window() {
                // Tauri owns this NSWindow; this closure runs on the main thread.
                let native = unsafe { &*native.cast::<objc2_app_kit::NSWindow>() };
                let name = objc2_foundation::NSString::from_str("AthensLightDocument");
                native.setFrameUsingName_force(&name, true);
            }

            // Register after restoration, otherwise the initial default frame
            // could overwrite the saved one. Only document windows use this key.
            let observed = window.clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                ) {
                    let window = observed.clone();
                    let dispatcher = window.clone();
                    let _ = dispatcher.run_on_main_thread(move || {
                        if let Ok(native) = window.ns_window() {
                            // Same lifetime and main-thread guarantees as above.
                            let native = unsafe { &*native.cast::<objc2_app_kit::NSWindow>() };
                            let name = objc2_foundation::NSString::from_str("AthensLightDocument");
                            native.saveFrameUsingName(&name);
                        }
                    });
                }
            });
            let _ = window.show();
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.show();
}

fn open_path(app: &AppHandle, path: PathBuf) {
    let path = match std::path::absolute(path) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Could not resolve document path: {error}");
            return;
        }
    };
    let path_str = path.to_string_lossy().to_string();
    if let Some(parent) = path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent, true);
    }
    let files = app.state::<OpenFiles>();

    let existing = files
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(_, p)| **p == path_str)
        .map(|(label, _)| label.clone());
    if let Some(window) = existing.and_then(|label| app.get_webview_window(&label)) {
        let _ = window.set_focus();
        return;
    }

    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::SeqCst));
    files.0.lock().unwrap().insert(label.clone(), path_str);

    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Athens Light".into());

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(820.0, 920.0)
        .visible(false)
        .tabbing_identifier("athens-light")
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .build();
    if let Ok(window) = window {
        publish_document_url(&window, &path);
        restore_document_frame(&window);
    }

    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.close();
    }
}

fn show_launcher(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("launcher") {
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "launcher", WebviewUrl::App("index.html".into()))
        .title("Athens Light")
        .inner_size(420.0, 300.0)
        .resizable(false)
        .build();
}

fn pick_and_open(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_file(move |picked| {
            if let Some(path) = picked.and_then(|p| p.into_path().ok()) {
                open_path(&handle, path);
            }
        });
}

fn create_and_open(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name("Untitled.md")
        .save_file(move |picked| {
            if let Some(mut path) = picked.and_then(|p| p.into_path().ok()) {
                if path.extension().is_none() {
                    path.set_extension("md");
                }
                if !path.exists() {
                    let _ = fs::write(&path, "");
                }
                open_path(&handle, path);
            }
        });
}

#[tauri::command]
fn new_file(app: AppHandle) {
    create_and_open(&app);
}

#[tauri::command]
fn open_file(app: AppHandle) {
    pick_and_open(&app);
}

#[tauri::command]
fn initial_path(window: WebviewWindow, files: tauri::State<OpenFiles>) -> Option<String> {
    files.0.lock().unwrap().get(window.label()).cloned()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_image(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"],
        )
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let source = picked.into_path().map_err(|error| error.to_string())?;
    images::copy_image(std::path::Path::new(&path), &source).map(Some)
}

#[tauri::command]
fn rename_file(
    window: WebviewWindow,
    files: tauri::State<OpenFiles>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let name = new_name.trim();
    if name.is_empty() || name.contains('/') || name.contains(':') || name.starts_with('.') {
        return Err("Invalid name".into());
    }
    let old = PathBuf::from(&path);
    let mut target = old.with_file_name(name);
    if !name.contains('.') {
        target.set_extension("md");
    }
    if target == old {
        return Ok(path);
    }
    let case_only = target.to_string_lossy().to_lowercase() == old.to_string_lossy().to_lowercase();
    if target.exists() && !case_only {
        return Err("A file with that name already exists".into());
    }
    fs::rename(&old, &target).map_err(|e| e.to_string())?;

    let new_path = target.to_string_lossy().to_string();
    files
        .0
        .lock()
        .unwrap()
        .insert(window.label().to_string(), new_path.clone());
    if let Some(file_name) = target.file_name() {
        let _ = window.set_title(&file_name.to_string_lossy());
    }
    publish_document_url(&window, &target);
    Ok(new_path)
}

#[tauri::command]
fn open_url(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

fn copy_file_path(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let dispatcher = app.clone();
        let _ = dispatcher.run_on_main_thread(move || {
            let Some(window) = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
            else {
                return;
            };
            let path = app
                .state::<OpenFiles>()
                .0
                .lock()
                .unwrap()
                .get(window.label())
                .cloned();
            let Some(path) = path else {
                return; // The launcher has no file path to copy.
            };
            let clipboard = objc2_app_kit::NSPasteboard::generalPasteboard();
            let path = objc2_foundation::NSString::from_str(&path);
            clipboard.clearContents();
            // This immutable AppKit constant is initialized by the framework.
            let string_type = unsafe { objc2_app_kit::NSPasteboardTypeString };
            if !clipboard.setString_forType(&path, string_type) {
                eprintln!("Could not copy document path to clipboard");
            } else if let Err(error) = window.emit_to(window.label(), "path-copied", ()) {
                eprintln!("Could not show copy confirmation: {error}");
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenFiles::default())
        .invoke_handler(tauri::generate_handler![
            initial_path,
            read_file,
            image_versions::image_versions,
            write_file,
            pick_image,
            image_clipboard::copy_image_to_clipboard,
            open_url,
            speech::speech_synthesize,
            rename_file,
            new_file,
            open_file
        ])
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let new = MenuItem::with_id(app, "new", "New…", true, Some("CmdOrCtrl+N"))?;
            let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
            let copy_path = MenuItem::with_id(
                app,
                "copy-path",
                "Copy File Path",
                true,
                Some("CmdOrCtrl+K"),
            )?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    if sub.text()? == "File" {
                        sub.insert(&new, 0)?;
                        sub.insert(&open, 1)?;
                        sub.insert(&copy_path, 2)?;
                    }
                }
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "new" => create_and_open(app),
                "open" => pick_and_open(app),
                "copy-path" => copy_file_path(app),
                _ => {}
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Athens Light");

    app.run(|app, event| match event {
        RunEvent::Ready => {
            // A double-clicked file arrives as an Opened event shortly after Ready.
            let handle = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(600));
                if handle.webview_windows().is_empty() {
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if h.webview_windows().is_empty() {
                            show_launcher(&h);
                        }
                    });
                }
            });
        }
        RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    open_path(app, path);
                }
            }
        }
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_launcher(app),
        _ => {}
    });
}
