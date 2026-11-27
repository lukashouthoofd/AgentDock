use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    title: String,
    artist: String,
    playing: Option<bool>,
    can_toggle: bool,
    can_previous: bool,
    can_next: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaAction {
    Toggle,
    Previous,
    Next,
}

#[cfg(not(windows))]
pub fn status() -> Result<Option<MediaStatus>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub fn act(_: MediaAction) -> Result<(), String> {
    Err("Spotify playback controls require Windows.".into())
}

#[cfg(windows)]
pub use windows_media::{act, status};

#[cfg(windows)]
mod windows_media {
    use super::{MediaAction, MediaStatus};
    use windows::{
        Media::Control::{
            GlobalSystemMediaTransportControlsSession as Session,
            GlobalSystemMediaTransportControlsSessionManager as Manager,
            GlobalSystemMediaTransportControlsSessionPlaybackControls as Controls,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback,
        },
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    };

    const UNAVAILABLE: &str = "Windows media controls are unavailable.";
    const NO_SESSION: &str = "There is no active Spotify desktop media session.";
    const ACTION_FAILED: &str = "Spotify did not accept that playback control.";

    struct Apartment;

    impl Apartment {
        fn enter() -> Result<Self, String> {
            // The caller runs on a blocking worker. Keep initialization and all
            // WinRT objects on that worker until the operation completes.
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| UNAVAILABLE.to_string())?;
            Ok(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }

    fn is_spotify(session: &Session) -> bool {
        session.SourceAppUserModelId().is_ok_and(|id| {
            matches!(
                id.to_string().to_ascii_lowercase().as_str(),
                "spotify.exe" | "spotify" | "spotifyab.spotifymusic_zpdnekdrzrea0!spotify"
            )
        })
    }

    fn spotify_session() -> windows::core::Result<Option<Session>> {
        let manager = Manager::RequestAsync()?.join()?;
        if let Ok(current) = manager.GetCurrentSession() {
            if is_spotify(&current) {
                return Ok(Some(current));
            }
        }
        Ok(manager.GetSessions()?.into_iter().find(is_spotify))
    }

    #[derive(Clone, Copy)]
    enum Toggle {
        Native,
        Pause,
        Play,
    }

    fn playing(playback: Playback) -> Option<bool> {
        match playback {
            Playback::Playing => Some(true),
            Playback::Paused | Playback::Stopped | Playback::Opened => Some(false),
            _ => None,
        }
    }

    fn toggle(controls: &Controls, playing: Option<bool>) -> Option<Toggle> {
        if controls.IsPlayPauseToggleEnabled().unwrap_or(false) {
            return Some(Toggle::Native);
        }
        match playing {
            Some(true) if controls.IsPauseEnabled().unwrap_or(false) => Some(Toggle::Pause),
            Some(false) if controls.IsPlayEnabled().unwrap_or(false) => Some(Toggle::Play),
            _ => None,
        }
    }

    pub fn status() -> Result<Option<MediaStatus>, String> {
        let _apartment = Apartment::enter()?;
        let Some(session) = spotify_session().map_err(|_| UNAVAILABLE.to_string())? else {
            return Ok(None);
        };

        let properties = session
            .TryGetMediaPropertiesAsync()
            .and_then(|read| read.join());
        let (title, artist) = properties.map_or_else(
            |_| (String::new(), String::new()),
            |value| {
                (
                    value.Title().unwrap_or_default().to_string(),
                    value.Artist().unwrap_or_default().to_string(),
                )
            },
        );
        let playback = session.GetPlaybackInfo().ok();
        let playing = playback
            .as_ref()
            .and_then(|info| playing(info.PlaybackStatus().ok()?));
        let controls = playback.and_then(|info| info.Controls().ok());
        Ok(Some(MediaStatus {
            title,
            artist,
            playing,
            can_toggle: controls
                .as_ref()
                .is_some_and(|caps| toggle(caps, playing).is_some()),
            can_previous: controls
                .as_ref()
                .is_some_and(|caps| caps.IsPreviousEnabled().unwrap_or(false)),
            can_next: controls
                .as_ref()
                .is_some_and(|caps| caps.IsNextEnabled().unwrap_or(false)),
        }))
    }

    pub fn act(action: MediaAction) -> Result<(), String> {
        let _apartment = Apartment::enter()?;
        let session = spotify_session()
            .map_err(|_| UNAVAILABLE.to_string())?
            .ok_or(NO_SESSION)?;
        let playback = session.GetPlaybackInfo().map_err(|_| ACTION_FAILED)?;
        let controls = playback.Controls().map_err(|_| ACTION_FAILED)?;
        let operation = match action {
            MediaAction::Previous if controls.IsPreviousEnabled().unwrap_or(false) => {
                session.TrySkipPreviousAsync()
            }
            MediaAction::Next if controls.IsNextEnabled().unwrap_or(false) => {
                session.TrySkipNextAsync()
            }
            MediaAction::Toggle => {
                match toggle(&controls, playback.PlaybackStatus().ok().and_then(playing)) {
                    Some(Toggle::Native) => session.TryTogglePlayPauseAsync(),
                    Some(Toggle::Play) => session.TryPlayAsync(),
                    Some(Toggle::Pause) => session.TryPauseAsync(),
                    None => return Err(ACTION_FAILED.into()),
                }
            }
            _ => return Err(ACTION_FAILED.into()),
        };
        if operation.and_then(|op| op.join()).unwrap_or(false) {
            Ok(())
        } else {
            Err(ACTION_FAILED.into())
        }
    }
}
