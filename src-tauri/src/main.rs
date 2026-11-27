#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod dev_status;
mod dotenv;
mod host;
mod media;
mod merge;
mod prompt_studio;
mod spotify_api;
mod stats;
mod terminal;
mod workspace;

use host::Result;
use serde_json::Value;
use spotify_api::{SpotifyApi, SpotifyKind, SpotifyPage};
use std::{path::PathBuf, sync::Arc};
use tauri::{ipc::{Channel, Response}, Manager, State};
use terminal::{Health, Spec, Start, Terminals};
use workspace::{Template, TemplateEdit, Workspace};

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| "The local operation was interrupted.".to_string())?
}

#[tauri::command]
async fn workspace_load(state: State<'_, Arc<Workspace>>) -> Result<Option<Value>> {
    let state = state.inner().clone();
    blocking(move || state.load()).await
}

#[tauri::command]
async fn workspace_save(state: State<'_, Arc<Workspace>>, model: Value) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.save(model)).await
}

#[tauri::command]
async fn dev_branches(path: String, distro: String) -> Result<dev_status::Branches> {
    blocking(move || dev_status::branches(&path, &distro)).await
}

#[tauri::command]
async fn dev_pulls(path: String, distro: String) -> Result<Vec<dev_status::Pull>> {
    blocking(move || dev_status::pulls(&path, &distro)).await
}

#[tauri::command]
async fn dev_containers(path: String, distro: String) -> Result<Vec<dev_status::Container>> {
    blocking(move || dev_status::containers(&path, &distro)).await
}

#[tauri::command]
async fn merge_preview(path: String, distro: String) -> Result<merge::Preview> {
    blocking(move || merge::preview(&path, &distro)).await
}

#[tauri::command]
async fn merge_execute(
    path: String,
    distro: String,
    expected_head: String,
    expected_branch: String,
    source: String,
    source_oid: String,
) -> Result<merge::Outcome> {
    blocking(move || {
        merge::execute(
            &path,
            &distro,
            &expected_head,
            &expected_branch,
            &source,
            &source_oid,
        )
    })
    .await
}

#[tauri::command]
async fn merge_observe(path: String, distro: String, since: u64) -> Result<Vec<merge::Observed>> {
    blocking(move || merge::observe(&path, &distro, since)).await
}

#[tauri::command]
async fn host_distros() -> Result<Vec<String>> {
    blocking(|| Ok(host::distros())).await
}

#[tauri::command]
async fn host_location(path: String, distro: String) -> Result<host::Location> {
    blocking(move || host::resolve(&path, &distro, true)).await
}

#[tauri::command]
async fn host_git(path: String, distro: String) -> Result<host::GitInfo> {
    blocking(move || host::git_info(&path, &distro)).await
}

#[tauri::command]
async fn host_clone(remote: String, path: String, distro: String) -> Result<host::Location> {
    blocking(move || host::clone_repo(&remote, &path, &distro)).await
}

#[tauri::command]
async fn terminal_create(
    state: State<'_, Arc<Terminals>>,
    spec: Spec,
    cols: u16,
    rows: u16,
) -> Result<Start> {
    let state = state.inner().clone();
    blocking(move || state.create(spec, cols, rows)).await
}

#[tauri::command]
async fn terminal_attach(
    state: State<'_, Arc<Terminals>>,
    spec: Spec,
    cols: u16,
    rows: u16,
) -> Result<Start> {
    let state = state.inner().clone();
    blocking(move || state.attach(spec, cols, rows)).await
}

#[tauri::command]
async fn terminal_conceal(state: State<'_, Arc<Terminals>>, spec: Spec) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.conceal(spec)).await
}

#[tauri::command]
async fn terminal_terminate(state: State<'_, Arc<Terminals>>, spec: Spec) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.terminate(spec)).await
}

#[tauri::command]
async fn terminal_read(
    state: State<'_, Arc<Terminals>>,
    id: String,
    attachment: u64,
    cursor: u64,
) -> Result<Response> {
    let state = state.inner().clone();
    blocking(move || state.read(&id, attachment, cursor))
        .await
        .map(Response::new)
}

#[tauri::command]
async fn terminal_write(
    state: State<'_, Arc<Terminals>>,
    id: String,
    attachment: u64,
    input: Vec<u8>,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.write(&id, attachment, &input)).await
}

#[tauri::command]
async fn terminal_resize(
    state: State<'_, Arc<Terminals>>,
    id: String,
    attachment: u64,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.resize(&id, attachment, cols, rows)).await
}

#[tauri::command]
async fn terminal_search(
    state: State<'_, Arc<Terminals>>,
    spec: Spec,
    query: String,
    backward: bool,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.search(spec, &query, backward)).await
}

#[tauri::command]
async fn terminal_health(
    state: State<'_, Arc<Terminals>>,
    distros: Vec<String>,
) -> Result<Vec<Health>> {
    let state = state.inner().clone();
    blocking(move || Ok(state.health(distros))).await
}

#[tauri::command]
fn terminal_active_powershell(state: State<'_, Arc<Terminals>>) -> usize {
    state.active_powershell()
}

#[tauri::command]
async fn prompt_studio_generate(
    state: State<'_, Arc<prompt_studio::PromptStudio>>,
    distro: String,
    request_id: String,
    model: String,
    prompt: String,
    on_delta: Channel<String>,
) -> Result<String> {
    let studio = state.inner().clone();
    blocking(move || studio.generate(&distro, &request_id, &model, &prompt, |text| {
        on_delta.send(text).is_ok()
    }))
    .await
}

#[tauri::command]
fn prompt_studio_cancel(
    state: State<'_, Arc<prompt_studio::PromptStudio>>,
    request_id: String,
) -> Result<()> {
    state.cancel(&request_id)
}

#[tauri::command]
fn terminal_attention_ping() {
    #[cfg(windows)]
    // SAFETY: MessageBeep is asynchronous and takes a numeric sound identifier.
    unsafe {
        use windows_sys::Win32::{System::Diagnostics::Debug::MessageBeep, UI::WindowsAndMessaging::MB_OK};
        MessageBeep(MB_OK);
    }
}

#[tauri::command]
async fn stats_sample(state: State<'_, Arc<stats::Stats>>) -> Result<stats::Sample> {
    let state = state.inner().clone();
    blocking(move || Ok(state.sample())).await
}

fn native_root(path: &str, distro: &str) -> Result<PathBuf> {
    host::resolve(path, distro, true).map(|loc| PathBuf::from(loc.native))
}

#[tauri::command]
async fn dotenv_list(path: String, distro: String) -> Result<Vec<String>> {
    blocking(move || dotenv::list(&native_root(&path, &distro)?)).await
}

#[tauri::command]
async fn dotenv_read(path: String, distro: String, name: String) -> Result<dotenv::Document> {
    blocking(move || dotenv::read(&native_root(&path, &distro)?, &name)).await
}

#[tauri::command]
async fn dotenv_create(path: String, distro: String, name: String) -> Result<dotenv::Document> {
    blocking(move || dotenv::create(&native_root(&path, &distro)?, &name)).await
}

#[tauri::command]
async fn dotenv_save(
    path: String,
    distro: String,
    name: String,
    version: String,
    edits: Vec<dotenv::Edit>,
) -> Result<dotenv::Document> {
    blocking(move || dotenv::save(&native_root(&path, &distro)?, &name, &version, edits)).await
}

#[tauri::command]
async fn templates_list(
    state: State<'_, Arc<Workspace>>,
    project: Option<String>,
) -> Result<Vec<Template>> {
    let state = state.inner().clone();
    blocking(move || state.templates(project.as_deref())).await
}

#[tauri::command]
async fn template_save(state: State<'_, Arc<Workspace>>, edit: TemplateEdit) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.write_template(edit)).await
}

#[tauri::command]
async fn template_remove(
    state: State<'_, Arc<Workspace>>,
    scope: String,
    name: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.remove_template(&scope, &name)).await
}

#[tauri::command]
async fn clipboard_read() -> Result<String> {
    blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.get_text())
            .map_err(|_| "No text is available on the clipboard.".into())
    })
    .await
}

#[tauri::command]
async fn clipboard_write(value: String) -> Result<()> {
    if value.len() > 1024 * 1024 {
        return Err("Clipboard text exceeds 1 MiB.".into());
    }
    blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(value))
            .map_err(|_| "The Windows clipboard is unavailable.".into())
    })
    .await
}

fn open_http(value: &str) -> Result<()> {
    let url = url::Url::parse(&value).map_err(|_| "Invalid browser link.")?;
    if !matches!(url.scheme(), "https" | "http") || url.host().is_none() || value.len() > 4096 {
        return Err("Only HTTP and HTTPS terminal links can be opened.".into());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let url: Vec<u16> = url
            .as_str()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: both wide strings are terminated and live for the duration of the call.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as usize <= 32 {
            return Err("Windows could not open the link.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Browser links are available on Windows.".into())
}

#[tauri::command]
async fn open_terminal_link(value: String) -> Result<()> {
    blocking(move || open_http(&value)).await
}

#[tauri::command]
async fn media_status() -> Result<Option<media::MediaStatus>> {
    blocking(media::status).await
}

#[tauri::command]
async fn media_action(action: media::MediaAction) -> Result<()> {
    blocking(move || media::act(action)).await
}

#[tauri::command]
async fn spotify_status(state: State<'_, Arc<SpotifyApi>>) -> Result<bool> {
    let state = state.inner().clone();
    blocking(move || state.status()).await
}

#[tauri::command]
async fn spotify_connect(state: State<'_, Arc<SpotifyApi>>, client_id: String) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.connect(&client_id, open_http)).await
}

#[tauri::command]
async fn spotify_disconnect(state: State<'_, Arc<SpotifyApi>>) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.disconnect()).await
}

#[tauri::command]
async fn spotify_search(
    state: State<'_, Arc<SpotifyApi>>,
    query: String,
    kind: SpotifyKind,
    offset: u32,
) -> Result<SpotifyPage> {
    let state = state.inner().clone();
    blocking(move || state.search(&query, kind, offset)).await
}

#[tauri::command]
async fn spotify_library(
    state: State<'_, Arc<SpotifyApi>>,
    kind: SpotifyKind,
    offset: u32,
) -> Result<SpotifyPage> {
    let state = state.inner().clone();
    blocking(move || state.library(kind, offset)).await
}

#[tauri::command]
async fn spotify_play(
    state: State<'_, Arc<SpotifyApi>>,
    kind: SpotifyKind,
    id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || state.play(kind, &id)).await
}

fn main() {
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        // Process-local options. Terminal rendering is DOM-based and the intro uses software VP8 decode.
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --disable-accelerated-video-decode",
        );
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            app.manage(Arc::new(SpotifyApi::new(root.join("spotify"))));
            app.manage(Arc::new(Workspace::new(root)));
            app.manage(Arc::new(Terminals::default()));
            app.manage(Arc::new(stats::Stats::default()));
            app.manage(Arc::new(prompt_studio::PromptStudio::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_load,
            workspace_save,
            host_distros,
            host_location,
            host_git,
            host_clone,
            dev_branches,
            dev_pulls,
            dev_containers,
            merge_preview,
            merge_execute,
            merge_observe,
            terminal_create,
            terminal_attach,
            terminal_conceal,
            terminal_terminate,
            terminal_read,
            terminal_write,
            terminal_resize,
            terminal_health,
            terminal_search,
            terminal_active_powershell,
            terminal_attention_ping,
            prompt_studio_generate,
            prompt_studio_cancel,
            stats_sample,
            dotenv_list,
            dotenv_read,
            dotenv_create,
            dotenv_save,
            templates_list,
            template_save,
            template_remove,
            clipboard_read,
            clipboard_write,
            open_terminal_link,
            media_status,
            media_action,
            spotify_status,
            spotify_connect,
            spotify_disconnect,
            spotify_search,
            spotify_library,
            spotify_play,
        ])
        .run(tauri::generate_context!())
        .expect("Could not start AgentDock");
}
