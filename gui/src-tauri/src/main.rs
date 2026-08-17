// Instlux natív shell.
//
// Ez a Rust folyamat elindítja a Node.js "sidecar"-t (a fordított
// source/gui-bridge.ts-t, ami a repo gyökerében dist/gui-bridge.js néven
// jön létre), és newline-delimited JSON-RPC-n keresztül kommunikál vele
// a stdin/stdout csöveken át. A frontend (src/) sima HTML/JS/CSS, ami a
// Tauri `invoke("bridge_call", ...)` hívással beszél ide, a realtime
// eseményeket pedig a "bridge-event" Tauri eseményen keresztül kapja meg.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct BridgeState {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: PendingMap,
    next_id: AtomicU64,
    // A child processt is tartjuk, hogy leállításkor korrekten ki tudjuk lőni.
    _child: Arc<Mutex<Option<Child>>>,
}

/// Megkeresi a dist/gui-bridge.js -t. Dev módban a repo gyökeréhez képest
/// relatív útvonalon (gui/src-tauri -> ../../dist/gui-bridge.js), éles
/// buildben a Tauri resource mappájából (lásd tauri.conf.json bundle
/// resources -- ezt még be kell állítani, ha csomagolt binárist adsz ki).
fn resolve_bridge_path(app: &tauri::App) -> PathBuf {
    // Dev fallback: a Cargo manifest mappájából kiindulva.
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../dist/gui-bridge.js");
    if dev_path.exists() {
        return dev_path;
    }

    // Éles build: a resource mappában keressük (bundle.resources-be fel
    // kell venni a dist/gui-bridge.js-t és a node_modules-t, vagy egy
    // pkg/ncc-vel önálló bináris. Lásd README a gui/ mappában.)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("dist/gui-bridge.js");
        if packaged.exists() {
            return packaged;
        }
    }

    dev_path
}

fn spawn_bridge(app: &tauri::App) -> BridgeState {
    let bridge_path = resolve_bridge_path(app);

    // A tokio::process::Command::spawn() egy futó Tokio reactor kontextust
    // igényel (hogy a gyermek folyamat wait/kill eseményeit tudja regisztrálni).
    // A Tauri setup() callback-je viszont szinkron kontextusban fut, reactor
    // nélkül -- ezért block_on-nal explicit be kell lépnünk a Tauri saját
    // Tokio runtime-jába a spawn idejére.
    let mut child = tauri::async_runtime::block_on(async {
        Command::new("node")
            .arg(&bridge_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
    })
    .expect("Nem sikerült elindítani a Node sidecar-t (gui-bridge.js). Van telepítve a node?");

    let stdin = child.stdin.take().expect("hiányzó stdin handle");
    let stdout = child.stdout.take().expect("hiányzó stdout handle");

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    let app_handle = app.handle().clone();

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            if let Some(event_name) = value.get("event").and_then(|v| v.as_str()) {
                let data = value.get("data").cloned().unwrap_or(Value::Null);
                let _ = app_handle.emit(
                    "bridge-event",
                    json!({ "event": event_name, "data": data }),
                );
                continue;
            }

            if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                let mut map = pending_reader.lock().await;
                if let Some(sender) = map.remove(&id) {
                    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                        let _ = sender.send(Err(err.to_string()));
                    } else {
                        let result = value.get("result").cloned().unwrap_or(Value::Null);
                        let _ = sender.send(Ok(result));
                    }
                }
            }
        }
    });

    BridgeState {
        stdin: Arc::new(Mutex::new(Some(stdin))),
        pending,
        next_id: AtomicU64::new(1),
        _child: Arc::new(Mutex::new(Some(child))),
    }
}

#[tauri::command]
async fn bridge_call(
    state: tauri::State<'_, BridgeState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let (tx, rx) = oneshot::channel();
    {
        let mut map = state.pending.lock().await;
        map.insert(id, tx);
    }

    let request = json!({
        "id": id,
        "method": method,
        "params": params.unwrap_or(json!({})),
    });
    let mut line = request.to_string();
    line.push('\n');

    {
        let mut stdin_guard = state.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| "A sidecar folyamat nem elérhető".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
    }

    match rx.await {
        Ok(result) => result,
        Err(_) => Err("A sidecar nem válaszolt (a csatorna bezárult)".to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let state = spawn_bridge(app);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge_call])
        .run(tauri::generate_context!())
        .expect("hiba az Instlux GUI indításakor");
}
