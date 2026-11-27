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

## Proportional resident estimate

Add `-Proportional` to the Windows sampler for an opt-in benchmark of the same application tree used by the private and summed working sets. The sampler uses Windows QueryWorkingSet. Each private page contributes its full size. Each shareable page contributes its size divided by its reported ShareCount, with a minimum divisor of one. ShareCount describes system-wide sharing, so the estimate also apportions pages shared with applications outside the measured tree. [QueryWorkingSet](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-queryworkingset) [Working-set page fields](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-psapi_working_set_block)

Read `Medians.AppProportionalMiB` together with `ProportionalCompleteSamples`. The sampler reports the median only when every frame includes every application process. Each frame reports covered entries, saturated entries, unavailable processes and cap hits. The default budget is 262,144 entries across the entire tree per sample, adjustable with `-ProportionalMaxPages`. Ordinary sampler output retains its original fields.

The estimate applies to resident working-set entries. ShareCount has three bits and saturates at seven. A page shared by more processes can therefore receive too much weight. The sampler records entries reporting seven so the reader can gauge this limitation. Duplicate mappings and changes during sequential process reads also affect precision. Use the estimate alongside the ordinary private and summed working sets.

## Baseline measurements

Measurements ran on the target Windows 11 workstation on 27 November 2026. Each row has seven samples at two-second intervals after a four-second quiescence delay. The Ubuntu runs used Ubuntu-24.04 on WSL2 with kernel 6.18.33.2-microsoft-standard-WSL2.

| Host application | Ubuntu shells | First window, ms | Ten shells ready, ms | App private WS, MiB | App summed WS, MiB | Windows workload WS, MiB | Linux shell RSS, MiB | Combined RSS, MiB | Idle CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| VS Code 1.148.0 | 0 | 1008.0 | — | 1036.90 | 1715.64 | 1715.64 | 0.00 | 1715.64 | 0.2824% |
| VS Code 1.148.0 | 10 | 1042.1 | 7554.8 | 1248.55 | 2293.79 | 2616.13 | 40.91 | 2657.04 | 0.5341% |
| Windows Terminal 1.25.3131.0 portable | 0 | 645.5 | — | 27.48 | 108.09 | 108.09 | 0.00 | 108.09 | 0% |
| Windows Terminal 1.25.3131.0 portable | 10 | 1374.2 | 2632.4 | 125.27 | 416.13 | 737.97 | 40.98 | 778.95 | 0.0323% |

The ten-shell runs each confirmed ten distinct Ubuntu Bash PIDs. Closing the benchmark root took 3004.2 ms for VS Code and 4033.7 ms for portable Windows Terminal. A final fixture scan found zero surviving Bash processes. These are complete case runs under ordinary workstation load, including other development activity. Earlier trials that failed fixture readiness or command verification were discarded before memory sampling.

## AgentDock measurements

The Windows release build used the same Ubuntu distribution, interactive Bash fixture and seven-frame process sampler. The idle measurement included WebView2 and all attributed child processes. The ten-terminal measurement kept one renderer mounted and verified all ten Bash PIDs with the same fixture probe used for the baselines. The ten shells were configured sequentially through the real UI. Setting them up took 6041 ms, including the automation steps, so that figure should be read separately from the automated baseline launch times.

To reproduce the shell workload, copy `scripts/benchmark-fixtures/shell.rc` and `probe.sh` into a disposable Ubuntu-accessible directory. Open ten blank AgentDock terminals and run `exec /bin/bash --noprofile --rcfile /path/to/fixture/shell.rc -i` in each one. Use `/bin/bash /path/to/fixture/probe.sh` in the same distro to verify the count and RSS. Keep one terminal visible while sampling the full process tree. Terminate the disposable sessions through AgentDock when finished.

| Ubuntu shells | First window, ms | App private WS, MiB | App proportional estimate, MiB | App summed WS, MiB | Windows workload WS, MiB | Linux shell RSS, MiB | Combined RSS, MiB | Idle CPU |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 155 | 91.51 | 132.58 | 384.39 | 384.39 | 0.00 | 384.39 | 0.1401% |
| 10 | 155 | 114.25 | 162.44 | 454.76 | 487.66 | 40.99 | 528.65 | 0.2503% |

The app’s private resident memory and proportional estimate were below the 150 MiB idle and 350 MiB ten-session targets. The summed working sets, which count shared mappings in each process, exceeded both targets. All seven proportional frames covered the complete app tree in each case. The workstation’s entire WSL VM measured 9845.87 MiB at idle and 9938.47 MiB with the fixtures. It was running other work, so those figures cannot be attributed to AgentDock.

The 20-terminal desktop run separately verified three creation and termination cycles with one mounted renderer. It rendered the marker following 12,000 lines of output in 201 ms. VS Code and Windows Terminal were compared for startup, CPU and memory. Their output latency was not measured on the same instrumented flow.

## AgentDock 0.2.0 Windows run

The native desktop suite measured the updated Windows process tree, including WebView2, with seven samples per workload. It measured ten normal Ubuntu-24.04 Bash shells after exercising the development flows and kept one terminal renderer mounted. The earlier baseline rows used fresh application profiles and a minimal Bash rc file. The first AgentDock window in this run appeared at 983 ms.

| Ubuntu shells | App private WS, MiB | App proportional estimate, MiB | App summed WS, MiB | Windows workload WS, MiB | Linux Bash RSS, MiB | Combined RSS, MiB | App CPU |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 93.84 | 133.56 | 391.38 | 391.38 | 0.00 | 391.38 | 0.1392% |
| 10 | 154.06 | — | 499.78 | 533.07 | 64.75 | 597.82 | 0.3006% |

The ten-shell check observed ten fixture Bash processes. One of the seven proportional frames could not query one process, so the table reports no ten-shell proportional estimate. App private residency stayed below the original targets. The summed Windows app working sets exceeded both of them. The WSL VM median working set was 7,503.05 MiB at idle and 7,655.00 MiB in the ten-shell run. The VM also hosted other work during both samples.

The final desktop run verified twenty simultaneous Ubuntu terminals and three additional create-and-close cycles with one mounted renderer. The high-output fixture took 361 ms to display its marker following 12,000 lines. Earlier runs exposed Windows-to-WSL helper and attachment delays. Creation now serializes per distro and retries the same tmux ID on a timeout. The terminal transport keeps capability replies flowing while the view is connecting. If tmux confirms a live session without an attached client, the view retries the attachment once without restarting the shell.
