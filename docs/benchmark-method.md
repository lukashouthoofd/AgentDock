# Windows benchmark method

Run scripts/measure-windows.ps1 on Windows PowerShell 5.1 or PowerShell 7. Start an application in a disposable workspace, capture its Windows PID, and optionally time from launch to the first owned main window. Keep one benchmark application open at a time. For an AgentDock run, pass its WebView2 user-data directory if the corresponding browser process starts outside the normal parent tree.

A native-drive copy of the script avoids the UNC trust classification used by some Windows PowerShell execution policies.

    $result = & .\scripts\measure-windows.ps1 -RootProcessId $AppProcess.Id -RootExecutable $AppPath -Label AgentDock -TerminalCount 10
    $result | ConvertTo-Json -Depth 6

The optional StartupMilliseconds parameter records a measured launch time. WebViewUserDataDirectory adds WebView2 processes that match the exact path and launch time. Otherwise the sampler follows parent relationships, checking creation times for reused process IDs.

## Baseline fixtures

Run scripts/bench-baselines.ps1 with Kind Code or Terminal, TerminalCount 0 or 10, and SandboxParent set to a disposable Windows drive folder. Set Distro to the installed Ubuntu distribution. The fixture expects Windows drives at their standard Ubuntu /mnt paths. Each execution creates a fresh workspace under SandboxParent.

    & .\scripts\bench-baselines.ps1 -Kind Code -TerminalCount 10 -Distro Ubuntu-24.04 -SandboxParent D:\AgentDockBench
    & .\scripts\bench-baselines.ps1 -Kind Terminal -TerminalCount 10 -Distro Ubuntu-24.04 -SandboxParent D:\AgentDockBench -WindowsTerminalZip D:\AgentDockBench\WindowsTerminal-x64.zip

VS Code uses the installed executable, an isolated user-data directory and an empty user extension directory. A small fixture extension starts the terminals through the VS Code API. Both counts use the same extension-development configuration. The VS Code window displays a disposable folder. [VS Code CLI isolation](https://code.visualstudio.com/docs/configure/command-line)

Windows Terminal uses the upstream x64 unpackaged release in a fresh portable directory. The zero-shell fixture holds one inert tab after /bin/true exits. The ten-shell run opens ten tabs. The pinned baseline archive is Microsoft.WindowsTerminal_1.25.3131.0_x64.zip. Its SHA-256 is 273d6f1502eca1b5bd95c43f5d4d7ec72cc503df340102f8659717e5bead3437. [Windows Terminal portable mode](https://learn.microsoft.com/en-us/windows/terminal/distributions) [Release archive](https://github.com/microsoft/terminal/releases/tag/v1.25.3131.0)

The ten-shell fixtures use interactive Ubuntu Bash with a shared minimal rc file and one visible terminal in each Windows application. Each shell prints its Ubuntu distribution, Linux runtime and PID before its benchmark prompt. The readiness marker records the same evidence. The Linux probe validates every marker against a live Bash PID and the exact fixture rc-file argument. It reports the distro, kernel release, verified PIDs and summed RSS. The driver verifies the Windows test window using the exact executable, PID, creation time and disposable profile argument before closing it. It checks for surviving fixture shells through their exact rc-file arguments.

## Reading the metrics

- **App private working set** sums privately resident bytes for the attributed application process tree. It includes ConPTY hosts and WebView2 where applicable and excludes dedicated WSL launcher processes.
- **App working set** sums resident bytes for the same process set. Shared mappings can appear in multiple processes’ working sets. **Private commit** is reported separately.
- **Windows workload working set** includes the application and its attributed WSL launchers. **Combined workload RSS** adds the fixture Bash RSS and remains a sum of process-level residency. **Shared WSL VM working set** independently describes the workstation’s entire WSL VM.
- **CPU percent** uses the process CPU-time change over elapsed time, divided by logical processors. The first frame provides a counter baseline. The report uses the median of later samples.
- **Startup time** measures from launch to the first owned main window handle. **Shell readiness** measures from launch until all fixture markers exist. **Shutdown time** ends at the exit of the verified Windows root process. Fixture shell cleanup is checked afterward.

Stock defaults, fresh profile costs, foreground window scheduling and existing workstation load can affect the measurements. The fixture captures a single launch per run and captures resident values after a quiescence delay. Compositor latency requires a dedicated visual timing test.

## Baseline measurements

Measurements ran on the target Windows 11 workstation on 27 November 2026. Each row has seven samples at two-second intervals after a four-second quiescence delay. The Ubuntu runs used Ubuntu-24.04 on WSL2 with kernel 6.18.33.2-microsoft-standard-WSL2.

| Host application | Ubuntu shells | First window, ms | Ten shells ready, ms | App private WS, MiB | App summed WS, MiB | Windows workload WS, MiB | Linux shell RSS, MiB | Combined RSS, MiB | Idle CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| VS Code 1.148.0 | 0 | 1008.0 | — | 1036.90 | 1715.64 | 1715.64 | 0.00 | 1715.64 | 0.2824% |
| VS Code 1.148.0 | 10 | 1042.1 | 7554.8 | 1248.55 | 2293.79 | 2616.13 | 40.91 | 2657.04 | 0.5341% |
| Windows Terminal 1.25.3131.0 portable | 0 | 645.5 | — | 27.48 | 108.09 | 108.09 | 0.00 | 108.09 | 0% |
| Windows Terminal 1.25.3131.0 portable | 10 | 1374.2 | 2632.4 | 125.27 | 416.13 | 737.97 | 40.98 | 778.95 | 0.0323% |

The ten-shell runs each confirmed ten distinct Ubuntu Bash PIDs. Closing the benchmark root took 3004.2 ms for VS Code and 4033.7 ms for portable Windows Terminal. A final fixture scan found zero surviving Bash processes. These are complete case runs under ordinary workstation load, including other development activity. Earlier trials that failed fixture readiness or command verification were discarded before memory sampling.
