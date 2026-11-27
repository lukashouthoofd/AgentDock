[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Code', 'Terminal')]
    [string] $Kind,
    [Parameter(Mandatory = $true)]
    [ValidateSet(0, 10)]
    [int] $TerminalCount,
    [Parameter(Mandatory = $true)]
    [string] $SandboxParent,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$')]
    [string] $Distro = 'Ubuntu-24.04',
    [string] $CodeExecutable = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
    [string] $WindowsTerminalZip,
    [ValidateRange(2, 30)]
    [int] $Samples = 7,
    [ValidateRange(1, 10)]
    [double] $IntervalSeconds = 2,
    [ValidateRange(0, 30)]
    [double] $QuietSeconds = 4
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$encoding = [Text.UTF8Encoding]::new($false)
$assetPath = Join-Path $PSScriptRoot 'benchmark-fixtures'
$parent = (Resolve-Path -LiteralPath $SandboxParent).Path
if ($parent -notmatch '^[A-Za-z]:\\') { throw 'Use a local Windows drive for the benchmark sandbox.' }
$stamp = [guid]::NewGuid().ToString('N')
$run = Join-Path $parent ("run-{0}-{1}-{2}" -f $Kind.ToLowerInvariant(), $TerminalCount, $stamp)
New-Item -ItemType Directory -Path $run | Out-Null
$linuxRun = '/mnt/' + $run.Substring(0, 1).ToLowerInvariant() + $run.Substring(2).Replace('\', '/')
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$working = Join-Path $run 'project'
New-Item -ItemType Directory -Path $working | Out-Null
Copy-Item -LiteralPath (Join-Path $assetPath 'shell.rc'), (Join-Path $assetPath 'probe.sh') -Destination $run

function Write-Json($File, $Data) {
    [IO.File]::WriteAllText($File, ($Data | ConvertTo-Json -Depth 12), $encoding)
}

function Quote-Argument([string] $Text) {
    if ($Text -match '["\r\n]') { throw 'An argument contains an unsupported quote or newline.' }
    if ($Text -and $Text -notmatch '\s') { return $Text }
    '"' + ($Text -replace '(\\+)$', '$1$1') + '"'
}

function Get-OwnedRow($Process, $ExpectedExecutable, $LaunchedAt, $ProfileToken) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $($Process.Id)" -Property ProcessId,ExecutablePath,CreationDate,CommandLine
    if ($null -eq $row -or !$row.ExecutablePath -or $row.ExecutablePath -ine $ExpectedExecutable -or
        $row.CreationDate -lt $LaunchedAt.AddSeconds(-1)) { return $null }
    if ($ProfileToken -and (!$row.CommandLine -or $row.CommandLine.IndexOf($ProfileToken, [StringComparison]::OrdinalIgnoreCase) -lt 0)) {
        return $null
    }
    $row
}

function Read-LinuxFixture([string] $Mode) {
    $arguments = (@('--distribution', (Quote-Argument $Distro), '--exec', '/bin/bash', (Quote-Argument "$linuxRun/probe.sh"), $Mode) -join ' ')
    $info = [Diagnostics.ProcessStartInfo]::new($wsl, $arguments)
    $info.CreateNoWindow = $true
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $probe = [Diagnostics.Process]::Start($info)
    try {
        $reader = $probe.StandardOutput.ReadToEndAsync()
        if (!$probe.WaitForExit(8000)) {
            $probe.Kill()
            throw 'The isolated WSL fixture probe timed out.'
        }
        $exitCode = $probe.ExitCode
        if (!$reader.Wait(2000)) { throw 'The isolated WSL fixture probe output timed out.' }
        $lines = @($reader.Result.Trim() -split '\r?\n')
    } finally {
        $probe.Dispose()
    }
    if ($exitCode -ne 0 -or $lines.Count -lt 4 -or $lines[1] -ne $Distro -or $lines[2] -ne 'Linux') {
        throw 'Could not read the isolated Linux shell processes.'
    }
    $match = [regex]::Match($lines[0], '^(\d+) +(\d+)$')
    $linuxProcesses = @($lines | Select-Object -Skip 4 | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
    if (!$match.Success -or $linuxProcesses.Count -ne [int]$match.Groups[1].Value) {
        throw 'The Linux fixture probe did not identify all expected Bash processes.'
    }
    [PSCustomObject]@{
        Count = [int]$match.Groups[1].Value
        RssMiB = [math]::Round([double]$match.Groups[2].Value / 1024, 2)
        Distro = $lines[1]
        Kernel = $lines[3]
        ProcessIds = $linuxProcesses
    }
}

$shellArgs = @('--distribution', $Distro, '--exec', '/bin/bash', '--noprofile', '--rcfile', "$linuxRun/shell.rc", '-i')
$profileToken = ''
if ($Kind -eq 'Code') {
    $executable = (Resolve-Path -LiteralPath $CodeExecutable).Path
    $data = Join-Path $run 'code-data'
    $plugins = Join-Path $run 'code-extensions'
    $extension = Join-Path $run 'code-fixture'
    $userSettings = Join-Path $data 'User'
    New-Item -ItemType Directory -Path $userSettings, $plugins, $extension -Force | Out-Null
    Write-Json (Join-Path $userSettings 'settings.json') @{
        'workbench.startupEditor' = 'none'
        'window.restoreWindows' = 'none'
        'window.confirmBeforeClose' = 'never'
        'extensions.autoUpdate' = $false
        'extensions.autoCheckUpdates' = $false
        'update.mode' = 'none'
        'telemetry.telemetryLevel' = 'off'
        'workbench.enableExperiments' = $false
        'security.workspace.trust.enabled' = $false
        'terminal.integrated.enablePersistentSessions' = $false
        'terminal.integrated.shellIntegration.enabled' = $false
        'terminal.integrated.scrollback' = 1000
    }
    Write-Json (Join-Path $extension 'package.json') @{
        name = 'agentdock-benchmark-fixture'
        publisher = 'local-benchmark'
        version = '1.0.0'
        engines = @{ vscode = '^1.75.0' }
        activationEvents = @('onStartupFinished')
        main = './vscode-terminal-fixture.cjs'
    }
    Write-Json (Join-Path $extension 'fixture.json') @{ count = $TerminalCount; wsl = $wsl; args = $shellArgs; workspace = $working }
    Copy-Item -LiteralPath (Join-Path $assetPath 'vscode-terminal-fixture.cjs') -Destination $extension
    $arguments = @('--new-window', '--disable-updates', '--disable-workspace-trust', '--skip-welcome',
        '--user-data-dir', (Quote-Argument $data), '--extensions-dir', (Quote-Argument $plugins),
        '--extensionDevelopmentPath', (Quote-Argument $extension), (Quote-Argument $working)) -join ' '
    $profileToken = $data
    $label = 'VS Code'
} else {
    if (!$WindowsTerminalZip) { throw 'Provide the official unpackaged Windows Terminal ZIP.' }
    $archive = (Resolve-Path -LiteralPath $WindowsTerminalZip).Path
    $extracted = Join-Path $run 'terminal'
    Expand-Archive -LiteralPath $archive -DestinationPath $extracted
    $stage = @(Get-ChildItem -LiteralPath $extracted -Filter 'WindowsTerminal.exe' -File -Recurse)
    if ($stage.Count -ne 1) { throw 'Expected one WindowsTerminal.exe in the portable ZIP.' }
    $executable = $stage[0].FullName
    $base = $stage[0].DirectoryName
    [IO.File]::WriteAllText((Join-Path $base '.portable'), '', $encoding)
    $config = Join-Path $base 'settings'
    New-Item -ItemType Directory -Path $config -Force | Out-Null
    $preset = 'AgentDockBaseline-' + $stamp
    $guid = '{' + [guid]::NewGuid().ToString() + '}'
    $command = @((Quote-Argument $wsl), '--distribution', (Quote-Argument $Distro), '--exec', '/bin/true') -join ' '
    if ($TerminalCount) { $command = (@((Quote-Argument $wsl)) + @($shellArgs | ForEach-Object { Quote-Argument $_ })) -join ' ' }
    Write-Json (Join-Path $config 'settings.json') @{
        defaultProfile = $guid
        disabledProfileSources = @('Windows.Terminal.Wsl', 'Windows.Terminal.Azure', 'Windows.Terminal.PowershellCore')
        confirmCloseAllTabs = $false
        profiles = @{ defaults = @{ historySize = 1000 }; list = @(@{
            guid = $guid; name = $preset; commandline = $command; startingDirectory = $working
            tabTitle = $preset; suppressApplicationTitle = $true; closeOnExit = 'never'
        }) }
    }
    $tab = 'new-tab --profile ' + (Quote-Argument $preset)
    $arguments = '-w new ' + ((@($tab) * [math]::Max(1, $TerminalCount)) -join ' ; ')
    $profileToken = $preset
    $label = 'Windows Terminal (portable)'
}

$startedAt = Get-Date
$timer = [Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru
$ownership = $null
$startup = -1
$shellsReady = $null
$report = $null
$shutdown = $null
$shutdownMs = $null
try {
    while ($timer.Elapsed.TotalSeconds -lt 25) {
        if ($process.HasExited) { break }
        $process.Refresh()
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $startup = $timer.Elapsed.TotalMilliseconds
            $ownership = Get-OwnedRow $process $executable $startedAt $profileToken
            break
        }
        Start-Sleep -Milliseconds 40
    }
    if (!$ownership) { throw 'Could not verify an isolated benchmark window. Shared application processes are excluded.' }

    $readyDeadline = (Get-Date).AddSeconds(40)
    do {
        $markers = @(Get-ChildItem -LiteralPath $run -Filter 'shell-*.ready' -File).Count
        if ($markers -eq $TerminalCount) { break }
        if ($process.HasExited) { throw 'The isolated benchmark app exited before its Ubuntu shells were ready.' }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $readyDeadline)
    if ($markers -ne $TerminalCount) { throw "Only $markers of $TerminalCount disposable Ubuntu shells were ready." }
    if ($TerminalCount -gt 0) { $shellsReady = [math]::Round($timer.Elapsed.TotalMilliseconds, 1) }

    $shells = Read-LinuxFixture 'count'
    if ($shells.Count -ne $TerminalCount) { throw 'The isolated shell process count does not match the benchmark workload.' }
    $measureArguments = @{
        RootProcessId = $process.Id; RootExecutable = $executable; Label = $label
        TerminalCount = $TerminalCount; StartupMilliseconds = $startup; Samples = $Samples
        IntervalSeconds = $IntervalSeconds; QuietSeconds = $QuietSeconds
    }
    $report = & (Join-Path $PSScriptRoot 'measure-windows.ps1') @measureArguments
    $report | Add-Member -NotePropertyName LinuxShellRssMiB -NotePropertyValue $shells.RssMiB
    $report | Add-Member -NotePropertyName LinuxShellProcessIds -NotePropertyValue $shells.ProcessIds
    $report | Add-Member -NotePropertyName LinuxDistro -NotePropertyValue $shells.Distro
    $report | Add-Member -NotePropertyName LinuxKernel -NotePropertyValue $shells.Kernel
    $report | Add-Member -NotePropertyName CombinedWorkloadRssMiB -NotePropertyValue ([math]::Round($report.Medians.WindowsWorkloadWorkingSetMiB + $shells.RssMiB, 2))
} finally {
    $closing = [Diagnostics.Stopwatch]::StartNew()
    $cleanupError = $null
    $current = Get-OwnedRow $process $executable $startedAt $profileToken
    if ($current -and (!$ownership -or $current.CreationDate -eq $ownership.CreationDate)) {
        $process.CloseMainWindow() | Out-Null
        $shutdown = $process.WaitForExit(8000)
        if (!$shutdown -and (Get-OwnedRow $process $executable $startedAt $profileToken)) {
            Stop-Process -Id $process.Id -Force
            $shutdown = $process.WaitForExit(5000)
        }
        if ($shutdown) { $shutdownMs = [math]::Round($closing.Elapsed.TotalMilliseconds, 1) }
        else { $cleanupError = 'The verified isolated benchmark root did not exit.' }
    } elseif ($ownership) {
        if ($process.HasExited) { $shutdown = $true }
        else { $cleanupError = 'The benchmark root changed identity while its process handle remained active.' }
    }
    if ($TerminalCount -gt 0 -and @(Get-ChildItem -LiteralPath $run -Filter 'shell-*.ready' -File).Count -gt 0) {
        $remaining = Read-LinuxFixture 'cleanup'
        if ($remaining.Count -gt 0) {
            Start-Sleep -Milliseconds 400
            $stillRunning = Read-LinuxFixture 'force-cleanup'
            if ($stillRunning.Count -gt 0) {
                Start-Sleep -Milliseconds 400
                if ((Read-LinuxFixture 'count').Count -gt 0) { throw 'A disposable Ubuntu shell did not exit.' }
            }
        }
    }
    if ($cleanupError) { throw $cleanupError }
}
if ($report) {
    $report | Add-Member -NotePropertyName OwnedRootStopped -NotePropertyValue ($shutdown -eq $true)
    $report | Add-Member -NotePropertyName ShellsReadyMilliseconds -NotePropertyValue $shellsReady
    $report | Add-Member -NotePropertyName ShutdownMilliseconds -NotePropertyValue $shutdownMs
    $report | ConvertTo-Json -Depth 6
}
