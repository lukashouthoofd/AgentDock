# AgentDock

AgentDock is a Windows terminal workspace for development in Ubuntu WSL and PowerShell. It keeps project and worktree navigation, terminal layouts, prompts, dotenv editing and development status in one window. It uses the Claude Code, Codex, Git, GitHub CLI and Docker installations already available in the selected environment.

## Install

- Use the Windows x64 setup executable produced by the build below. AgentDock installs for the current user with a desktop shortcut and Start menu entry.
- Have WebView2 and a functioning Ubuntu WSL distribution. Install tmux in Ubuntu if it is absent. PowerShell uses the native Windows terminal profile.
- Open an existing folder or clone a repository. Select **Shell**, **Claude**, or **Codex** on a project to start a terminal there.

## Build and verify on Windows

Use Node.js 22, Rust with the MSVC target, Microsoft C++ Build Tools and WebView2.

```powershell
npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri build -- --bundles nsis
```

The default installer output is under `src-tauri/target/release/bundle/nsis`. Cargo also supports moving build output to a separate volume through `CARGO_TARGET_DIR`. Native desktop verification uses `scripts/test-windows.mjs` with disposable fixtures and the release executable. See [verification](docs/verification.md) for observed coverage and benchmark methods.

## Use

| Action | Shortcut |
| --- | --- |
| Commands, projects, worktrees and terminals | Ctrl+Shift+P |
| Open project | Ctrl+Shift+O |
| New Ubuntu shell | Ctrl+Shift+T |
| Launch Claude Code | Ctrl+Alt+Shift+C |
| Launch Codex | Ctrl+Shift+K |
| Switch terminal tab | Ctrl+Tab |
| Worktrees | Ctrl+Shift+W |
| Workflows and saved prompts | Ctrl+Shift+E |
| Find in terminal | Ctrl+Shift+F |
| Terminal copy and paste | Ctrl+Shift+C / Ctrl+Shift+V |
| Toggle full screen | F11 |

Drag pane titles to move panes. Drag dividers or focus a divider and press an arrow key to resize. Ubuntu sessions can detach and reconnect while WSL remains running. Closing the window prompts before ending active PowerShell sessions. The Development panel fetches PR and Docker details on demand. Use the Spotify panel to control an existing Windows Spotify media session and optionally connect to the catalog and library.

## Documentation

- [Architecture and upstream evaluation](docs/architecture.md)
- [Engineering workflow template](docs/engineering-template.md)
- [Development panel](docs/dev-status.md)
- [Spotify setup](docs/spotify.md)
- [Ship It merge celebrations](docs/ship-it.md)
- [Upstream licences and credits](THIRD_PARTY_NOTICES.txt)
