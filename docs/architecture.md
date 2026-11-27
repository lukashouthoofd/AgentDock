# Architecture

AgentDock is one Tauri 2 window with a bundled vanilla JavaScript interface hosted by Windows WebView2. It uses xterm.js for terminal rendering, portable-pty for ConPTY and the workstation’s Ubuntu tmux for durable sessions. Windows resource readings come from process accounting in the host. AgentDock keeps its own local workspace state and launches the installed agent CLIs as ordinary commands.

## Foundation review

| Project | License | Windows and WSL | Decision |
| --- | --- | --- | --- |
| [Voktty](https://github.com/voktty/voktty) | Apache-2.0 | Tauri, portable-pty, xterm.js, Windows and WSL | Its MCP, agent services, file indexing and general editor make a full fork expensive to trim. |
| [Shellboard](https://github.com/calmbit-sro/shellboard) | No repository license found | Tauri and portable-pty, Windows native shells | Its project layout is relevant. Code reuse requires a license and its disk scrollback differs from AgentDock’s privacy boundary. |
| [wmux](https://github.com/amirlehmam/wmux) | MIT | Electron, node-pty/ConPTY and WSL | Broad adjacent functionality and a second Chromium distribution. |
| [winmux](https://github.com/samo33ddd/winmux) | No repository license found | Electron, xterm.js, ConPTY and WSL | Its persistent daemon and private IPC add an infrastructure surface. Code reuse requires a license. |
| [Windows Terminal](https://github.com/microsoft/terminal) | MIT | Native Windows terminal, ConPTY and WSL | Native comparison baseline. Its Windows application shell is a large customization boundary. |
| [xterm.js](https://github.com/xtermjs/xterm.js) | MIT | Renderer in WebView2 | Reuse renderer, search, fit, Unicode and URL addons. |
| [Termigo](https://github.com/99apps-id/termigo) | Apache-2.0 | Tauri, portable-pty, Windows and WSL | Its PTY output bounds are relevant. Full fork includes a generalized AI/editor/backend surface. |
| [Pebrel](https://github.com/pebrel/pebrel) | GPL-3.0 | Native Rust/GPUI and WSL | Native option with a larger upstream feature and licensing boundary. |

GitHub listings and repository inspection on November 27, 2026 showed recent activity in the six requested repositories. GitHub advisory results and inspected launch surfaces are limited evidence. Upstream installer sizes cannot establish comparable workstation process-tree memory, and no matched six-project measurement was available. The shipped dependencies carry their upstream license obligations. No application source was copied from the evaluated workspaces.

## Trust and lifecycle

The webview loads bundled assets under a restrictive content security policy. It has no remote command surface. Git and WSL arguments cross IPC as data. Launcher commands are user-selected configuration. Terminal links accept HTTP and HTTPS and open outside the application. Terminal output and dotenv contents stay in memory. Terminal metadata records identities, presentation and lifecycle fields only.

Ubuntu session IDs are attached through an isolated tmux server. Detach and termination are separate actions. A Windows shell uses a local ConPTY and a process job owned by AgentDock. Window closure requires explicit disposition of any active Windows shells. Explicit WSL session loss, a WSL shutdown, machine reboot or user termination ends the corresponding session.

Window layout and recent projects live in the application’s per-user local-data directory. Dotenv storage stays in the project. User templates are local Markdown files, scoped globally or by project. The built-in methodology is embedded and can be overridden.
