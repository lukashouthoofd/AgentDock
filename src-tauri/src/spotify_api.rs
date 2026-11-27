use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::{redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use url::Url;

type Result<T> = std::result::Result<T, String>;

const AUTHORIZE: &str = "https://accounts.spotify.com/authorize";
const TOKEN: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";
const CALLBACK_PORT: u16 = 45867;
const SCOPE: &str = "user-library-read playlist-read-private playlist-read-collaborative user-modify-playback-state";
const PAGE_SIZE: u32 = 10;
const MAX_RESPONSE: u64 = 2 * 1024 * 1024;
const MAX_CREDENTIAL: u64 = 64 * 1024;
const HTTP_ERROR: &str = "Spotify could not be reached. Check your connection and try again.";
const RATE_LIMIT: &str = "Spotify is rate limiting requests. Wait a moment and try again.";
const RECONNECT: &str = "Spotify access has expired or been removed. Disconnect and connect again.";
const AUTH_INTERRUPTED: &str = "Spotify connection was cancelled.";
const STORAGE_ERROR: &str =
    "AgentDock could not access the protected Spotify connection on this computer.";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpotifyKind {
    Track,
    Playlist,
    Show,
    Episode,
}

impl SpotifyKind {
    fn singular(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Playlist => "playlist",
            Self::Show => "show",
            Self::Episode => "episode",
        }
    }

    fn plural(self) -> &'static str {
        match self {
            Self::Track => "tracks",
            Self::Playlist => "playlists",
            Self::Show => "shows",
            Self::Episode => "episodes",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyItem {
    id: String,
    name: String,
    subtitle: String,
    url: String,
    can_play: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPage {
    items: Vec<SpotifyItem>,
    next_offset: Option<u32>,
}

#[derive(Deserialize, Serialize)]
struct SavedConnection {
    client_id: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct TokenGrant {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

struct AccessToken {
    value: String,
    expires: Instant,
}

struct Session {
    saved: SavedConnection,
    access: Option<AccessToken>,
}

#[derive(Default)]
struct Connection {
    restored: bool,
    session: Option<Session>,
    pending: Option<Arc<AtomicBool>>,
}

pub struct SpotifyApi {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SpotifyApi {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            path: directory.join("spotify-session.bin"),
            connection: Mutex::new(Connection::default()),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| "Spotify connection state is unavailable.".into())
    }

    fn restored(&self) -> Result<MutexGuard<'_, Connection>> {
        let mut connection = self.lock()?;
        if !connection.restored {
            connection.session = self.read_saved()?.map(|saved| Session {
                saved,
                access: None,
            });
            connection.restored = true;
        }
        Ok(connection)
    }

    pub fn status(&self) -> Result<bool> {
        Ok(self.restored()?.session.is_some())
    }

    pub fn connect(&self, client_id: &str, open: impl FnOnce(&str) -> Result<()>) -> Result<()> {
        let client_id = client_id.trim();
        if client_id.len() != 32 || !client_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(
                "Enter the 32-character Client ID from the Spotify developer dashboard.".into(),
            );
        }
        let pending = Arc::new(AtomicBool::new(false));
        {
            let mut connection = self.restored()?;
            if connection.session.is_some() || connection.pending.is_some() {
                return Err("A Spotify connection already exists or is being opened.".into());
            }
            connection.pending = Some(pending.clone());
        }

        let authorization = authorize(client_id, &pending, open);
        let mut connection = self.lock()?;
        if !connection
            .pending
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &pending))
        {
            return Err(AUTH_INTERRUPTED.into());
        }
        connection.pending = None;
        let grant = authorization?;
        let access = access_token(&grant)?;
        let saved = SavedConnection {
            client_id: client_id.to_owned(),
            refresh_token: grant
                .refresh_token
                .filter(|value| valid_token(value))
                .ok_or("Spotify did not return a usable refresh token.")?,
        };
        self.write_saved(&saved)?;
        connection.session = Some(Session {
            saved,
            access: Some(access),
        });
        Ok(())
    }

    pub fn disconnect(&self) -> Result<()> {
        let mut connection = self.lock()?;
        if let Some(pending) = connection.pending.take() {
            pending.store(true, Ordering::Relaxed);
        }
        match fs::remove_file(&self.path) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::NotFound => (),
            Err(_) => return Err(STORAGE_ERROR.into()),
        }
        connection.session = None;
        connection.restored = true;
        Ok(())
    }

    pub fn search(&self, query: &str, kind: SpotifyKind, offset: u32) -> Result<SpotifyPage> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 240 {
            return Err("Enter a Spotify search query of up to 240 characters.".into());
        }
        if offset > 1000 {
            return Err("That search page is out of range.".into());
        }
        let response = self.authorized(|http| {
            http.get(format!("{API}/search")).query(&[
                ("q", query.to_owned()),
                ("type", kind.singular().into()),
                ("limit", PAGE_SIZE.to_string()),
                ("offset", offset.to_string()),
            ])
        })?;
        let payload: Value = read_json(response, MAX_RESPONSE)?;
        page(&payload[kind.plural()], kind, false, offset, 1000)
    }

    pub fn library(&self, kind: SpotifyKind, offset: u32) -> Result<SpotifyPage> {
        const MAX_OFFSET: u32 = 100_000;
        if offset > MAX_OFFSET {
            return Err("That library page is out of range.".into());
        }
        let response = self.authorized(|http| {
            http.get(format!("{API}/me/{}", kind.plural()))
                .query(&[("limit", PAGE_SIZE), ("offset", offset)])
        })?;
        page(
            &read_json(response, MAX_RESPONSE)?,
            kind,
            !matches!(kind, SpotifyKind::Playlist),
            offset,
            MAX_OFFSET,
        )
    }

    pub fn play(&self, kind: SpotifyKind, id: &str) -> Result<()> {
        if !valid_item_id(id) {
            return Err("This Spotify item is unavailable.".into());
        }
        let uri = format!("spotify:{}:{id}", kind.singular());
        let body = match kind {
            SpotifyKind::Track => json!({ "uris": [uri] }),
            SpotifyKind::Playlist => json!({ "context_uri": uri }),
            _ => return Err("Open this item in Spotify to play it.".into()),
        };
        self.authorized(|http| http.put(format!("{API}/me/player/play")).json(&body))?;
        Ok(())
    }

    fn authorized(&self, request: impl Fn(&Client) -> RequestBuilder) -> Result<Response> {
        let http = client()?;
        let mut connection = self.restored()?;
        let session = connection
            .session
            .as_mut()
            .ok_or("Connect Spotify to use search and your library.")?;
        let token = self.token(&http, session, false)?;
        let mut response = request(&http)
            .bearer_auth(token)
            .send()
            .map_err(|_| HTTP_ERROR)?;
        if response.status() == StatusCode::UNAUTHORIZED {
            let token = self.token(&http, session, true)?;
            response = request(&http)
                .bearer_auth(token)
                .send()
                .map_err(|_| HTTP_ERROR)?;
        }
        match response.status() {
            code if code.is_success() => Ok(response),
            StatusCode::UNAUTHORIZED => Err(RECONNECT.into()),
            StatusCode::FORBIDDEN => Err("Spotify refused access. Check the app's approved users, permissions and Premium requirement.".into()),
            StatusCode::NOT_FOUND => Err("Spotify could not find the item or an active playback device.".into()),
            StatusCode::TOO_MANY_REQUESTS => Err(RATE_LIMIT.into()),
            _ => Err("Spotify could not complete this request.".into()),
        }
    }

    fn token<'a>(&self, http: &Client, session: &'a mut Session, refresh: bool) -> Result<&'a str> {
        if refresh
            || session
                .access
                .as_ref()
                .is_none_or(|access| Instant::now() >= access.expires)
        {
            let grant = exchange(
                http,
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", &session.saved.client_id),
                    ("refresh_token", &session.saved.refresh_token),
                ],
            )?;
            let access = access_token(&grant)?;
            if let Some(refresh_token) = grant.refresh_token.filter(|value| valid_token(value)) {
                let saved = SavedConnection {
                    client_id: session.saved.client_id.clone(),
                    refresh_token,
                };
                self.write_saved(&saved)?;
                session.saved = saved;
            }
            session.access = Some(access);
        }
        session
            .access
            .as_ref()
            .map(|access| access.value.as_str())
            .ok_or(RECONNECT.into())
    }

    fn read_saved(&self) -> Result<Option<SavedConnection>> {
        #[cfg(windows)]
        {
            let file = match fs::File::open(&self.path) {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(STORAGE_ERROR.into()),
            };
            let encrypted = read_bounded(file, MAX_CREDENTIAL).map_err(|_| STORAGE_ERROR)?;
            let mut plain = dpapi(&encrypted, false)?;
            let decoded = serde_json::from_slice(&plain).map_err(|_| STORAGE_ERROR.to_owned());
            plain.fill(0);
            decoded.map(Some)
        }
        #[cfg(not(windows))]
        Ok(None)
    }

    fn write_saved(&self, saved: &SavedConnection) -> Result<()> {
        #[cfg(windows)]
        {
            let parent = self.path.parent().ok_or(STORAGE_ERROR)?;
            fs::create_dir_all(parent).map_err(|_| STORAGE_ERROR)?;
            let mut plain = serde_json::to_vec(saved).map_err(|_| STORAGE_ERROR)?;
            let encrypted = dpapi(&plain, true);
            plain.fill(0);
            let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| STORAGE_ERROR)?;
            file.write_all(&encrypted?).map_err(|_| STORAGE_ERROR)?;
            file.as_file().sync_all().map_err(|_| STORAGE_ERROR)?;
            file.persist(&self.path).map_err(|_| STORAGE_ERROR)?;
        }
        #[cfg(not(windows))]
        let _ = saved;
        Ok(())
    }
}

fn client() -> Result<Client> {
    Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| HTTP_ERROR.into())
}

fn read_bounded(source: impl Read, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    source.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "Response exceeds its size limit",
        ));
    }
    Ok(bytes)
}

fn read_json<T: serde::de::DeserializeOwned>(response: Response, limit: u64) -> Result<T> {
    let data =
        read_bounded(response, limit).map_err(|_| "Spotify returned an unreadable response.")?;
    serde_json::from_slice(&data).map_err(|_| "Spotify returned an unexpected response.".into())
}

fn exchange(http: &Client, form: &[(&str, &str)]) -> Result<TokenGrant> {
    let response = http.post(TOKEN).form(form).send().map_err(|_| HTTP_ERROR)?;
    let status = response.status();
    if status.is_success() {
        let mut bytes = read_bounded(response, MAX_CREDENTIAL).map_err(|_| HTTP_ERROR)?;
        let grant = serde_json::from_slice(&bytes)
            .map_err(|_| "Spotify returned an unexpected authorization response.".into());
        bytes.fill(0);
        return grant;
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(RATE_LIMIT.into());
    }
    if status.is_server_error() {
        return Err(HTTP_ERROR.into());
    }
    if form.contains(&("grant_type", "refresh_token")) && status.is_client_error() {
        return Err(RECONNECT.into());
    }
    Err("Spotify did not authorize this connection. Check the Client ID and registered redirect URI.".into())
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 8192 && token.bytes().all(|c| c.is_ascii_graphic())
}

fn access_token(grant: &TokenGrant) -> Result<AccessToken> {
    if !valid_token(&grant.access_token)
        || !grant.token_type.eq_ignore_ascii_case("Bearer")
        || grant.expires_in == 0
    {
        return Err("Spotify returned an invalid access token.".into());
    }
    let lifetime = grant.expires_in.min(86_400).saturating_sub(30);
    Ok(AccessToken {
        value: grant.access_token.clone(),
        expires: Instant::now() + Duration::from_secs(lifetime),
    })
}

fn random_key() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "AgentDock could not initialize secure Spotify authorization.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn authorize(
    client_id: &str,
    cancel: &AtomicBool,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<TokenGrant> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, CALLBACK_PORT)).map_err(|error| {
        if error.kind() == ErrorKind::AddrInUse {
            "The Spotify callback port 45867 is in use. Close the other process using it and try again."
        } else {
            "Could not open the local Spotify callback on port 45867."
        }
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not prepare the Spotify callback.")?;
    let host = listener
        .local_addr()
        .map_err(|_| "Could not read the Spotify callback address.")?
        .to_string();
    let redirect = format!("http://{host}/callback");
    let verifier = random_key()?;
    let state = random_key()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse(AUTHORIZE).map_err(|_| "Invalid Spotify authorization URL.")?;
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", client_id),
        ("scope", SCOPE),
        ("redirect_uri", &redirect),
        ("state", &state),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
    ]);
    if cancel.load(Ordering::Relaxed) {
        return Err(AUTH_INTERRUPTED.into());
    }
    open(url.as_str())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline && !cancel.load(Ordering::Relaxed) {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(75));
                continue;
            }
            Err(_) => return Err("Could not read the Spotify callback.".into()),
        };
        match read_callback(&mut stream, &host, &state) {
            Some(Callback::Code(code)) if !cancel.load(Ordering::Relaxed) => {
                let grant = client().and_then(|http| {
                    exchange(
                        &http,
                        &[
                            ("grant_type", "authorization_code"),
                            ("client_id", client_id),
                            ("code", &code),
                            ("redirect_uri", &redirect),
                            ("code_verifier", &verifier),
                        ],
                    )
                });
                callback_response(
                    &mut stream,
                    grant.is_ok(),
                    if grant.is_ok() {
                        "Spotify authorization received. You can return to AgentDock."
                    } else {
                        "Spotify authorization failed. Return to AgentDock for details."
                    },
                );
                return grant;
            }
            Some(Callback::Denied) => {
                callback_response(
                    &mut stream,
                    true,
                    "Spotify authorization was declined. You can return to AgentDock.",
                );
                return Err("Spotify authorization was declined.".into());
            }
            _ => callback_response(&mut stream, false, "Invalid Spotify callback."),
        }
    }
    if cancel.load(Ordering::Relaxed) {
        Err(AUTH_INTERRUPTED.into())
    } else {
        Err("Spotify authorization timed out. Connect again when ready.".into())
    }
}

enum Callback {
    Code(String),
    Denied,
}

fn read_callback(stream: &mut TcpStream, host: &str, state: &str) -> Option<Callback> {
    stream.set_nonblocking(false).ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::with_capacity(2048);
    let mut buffer = [0u8; 1024];
    while bytes.len() < 16 * 1024 && !bytes.ends_with(b"\r\n\r\n") {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        stream
            .set_read_timeout(Some(remaining.max(Duration::from_millis(1))))
            .ok()?;
        let n = stream.read(&mut buffer).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    if bytes.len() > 16 * 1024 {
        return None;
    }
    parse_callback(std::str::from_utf8(&bytes).ok()?, host, state)
}

fn parse_callback(request: &str, host: &str, state: &str) -> Option<Callback> {
    let mut headers = request.split_once("\r\n\r\n")?.0.split("\r\n");
    let mut line = headers.next()?.split(' ');
    if line.next()? != "GET" {
        return None;
    }
    let target = line.next()?;
    if line.next()? != "HTTP/1.1" || line.next().is_some() || !target.starts_with("/callback?") {
        return None;
    }
    let mut hosts = headers.filter_map(|header| {
        let (name, value) = header.split_once(':')?;
        name.eq_ignore_ascii_case("host").then_some(value.trim())
    });
    if hosts.next()? != host || hosts.next().is_some() {
        return None;
    }
    let url = Url::parse(&format!("http://{host}{target}")).ok()?;
    if url.fragment().is_some() {
        return None;
    }
    let (mut seen_state, mut code, mut error) = (false, None, None);
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" if !seen_state && value == state => seen_state = true,
            "code" if code.is_none() && valid_token(&value) => code = Some(value.into_owned()),
            "error" if error.is_none() => error = Some(value.into_owned()),
            "state" | "code" | "error" => return None,
            _ => (),
        }
    }
    if !seen_state {
        return None;
    }
    match (code, error) {
        (Some(code), None) => Some(Callback::Code(code)),
        (None, Some(_)) => Some(Callback::Denied),
        _ => None,
    }
}

fn callback_response(stream: &mut TcpStream, success: bool, body: &str) {
    let status = if success { "200 OK" } else { "400 Bad Request" };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn valid_item_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn metadata(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(240)
        .collect()
}

fn page(
    payload: &Value,
    kind: SpotifyKind,
    wrapped: bool,
    offset: u32,
    max_offset: u32,
) -> Result<SpotifyPage> {
    let records = payload["items"]
        .as_array()
        .ok_or("Spotify returned an unexpected results page.")?;
    let items = records
        .iter()
        .take(PAGE_SIZE as usize)
        .filter_map(|record| {
            let value = if wrapped {
                &record[kind.singular()]
            } else {
                record
            };
            let id = value["id"].as_str().filter(|id| valid_item_id(id))?;
            let name = metadata(&value["name"]);
            if name.is_empty() {
                return None;
            }
            let subtitle = match kind {
                SpotifyKind::Track => value["artists"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(5)
                    .map(|artist| metadata(&artist["name"]))
                    .filter(|name| !name.is_empty())
                    .collect::<Vec<_>>()
                    .join(", "),
                SpotifyKind::Playlist => metadata(&value["owner"]["display_name"]),
                SpotifyKind::Show => metadata(&value["publisher"]),
                SpotifyKind::Episode => metadata(&value["release_date"]),
            };
            Some(SpotifyItem {
                id: id.to_owned(),
                name,
                subtitle,
                url: format!("https://open.spotify.com/{}/{id}", kind.singular()),
                can_play: matches!(kind, SpotifyKind::Track | SpotifyKind::Playlist)
                    && value["is_playable"].as_bool() != Some(false),
            })
        })
        .collect();
    let next_offset = (payload["next"].is_string() && offset + PAGE_SIZE <= max_offset)
        .then_some(offset + PAGE_SIZE);
    Ok(SpotifyPage { items, next_offset })
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(input.len()).map_err(|_| STORAGE_ERROR)?,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // DPAPI reads `source` for the duration of the call and allocates `out`
    // with LocalAlloc. All optional arguments are unused.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &source,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &source,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
    };
    if ok == 0 || out.pbData.is_null() {
        return Err(STORAGE_ERROR.into());
    }
    // The success result holds exactly cbData bytes until LocalFree.
    let output = unsafe {
        let bytes = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
        let copied = bytes.to_vec();
        if !protect {
            bytes.fill(0);
        }
        LocalFree(out.pbData.cast());
        copied
    };
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_requires_exact_host_path_and_single_state() {
        const HOST: &str = "127.0.0.1:45867";
        let request =
            |path: &str, host: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n");
        let approved = parse_callback(
            &request("/callback?code=code123&state=state123", HOST),
            HOST,
            "state123",
        );
        assert!(matches!(approved, Some(Callback::Code(code)) if code == "code123"));
        let denied = parse_callback(
            &request("/callback?error=access_denied&state=state123", HOST),
            HOST,
            "state123",
        );
        assert!(matches!(denied, Some(Callback::Denied)));
        for (path, host) in [
            ("/callback?code=code123&state=wrong", HOST),
            ("/callback?code=code123&state=state123&state=state123", HOST),
            ("/callback?code=code123&code=other&state=state123", HOST),
            ("/callback?code=code123&error=denied&state=state123", HOST),
            ("/callback?code=code123&state=state123", "example.test"),
            ("/different?code=code123&state=state123", HOST),
        ] {
            assert!(parse_callback(&request(path, host), HOST, "state123").is_none());
        }
    }

    #[test]
    fn loopback_reads_browser_request_and_returns_plain_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let mut browser = TcpStream::connect(address).unwrap();
            browser
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            write!(
                browser,
                "GET /callback?code=from-browser&state=nonce HTTP/1.1\r\nHost: {address}\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            browser.read_to_string(&mut response).unwrap();
            response
        });
        let (mut stream, _) = listener.accept().unwrap();
        let parsed = read_callback(&mut stream, &address.to_string(), "nonce");
        assert!(matches!(parsed, Some(Callback::Code(code)) if code == "from-browser"));
        callback_response(&mut stream, true, "Return to AgentDock.");
        drop(stream);
        let response = worker.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("Cache-Control: no-store\r\n"));
        assert!(!response.contains("from-browser"));
    }

    #[test]
    fn catalog_normalization_ignores_untrusted_links_and_preserves_pagination() {
        let sample = json!({"next": "https://example.test/ignored", "items": [
            {"track": {"id": "1a23456789012345678901", "name": "A song", "artists": [{"name": "Artist"}],
                "external_urls": {"spotify": "https://example.test/ignored"}}},
            {"track": {"id": "../../other", "name": "Ignored"}},
            {"track": null}
        ]});
        let normalized = page(&sample, SpotifyKind::Track, true, 10, 100).unwrap();
        assert_eq!(normalized.next_offset, Some(20));
        assert_eq!(normalized.items.len(), 1);
        assert_eq!(normalized.items[0].subtitle, "Artist");
        assert_eq!(
            normalized.items[0].url,
            "https://open.spotify.com/track/1a23456789012345678901"
        );
        assert!(normalized.items[0].can_play);
    }

    #[cfg(windows)]
    #[test]
    fn protected_refresh_token_round_trips_and_disconnect_removes_it() {
        let directory = tempfile::tempdir().unwrap();
        let api = SpotifyApi::new(directory.path().to_path_buf());
        let local = SavedConnection {
            client_id: "fixture-client".into(),
            refresh_token: "fixture-refresh".into(),
        };
        api.write_saved(&local).unwrap();
        let disk = fs::read(&api.path).unwrap();
        assert!(!disk
            .windows(b"fixture-refresh".len())
            .any(|window| window == b"fixture-refresh"));
        assert_eq!(
            api.read_saved().unwrap().unwrap().refresh_token,
            "fixture-refresh"
        );
        assert!(api.status().unwrap());
        api.disconnect().unwrap();
        assert!(!api.status().unwrap());
        assert!(!api.path.exists());
    }
}
