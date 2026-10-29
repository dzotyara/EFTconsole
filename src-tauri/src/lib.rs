use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;

mod qa;

const IS_WIN: bool = cfg!(windows);

// ---------- config ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    font_size: u32,
    font_family: Option<String>,
    boot_animation: bool,
    scanlines: bool,
    cursor_blink: bool,
    callsign: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            shell: None,
            shell_args: None,
            font_size: 14,
            font_family: None,
            boot_animation: true,
            scanlines: true,
            cursor_blink: true,
            callsign: None,
        }
    }
}

fn home_dir() -> PathBuf {
    let var = if IS_WIN { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

// User config lives in ~/.eftconsole.json (or $EFTCONSOLE_CONFIG); every key is optional.
fn config_path() -> PathBuf {
    std::env::var_os("EFTCONSOLE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".eftconsole.json"))
}

fn load_config() -> Config {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn find_on_path(exe: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file())
}

fn resolve_shell(config: &Config) -> (String, Vec<String>) {
    if let Some(shell) = &config.shell {
        return (shell.clone(), config.shell_args.clone().unwrap_or_default());
    }
    if IS_WIN {
        let pwsh = find_on_path("pwsh.exe").map(|p| p.to_string_lossy().into_owned());
        return (pwsh.unwrap_or_else(|| "powershell.exe".into()), vec!["-NoLogo".into()]);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
    });
    (shell, vec!["-l".into()])
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if IS_WIN {
        "win32"
    } else {
        "linux"
    }
}

// ---------- terminals ----------

struct Term {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Terminals {
    map: Mutex<HashMap<u32, Term>>,
    next_id: AtomicU32,
}

struct AppState {
    config: Config,
    terms: Arc<Terminals>,
}

#[derive(Serialize)]
struct SpawnInfo {
    id: u32,
    pid: Option<u32>,
    shell: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitInfo {
    exit_code: u32,
    killed: bool,
    cause: Option<String>,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: u32,
    info: ExitInfo,
}

// Windows has no signals; these are the exit codes a process gets when it is
// terminated from outside (taskkill /F, Task Manager, Stop-Process, Ctrl+Break).
const WIN_KILL_CODES: [u32; 3] = [1, 0xffff_ffff, 0xc000_013a];

/// strsignal() descriptions ("Killed: 9", "Terminated") back to signal names.
fn signal_name(desc: &str) -> String {
    let base = desc.split(':').next().unwrap_or(desc).trim();
    let name = match base {
        "Killed" => "SIGKILL",
        "Terminated" => "SIGTERM",
        "Hangup" => "SIGHUP",
        "Interrupt" => "SIGINT",
        "Quit" => "SIGQUIT",
        "Segmentation fault" => "SIGSEGV",
        "Abort trap" | "Aborted" => "SIGABRT",
        "Bus error" => "SIGBUS",
        _ => return base.to_string(),
    };
    name.to_string()
}

fn describe_exit(status: &portable_pty::ExitStatus) -> ExitInfo {
    let exit_code = status.exit_code();
    if let Some(sig) = status.signal() {
        return ExitInfo { exit_code, killed: true, cause: Some(signal_name(sig)) };
    }
    if IS_WIN && WIN_KILL_CODES.contains(&exit_code) {
        return ExitInfo { exit_code, killed: true, cause: Some("terminated".into()) };
    }
    ExitInfo { exit_code, killed: false, cause: None }
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<SpawnInfo, String> {
    let (file, args) = resolve_shell(&state.config);
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&file);
    cmd.args(&args);
    cmd.cwd(home_dir());
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "EFTconsole");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("{file}: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let pid = child.process_id();

    let terms = state.terms.clone();
    let id = terms.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    terms.map.lock().unwrap().insert(id, Term { writer, master: pair.master, killer });

    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    thread::spawn(move || {
        let status = child.wait();
        // Let the reader drain the last output before the pty goes away.
        thread::sleep(Duration::from_millis(150));
        // Dropping the master closes the pseudoconsole, so Windows doesn't keep
        // an orphaned conhost.exe around for every shell that exits.
        let removed = terms.map.lock().unwrap().remove(&id);
        drop(removed);
        let info = match status {
            Ok(s) => describe_exit(&s),
            Err(_) => ExitInfo { exit_code: 1, killed: false, cause: None },
        };
        let _ = app.emit("pty:exit", ExitEvent { id, info });
    });

    let shell = PathBuf::from(&file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(file);
    Ok(SpawnInfo { id, pid, shell })
}

#[tauri::command]
fn pty_write(state: State<AppState>, id: u32, data: String) {
    if let Some(t) = state.terms.map.lock().unwrap().get_mut(&id) {
        let _ = t.writer.write_all(data.as_bytes());
        let _ = t.writer.flush();
    }
}

#[tauri::command]
fn pty_resize(state: State<AppState>, id: u32, cols: u16, rows: u16) {
    if let Some(t) = state.terms.map.lock().unwrap().get(&id) {
        let _ = t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
fn pty_kill(state: State<AppState>, id: u32) {
    if let Some(mut t) = state.terms.map.lock().unwrap().remove(&id) {
        let _ = t.killer.kill();
    }
}

fn kill_all(terms: &Terminals) {
    for (_, mut t) in terms.map.lock().unwrap().drain() {
        let _ = t.killer.kill();
    }
}

// ---------- misc commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    #[serde(flatten)]
    config: Config,
    platform: &'static str,
    hostname: String,
    username: String,
    qa: bool,
}

#[tauri::command]
fn config_get(state: State<AppState>) -> ConfigResponse {
    let username = std::env::var(if IS_WIN { "USERNAME" } else { "USER" }).unwrap_or_default();
    ConfigResponse {
        config: state.config.clone(),
        platform: platform(),
        hostname: sysinfo::System::host_name().unwrap_or_default(),
        username,
        qa: qa::enabled(),
    }
}

#[tauri::command]
fn config_open() {
    let path = config_path();
    if !path.exists() {
        let json = serde_json::to_string_pretty(&Config::default()).unwrap_or_default();
        let _ = std::fs::write(&path, json + "\n");
    }
    if qa::enabled() {
        qa::record_opened(&path);
        return;
    }
    let opened = tauri_plugin_opener::open_path(&path, None::<&str>);
    // Windows has no default app for .json out of the box.
    if opened.is_err() && IS_WIN {
        let _ = std::process::Command::new("notepad.exe").arg(&path).spawn();
    }
}

#[tauri::command]
fn open_external(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    if qa::enabled() {
        qa::record_opened(url);
        return;
    }
    let _ = tauri_plugin_opener::open_url(url, None::<&str>);
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) {
    let _ = app.clipboard().write_text(text);
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn window_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn window_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

// ---------- stats ----------

#[derive(Clone, Serialize)]
struct Stats {
    cpu: f32,
    mem: f64,
}

fn start_stats(app: AppHandle) {
    thread::spawn(move || {
        let Ok(mut sys) = sysinfo::System::new() else { return };
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let total = sys.total_memory().max(1) as f64;
            let stats = Stats {
                cpu: (sys.global_cpu_usage() / 100.0).clamp(0.0, 1.0),
                mem: (sys.used_memory() as f64 / total).clamp(0.0, 1.0),
            };
            let _ = app.emit("stats", stats);
            thread::sleep(Duration::from_secs(2));
        }
    });
}

// ---------- window & menu ----------

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("EFTconsole")
        .inner_size(1100.0, 700.0)
        .min_inner_size(560.0, 360.0)
        .background_color(tauri::window::Color(10, 11, 9, 255));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 19.0));

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder.build()
}

// On macOS shortcuts go through the native menu. Frameless Windows/Linux
// windows have no menu bar, so the frontend handles shortcuts there itself.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let item = |id: &str, label: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        match accel {
            Some(a) => b.accelerator(a).build(app),
            None => b.build(app),
        }
    };

    let app_menu = SubmenuBuilder::new(app, "EFTconsole")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    // Ctrl+Tab and Cmd+1..9 are handled by the frontend on every platform.
    let shell = SubmenuBuilder::new(app, "Shell")
        .item(&item("tab:new", "New Tab", Some("Cmd+T"))?)
        .item(&item("tab:close", "Close Tab", Some("Cmd+W"))?)
        .item(&item("tab:next", "Next Tab", None)?)
        .item(&item("tab:prev", "Previous Tab", None)?)
        .separator()
        .item(&item("config:open", "Open Config", None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("edit:copy", "Copy", Some("Cmd+C"))?)
        .item(&item("edit:paste", "Paste", Some("Cmd+V"))?)
        .item(&item("edit:selectAll", "Select All", Some("Cmd+A"))?)
        .item(&item("edit:clear", "Clear", Some("Cmd+K"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("font:bigger", "Zoom In", Some("Cmd+="))?)
        .item(&item("font:smaller", "Zoom Out", Some("Cmd+-"))?)
        .item(&item("font:reset", "Reset Zoom", Some("Cmd+0"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .item(&item("devtools", "Toggle Developer Tools", Some("Alt+Cmd+I"))?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &shell, &edit, &view]).build()
}

pub(crate) fn dispatch_menu(app: &AppHandle, id: &str) {
    match id {
        "config:open" => config_open(),
        "devtools" => {
            if let Some(w) = app.get_webview_window("main") {
                window_devtools(w);
            }
        }
        other => {
            let _ = app.emit("command", other.to_string());
        }
    }
}

// Whether Ctrl+C is ignored is inherited by child processes on Windows. If we were
// started by something that disabled it (CI runners, some launchers), every shell
// would ignore Ctrl+C too, so turn normal processing back on for our children.
#[cfg(windows)]
fn enable_ctrl_c_for_children() {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }
    unsafe {
        SetConsoleCtrlHandler(None, 0);
    }
}

pub fn run() {
    #[cfg(windows)]
    enable_ctrl_c_for_children();

    let terms = Arc::new(Terminals::default());
    let exit_terms = terms.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { config: load_config(), terms: terms.clone() })
        .manage(terms)
        .invoke_handler(tauri::generate_handler![
            config_get,
            config_open,
            open_external,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            clipboard_read,
            clipboard_write,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_devtools,
            qa::qa_report,
            qa::qa_opened,
            qa::qa_menu,
            qa::qa_window_state,
        ])
        .setup(|app| {
            let handle = app.handle();
            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(handle)?)?;
                app.on_menu_event(|app, event| dispatch_menu(app, event.id().as_ref()));
            }
            create_window(handle)?;
            start_stats(handle.clone());
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_all(&exit_terms);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building EFTconsole")
        .run(|_app, event| {
            // In QA mode the report still has to check for leftover processes
            // after the window closes; it exits explicitly.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
                if qa::enabled() {
                    api.prevent_exit();
                }
            }
        });
}
