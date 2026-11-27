# Development panel

The Development panel shows local branches, the checked-out branch and known worktrees for the active project. Open navigates to an existing worktree through the workspace. Refresh reads the current repository state.

Load pull requests runs the project environment’s existing GitHub CLI against its configured repository remote. The panel displays up to 25 open pull requests and links to their pages in the system browser. It uses existing CLI authentication. A Windows project visible from Ubuntu uses the Ubuntu toolchain. Windows-only paths use the available Windows tools.

Load containers runs the existing Docker CLI’s read-only container-list command in the configured context. It shows running container names, images, status and ports. If the project environment cannot reach its engine, AgentDock can read the local Windows Docker Desktop Linux engine through its named pipe. The panel shows which engine supplied the result.

These reads run on demand with per-command deadlines and a bounded output buffer. Results live in the open panel’s memory. CLI errors may require a working remote, existing GitHub CLI access or a reachable Docker daemon. If the Windows Docker Desktop fallback cannot reach its Linux engine, start Docker Desktop and wait for the engine to be ready. To run `docker` directly inside Ubuntu, enable WSL Integration for that distribution in Docker Desktop settings. The panel displays up to 60 local branches, worktrees or containers per listing.

The backend regression tests create a disposable repository and separate worktree with spaces in their paths. The tests also cover detached, locked and missing worktree output.
