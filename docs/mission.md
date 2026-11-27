# AgentDock mission

The target is a lightweight installed Windows terminal workspace. Ubuntu on WSL is primary, PowerShell is secondary. Existing agent tools, auth, worktrees, and host settings are outside the migration scope. See the architecture for implementation decisions and the verification record for measured outcomes.

## Delivery gates

- [x] Confirm Windows toolchain, WebView2, Ubuntu, tmux and installed CLI versions.
- [x] Inspect requested upstreams and choose reusable terminal components.
- [x] Implement and commit the workspace and session lifecycle, including secondary panels and animations.
- [ ] Exercise actual Windows release and inspect independent review findings.
- [ ] Measure AgentDock, Windows Terminal and VS Code using equivalent local fixtures.
- [ ] Install current-user release, verify shortcuts and installed application.
- [ ] Publish verified source to the authorized private GitHub repository.

## Resume notes

The repository and source remain in WSL. A Windows-side build can use an isolated directory on a volume with sufficient space. A stale inherited WSL interop socket can prevent Windows CLI calls. Select a live socket under `/run/WSL` with a bounded `cmd.exe /d /c ver` probe for the individual command. No WSL or Windows restart is needed. Keep fixture sessions in a separate test scope and leave existing shell and IDE processes alone.

## Current verification checkpoint

The source includes the compact Development panel, the local Tux video, Spotify media controls and PKCE catalog/library integration, and the in-app/local-worktree merge celebrations. The existing global Ship It hook and Startup watcher were inventoried read-only. Retire the exact hook only after observing the replacement in the actual Windows app.

The first Windows release executable compiled and displayed the AgentDock window. The native WebView2 automation connection has been intermittent and must be confirmed before counting desktop feature checks. Benchmark baselines for VS Code and Windows Terminal are in the repository. AgentDock process-tree samples, installer and shortcut verification, authenticated catalog/library checks and the private push remain delivery gates.
