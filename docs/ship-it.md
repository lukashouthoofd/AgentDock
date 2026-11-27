# Ship It

AgentDock celebrates a local branch merge when Git returns successfully, the selected destination branch is still checked out, its HEAD changed, and the confirmed source commit is part of the result. The in-app train is silent, dismissible, and static with reduced motion. Already up-to-date merges and failed merges leave the celebration hidden. [Original Ship It project](https://github.com/lukashouthoofd/ship-it)

The merge dialog previews the destination branch, its HEAD and local source branch tips. After confirmation, AgentDock checks both branch tips and the worktree status, then runs the installed Git with the confirmed source commit. Standard Git configuration and hooks apply. Any conflicts stay in the worktree for manual resolution or abort. Choose a worktree whose agents are idle before merging so Git operations remain coordinated.

The celebration uses its own visual implementation. The upstream project’s global Claude hook, desktop-wide WinForms overlay and GitHub poller are outside AgentDock’s application lifecycle.

AgentDock can also observe merges made from terminals and agents in tracked worktrees. It reads a bounded tail of each worktree’s local Git HEAD reflog and checks fast-forward ancestry or merge-commit parents. A merge stopped by conflicts only becomes eligible if its resolution produces a merge commit. The observer requires a standard file-based HEAD reflog and conventional Git merge actions. Squash merges followed by ordinary commits, GitHub merges, and operations preceding the active observation window have no local merge event for AgentDock to celebrate.
