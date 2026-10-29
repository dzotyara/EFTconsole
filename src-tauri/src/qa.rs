//! In-app QA mode (EFTCONSOLE_QA=1): the frontend runs test/qa-web.js against
//! the live UI and reports here; we then close the window, look for leftover
//! shell processes and exit with the result. Nothing in here is reachable
//! unless the env var is set.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn enabled() -> bool {
    std::env::var("EFTCONSOLE_QA").as_deref() == Ok("1")
}

/// Paths/URLs the app would have opened (QA mode doesn't launch other apps).
pub fn record_opened(what: impl AsRef<std::ffi::OsStr>) {
    OPENED.lock().unwrap().push(what.as_ref().to_string_lossy().into_owned());
}

fn log_path() -> PathBuf {
    let dir = std::env::var_os("QA_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("eftconsole-qa"));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("qa.log")
}

fn log(line: &str) {
    println!("{line}");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
pub fn qa_opened() -> Vec<String> {
    OPENED.lock().unwrap().clone()
}

#[tauri::command]
pub fn qa_menu(app: AppHandle, id: String) {
    if enabled() {
        crate::dispatch_menu(&app, &id);
    }
}

#[derive(Serialize)]
pub struct WindowState {
    maximized: bool,
    minimized: bool,
}

#[tauri::command]
pub fn qa_window_state(window: WebviewWindow, action: Option<String>) -> WindowState {
    if enabled() {
        match action.as_deref() {
            Some("restore") => {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Some("focus") => {
                let _ = window.set_focus();
            }
            _ => {}
        }
    }
    WindowState {
        maximized: window.is_maximized().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
    }
}

/// Shell-ish processes still parented (directly or not) under this process.
fn leftover_shells() -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
    let Ok(mut sys) = System::new_with_specifics(RefreshKind::nothing()) else { return vec![] };
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let me = sysinfo::get_current_pid().ok();
    let shell = |name: &str| {
        let n = name.to_ascii_lowercase();
        let n = n.trim_end_matches(".exe").trim_start_matches('-');
        matches!(n, "cmd" | "conhost" | "openconsole" | "ping" | "zsh" | "bash" | "sh" | "pwsh" | "powershell" | "sleep")
    };
    let mut found = Vec::new();
    let mut frontier: Vec<sysinfo::Pid> = me.into_iter().collect();
    while let Some(parent) = frontier.pop() {
        for (pid, p) in sys.processes() {
            if p.parent() == Some(parent) {
                let name = p.name().to_string_lossy().into_owned();
                if shell(&name) {
                    found.push(format!("{name}({pid})"));
                }
                frontier.push(*pid);
            }
        }
    }
    found
}

#[tauri::command]
pub fn qa_report(app: AppHandle, lines: Vec<String>, failed: u32) {
    if !enabled() {
        return;
    }
    for line in &lines {
        log(line);
    }
    thread::spawn(move || {
        let mut failed = failed;
        let mut passed = lines.iter().filter(|l| l.starts_with("PASS")).count();
        let mut check = |name: &str, ok: bool, detail: String| {
            if ok { passed += 1 } else { failed += 1 }
            log(&format!("{}  {name}{}", if ok { "PASS" } else { "FAIL" },
                if detail.is_empty() { String::new() } else { format!("  -- {detail}") }));
        };

        if let Some(w) = app.get_webview_window("main") {
            let _ = w.close();
        }
        thread::sleep(Duration::from_millis(1500));
        check("close window", app.get_webview_window("main").is_none(), String::new());
        let left = leftover_shells();
        check("no shell processes left after closing", left.is_empty(), left.join(", "));

        log(&format!("\n{}: {passed} passed, {failed} failed", crate::platform().to_uppercase()));
        app.exit(if failed == 0 { 0 } else { 1 });
    });
}
