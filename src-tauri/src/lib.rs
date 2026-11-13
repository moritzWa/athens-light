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
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

static NEXT_WINDOW: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct OpenFiles(Mutex<HashMap<String, String>>);

fn open_path(app: &AppHandle, path: PathBuf) {
    let path_str = path.to_string_lossy().to_string();
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

    let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(820.0, 920.0)
        .tabbing_identifier("athens-light")
        .build();
}

fn pick_and_open(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_file(move |picked| {
            match picked.and_then(|p| p.into_path().ok()) {
                Some(path) => open_path(&handle, path),
                None => {
                    if handle.webview_windows().is_empty() {
                        handle.exit(0);
                    }
                }
            }
        });
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
fn open_url(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenFiles::default())
        .invoke_handler(tauri::generate_handler![
            initial_path,
            read_file,
            write_file,
            open_url
        ])
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    if sub.text()? == "File" {
                        sub.insert(&open, 0)?;
                    }
                }
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "open" {
                    pick_and_open(app);
                }
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
                            pick_and_open(&h);
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
        } => pick_and_open(app),
        _ => {}
    });
}
