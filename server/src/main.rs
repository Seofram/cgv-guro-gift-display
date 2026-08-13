#![cfg_attr(windows, windows_subsystem = "windows")]

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 3210;
const MAX_BODY_BYTES: usize = 2_000_000;

#[derive(Default)]
struct DisplayState {
    expected: Option<bool>,
    last_running: Option<bool>,
    incident_id: Option<String>,
    incident_at: Option<String>,
    last_sync_at: Option<String>,
    busy: bool,
}

struct AppState {
    database_path: PathBuf,
    reset_marker: PathBuf,
    web_root: PathBuf,
    display_script: PathBuf,
    display: Mutex<DisplayState>,
    startup_ms: u128,
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn local_app_data() -> Result<PathBuf, String> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not available.".to_string())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS app_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              payload TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            ",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn read_data(path: &Path) -> Result<Option<Value>, String> {
    let connection = open_database(path)?;
    let payload = connection
        .query_row("SELECT payload FROM app_state WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    payload
        .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
}

fn valid_app_data(value: &Value) -> bool {
    value.get("items").is_some_and(Value::is_array)
        && value.get("settings").is_some_and(Value::is_object)
        && value.get("updatedAt").is_some_and(Value::is_string)
}

fn write_data(path: &Path, value: &Value) -> Result<(), String> {
    if !valid_app_data(value) {
        return Err("invalid data".to_string());
    }
    let payload = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let updated_at = value
        .get("updatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "updatedAt is required".to_string())?;
    let connection = open_database(path)?;
    connection
        .execute(
            "
            INSERT INTO app_state (id, payload, updated_at)
            VALUES (1, ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET
              payload = excluded.payload,
              updated_at = excluded.updated_at
            ",
            params![payload, updated_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn migrate_legacy_data(runtime_dir: &Path, database_path: &Path) -> Result<(), String> {
    if read_data(database_path)?.is_some() {
        return Ok(());
    }
    let legacy_path = runtime_dir.join("display-data.json");
    if !legacy_path.is_file() {
        return Ok(());
    }
    let value: Value =
        serde_json::from_slice(&fs::read(&legacy_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    write_data(database_path, &value)
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(4096);
    let mut buffer = [0_u8; 4096];
    let header_end;
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed".to_string());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > MAX_BODY_BYTES + 16_384 {
            return Err("request too large".to_string());
        }
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header = std::str::from_utf8(&bytes[..header_end]).map_err(|error| error.to_string())?;
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let raw_path = request_parts.next().unwrap_or("/");
    let path = raw_path.split('?').next().unwrap_or("/").to_string();
    let content_length = lines
        .find_map(|line| {
            line.split_once(':').and_then(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
        })
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err("request too large".to_string());
    }
    while bytes.len() < header_end + content_length {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() < header_end + content_length {
        return Err("incomplete request body".to_string());
    }
    Ok(HttpRequest {
        method,
        path,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status_text(status),
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

fn respond_json(stream: &mut TcpStream, status: u16, value: Value) {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    respond(stream, status, "application/json; charset=utf-8", &body);
}

fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn safe_static_path(web_root: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    if relative.split('/').any(|part| part == "..") {
        return None;
    }
    let path = if relative.is_empty() {
        web_root.join("index.html")
    } else {
        web_root.join(relative)
    };
    if path.is_file() {
        Some(path)
    } else if !relative.contains('.') {
        Some(web_root.join("index.html"))
    } else {
        None
    }
}

fn run_display_action(script: &Path, action: &str) -> Result<String, String> {
    if !script.is_file() {
        return Err(format!("Display script not found: {}", script.display()));
    }
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.to_string_lossy().as_ref(),
            "-Action",
            action,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn iso_now() -> String {
    format!("{}", unix_millis())
}

fn handle_display_status(stream: &mut TcpStream, state: &AppState) {
    let mut display = state.display.lock().expect("display state poisoned");
    if display.busy {
        respond_json(
            stream,
            200,
            json!({
                "controller": true,
                "running": display.last_running.unwrap_or(false),
                "expected": display.expected.unwrap_or(false),
                "abnormal": false,
                "incidentId": null,
                "incidentAt": null,
                "lastSyncAt": display.last_sync_at,
            }),
        );
        return;
    }
    match run_display_action(&state.display_script, "Status") {
        Ok(result) => {
            let running = result.trim() == "running";
            if display.expected.is_none() {
                display.expected = Some(running);
            }
            if display.expected == Some(true)
                && display.last_running == Some(true)
                && !running
                && display.incident_id.is_none()
            {
                display.incident_id = Some(unix_millis().to_string());
                display.incident_at = Some(iso_now());
            }
            if running {
                display.incident_id = None;
                display.incident_at = None;
            }
            display.last_running = Some(running);
            respond_json(
                stream,
                200,
                json!({
                    "controller": true,
                    "running": running,
                    "expected": display.expected.unwrap_or(false),
                    "abnormal": display.expected == Some(true) && !running && display.incident_id.is_some(),
                    "incidentId": display.incident_id,
                    "incidentAt": display.incident_at,
                    "lastSyncAt": display.last_sync_at,
                }),
            );
        }
        Err(message) => respond_json(
            stream,
            500,
            json!({"controller": true, "running": false, "message": message}),
        ),
    }
}

fn handle_display_action(stream: &mut TcpStream, state: &AppState, opening: bool) {
    {
        let mut display = state.display.lock().expect("display state poisoned");
        if display.busy {
            respond_json(stream, 409, json!({"ok": false, "message": "busy"}));
            return;
        }
        display.busy = true;
    }
    let result = run_display_action(
        &state.display_script,
        if opening { "Open" } else { "Close" },
    );
    let mut display = state.display.lock().expect("display state poisoned");
    display.busy = false;
    match result {
        Ok(message) => {
            display.expected = Some(opening);
            display.last_running = Some(opening);
            display.incident_id = None;
            display.incident_at = None;
            respond_json(stream, 200, json!({"ok": true, "message": message}));
        }
        Err(message) => respond_json(stream, 500, json!({"ok": false, "message": message})),
    }
}

fn handle_connection(mut stream: TcpStream, state: Arc<AppState>) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(message) => {
            respond_json(&mut stream, 400, json!({"ok": false, "message": message}));
            return;
        }
    };
    if request.method == "OPTIONS" {
        respond(&mut stream, 204, "text/plain", b"");
        return;
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => respond_json(
            &mut stream,
            200,
            json!({"ok": true, "version": env!("CARGO_PKG_VERSION"), "startupMs": state.startup_ms}),
        ),
        ("GET", "/data") => match read_data(&state.database_path) {
            Ok(Some(data)) => respond_json(&mut stream, 200, json!({"ok": true, "data": data})),
            Ok(None) => respond_json(
                &mut stream,
                404,
                json!({"ok": false, "message": "no data", "reset": state.reset_marker.is_file()}),
            ),
            Err(message) => {
                respond_json(&mut stream, 500, json!({"ok": false, "message": message}))
            }
        },
        ("POST", "/data") => match serde_json::from_slice::<Value>(&request.body)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                write_data(&state.database_path, &value)?;
                Ok(value)
            }) {
            Ok(_) => {
                let _ = fs::remove_file(&state.reset_marker);
                state
                    .display
                    .lock()
                    .expect("display state poisoned")
                    .last_sync_at = Some(iso_now());
                respond_json(&mut stream, 200, json!({"ok": true}));
            }
            Err(message) => {
                respond_json(&mut stream, 400, json!({"ok": false, "message": message}))
            }
        },
        ("GET", "/display/status") => handle_display_status(&mut stream, &state),
        ("POST", "/display/open") => handle_display_action(&mut stream, &state, true),
        ("POST", "/display/close") => handle_display_action(&mut stream, &state, false),
        ("GET", _) => match safe_static_path(&state.web_root, &request.path) {
            Some(path) => match fs::read(&path) {
                Ok(body) => respond(&mut stream, 200, mime_type(&path), &body),
                Err(_) => respond_json(&mut stream, 404, json!({"ok": false})),
            },
            None => respond_json(&mut stream, 404, json!({"ok": false})),
        },
        _ => respond_json(&mut stream, 404, json!({"ok": false})),
    }
}

fn open_admin(script: &Path) {
    if !script.is_file() {
        return;
    }
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn run() -> Result<(), String> {
    let started = Instant::now();
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let install_dir = executable
        .parent()
        .ok_or_else(|| "Executable directory is unavailable.".to_string())?;
    let runtime_dir = local_app_data()?.join("CGVGiftDisplay");
    fs::create_dir_all(&runtime_dir).map_err(|error| error.to_string())?;
    let database_path = runtime_dir.join("inventory.db");
    open_database(&database_path)?;
    migrate_legacy_data(&runtime_dir, &database_path)?;

    let listener = TcpListener::bind((HOST, PORT)).map_err(|error| error.to_string())?;
    let state = Arc::new(AppState {
        database_path,
        reset_marker: runtime_dir.join("reset-data.flag"),
        web_root: env::var_os("CGV_WEB_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| install_dir.join("web")),
        display_script: install_dir.join("scripts").join("display-window.ps1"),
        display: Mutex::new(DisplayState::default()),
        startup_ms: started.elapsed().as_millis(),
    });
    if !state.web_root.join("index.html").is_file() {
        return Err(format!(
            "Web assets not found: {}",
            state.web_root.display()
        ));
    }
    if !env::args().any(|argument| argument == "--no-open") {
        open_admin(&install_dir.join("scripts").join("open-admin.ps1"));
    }
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || handle_connection(stream, state));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        if let Ok(runtime_dir) = local_app_data().map(|path| path.join("CGVGiftDisplay")) {
            let _ = fs::create_dir_all(&runtime_dir);
            let _ = fs::write(runtime_dir.join("server-error.log"), &message);
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "cgv-gift-server-{name}-{}-{}",
            std::process::id(),
            unix_millis()
        ))
    }

    #[test]
    fn writes_and_reads_the_legacy_compatible_state_row() {
        let directory = test_directory("sqlite");
        fs::create_dir_all(&directory).unwrap();
        let database = directory.join("inventory.db");
        let data = json!({
            "items": [],
            "settings": {
                "location": "구로",
                "title": "경품 안내",
                "notices": [],
                "pageSeconds": 8,
                "showSoldout": true
            },
            "updatedAt": "2026-08-13T00:00:00.000Z"
        });

        write_data(&database, &data).unwrap();
        assert_eq!(read_data(&database).unwrap(), Some(data));

        let connection = Connection::open(&database).unwrap();
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM app_state WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(row_count, 1);
        drop(connection);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_invalid_payloads_and_static_path_traversal() {
        let directory = test_directory("validation");
        fs::create_dir_all(&directory).unwrap();
        let database = directory.join("inventory.db");
        assert!(write_data(&database, &json!({"items": []})).is_err());

        fs::write(directory.join("index.html"), "ok").unwrap();
        assert_eq!(
            safe_static_path(&directory, "/").unwrap(),
            directory.join("index.html")
        );
        assert!(safe_static_path(&directory, "/../Cargo.toml").is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
