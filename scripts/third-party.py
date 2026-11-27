"""Generate notices after npm ci and cargo fetch."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[1]
metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--locked", "--manifest-path", str(root / "src-tauri/Cargo.toml"),
    "--filter-platform", "x86_64-pc-windows-msvc", "--format-version", "1",
]))
resolved = {node["id"] for node in metadata["resolve"]["nodes"]}
items = []
for package in metadata["packages"]:
    if package["source"] and package["id"] in resolved:
        name, version = package["name"], package["version"]
        url = f"https://crates.io/crates/{name}/{version}"
        items.append((name, version, package["license"], url, Path(package["manifest_path"]).parent))
for name in json.loads((root / "package.json").read_text())["dependencies"]:
    path = root / "node_modules" / name
    package = json.loads((path / "package.json").read_text())
    version = package["version"]
    name = package["name"]
    items.append((name, version, package["license"], f"https://www.npmjs.com/package/{name}/v/{version}", path))

sections = [
    "AgentDock third-party notices",
    "This inventory includes transitive Rust build and runtime dependencies for Windows x64.",
    "The Rust package links identify exact versions and provide the corresponding source.",
    "Javascript package links identify the source package versions.",
    "",
    "Tux was created by Larry Ewing (lewing@isc.tamu.edu) with The GIMP.",
    "Use and modification are permitted with acknowledgement. See scripts/intro/ATTRIBUTION.md.",
    "Ship It was inspired by https://github.com/lukashouthoofd/ship-it (MIT).",
    "",
    "Package inventory",
]
texts = {}
for name, version, license, source, path in sorted(items, key=lambda item: (item[0].lower(), item[1])):
    identifiers = []
    for item in sorted(path.iterdir()):
        if not item.is_file() or not item.name.lower().startswith(("licen", "copying", "notice", "copyright")):
            continue
        text = item.read_text(encoding="utf-8", errors="replace").strip()
        digest = hashlib.sha256(text.encode()).hexdigest()
        if digest not in texts:
            texts[digest] = (f"L{len(texts) + 1:03}", text)
        identifiers.append(texts[digest][0])
    sections.append(f"{name} {version} | {license} | {source}" +
                    (f" | {', '.join(dict.fromkeys(identifiers))}" if identifiers else " | notice available in package source"))
for label, text in texts.values():
    sections.extend(["", f"[{label}]", text])
(root / "THIRD_PARTY_NOTICES.txt").write_text("\n".join(sections) + "\n", encoding="utf-8")
