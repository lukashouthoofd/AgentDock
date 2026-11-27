//! Lossless edits for conventional dotenv files. Values stay in memory outside the project file.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    ops::Range,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: usize = 512 * 1024;
const MAX_ROWS: usize = 8192;
const CONFLICT: &str = "The dotenv file changed on disk. Reload it before saving.";
const INVALID_NAME: &str = "Enter a dotenv filename such as .env, .env.local or settings.env.";
const NOT_REGULAR: &str = "Choose a regular dotenv file. Links and special files are unavailable.";
const BACKTICK: u8 = 0x60;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub version: String,
    pub rows: Vec<Row>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: usize,
    pub key: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: Option<usize>,
    pub key: String,
    pub value: Option<String>,
}

// Source ranges let an edit keep every byte it does not explicitly replace.
struct Assignment {
    full: Range<usize>,
    key: Range<usize>,
    value: Range<usize>,
    comment: Option<usize>,
    indent_end: usize,
    quote: Option<u8>,
}

struct Snapshot {
    source: String,
    version: String,
    file: File,
}

pub fn list(root: &Path) -> Result<Vec<String>, String> {
    let directory = fs::read_dir(root).map_err(|_| "Could not read the project folder.")?;
    let mut names = Vec::new();
    for entry in directory.flatten() {
        let Some(name) = entry
            .file_name()
            .into_string()
            .ok()
            .filter(|name| valid_name(name))
        else {
            continue;
        };
        if fs::symlink_metadata(entry.path()).is_ok_and(|meta| regular(&meta)) {
            names.push(name);
        }
    }
    names.sort_by(|left, right| {
        (!left.eq_ignore_ascii_case(".env"))
            .cmp(&(!right.eq_ignore_ascii_case(".env")))
            .then_with(|| left.cmp(right))
    });
    Ok(names)
}

pub fn read(root: &Path, name: &str) -> Result<Document, String> {
    let (_, path) = target(root, name)?;
    let snapshot = snapshot(&path)?;
    let entries = assignments(&snapshot.source)?;
    Ok(document(&snapshot.source, snapshot.version, &entries))
}

pub fn create(root: &Path, name: &str) -> Result<Document, String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Could not prepare the dotenv file.")?;
    let (_, path) = target(root, name)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "That dotenv filename already exists."
        } else {
            "Could not create the dotenv file."
        }
    })?;
    Ok(document("", fingerprint(""), &[]))
}

pub fn save(root: &Path, name: &str, version: &str, edits: Vec<Edit>) -> Result<Document, String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Could not prepare the dotenv save.")?;
    let (directory, path) = target(root, name)?;
    if fs::symlink_metadata(&path).is_err_and(|error| error.kind() == io::ErrorKind::NotFound) {
        return Err(CONFLICT.into());
    }
    let before = snapshot(&path)?;
    if before.version != version {
        return Err(CONFLICT.into());
    }

    let entries = assignments(&before.source)?;
    let expected_rows = edits.len();
    let output = apply_edits(&before.source, &entries, edits)?;
    let output_entries = assignments(&output)?;
    if output_entries.len() != expected_rows {
        return Err(
            "Fix an incomplete assignment in the dotenv file before making this change.".into(),
        );
    }
    if output != before.source {
        let permissions = before
            .file
            .metadata()
            .map_err(|_| "Could not read the dotenv file permissions.")?
            .permissions();
        if permissions.readonly() {
            return Err("The dotenv file is read-only.".into());
        }
        let mut temp = tempfile::Builder::new()
            .prefix(".agentdock-env-")
            .tempfile_in(directory)
            .map_err(|_| "Could not stage the dotenv save in the project folder.")?;
        temp.write_all(output.as_bytes())
            .and_then(|_| temp.as_file().set_permissions(permissions))
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|_| "Could not write the staged dotenv file.")?;

        // The existing Windows handle denies in-place writes. Recheck the path for replacements.
        let latest = snapshot(&path).map_err(|_| CONFLICT)?;
        if latest.version != version {
            return Err(CONFLICT.into());
        }
        // Windows can reject a rename over an open destination even if delete sharing is enabled.
        drop(latest);
        drop(before);
        temp.persist(&path)
            .map_err(|_| "Could not replace the dotenv file. The staged save was discarded.")?;
    }

    Ok(document(&output, fingerprint(&output), &output_entries))
}

fn target(root: &Path, name: &str) -> Result<(PathBuf, PathBuf), String> {
    if !valid_name(name) {
        return Err(INVALID_NAME.into());
    }
    let directory = fs::canonicalize(root).map_err(|_| "Could not open the project folder.")?;
    if !directory.is_dir() {
        return Err("Could not open the project folder.".into());
    }
    let path = directory.join(name);
    Ok((directory, path))
}

fn valid_name(name: &str) -> bool {
    if name.len() > 240
        || name.trim() != name
        || name.ends_with('.')
        || name
            .chars()
            .any(|ch| ch.is_control() || r#"\/:*?"<>|"#.contains(ch))
    {
        return false;
    }
    let folded = name.to_ascii_lowercase();
    if !(folded == ".env" || folded.starts_with(".env.") || folded.ends_with(".env")) {
        return false;
    }
    let base = folded.split('.').next().unwrap_or_default().trim_end();
    !(matches!(base, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        }))
}

fn regular(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    meta.is_file() && !meta.file_type().is_symlink()
}

fn snapshot(path: &Path) -> Result<Snapshot, String> {
    let before = fs::symlink_metadata(path).map_err(|_| "Could not open the dotenv file.")?;
    if !regular(&before) {
        return Err(NOT_REGULAR.into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        const FILE_SHARE_DELETE: u32 = 4;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NOFOLLOW: i32 = 0x20000;
        const O_NONBLOCK: i32 = 0x800;
        options.custom_flags(O_NOFOLLOW | O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Could not open the dotenv file.")?;
    let opened = file
        .metadata()
        .map_err(|_| "Could not inspect the dotenv file.")?;
    if !regular(&opened) {
        return Err(NOT_REGULAR.into());
    }
    if opened.len() > MAX_BYTES as u64 {
        return Err("Dotenv files must be 512 KiB or smaller.".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    (&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the dotenv file.")?;
    if bytes.len() > MAX_BYTES {
        return Err("Dotenv files must be 512 KiB or smaller.".into());
    }
    let source = String::from_utf8(bytes).map_err(|_| "The dotenv file must use UTF-8.")?;
    if source.contains('\0') {
        return Err("The dotenv file contains a null character.".into());
    }
    Ok(Snapshot {
        version: fingerprint(&source),
        source,
        file,
    })
}

fn fingerprint(source: &str) -> String {
    format!("{:x}", Sha256::digest(source))
}

fn document(source: &str, version: String, assignments: &[Assignment]) -> Document {
    let rows = assignments
        .iter()
        .enumerate()
        .map(|(id, entry)| Row {
            id,
            key: source[entry.key.clone()].into(),
            value: decode(&source[entry.value.clone()], entry.quote),
        })
        .collect();
    Document { version, rows }
}

fn horizontal(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t')
}

fn key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 256 && key.bytes().all(key_byte)
}

fn line_bounds(source: &[u8], from: usize) -> (usize, usize) {
    let end = source[from..]
        .iter()
        .position(|byte| matches!(byte, b'\r' | b'\n'))
        .map_or(source.len(), |offset| from + offset);
    let next = match source.get(end..end + 2) {
        Some(b"\r\n") => end + 2,
        _ if end < source.len() => end + 1,
        _ => end,
    };
    (end, next)
}

fn advance(source: &[u8], from: usize, until: usize, matches: impl Fn(u8) -> bool) -> usize {
    source[from..until]
        .iter()
        .position(|byte| !matches(*byte))
        .map_or(until, |index| from + index)
}

fn close_quote(source: &[u8], value_start: usize, quote: u8) -> Option<usize> {
    let mut index = value_start + 1;
    while let Some(byte) = source.get(index) {
        if *byte == quote {
            return Some(index + 1);
        }
        index += if *byte == b'\\' { 2 } else { 1 };
    }
    None
}

fn assignments(source: &str) -> Result<Vec<Assignment>, String> {
    let mut result = Vec::new();
    let mut start = if source.starts_with('\u{feff}') { 3 } else { 0 };
    let bytes = source.as_bytes();
    while start < bytes.len() {
        let (end, next) = line_bounds(bytes, start);
        let indent_end = advance(bytes, start, end, horizontal);
        let mut key_start = indent_end;
        if bytes[key_start..end].starts_with(b"export")
            && bytes
                .get(key_start + 6)
                .is_some_and(|byte| horizontal(*byte))
        {
            key_start = advance(bytes, key_start + 6, end, horizontal);
        }
        let key_end = advance(bytes, key_start, end, key_byte);
        let equals = advance(bytes, key_end, end, horizontal);
        if key_start == key_end || equals == end || bytes[equals] != b'=' {
            start = next;
            continue;
        }
        let mut value_start = advance(bytes, equals + 1, end, horizontal);
        let quote = bytes
            .get(value_start)
            .copied()
            .filter(|byte| matches!(*byte, b'\'' | b'"' | BACKTICK));
        let (value_end, comment, next) = if let Some(quote) = quote {
            let Some(value_end) = close_quote(bytes, value_start, quote) else {
                // With an unterminated multiline quote, subsequent bytes could be the value.
                break;
            };
            let (end, next) = line_bounds(bytes, value_end);
            let suffix = advance(bytes, value_end, end, horizontal);
            if suffix < end && bytes[suffix] != b'#' {
                start = next;
                continue;
            }
            (value_end, (suffix < end).then_some(suffix), next)
        } else {
            let comment = bytes[value_start..end]
                .iter()
                .position(|byte| *byte == b'#')
                .map(|offset| offset + value_start);
            let limit = comment.unwrap_or(end);
            let value_end = bytes[value_start..limit]
                .iter()
                .rposition(|byte| !horizontal(*byte))
                .map_or(value_start, |offset| value_start + offset + 1);
            // An empty value can share its original whitespace with a following comment.
            if comment == Some(value_start) && value_start > equals + 1 {
                value_start -= 1;
                (value_start, comment, next)
            } else {
                (value_end, comment, next)
            }
        };

        if result.len() == MAX_ROWS {
            return Err("Dotenv files must have 8192 variables or fewer.".into());
        }
        result.push(Assignment {
            full: start..next,
            key: key_start..key_end,
            value: value_start..value_end,
            comment,
            indent_end,
            quote,
        });
        start = next;
    }
    Ok(result)
}

fn decode(value: &str, quote: Option<u8>) -> String {
    let Some(quote) = quote else {
        return value.into();
    };
    let normalized = value[1..value.len() - 1]
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut result = String::with_capacity(normalized.len());
    let mut characters = normalized.chars().peekable();
    while let Some(ch) = characters.next() {
        if ch == '\\' {
            let escaped = match characters.peek() {
                Some(next) if *next == char::from(quote) || *next == '\\' => Some(*next),
                Some('n') if quote == b'"' => Some('\n'),
                Some('r') if quote == b'"' => Some('\r'),
                _ => None,
            };
            if let Some(escaped) = escaped {
                characters.next();
                result.push(escaped);
                continue;
            }
        }
        result.push(ch);
    }
    result
}

fn is_bare(value: &str) -> bool {
    value.trim() == value && !value.contains(['\n', '\r', '#', '\'', '"', char::from(BACKTICK)])
}

fn encode(value: &str, preferred: Option<u8>, newline: &str) -> String {
    if preferred.is_none() && is_bare(value) {
        return value.into();
    }

    let verbatim = |quote| !value.contains([quote, '\\', '\r']);
    if let Some(quote) = preferred
        .filter(|quote| *quote != BACKTICK)
        .map(char::from)
        .filter(|quote| verbatim(*quote))
    {
        return format!("{quote}{}{quote}", value.replace('\n', newline));
    }
    if verbatim('\'') {
        return format!("'{}'", value.replace('\n', newline));
    }

    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');
    for ch in value.chars() {
        match ch {
            '\n' => result.push_str(newline),
            '\r' => result.push_str(r"\r"),
            '"' => result.push_str(r#"\""#),
            '\\' => result.push_str(r"\\"),
            _ => result.push(ch),
        }
    }
    result.push('"');
    result
}

fn preferred_newline(source: &str) -> &'static str {
    let (end, after) = line_bounds(source.as_bytes(), 0);
    match &source[end..after] {
        "\r\n" => "\r\n",
        "\r" => "\r",
        _ => "\n",
    }
}

fn apply_edits(source: &str, entries: &[Assignment], edits: Vec<Edit>) -> Result<String, String> {
    if edits.len() > MAX_ROWS {
        return Err("Dotenv files must have 8192 variables or fewer.".into());
    }
    let mut existing = HashMap::new();
    let mut added = Vec::new();
    for edit in edits {
        if edit
            .value
            .as_ref()
            .is_some_and(|value| value.len() > MAX_BYTES || value.contains('\0'))
        {
            return Err("A value exceeds the dotenv limit or contains a null character.".into());
        }
        if let Some(id) = edit.id {
            let entry = entries.get(id).ok_or("A dotenv edit has an unknown row.")?;
            if edit.key != source[entry.key.clone()] && !valid_key(&edit.key) {
                return Err("Use a valid dotenv variable name.".into());
            }
            if existing.insert(id, edit).is_some() {
                return Err("A dotenv row was supplied twice.".into());
            }
        } else {
            if !valid_key(&edit.key) || edit.value.is_none() {
                return Err("New variables require a valid name and a value.".into());
            }
            added.push(edit);
        }
    }

    let newline = preferred_newline(source);
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    for (id, entry) in entries.iter().enumerate() {
        output.push_str(&source[cursor..entry.full.start]);
        if let Some(edit) = existing.remove(&id) {
            output.push_str(&source[entry.full.start..entry.key.start]);
            output.push_str(&edit.key);
            output.push_str(&source[entry.key.end..entry.value.start]);
            if let Some(value) = edit.value {
                output.push_str(&encode(&value, entry.quote, newline));
            } else {
                output.push_str(&source[entry.value.clone()]);
            }
            output.push_str(&source[entry.value.end..entry.full.end]);
        } else if let Some(comment) = entry.comment {
            output.push_str(&source[entry.full.start..entry.indent_end]);
            output.push_str(&source[comment..entry.full.end]);
        }
        cursor = entry.full.end;
        if output.len() > MAX_BYTES {
            return Err("Dotenv files must be 512 KiB or smaller.".into());
        }
    }
    output.push_str(&source[cursor..]);
    for edit in added {
        if !output.is_empty() && output != "\u{feff}" && !output.ends_with(['\n', '\r']) {
            output.push_str(newline);
        }
        output.push_str(&edit.key);
        output.push('=');
        output.push_str(&encode(
            edit.value.as_deref().unwrap_or_default(),
            None,
            newline,
        ));
        output.push_str(newline);
        if output.len() > MAX_BYTES {
            return Err("Dotenv files must be 512 KiB or smaller.".into());
        }
    }
    if output.len() > MAX_BYTES {
        return Err("Dotenv files must be 512 KiB or smaller.".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(id: usize, key: &str, value: Option<&str>) -> Edit {
        Edit {
            id: Some(id),
            key: key.into(),
            value: value.map(str::to_owned),
        }
    }

    fn add(key: &str, value: &str) -> Edit {
        Edit {
            id: None,
            key: key.into(),
            value: Some(value.into()),
        }
    }

    #[test]
    fn keeps_comments_multiline_values_bom_and_mixed_endings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".env.local");
        let source = "\u{feff}# header\r\n\
            FIRST  = old  # note\r\n\
            \texport MULTI = \"first\r\n# inside the value\nline with =\"\t # after\n\
            \r\n\
            LAST=last";
        fs::write(&path, source).unwrap();

        let original = read(directory.path(), ".env.local").unwrap();
        assert_eq!(
            original.rows[1].value,
            "first\n# inside the value\nline with ="
        );
        let edited = save(
            directory.path(),
            ".env.local",
            &original.version,
            vec![
                change(2, "FINAL", None),
                change(1, "MULTI", None),
                change(0, "FIRST", Some("new")),
            ],
        )
        .unwrap();

        assert_eq!(edited.rows[2].key, "FINAL");
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            source
                .replace("old  #", "new  #")
                .replace("LAST=", "FINAL=")
        );
    }

    #[test]
    fn keeps_comments_when_removing_variables_and_can_add_multiline() {
        let source = "# start\r\n\tA=old  # retain\r\nB='legacy'\r\nC=last\r\n";
        let entries = assignments(source).unwrap();
        let output = apply_edits(
            source,
            &entries,
            vec![
                change(1, "B", Some("two\nthree # literal")),
                add("NEW", "😀\nend"),
                add("EMPTY", ""),
            ],
        )
        .unwrap();
        assert_eq!(
            output,
            "# start\r\n\t# retain\r\nB='two\r\nthree # literal'\r\nNEW='😀\r\nend'\r\nEMPTY=\r\n"
        );
        let edited = document(&output, String::new(), &assignments(&output).unwrap());
        assert_eq!(edited.rows[2].value, "");
    }

    #[test]
    fn encodes_values_without_creating_new_assignments() {
        for value in [
            "",
            " trailing ",
            "\"and'quotes\\",
            "key=a #hash",
            "\r",
            "new\nBAD=bad\nline",
        ] {
            let output = apply_edits("", &[], vec![add("TOKEN", value)]).unwrap();
            let document = document(&output, String::new(), &assignments(&output).unwrap());
            assert_eq!(document.rows.len(), 1);
            assert_eq!(document.rows[0].value, value);
        }
    }

    #[test]
    fn rejects_conflicting_edit_after_external_write_or_delete() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".env");
        fs::write(&path, "A=original").unwrap();
        let original = read(directory.path(), ".env").unwrap();

        fs::write(&path, "A=external").unwrap();
        let result = save(
            directory.path(),
            ".env",
            &original.version,
            vec![change(0, "A", Some("local"))],
        );
        assert_eq!(result.err().as_deref(), Some(CONFLICT));
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=external");

        fs::remove_file(&path).unwrap();
        let result = save(directory.path(), ".env", &original.version, Vec::new());
        assert_eq!(result.err().as_deref(), Some(CONFLICT));
        assert!(!path.exists());
    }

    #[test]
    fn lists_and_creates_only_regular_dotenv_files() {
        let directory = tempfile::tempdir().unwrap();
        for name in [".env", ".env.example", "custom variables.env"] {
            assert!(create(directory.path(), name).unwrap().rows.is_empty());
        }
        for name in [
            "../x.env",
            "/outside.env",
            r"C:\outside.env",
            ".env:stream",
            ".env.local.",
            "CON.env",
            "LPT¹.env",
        ] {
            assert!(create(directory.path(), name).is_err());
        }
        fs::create_dir(directory.path().join("directory.env")).unwrap();
        fs::write(directory.path().join("script.envrc"), "").unwrap();
        assert_eq!(
            list(directory.path()).unwrap(),
            [".env", ".env.example", "custom variables.env"]
        );
        assert!(create(directory.path(), ".env").is_err());
        assert!(read(directory.path(), "directory.env").is_err());
    }

    #[test]
    fn rejects_malformed_options_and_large_files_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".env");
        fs::write(&path, "A=value\n").unwrap();
        let original = read(directory.path(), ".env").unwrap();
        for edits in [
            vec![change(1, "A", None)],
            vec![change(0, "A", None), change(0, "A", None)],
            vec![change(0, "BAD\nNAME", None)],
            vec![add("A", "\0")],
        ] {
            assert!(save(directory.path(), ".env", &original.version, edits).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), "A=value\n");
        }
        fs::write(&path, vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(read(directory.path(), ".env").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_preserves_original_mode() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join(".env");
        fs::write(&target, "A=outside\n").unwrap();
        let link = project.path().join(".env.link");
        symlink(&target, link).unwrap();
        assert!(read(project.path(), ".env.link").is_err());
        assert!(create(project.path(), ".env.link").is_err());
        assert!(list(project.path()).unwrap().is_empty());

        let path = project.path().join(".env");
        fs::write(&path, "A=project\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let original = read(project.path(), ".env").unwrap();
        save(
            project.path(),
            ".env",
            &original.version,
            vec![change(0, "A", Some("changed"))],
        )
        .unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "A=outside\n");
    }
}
