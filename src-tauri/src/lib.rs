use std::{fs, path::PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const DATABASE_DIRECTORY: &str = "CGVGiftDisplay";
const DATABASE_FILE: &str = "inventory.db";

fn data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data).join(DATABASE_DIRECTORY));
    }

    app.path()
        .app_local_data_dir()
        .map(|path| path.join(DATABASE_DIRECTORY))
        .map_err(|error| error.to_string())
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let directory = data_directory(app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let connection =
        Connection::open(directory.join(DATABASE_FILE)).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
       PRAGMA synchronous = NORMAL;
       CREATE TABLE IF NOT EXISTS app_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         payload TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

#[tauri::command]
fn load_app_data(app: AppHandle) -> Result<Option<Value>, String> {
    let connection = open_database(&app)?;
    let payload = connection
        .query_row("SELECT payload FROM app_state WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;

    payload
        .map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
fn save_app_data(app: AppHandle, data: Value) -> Result<(), String> {
    let updated_at = data
        .get("updatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "updatedAt is required".to_string())?;
    let payload = serde_json::to_string(&data).map_err(|error| error.to_string())?;
    let connection = open_database(&app)?;

    connection
        .execute(
            "INSERT INTO app_state (id, payload, updated_at)
       VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at",
            params![payload, updated_at],
        )
        .map_err(|error| error.to_string())?;

    app.emit("inventory-updated", data)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_display_window(app: AppHandle, preview: bool) -> Result<(), String> {
    let label = if preview {
        "monitor-preview"
    } else {
        "display"
    };
    if let Some(window) = app.get_webview_window(label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App("index.html?view=display".into()),
    )
    .title(if preview {
        "CGV 구로 경품 전시 미리보기"
    } else {
        "CGV 구로 경품 전시 화면"
    })
    .decorations(preview)
    .always_on_top(!preview)
    .resizable(preview);

    if preview {
        builder = builder.inner_size(720.0, 576.0).center();
    } else {
        let monitors = app
            .available_monitors()
            .map_err(|error| error.to_string())?;
        let primary_position = app
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .map(|monitor| *monitor.position());
        let monitor = monitors
            .iter()
            .find(|monitor| Some(*monitor.position()) != primary_position)
            .or_else(|| monitors.first())
            .ok_or_else(|| "사용 가능한 모니터를 찾을 수 없습니다.".to_string())?;
        let position = monitor.position();
        let size = monitor.size();
        builder = builder
            .position(position.x as f64, position.y as f64)
            .inner_size(size.width as f64, size.height as f64)
            .fullscreen(true)
            .skip_taskbar(true);
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_display_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("display") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayStatus {
    controller: bool,
    running: bool,
    expected: bool,
    abnormal: bool,
    incident_id: Option<String>,
    incident_at: Option<String>,
    last_sync_at: Option<String>,
}

#[tauri::command]
fn display_status(app: AppHandle) -> DisplayStatus {
    let running = app.get_webview_window("display").is_some();
    DisplayStatus {
        controller: true,
        running,
        expected: running,
        abnormal: false,
        incident_id: None,
        incident_at: None,
        last_sync_at: None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            open_database(app.handle()).map_err(std::io::Error::other)?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app_data,
            save_app_data,
            open_display_window,
            close_display_window,
            display_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running CGV Guro Gift Display");
}
