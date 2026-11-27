# Ship It

AgentDock celebrates a local branch merge when Git returns successfully, the selected destination branch is still checked out, its HEAD changed, and the confirmed source commit is part of the result. The in-app train is silent, dismissible, and static with reduced motion. Already up-to-date merges and failed merges leave the celebration hidden. [Original Ship It project](https://github.com/lukashouthoofd/ship-it)

The merge dialog previews the destination branch, its HEAD and local source branch tips. After confirmation, AgentDock checks both branch tips and the worktree status, then runs the installed Git with the confirmed source commit. Standard Git configuration and hooks apply. Any conflicts stay in the worktree for manual resolution or abort. Choose a worktree whose agents are idle before merging so Git operations remain coordinated.

The celebration uses its own visual implementation. The upstream project’s global Claude hook, desktop-wide WinForms overlay and GitHub poller are outside AgentDock’s application lifecycle.
