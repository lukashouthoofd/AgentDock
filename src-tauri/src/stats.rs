use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct Stats(Mutex<System>, AtomicBool);

impl Default for Stats {
    fn default() -> Self {
        Self(Mutex::new(System::new()), AtomicBool::new(false))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    total: u64,
    used: u64,
    available: u64,
    cpu: Option<f32>,
    windows_subsystem: Option<u64>,
    agent_dock: u64,
    agent_dock_private: Option<u64>,
}

impl Stats {
    pub fn sample(&self) -> Sample {
        let mut system = self.0.lock().unwrap();
        system.refresh_memory();
        system.refresh_cpu_usage();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        let own_pid = Pid::from_u32(std::process::id());
        let mut app_processes = HashSet::from([own_pid]);
        loop {
            let previous = app_processes.len();
            for (pid, process) in system.processes() {
                if process
                    .parent()
                    .is_some_and(|parent| app_processes.contains(&parent))
                {
                    app_processes.insert(*pid);
                }
            }
            if previous == app_processes.len() {
                break;
            }
        }
        let owned: Vec<_> = app_processes
            .iter()
            .filter_map(|pid| system.process(*pid))
            .filter(|process| {
                process.pid() == own_pid
                    || ["msedgewebview2", "conhost", "openconsole"]
                        .iter()
                        .any(|name| {
                            process
                                .name()
                                .to_string_lossy()
                                .trim_end_matches(".exe")
                                .eq_ignore_ascii_case(name)
                        })
            })
            .collect();
        let agent_dock = owned.iter().map(|process| process.memory()).sum();
        #[cfg(windows)]
        let agent_dock_private = owned.iter().try_fold(0, |total, process| {
            private_working_set(process.pid().as_u32()).map(|bytes| total + bytes)
        });
        #[cfg(not(windows))]
        let agent_dock_private = None;
        #[cfg(windows)]
        let windows_subsystem = wsl_working_set();
        #[cfg(not(windows))]
        let windows_subsystem = None;
        let cpu = self
            .1
            .swap(true, Ordering::Relaxed)
            .then(|| system.global_cpu_usage());
        Sample {
            total: system.total_memory(),
            used: system
                .total_memory()
                .saturating_sub(system.available_memory()),
            available: system.available_memory(),
            cpu,
            windows_subsystem,
            agent_dock,
            agent_dock_private,
        }
    }
}

#[cfg(windows)]
fn private_working_set(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX2},
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
        ..Default::default()
    };
    // SAFETY: the local structure is writable for its supplied size. The handle is closed once.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let ok = K32GetProcessMemoryInfo(
            process,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast(),
            counters.cb,
        );
        CloseHandle(process);
        (ok != 0).then_some(counters.PrivateWorkingSetSize as u64)
    }
}

#[cfg(windows)]
fn wsl_working_set() -> Option<u64> {
    use windows_sys::Win32::System::Performance::*;
    let counter_path: Vec<u16> = r"\Process(vmmemWSL)\Working Set"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut query = std::ptr::null_mut();
    let mut counter = std::ptr::null_mut();
    let mut result = PDH_FMT_COUNTERVALUE::default();
    // SAFETY: the handles and result are out parameters. The query owns the counter.
    unsafe {
        if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
            return None;
        }
        let ok = PdhAddEnglishCounterW(query, counter_path.as_ptr(), 0, &mut counter) == 0
            && PdhCollectQueryData(query) == 0
            && PdhGetFormattedCounterValue(
                counter,
                PDH_FMT_LARGE,
                std::ptr::null_mut(),
                &mut result,
            ) == 0
            && matches!(
                result.CStatus,
                PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA
            );
        PdhCloseQuery(query);
        if ok {
            u64::try_from(result.Anonymous.largeValue)
                .ok()
                .filter(|bytes| *bytes > 0)
        } else {
            None
        }
    }
}
