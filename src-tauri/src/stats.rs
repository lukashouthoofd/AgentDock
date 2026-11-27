use serde::Serialize;
use std::{collections::HashSet, sync::Mutex};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct Stats(Mutex<System>);

impl Default for Stats {
    fn default() -> Self {
        Self(Mutex::new(System::new()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    total: u64,
    used: u64,
    available: u64,
    cpu: f32,
    windows_subsystem: Option<u64>,
    agent_dock: u64,
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
        let agent_dock = app_processes
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
            .map(|process| process.memory())
            .sum();
        let windows_subsystem = system
            .processes()
            .values()
            .find(|process| {
                let name = process.name();
                name.eq_ignore_ascii_case("vmmemWSL") || name.eq_ignore_ascii_case("vmmemWSL.exe")
            })
            .map(|process| process.memory());
        Sample {
            total: system.total_memory(),
            used: system
                .total_memory()
                .saturating_sub(system.available_memory()),
            available: system.available_memory(),
            cpu: system.global_cpu_usage(),
            windows_subsystem,
            agent_dock,
        }
    }
}
