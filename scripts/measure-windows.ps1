[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int] $RootProcessId,
    [Parameter(Mandatory = $true)]
    [string] $Label,
    [string] $RootExecutable,
    [string] $WebViewUserDataDirectory,
    [ValidateRange(0, 1000)]
    [int] $TerminalCount,
    [double] $StartupMilliseconds = -1,
    [ValidateRange(2, 30)]
    [int] $Samples = 7,
    [ValidateRange(1, 10)]
    [double] $IntervalSeconds = 2,
    [ValidateRange(0, 30)]
    [double] $QuietSeconds = 4,
    [switch] $Proportional,
    [ValidateRange(1, 1048576)]
    [int] $ProportionalMaxPages = 262144
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$wslClientNames = @('wsl.exe', 'wslhost.exe', 'wslrelay.exe')

if ($Proportional -and !('AgentDock.Bench.WorkingSetPages' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AgentDock.Bench
{
    public static class WorkingSetPages
    {
        private const uint QueryInformationAndVmRead = 0x0410;
        private const int ErrorBadLength = 24;

        [DllImport("kernel32.dll")]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll")]
        private static extern bool GetProcessTimes(
            IntPtr process, out long created, out long exited, out long kernel, out long user);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("psapi.dll", SetLastError = true)]
        private static extern bool QueryWorkingSet(IntPtr process, IntPtr buffer, uint bytes);

        public sealed class Sample
        {
            public int Pages;
            public int SaturatedPages;
            public int UnavailableProcesses;
            public int LimitHits;
            public double AttributedBytes;
        }

        private static ulong ReadWord(IntPtr buffer, int index)
        {
            int offset = IntPtr.Size * index;
            return IntPtr.Size == 8
                ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
                : unchecked((uint)Marshal.ReadInt32(buffer, offset));
        }

        public static Sample Read(int[] processIds, long[] creationTimes, int pageLimit)
        {
            var result = new Sample();
            var buffer = Marshal.AllocHGlobal((pageLimit + 1) * IntPtr.Size);
            try
            {
                for (int i = 0; i < processIds.Length; i++)
                {
                    int available = pageLimit - result.Pages;
                    if (available == 0)
                    {
                        result.LimitHits += processIds.Length - i;
                        break;
                    }
                    var process = OpenProcess(QueryInformationAndVmRead, false, processIds[i]);
                    if (process == IntPtr.Zero)
                    {
                        result.UnavailableProcesses++;
                        continue;
                    }
                    try
                    {
                        long created, exited, kernel, user;
                        // CIM truncates process creation time. Allow less than one millisecond.
                        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)
                            || Math.Abs(created - creationTimes[i]) >= 10000)
                        {
                            result.UnavailableProcesses++;
                            continue;
                        }
                        if (!QueryWorkingSet(process, buffer, (uint)((available + 1) * IntPtr.Size)))
                        {
                            if (Marshal.GetLastWin32Error() == ErrorBadLength)
                                result.LimitHits++;
                            else
                                result.UnavailableProcesses++;
                            continue;
                        }
                        ulong size = ReadWord(buffer, 0);
                        if (size > (ulong)available)
                        {
                            result.LimitHits++;
                            continue;
                        }

                        double pageShares = 0;
                        for (int page = 1; page <= (int)size; page++)
                        {
                            ulong flags = ReadWord(buffer, page);
                            bool shareable = (flags & (1UL << 8)) != 0;
                            int count = shareable ? (int)((flags >> 5) & 7UL) : 1;
                            if (count == 7) result.SaturatedPages++;
                            pageShares += 1.0 / Math.Max(1, count);
                        }
                        result.Pages += (int)size;
                        result.AttributedBytes += pageShares * Environment.SystemPageSize;
                    }
                    finally
                    {
                        CloseHandle(process);
                    }
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            return result;
        }
    }
}
'@
}

function Get-ProcessInventory {
    @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)
}

function Get-Tree {
    param($Inventory, $RootRow, $WebViewPath)

    $included = @{}
    $included[[int]$RootRow.ProcessId] = $RootRow
    if ($WebViewPath) {
        $wanted = [regex]::Escape($WebViewPath.TrimEnd('\', '/'))
        $pattern = '(?i)(?:^|[\s"])--user-data-dir(?:=|\s+)"?' + $wanted + '[\\/]?(?:$|[\s"])'
        $webViews = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine
        foreach ($row in $webViews) {
            if ($row.CommandLine -match $pattern -and $row.CreationDate -ge $RootRow.CreationDate.AddSeconds(-1)) {
                $included[[int]$row.ProcessId] = $row
            }
        }
    }

    do {
        $before = $included.Count
        foreach ($row in $Inventory) {
            $number = [int]$row.ProcessId
            $parent = [int]$row.ParentProcessId
            if (!$included.ContainsKey($number) -and $included.ContainsKey($parent) -and
                $row.CreationDate -ge $included[$parent].CreationDate) {
                $included[$number] = $row
            }
        }
    } while ($included.Count -ne $before)
    @($included.Values)
}

function Get-Median {
    param([object[]] $Values)
    $ordered = @($Values | Sort-Object)
    if (!$ordered.Count) { return $null }
    $middle = [math]::Floor($ordered.Count / 2)
    if ($ordered.Count % 2) { return [double]$ordered[$middle] }
    ([double]$ordered[$middle - 1] + [double]$ordered[$middle]) / 2
}

function In-MiB([double] $Bytes) {
    [math]::Round($Bytes / 1MB, 2)
}

$rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId" -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)
if ($rows.Count -ne 1) { throw 'The specified benchmark process is unavailable.' }
$root = $rows[0]
if ($RootExecutable -and (!$root.ExecutablePath -or
    [IO.Path]::GetFullPath($RootExecutable) -ine [IO.Path]::GetFullPath($root.ExecutablePath))) {
    throw 'The benchmark PID does not have the expected executable path.'
}

$logicalCpus = [int](Get-CimInstance Win32_ComputerSystem -Property NumberOfLogicalProcessors).NumberOfLogicalProcessors
$physicalBytes = [double](Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize).TotalVisibleMemorySize * 1KB
$watch = [Diagnostics.Stopwatch]::StartNew()
if ($QuietSeconds -gt 0) { Start-Sleep -Milliseconds ([int]($QuietSeconds * 1000)) }
$frames = @()
$previous = $null
for ($sample = 0; $sample -lt $Samples; $sample++) {
    $inventory = Get-ProcessInventory
    $liveRoot = @($inventory | Where-Object { $_.ProcessId -eq $RootProcessId -and $_.CreationDate -eq $root.CreationDate })
    if ($liveRoot.Count -ne 1) { throw 'The owned benchmark process exited while sampling.' }
    $tree = Get-Tree $inventory $root $WebViewUserDataDirectory
    $counters = @{}
    $perf = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,WorkingSet,WorkingSetPrivate,PrivateBytes,PercentProcessorTime
    foreach ($counter in $perf) {
        if ($counter.IDProcess -gt 0) { $counters[[int]$counter.IDProcess] = $counter }
    }

    $timestamp = $watch.Elapsed.TotalSeconds
    $nextCpu = @{}
    $appPrivate = 0.0
    $appWorking = 0.0
    $appCommit = 0.0
    $clientPrivate = 0.0
    $clientWorking = 0.0
    $appCpu100ns = 0.0
    $clientCpu100ns = 0.0
    $appCount = 0
    $clientCount = 0
    $webViewCount = 0
    foreach ($row in $tree) {
        $counter = $counters[[int]$row.ProcessId]
        if ($null -eq $counter) { continue }
        $key = '{0}-{1}' -f $row.ProcessId, $row.CreationDate.Ticks
        $ticks = [double]$counter.PercentProcessorTime
        $nextCpu[$key] = $ticks
        $ticksDelta = 0.0
        if ($previous -and $previous.Cpu.ContainsKey($key)) {
            $ticksDelta = [math]::Max(0, $ticks - $previous.Cpu[$key])
        }

        if ($row.Name -in $wslClientNames) {
            $clientPrivate += [double]$counter.WorkingSetPrivate
            $clientWorking += [double]$counter.WorkingSet
            $clientCpu100ns += $ticksDelta
            $clientCount++
        } else {
            $appPrivate += [double]$counter.WorkingSetPrivate
            $appWorking += [double]$counter.WorkingSet
            $appCommit += [double]$counter.PrivateBytes
            $appCpu100ns += $ticksDelta
            $appCount++
            if ($row.Name -eq 'msedgewebview2.exe') { $webViewCount++ }
        }
    }
    if (!$counters.ContainsKey($RootProcessId)) { throw 'The root process performance counters are unavailable.' }

    $cpu = $null
    $cpuWithClients = $null
    if ($previous -and $timestamp -gt $previous.Seconds) {
        $divisor = ($timestamp - $previous.Seconds) * 10000000 * $logicalCpus
        $cpu = 100 * $appCpu100ns / $divisor
        $cpuWithClients = 100 * ($appCpu100ns + $clientCpu100ns) / $divisor
    }

    $memory = Get-CimInstance Win32_PerfRawData_PerfOS_Memory -Property AvailableBytes
    $vm = 0.0
    foreach ($row in $inventory) {
        if ($row.Name -match '^VmmemWSL(?:\.exe)?$' -and $counters.ContainsKey([int]$row.ProcessId)) {
            $vm += [double]$counters[[int]$row.ProcessId].WorkingSet
        }
    }
    $frame = [ordered]@{
        AppPrivateMiB = In-MiB $appPrivate
        AppWorkingSetMiB = In-MiB $appWorking
        AppCommitMiB = In-MiB $appCommit
        WindowsWorkloadPrivateMiB = In-MiB ($appPrivate + $clientPrivate)
        WindowsWorkloadWorkingSetMiB = In-MiB ($appWorking + $clientWorking)
        AppCpuPercent = $(if ($null -ne $cpu) { [math]::Round($cpu, 4) })
        WindowsWorkloadCpuPercent = $(if ($null -ne $cpuWithClients) { [math]::Round($cpuWithClients, 4) })
        ActiveAppProcesses = $appCount
        WebViewProcesses = $webViewCount
        WslClientProcesses = $clientCount
        SharedWslVmWorkingSetMiB = In-MiB $vm
        WindowsMemoryUsedMiB = In-MiB ($physicalBytes - [double]$memory.AvailableBytes)
    }
    if ($Proportional) {
        $members = @($tree | Where-Object { $_.Name -notin $wslClientNames })
        $processIds = [int[]]@($members | ForEach-Object { $_.ProcessId })
        $created = [long[]]@($members | ForEach-Object { $_.CreationDate.ToUniversalTime().ToFileTimeUtc() })
        $pages = [AgentDock.Bench.WorkingSetPages]::Read($processIds, $created, $ProportionalMaxPages)
        $frame.ProportionalPages = $pages.Pages
        $frame.ProportionalSaturatedPages = $pages.SaturatedPages
        $frame.ProportionalUnavailableProcesses = $pages.UnavailableProcesses
        $frame.ProportionalLimitHits = $pages.LimitHits
        $frame.AppProportionalMiB = if ($members.Count -gt 0 -and !$pages.UnavailableProcesses -and !$pages.LimitHits) {
            In-MiB $pages.AttributedBytes
        }
    }
    $frames += [PSCustomObject]$frame
    $previous = @{ Seconds = $timestamp; Cpu = $nextCpu }
    if ($sample -lt $Samples - 1) { Start-Sleep -Milliseconds ([int]($IntervalSeconds * 1000)) }
}

$medians = [ordered]@{}
foreach ($property in $frames[0].PSObject.Properties.Name) {
    $medians[$property] = Get-Median @($frames | ForEach-Object { $_.$property } | Where-Object { $null -ne $_ })
}
$fileVersion = if ($root.ExecutablePath) { (Get-Item -LiteralPath $root.ExecutablePath).VersionInfo.ProductVersion }
$report = [ordered]@{
    Label = $Label
    Version = $fileVersion
    TerminalCount = $TerminalCount
    StartupMilliseconds = $(if ($StartupMilliseconds -ge 0) { [math]::Round($StartupMilliseconds, 1) })
    SampleCount = $Samples
    LogicalCpus = $logicalCpus
    Medians = $medians
    Samples = $frames
}
if ($Proportional) {
    $complete = @($frames | Where-Object { $null -ne $_.AppProportionalMiB }).Count
    $report.ProportionalCompleteSamples = $complete
    $report.ProportionalMaxPages = $ProportionalMaxPages
    if ($complete -ne $Samples) { $medians.AppProportionalMiB = $null }
}
[PSCustomObject]$report
