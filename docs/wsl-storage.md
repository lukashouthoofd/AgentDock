# WSL storage audit

Put source and generated dependencies on the filesystem native to the tools that do most of the work. Use Ubuntu-native directories for WSL Git, Node, Python, Rust and Linux agents. Keep Windows-first work on a Windows drive. `wslpath` converts paths for occasional crossing. [Microsoft WSL filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems#file-storage-and-performance-across-file-systems) · [Microsoft WSL interop](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)

## Measured on the workstation

The same Ubuntu Python and Git binaries processed 150 synthetic 1 KiB files in 10 directories. Three trials ran on each filesystem with alternating order. Times are median wall-clock milliseconds. Stat, read and checksum followed writes within the same fixture, so the Linux read had a warm cache.

| Operation | Ubuntu ext4 | Windows C: via 9P |
| --- | ---: | ---: |
| Create directories and files | 14.8 ms | 1,166.3 ms |
| Stat, read and validate SHA-256 | 0.9 ms | 1,193.2 ms |
| `git add --all` | 3.7 ms | 1,241.2 ms |
| `git status --porcelain` | 3.7 ms | 234.7 ms |

The workstation was in active use. The larger 1,000-file trial reached its 75-second guard and supplied no comparable results. These timings describe the small-file fixture and the Linux tools running it. Native Windows tooling and full application builds have separate performance characteristics.

## Workstation snapshot

| Measure | Observed |
| --- | --- |
| Windows physical memory | 31.43 GiB total, 1.85 GiB available |
| `VmmemWSL` Windows working set | 5.31 GiB shared by the running WSL workloads |
| Ubuntu kernel memory | 11.68 GiB total, 7.17 GiB available, about 1.00 GiB swap in use |
| Available physical C: space | 148.30 GiB |
| Ubuntu ext4 | 52 GiB used, 904 GiB virtual free |
| Current VHDX file lengths | Ubuntu 61.02 GiB, Docker Desktop data 92.71 GiB |

WSL 2.7.10.0 was running Ubuntu and Docker Desktop. The saved WSL settings already specify a 12 GB memory cap, 4 GB swap, 8 processors, gradual memory reclamation and sparse VHDs for newly created disks. Both measured VHDX files lacked the Windows sparse-file attribute. Ext4 virtual free space and VHDX file length are distinct from host disk capacity. [Microsoft memory and sparse VHD settings](https://learn.microsoft.com/windows/wsl/wsl-config#experimental-settings) · [Microsoft WSL disk space](https://learn.microsoft.com/windows/wsl/disk-space)

Docker Desktop 29.6.1 had 31 containers, 11 running, and 87 named volumes. Four running and ten stopped bind-mount instances were Windows-backed. Running containers used 12 named-volume mount instances and stopped containers used 15. Those counts describe mounts, and a volume can appear more than once. The desktop engine answered over its local Windows pipe. The usual Ubuntu Docker socket was unavailable. AgentDock can fall back to the local Windows Docker Desktop Linux-engine pipe and identifies that source in the Development panel. Direct source and Compose-path checks found no matches for the three pinned repository roots. Before testing a Linux bind-mount migration, establish working access to this engine from Ubuntu and verify file-watch behavior. Keep container database and cache data in managed volumes. [Docker Desktop WSL best practices](https://docs.docker.com/desktop/features/wsl/best-practices/)

## Repository and tool placement

All three pinned repositories were Windows-backed. The fourth open project was an Ubuntu-native end-to-end fixture with live test processes. The table records the primary checkout state and also notes evidence from related worktrees. Branch relationships were checked against local tracking refs.

| Pinned repository | Scope and observed state | Migration decision |
| --- | --- | --- |
| A, Node/pnpm and Compose | 11 worktrees. Primary had 1 tracked change and 6 untracked entries. One linked worktree had a live Claude process. Another was 5 commits ahead of its tracking ref. Multiple linked worktrees had working-copy changes. | Defer. Active work, local changes, linked worktree references and native tooling make it unsuitable for an in-place move. |
| B, Node/pnpm | 3 worktrees. Primary had 7 tracked changes and 7 untracked entries. No matching WSL process working directory or live managed terminal was observed. | Defer moving the checkout. A separate Ubuntu clone of a verified commit could later compare installs, tests and file watchers while preserving the originals and their linked worktrees. Windows activity attribution remains unverified. |
| C, Python and Docker | 9 worktrees. Primary had 2 untracked entries. Several linked worktrees had no verified upstream. A Python virtual environment was present. | Defer. Resolve local worktree ownership and verify Docker bind-mount integration before a pilot. Recreate the virtual environment with Ubuntu Python in any separate clone. |

Git, Node/npm, Python/uv, Rust/Cargo, tmux, Claude Code and Codex resolved from Ubuntu-native locations. Windows Git, PowerShell, Antigravity and VS Code resolved from the Windows installation. Existing Node projects already had dependency directories on C:. Recreate package installations or virtual environments with the target runtime when making a separate test checkout.

The Ubuntu Codex and Claude configurations each defined one MCP server with Linux-native setup paths. The Windows Codex and Claude configurations defined 18 and 11 servers. Six and seven definitions, respectively, referenced Windows-backed setup paths. These are configuration-entry counts. Bare command names resolve against the host's PATH. Keep scripts and runtime-specific dependencies beside the MCP host that executes them. Review absolute setup paths and network connectors separately when changing host. The audit recorded placement and counts only.

## Reproduce the fixture

Run from Ubuntu with the matching Windows user’s existing temporary directory supplied below. The script uses only temporary files, a fresh Git index and a 45-second deadline.

```bash
python3 - '/mnt/c/Users/<windows-user>/AppData/Local/Temp' <<'PY'
import hashlib, os, pathlib, signal, statistics, subprocess, sys, tempfile, time

locations = [('ext4', '/tmp'), ('9p', sys.argv[1])]
samples = {name: [] for name, _ in locations}
payload = bytes(range(256)) * 4
expected = hashlib.sha256(payload).digest()
env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', LC_ALL='C')

def stop(*_):
    raise TimeoutError('Fixture reached its 45-second deadline')

def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], env=env, check=True,
                          capture_output=True, timeout=8).stdout

def timed(operation):
    start = time.perf_counter()
    operation()
    return (time.perf_counter() - start) * 1000

signal.signal(signal.SIGALRM, stop)
signal.alarm(45)
for trial in range(3):
    for kind, base in (locations if trial % 2 == 0 else reversed(locations)):
        with tempfile.TemporaryDirectory(dir=base, prefix='agentdock-fs-mini.') as temporary:
            root = pathlib.Path(temporary)
            git(root, 'init', '-q', '-b', 'fixture')
            paths = [root / f'd{i // 15:02}' / f'{i:03}.txt' for i in range(150)]

            def write():
                for directory in sorted({path.parent for path in paths}):
                    directory.mkdir()
                for path in paths:
                    path.write_bytes(payload)

            def read():
                for path in paths:
                    assert path.stat().st_size == len(payload)
                    assert hashlib.sha256(path.read_bytes()).digest() == expected

            def status():
                result = git(root, 'status', '--porcelain=v1', '--untracked-files=all')
                assert len(result.splitlines()) == len(paths)

            samples[kind].append([timed(write), timed(read),
                                  timed(lambda: git(root, 'add', '--all')), timed(status)])
signal.alarm(0)
for kind, results in samples.items():
    print(kind, 'create, stat/read/checksum, git add, git status (ms)',
          [round(statistics.median(column), 1) for column in zip(*results)])
PY
```
