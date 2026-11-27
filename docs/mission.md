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

The first Windows release executable compiled and displayed the AgentDock window. The WebView2 automation connection opened via the native test launch. A Windows UI pilot confirmed Linux and Ubuntu-24.04 from inside an AgentDock terminal. Independent benchmarks and remaining desktop checks use a fresh verification application profile because other Claude sessions started in the original preview. Benchmark baselines for VS Code and Windows Terminal are in the repository. Live Spotify search and library authorization passed in a separate native verification process. Clean AgentDock process-tree samples, the complete native desktop checks, installer and shortcut verification, and the private push remain delivery gates.

The native verification rerun passed through the terminal, Git, dotenv and workflow checks. It reached 17 live Ubuntu terminals before the former tab row expanded the workspace and obscured the toolbar. The updated tab strip keeps its action buttons fixed. A native Windows release test verified the two plus menus and dragging a live Windows process from the sidebar and by its pane header into all four positions beside an Ubuntu shell. The latest source adds named layouts, notification-based attention, configurable launch permissions and Prompt Studio model selection. The complete native test includes layout restoration and 20 sessions.
