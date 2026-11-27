# tmux workspace consolidation

Ubuntu shells, Windows PowerShell via WSL interoperability, and the installed coding agents start in tmux. ConPTY carries the interactive client, while xterm.js renders it. The Sessions rail combines live tmux inventory with workspace labels and placement stored locally. Older native Windows sessions and the explicit native compatibility profile keep their Windows process path.

## Backend boundary

Use tmux as the execution authority for session and pane state, working directories, attach and detach, process creation, and retained scrollback. AgentDock keeps an ephemeral interactive client and a bounded transport queue for visible panes. It owns workspace placement, project pins, keyboard actions, launch policy, user-provided metadata and exact resume references.

Discovery returns session and pane metadata from servers owned by the current Unix user. An externally created session remains external until the user attaches or assigns a project. The identity combines Ubuntu distribution, socket address, and server and session epochs. An expired reference can be shown as previous history. Operations on a live session use an exact verified identity. Discovery does not read pane contents or modify tmux settings.

Use the same command and target boundary for app launches and discovered sessions. Preserve older `agentdock-v1` sessions by their reserved UUID-backed names. Native tmux splits act within one session. Workspace splits arrange separate terminal views, including sessions from different projects. The host boundary runs tmux commands and adapter discovery locally via WSL. A future SSH adapter can use those action and session fields.

## Agent resume

An available live tmux session reconnects to its current process and scrollback. After a host reboot, tmux process state is gone. Resume uses the installed agent's own history and an exact conversation ID where one is available. Claude Code can start with an app-selected session UUID. Codex and Claude Code can also open their own resume selection UI. AgentDock never infers the correct conversation from inactivity or the latest history entry.

## Verification

- Discover disposable sessions on the default and alternate tmux servers.
- Attach, detach, rename, split, select, and close exact targets. Test a stale identity and a neighboring session that must stay alive.
- Verify that closing the native app preserves the true session PIDs and that reopening the app reconnects to those sessions and their history.
- Exercise keyboard-only project, tab, pane, session, and dialog navigation. Verify a custom binding and terminal passthrough with the exit binding.
- Verify a Claude exact session reference and the Codex native resume entry point with the installed tools. Record any Windows interoperability limitations observed during testing.

### Observed results

On Windows with Ubuntu-24.04 and tmux 3.4, the focused desktop suite passed all 11 checks. It discovered two disposable tmux sockets, attached to the exact original Bash PID, searched native history, renamed and split the intended session, changed pane focus and ended only the confirmed pane. A stale rename left the replacement session unchanged. Custom shortcuts and terminal passthrough survived reopening. Ubuntu and default PowerShell retained their original process IDs and environment variables. Explicit Close ended the default PowerShell test process.

A real Claude Code process resumed a disposable conversation by UUID and returned a word stored by its predecessor. The installed Codex CLI did the same through an exact native conversation ID. These tests started new CLI processes without restarting Windows or WSL. Antigravity exposes an installed CLI resume option, and an authenticated Antigravity resume was outside these fixture checks.

The independent native review also exercised a socket replacement between verification and attach, a stale server identity, cross-window pane selection, and partial inventory. The guarded helper pins the socket inode and scopes every pane action to its session and window. tmux window activity can advance on selection. The UI uses it for observed activity and quiet-watch timing, with transport output tracked separately.
