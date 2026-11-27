use crate::host::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const BUILTIN: &str = include_str!("../../docs/engineering-template.md");
const MAX_WORKSPACE: usize = 2 * 1024 * 1024;
const MAX_TEMPLATE: usize = 128 * 1024;

pub struct Workspace {
    root: PathBuf,
    access: Mutex<()>,
}

#[derive(Serialize)]
pub struct Template {
    scope: String,
    name: String,
    content: String,
}

#[derive(Deserialize)]
pub struct TemplateEdit {
    scope: String,
    name: String,
    content: String,
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn template_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 80
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || " -_".contains(c))
        && name.trim() == name
}

fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Invalid storage location.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create AgentDock’s local storage.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not open AgentDock’s local storage.")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Could not write AgentDock’s local storage.")?;
    temporary
        .persist(path)
        .map_err(|_| "Could not replace AgentDock’s local storage.")?;
    Ok(())
}

impl Workspace {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            access: Mutex::new(()),
        }
    }

    pub fn load(&self) -> Result<Option<Value>> {
        let _lock = self
            .access
            .lock()
            .map_err(|_| "Workspace storage is unavailable.")?;
        let path = self.root.join("workspace.json");
        match fs::read(path) {
            Ok(bytes) if bytes.len() <= MAX_WORKSPACE => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Workspace metadata is damaged.".to_owned()),
            Ok(_) => Err("Workspace metadata exceeds the size limit.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("Could not read AgentDock’s workspace.".into()),
        }
    }

    pub fn save(&self, model: Value) -> Result<()> {
        let _lock = self
            .access
            .lock()
            .map_err(|_| "Workspace storage is unavailable.")?;
        let bytes = serde_json::to_vec(&model).map_err(|_| "Invalid workspace metadata.")?;
        if bytes.len() > MAX_WORKSPACE {
            return Err("Workspace metadata exceeds the size limit.".into());
        }
        atomic(&self.root.join("workspace.json"), &bytes)
    }

    fn templates_at(&self, scope: &str) -> Result<PathBuf> {
        if scope == "global" || valid_id(scope) {
            Ok(self.root.join("templates").join(scope))
        } else {
            Err("Invalid template scope.".into())
        }
    }

    pub fn templates(&self, project: Option<&str>) -> Result<Vec<Template>> {
        let _lock = self
            .access
            .lock()
            .map_err(|_| "Template storage is unavailable.")?;
        let mut items = vec![Template {
            scope: "built-in".into(),
            name: "Engineering workflow".into(),
            content: BUILTIN.into(),
        }];
        for scope in std::iter::once("global").chain(project) {
            let path = self.templates_at(scope)?;
            let entries = match fs::read_dir(path) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("Could not read local templates.".into()),
            };
            let mut scoped = Vec::new();
            for entry in entries.flatten().take(128) {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("md") {
                    continue;
                }
                let Some(name) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .filter(|name| template_name(name))
                else {
                    continue;
                };
                if !entry.file_type().is_ok_and(|kind| kind.is_file())
                    || !entry
                        .metadata()
                        .is_ok_and(|metadata| metadata.len() <= MAX_TEMPLATE as u64)
                {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&path) {
                    scoped.push(Template {
                        scope: scope.into(),
                        name: name.into(),
                        content,
                    });
                }
            }
            scoped.sort_unstable_by(|a, b| a.name.cmp(&b.name));
            items.extend(scoped);
        }
        Ok(items)
    }

    pub fn write_template(&self, edit: TemplateEdit) -> Result<()> {
        let _lock = self
            .access
            .lock()
            .map_err(|_| "Template storage is unavailable.")?;
        if !template_name(&edit.name) || edit.content.len() > MAX_TEMPLATE {
            return Err("Use a template name with letters, numbers, spaces, hyphens or underscores and up to 128 KiB of Markdown.".into());
        }
        atomic(
            &self
                .templates_at(&edit.scope)?
                .join(format!("{}.md", edit.name)),
            edit.content.as_bytes(),
        )
    }

    pub fn remove_template(&self, scope: &str, name: &str) -> Result<()> {
        let _lock = self
            .access
            .lock()
            .map_err(|_| "Template storage is unavailable.")?;
        if !template_name(name) {
            return Err("Invalid template name.".into());
        }
        fs::remove_file(self.templates_at(scope)?.join(format!("{name}.md")))
            .map_err(|_| "Could not remove the local template.".into())
    }
}
