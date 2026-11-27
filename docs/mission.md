# AgentDock mission

The target is a lightweight installed Windows terminal workspace. Ubuntu on WSL is primary, PowerShell is secondary. Existing agent tools, auth, worktrees, and host settings are outside the migration scope. See the architecture for implementation decisions and the verification record for measured outcomes.

## Delivery gates

- [x] Confirm Windows toolchain, WebView2, Ubuntu, tmux and installed CLI versions.
- [x] Inspect requested upstreams and choose reusable terminal components.
- [ ] Implement and commit the workspace and session lifecycle.
- [ ] Exercise actual Windows release and inspect independent review findings.
- [ ] Measure AgentDock, Windows Terminal and VS Code using equivalent local fixtures.
- [ ] Install current-user release, verify shortcuts and installed application.
- [ ] Publish verified source to the authorized private GitHub repository.

## Resume notes

The repository and source remain in WSL. A Windows-side build can use an isolated directory on a volume with sufficient space. A stale inherited WSL interop socket can prevent Windows CLI calls. Select a live socket under `/run/WSL` with a bounded `cmd.exe /d /c ver` probe for the individual command. No WSL or Windows restart is needed. Keep fixture sessions in a separate test scope and leave existing shell and IDE processes alone.
