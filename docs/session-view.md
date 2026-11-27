# Sessions rail

Open Sessions from the terminal tab row or press Ctrl+Shift+J. Search by terminal title, role, project, distribution, worktree path or observed status. Filter for the current project, running terminals, pinned sessions or sessions with attention to review.

Open focuses a real terminal. Drag a session title to an edge of a terminal pane to choose left, right, above or below. Use Beside or Below to split relative to the focused terminal with a button. Hide removes the pane from the layout and keeps the session available in the rail. On a narrow app window, the rail temporarily overlays the terminal workspace and clears after opening or placing a terminal. In a wide window, it docks on the right.

Use Layouts to name and save the current arrangement, restore a saved arrangement or delete a preset. Choose a preset manually for either screen. Opening a layout changes pane placement while terminal sessions keep their independent lifecycle.

The rail uses AgentDock’s existing session and health snapshots. Output times reflect the most recent output observed by AgentDock. Quiet, hidden, detached and unavailable carry no claim about an agent’s progress. Pinning and acknowledging are user actions. The rail loads no terminal transcripts and runs no separate polling loop.

The pane border turns red for a real terminal bell. AgentDock’s default Claude Code and Codex launchers request bells for their documented input and permission events using settings scoped to that launch. Other terminal applications can also emit bells. Enable an optional Windows sound in Settings. Set a quiet threshold in Terminal details to surface long gaps in observed output. Windows PowerShell, attached Ubuntu and detached Ubuntu on AgentDock’s tmux socket provide different levels of activity metadata. [Claude Code notification hooks](https://code.claude.com/docs/en/hooks#notification) [Codex terminal notification settings](https://learn.chatgpt.com/docs/config-file/config-reference)

Settings controls full access for new launches. The default commands use each installed CLI's full-access option. A customized launch command can place the flag with `{permissions}`. Use this placeholder if the command contains pipes or other shell operators. Flags written explicitly into a custom launch command are passed to the agent as entered. Windows Antigravity uses the installed `agy.exe` and Windows terminal lifecycle. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) [Codex CLI reference](https://learn.chatgpt.com/docs/cli/cli-reference) [Antigravity CLI reference](https://antigravity.google/docs/cli/reference/)

Project-scoped organization and split terminals were the relevant features from the reference. [BridgeMind Code Mode](https://docs.bridgemind.ai/docs/code-mode)
