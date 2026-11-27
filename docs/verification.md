# Verification

The delivery gates are tracked in [the mission checkpoint](mission.md). Development and test artifacts stay local. The verified source, published repository and installed release are separate delivery gates.

## Observed evidence

- The first native Windows release binary compiled and opened an AgentDock desktop window using the installed WebView2 runtime.
- The bundled intro generator produced a 63,248-byte, 640 × 360, 2.792-second silent VP8 clip. Its storyboard and last decoded frames were reviewed. Runtime playback is checked separately in the desktop test.
- Dotenv unit fixtures passed on Linux, Windows NTFS, and Ubuntu accessed by Windows UNC. A dedicated native write preserved multiline bytes, mode 0600 and extended POSIX ACL on a WSL file.
- The Ship It branch and reflog tests covered successful fast-forward and merge commits, linked worktrees, conflicts, ordinary commits and no-op merges. The animation was tested in Chromium for the exact message, dismissal and reduced motion.
- The Spotify native probe read the existing Spotify desktop media session without changing playback. Windows tests covered the loopback callback, request validation, catalog normalization, and DPAPI token storage. The live catalog and library check is separate.
- [Measured VS Code and Windows Terminal baselines](benchmark-method.md) include verified Linux Bash processes from the installed Ubuntu distribution. AgentDock measures are separate.
- Independent review found a Windows release media policy issue, PTY ownership and stale I/O issues, clipboard and link routing gaps, a dotenv save race, and a pane drop defect. Fixes were integrated into the workspace before the Windows desktop run. The Aikido local scanner required a keychain or token unavailable on this workstation.

## Native desktop checks

`scripts/test-windows.mjs` drives the real Windows window using the WebView2 debugger enabled for that test process. Supply a disposable profile and distinct disposable WSL and Windows repositories. The WSL repository fixture uses `main`, branches `dock-feature` and `agent-feature` with different unmerged changes, linked worktree `dock-worktree`, and an ignored `.env.local` containing synthetic data. The Windows fixture uses a real Git for Windows linked worktree on branch `windows-linked`.

The test harness checks the Linux kernel and exact Ubuntu distro from inside the terminal. It records results in an external evidence directory and terminates only the fixture session IDs. It can use `AGENTDOCK_MEASURE_SCRIPT` to invoke the process-tree sampler during its idle and ten-Ubuntu-terminal phases.
