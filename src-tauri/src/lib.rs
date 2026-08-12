use std::{fs, path::PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

fn initialize_database(connection: &Connection) -> Result<(), String> {
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
        .map_err(|error| error.to_string())
}

fn read_app_data(connection: &Connection) -> Result<Option<Value>, String> {
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

fn write_app_data(connection: &Connection, data: &Value) -> Result<(), String> {
    let payload = serde_json::to_string(&data).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_state (id, payload, updated_at)
       VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at",
            params![
                payload,
                data.get("updatedAt")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "updatedAt is required".to_string())?
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let directory = data_directory(app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let connection =
        Connection::open(directory.join(DATABASE_FILE)).map_err(|error| error.to_string())?;
    initialize_database(&connection)?;
    Ok(connection)
}

#[tauri::command]
fn load_app_data(app: AppHandle) -> Result<Option<Value>, String> {
    let connection = open_database(&app)?;
    read_app_data(&connection)
}

#[tauri::command]
fn save_app_data(app: AppHandle, data: Value) -> Result<(), String> {
    let connection = open_database(&app)?;
    write_app_data(&connection, &data)?;

    app.emit("inventory-updated", data)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn mark_frontend_ready(window: WebviewWindow, view: String) -> Result<(), String> {
    let title = if view == "display" {
        "CGV 구로 경품 전시 화면"
    } else {
        "CGV 구로 경품 관리"
    };
    window.set_title(title).map_err(|error| error.to_string())
}

fn should_open_display_on_startup(args: &[String]) -> bool {
    args.iter().any(|argument| argument == "--verify-display")
}

fn choose_display_monitor_index(
    monitor_positions: &[(i32, i32)],
    primary_position: Option<(i32, i32)>,
) -> Option<usize> {
    monitor_positions
        .iter()
        .position(|position| Some(*position) != primary_position)
        .or_else(|| {
            if monitor_positions.is_empty() {
                None
            } else {
                Some(0)
            }
        })
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
            .map(|monitor| {
                let position = monitor.position();
                (position.x, position.y)
            });
        let monitor_positions = monitors
            .iter()
            .map(|monitor| {
                let position = monitor.position();
                (position.x, position.y)
            })
            .collect::<Vec<_>>();
        let monitor_index = choose_display_monitor_index(&monitor_positions, primary_position)
            .ok_or_else(|| "사용 가능한 모니터를 찾을 수 없습니다.".to_string())?;
        let monitor = &monitors[monitor_index];
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_updates_legacy_app_state_row() {
        let connection = Connection::open_in_memory().expect("in-memory SQLite database");
        initialize_database(&connection).expect("initialize legacy-compatible schema");

        let legacy = serde_json::json!({
            "items": [{"id": "legacy-gift", "movie": "기존 영화"}],
            "settings": {"location": "구로"},
            "updatedAt": "2026-08-01T00:00:00.000Z"
        });
        connection
            .execute(
                "INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?1, ?2)",
                params![legacy.to_string(), "2026-08-01T00:00:00.000Z"],
            )
            .expect("insert legacy app_state row");

        assert_eq!(
            read_app_data(&connection).expect("read legacy payload"),
            Some(legacy)
        );

        let updated = serde_json::json!({
            "items": [{"id": "legacy-gift", "movie": "변경된 영화"}],
            "settings": {"location": "구로"},
            "updatedAt": "2026-08-12T00:00:00.000Z"
        });
        write_app_data(&connection, &updated).expect("update existing app_state row");

        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM app_state", [], |row| row.get(0))
            .expect("count app_state rows");
        assert_eq!(row_count, 1);
        assert_eq!(
            read_app_data(&connection).expect("read updated payload"),
            Some(updated)
        );
    }

    #[test]
    fn selects_a_non_primary_monitor_for_the_display_window() {
        let monitors = [(0, 0), (1920, 0), (-1280, 0)];
        assert_eq!(
            choose_display_monitor_index(&monitors, Some((0, 0))),
            Some(1)
        );
    }

    #[test]
    fn falls_back_to_the_only_monitor_and_handles_no_monitors() {
        assert_eq!(
            choose_display_monitor_index(&[(0, 0)], Some((0, 0))),
            Some(0)
        );
        assert_eq!(choose_display_monitor_index(&[], Some((0, 0))), None);
    }

    #[test]
    fn recognizes_the_operating_pc_display_verification_flag() {
        assert!(should_open_display_on_startup(&[
            "cgv-guro-gift-display.exe".to_string(),
            "--verify-display".to_string(),
        ]));
        assert!(!should_open_display_on_startup(&[
            "cgv-guro-gift-display.exe".to_string(),
        ]));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_arguments = std::env::args().collect::<Vec<_>>();
    tauri::Builder::default()
        .setup(move |app| {
            open_database(app.handle()).map_err(std::io::Error::other)?;
            if should_open_display_on_startup(&startup_arguments) {
                open_display_window(app.handle().clone(), false).map_err(std::io::Error::other)?;
            }
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
            mark_frontend_ready,
            open_display_window,
            close_display_window,
            display_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running CGV Guro Gift Display");
}
