# AgentDock

AgentDock is a Windows terminal workspace for development in Ubuntu WSL and PowerShell. It keeps project and worktree navigation, terminal layouts, prompts, dotenv editing and development status in one window. It uses the Claude Code, Codex, Antigravity, Git, GitHub CLI and Docker installations already available in the selected environment.

## Install

- Use the Windows x64 setup executable produced by the build below. AgentDock installs for the current user with a desktop shortcut and Start menu entry.
- Have WebView2 and a functioning Ubuntu WSL distribution. Ubuntu needs tmux and Python 3. Windows PowerShell and Antigravity also open inside Ubuntu tmux by default.
- Open an existing folder or clone a repository. Select **Shell**, **Claude**, or **Codex** on a project to start a terminal there.

## Build and verify on Windows

Use Node.js 22, Rust with the MSVC target, Microsoft C++ Build Tools and WebView2.

```powershell
npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri -- build --bundles nsis
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
| Switch project | Ctrl+Shift+L |
| Switch session, including discovered sessions | Ctrl+Shift+U |
| Switch visible workspace pane | Ctrl+Shift+M |
| Move focus between workspace regions | F6 / Shift+F6 |
| Hide and detach focused terminal | Ctrl+Shift+H |
| Toggle terminal key passthrough | Ctrl+Shift+Space |
| Close focused terminal | Ctrl+Shift+Backspace |
| Sessions and layout presets | Ctrl+Shift+J |
| Worktrees | Ctrl+Shift+W |
| Workflows and saved prompts | Ctrl+Shift+E |
| Find in terminal | Ctrl+Shift+F |
| Terminal copy | Ctrl+Shift+C |
| Paste Windows clipboard text into a terminal | Ctrl+V or Ctrl+Shift+V |
| Toggle full screen | F11 |

The **Projects** plus opens an existing folder or clones a repository. The plus at the right of the tab row opens a terminal. Drag a pane title or session row to a pane edge to arrange terminals from any project. **Move terminal to another pane** offers the same placement controls from the command palette. Drag a divider or use arrow keys on the focused divider to resize. The Sessions panel can hide terminals, restore named layouts and surface terminal bells or configured periods of quiet.

Switch projects to show their own tabs and running sessions. New terminals start in the project root. The **Worktrees** dialog provides an explicit terminal launch for a linked worktree. The Sessions panel opens with the current project's running sessions and offers a filter for other projects or previous sessions.

Use a project's pin button to keep it at the top of the sidebar. Press Alt+1 through Alt+9 to switch to the first nine pinned projects in pin order.

tmux sessions retain their processes and available history while you hide a pane, switch projects or close the window. **Browse tmux sessions** finds external sessions. Open one to attach, or use **Manage tmux panes** to select, split or close a native pane. You can use tmux keys directly. New AgentDock sessions use the `Ctrl+B` prefix. Open **Keyboard shortcuts** from the command palette to change app bindings. A workspace split can show sessions from different projects.

After a reboot, **Resume agent** opens the installed CLI's own conversation history. Set a conversation ID in **Terminal details** for an exact resume. Claude Code sessions started with the standard launcher already have an assigned ID. Codex can open its native picker and Antigravity needs an explicit conversation ID. New coding agent launches use the workspace's full-access setting. Prompt Studio uses the existing Claude login and offers model selection.

New repositories default to `~/projects` inside Ubuntu. Change **Default clone directory** to use another location. Existing Windows folders remain supported.

Use the X on a terminal pane, a single-terminal tab, or a session row to close that terminal. Live terminals require confirmation. Hide keeps a session running, and the Sessions panel can reopen or close hidden sessions. Use All sessions to find exited terminals.

The Development panel fetches PR and Docker details on demand. Use the Spotify panel to control an existing Windows Spotify media session and optionally connect to the catalog and library.

## Documentation

- [Architecture and upstream evaluation](docs/architecture.md)
- [Measured Windows benchmarks](docs/benchmark-method.md)
- [Engineering workflow template](docs/engineering-template.md)
- [Development panel](docs/dev-status.md)
- [tmux architecture and session lifecycle](docs/tmux-workspace.md)
- [WSL placement audit and benchmarks](docs/wsl-storage.md)
- [Sessions and layout presets](docs/session-view.md)
- [Prompt Studio](docs/prompt-studio.md)
- [Spotify setup](docs/spotify.md)
- [Ship It merge celebrations](docs/ship-it.md)
- [Upstream licences and credits](THIRD_PARTY_NOTICES.txt)

## Troubleshooting

- **Ubuntu terminal unavailable.** Run `wsl.exe --list --verbose` from PowerShell and check the selected distro in AgentDock Settings. Inside that distro, `tmux -V`, `claude --version` and `codex --version` check the installed tools.
- **A Windows network share opens but Ubuntu cannot enter it.** Choose **PowerShell (native compatibility)**. Ubuntu can open paths exposed to the distro, including normal mounted drives and its own WSL files.
- **A session ended while the app was closed.** A tmux session relies on its WSL distribution staying up. After a WSL shutdown or reboot, use the CLI’s saved history to resume. The explicit **PowerShell (native compatibility)** profile ends on app exit after confirmation. Detached processes intentionally started outside the terminal's control follow the operating system's normal lifecycle.
- **A dotenv save reports a disk change.** Reload the file, review the intervening changes, and reapply the edit. AgentDock accepts regular UTF-8 dotenv files and preserves unedited syntax.
- **The PR or Docker results are unavailable.** Refresh that section after checking `gh auth status` or `docker ps` in the relevant environment. The panel uses the local tools on demand.
- **A merge is visible on GitHub but absent from Ship It.** AgentDock verifies completed local merges in its tracked worktrees. A remote-only PR merge has no local HEAD event.
