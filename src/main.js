import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { dotenvEditor, workflowEditor } from './editors.js';
import { initialModel, leaves, exchangeLeaves, formatBytes, removeTerminal, splitLeaf } from './model.js';
import { playIntro } from './intro.js';
import { openDevelopment } from './dev-status.js';
import { celebrateShip } from './ship-celebration.js';
import { openSpotify } from './spotify.js';
import { $, busy, button, confirmAction, dialog, el, field, icon, input, pathName, reportError, safeColor, select } from './ui.js';
import './style.css';

const view = new Map();
const waiters = new Map();
const hiding = new Map();
const worktreeInfo = new Map();
const collapsed = new Set();
const runtime = new Map();
const health = new Map();
const paneLabels = new Map();
const app = $('#app');
const desktop = getCurrentWindow();
const projectBar = el('header', { class: 'toolbar', 'aria-label': 'Workspace toolbar' });
const sidebar = el('aside', { class: 'sidebar', 'aria-label': 'Projects and terminals' });
const tabbar = el('nav', { class: 'tabs', 'aria-label': 'Terminal tabs' });
const stage = el('main', { class: 'stage', 'aria-label': 'Terminal workspace' });
const statusBar = el('footer', { class: 'statusbar', 'aria-label': 'System resources' });
const notice = el('div', { id: 'notice', class: 'notice', role: 'status', hidden: true },
  el('span', { class: 'notice-message' }), button('Dismiss message', () => { notice.hidden = true; }, { icon: 'x', only: true }));
const workspace = el('div', { class: 'workspace' }, tabbar, stage);
app.append(projectBar, el('div', { class: 'workbench' }, sidebar, workspace), statusBar, notice);

let model = initialModel();
let distros = [];
let focused = null;
let maximized = null;
let minimized = false;
let renderRevision = 0;
let saved = Promise.resolve();
let closed = false;
let closing = false;
let sample;
const mergeSince = new Map();
const observedKeys = new Set();
const appMergeNotices = new Set();
function remember(set, key, max) {
  set.add(key);
  if (set.size > max) set.delete(set.values().next().value);
}
const mergeNoticeKey = (distro, path, oldHead, head) => JSON.stringify([distro, path, oldHead, head]);
const observerStarted = Math.floor(Date.now() / 1000);
let observationIndex = 0;
let mergeInFlight = false;
let gitRefreshTime = 0;

const project = () => model.projects.find(item => item.id === model.project);
const activeTab = () => model.tabs.find(item => item.id === model.active);
const activeSession = () => model.sessions[focused];
const rootPath = () => model.worktree || project()?.path;
const specFor = (session, launcher) => ({
  id: session.id, path: session.path, distro: session.distro, profile: session.profile, launcher,
});
const profileName = profile => profile === 'ubuntu' ? 'Ubuntu' : 'PowerShell';
const launchNames = { blank: 'Blank terminal', claude: 'Claude Code', codex: 'Codex', powershell: 'PowerShell' };

function save() {
  const snapshot = structuredClone(model);
  saved = saved.catch(() => {}).then(() => invoke('workspace_save', { model: snapshot }));
  saved.catch(reportError);
  return saved;
}

function projectDistro() { return model.settings.distro || distros.find(name => /^ubuntu/i.test(name)) || distros[0] || 'Ubuntu'; }

function currentStatus(session) {
  const local = runtime.get(session.id);
  const observed = health.get(session.id);
  if (local?.state === 'starting') return ['Starting', 'cool'];
  if (!observed?.running && observed?.exitCode != null) return observed.exitCode === 0
    ? ['Exited', 'quiet'] : [`Exit ${observed.exitCode}`, 'bad'];
  if (local?.state === 'unavailable') return ['Unavailable', 'bad'];
  if (local?.state === 'ended') return ['Exited', 'quiet'];
  if (observed?.running && (local?.state === 'detached' || !observed.attached)) return ['Detached', 'quiet'];
  if ((observed?.running || local?.state === 'attached') &&
    Date.now() - Math.max(observed?.lastOutput || 0, local?.last || 0) < 8000) return ['Output', 'ok'];
  if (observed?.running || local?.state === 'attached') return ['Quiet', 'quiet'];
  return [session.profile === 'ubuntu' ? 'Detached' : 'Exited', 'quiet'];
}

function mark(id, state, message) {
  const previous = runtime.get(id) || {};
  if (state === 'output') {
    runtime.set(id, { ...previous, last: Date.now() });
    if (Date.now() - (previous.last || 0) > 7500) paintStatus(id);
  } else {
    runtime.set(id, { ...previous, state, message });
    paintStatus(id);
  }
}

function paintStatus(id) {
  const session = model.sessions[id];
  if (!session) return;
  const [label, tone] = currentStatus(session);
  for (const element of [paneLabels.get(id), ...sidebar.querySelectorAll('[data-status-id]')]) {
    if (!element || element.dataset.statusId !== id) continue;
    element.textContent = label;
    element.className = `session-status ${tone}`;
    element.title = runtime.get(id)?.message || label;
  }
}

async function refreshHealth() {
  const distros = [...new Set(Object.values(model.sessions).filter(session => session.profile === 'ubuntu')
    .map(session => session.distro))];
  if (Object.keys(model.sessions).length) {
    const records = await invoke('terminal_health', { distros });
    health.clear();
    for (const item of records) health.set(item.id, item);
    Object.keys(model.sessions).forEach(paintStatus);
  }
  paintStats();
}

async function refreshGit(item, path = item.path) {
  const key = `${item.id}\n${path}`;
  try {
    const info = await invoke('host_git', { path, distro: item.distro });
    worktreeInfo.set(key, info);
  } catch (error) {
    worktreeInfo.set(key, { branch: '', worktrees: [], error: String(error) });
  }
  paintToolbar();
  paintSidebar();
}

function gitInfo(item, path = item.path) { return worktreeInfo.get(`${item.id}\n${path}`); }

function chooseProject(item, path = null) {
  model.project = item.id;
  model.recent = [item.id, ...model.recent.filter(id => id !== item.id)].slice(0, 36);
  model.worktree = path && path !== item.path ? path : null;
  collapsed.delete(item.id);
  const matching = activeTab() && leaves(activeTab().tree).find(id => {
    const session = model.sessions[id];
    return session?.project === item.id && (!path || session.path === path);
  });
  const candidate = matching || Object.values(model.sessions).findLast(session =>
    session.project === item.id && (!path || session.path === path) &&
    model.tabs.some(tab => leaves(tab.tree).includes(session.id)))?.id;
  if (candidate) activate(candidate, false);
  else { paintToolbar(); paintSidebar(); }
  save();
  refreshGit(item);
  if (path && path !== item.path) refreshGit(item, path);
}

function activate(id, updateProject = true) {
  const session = model.sessions[id];
  if (!session) return;
  let tab = model.tabs.find(item => leaves(item.tree).includes(id));
  if (!tab) {
    tab = { id: crypto.randomUUID(), tree: { id } };
    model.tabs.push(tab);
  }
  if (model.active !== tab.id) maximized = null;
  model.active = tab.id;
  focused = id;
  if (updateProject) {
    model.project = session.project;
    model.worktree = session.path === project()?.path ? null : session.path;
  }
  render();
  view.get(id)?.focus();
  save();
}

function focusPane(id) {
  if (focused === id) return;
  focused = id;
  const session = model.sessions[id];
  model.project = session.project;
  model.worktree = project()?.path === session.path ? null : session.path;
  paintToolbar();
  paintSidebar();
  for (const pane of stage.querySelectorAll('.pane')) pane.classList.toggle('active', pane.dataset.session === id);
}

function makeTab(id) {
  const tab = { id: crypto.randomUUID(), tree: { id } };
  model.tabs.push(tab);
  return tab;
}

async function newTerminal(kind = 'blank', axis, item = project(), path = rootPath()) {
  if (closing) return;
  if (!item) { await openProject(); return; }
  if (Object.keys(model.sessions).length >= 64) throw new Error('Remove an unused terminal before opening another.');
  const profile = kind === 'powershell' ? 'powershell' : 'ubuntu';
  const session = {
    id: crypto.randomUUID(), project: item.id, path: path || item.path, distro: item.distro, kind, profile,
    title: kind === 'blank' ? `${profileName(profile)} ${1 + Object.values(model.sessions).filter(term => term.project === item.id && term.kind === 'blank').length}` : launchNames[kind],
    role: '', color: item.color,
  };
  const previous = focused;
  const tab = axis && activeTab() && previous && leaves(activeTab().tree).includes(previous)
    ? activeTab() : makeTab(session.id);
  if (axis && tab === activeTab() && previous) tab.tree = splitLeaf(tab.tree, previous, session.id, axis);
  model.sessions[session.id] = session;
  model.active = tab.id;
  model.project = item.id;
  model.worktree = session.path === item.path ? null : session.path;
  focused = session.id;
  maximized = null;
  mark(session.id, 'starting');
  const starting = save().then(() => invoke('terminal_create', {
    spec: specFor(session, kind === 'claude' || kind === 'codex' ? model.settings[kind] : null), cols: 100, rows: 30,
  }));
  waiters.set(session.id, starting);
  starting.catch(error => mark(session.id, 'unavailable', String(error)))
    .finally(() => { waiters.delete(session.id); refreshHealth().catch(() => {}); });
  render();
  await starting;
}

function detach(id) {
  removeTerminal(model, id);
  if (focused === id) focused = null;
  if (maximized === id) maximized = null;
  mark(id, 'detached');
  render();
  save();
}

async function terminate(session) {
  if (!await confirmAction('Terminate terminal',
    `End “${session.title}” and the processes it owns?`, 'Terminate')) return;
  await Promise.allSettled([waiters.get(session.id), hiding.get(session.id)]);
  await invoke('terminal_terminate', { spec: specFor(session) });
  detach(session.id);
  delete model.sessions[session.id];
  health.delete(session.id);
  runtime.delete(session.id);
  render();
  save();
}

async function normalizeProject(path, distro) {
  const location = await invoke('host_location', { path, distro });
  let item = model.projects.find(existing => existing.path === location.display
    && existing.distro === (location.distro || distro));
  if (!item) {
    item = { id: crypto.randomUUID(), name: pathName(location.display), path: location.display,
      native: location.native, distro: location.distro || distro, color: '#b7c9e7' };
    model.projects.push(item);
  }
  chooseProject(item);
  return item;
}

async function openProject() {
  await ready;
  const path = input('', { placeholder: 'C:\\Projects\\repo or ~/projects/repo', spellcheck: 'false' });
  const distro = select((distros.length ? distros : [projectDistro()]).map(name => [name, name]), projectDistro());
  const form = el('form', { class: 'field-stack' }, field('Folder path', path), field('Ubuntu distribution', distro));
  const recentItems = model.recent.map(id => model.projects.find(item => item.id === id)).filter(Boolean).slice(0, 6);
  const recent = recentItems.length ? el('div', { class: 'recent-folders' },
    el('h3', { text: 'Recent projects' }),
    ...recentItems.map(item => button(item.name, () => { chooseProject(item); ui.close(); },
      { icon: 'folder-open', title: item.path }))) : null;
  const ui = dialog('Open project folder', [form, recent]);
  const submit = busy(async () => { await normalizeProject(path.value.trim(), distro.value); ui.close(); }, ui.error);
  form.addEventListener('submit', event => { event.preventDefault(); submit(event); });
  ui.footer.append(button('Browse folders', busy(async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Open project folder' });
    if (typeof picked === 'string') { await normalizeProject(picked, distro.value); ui.close(); }
  }, ui.error), { icon: 'folder-open' }), button('Open project', submit, { class: 'primary' }));
  path.focus();
}

async function cloneProject() {
  await ready;
  const remote = input('', { placeholder: 'https://github.com/owner/repository.git', spellcheck: 'false' });
  const destination = input(model.settings.cloneRoot + '/', { spellcheck: 'false' });
  const distro = select((distros.length ? distros : [projectDistro()]).map(name => [name, name]), projectDistro());
  const form = el('form', { class: 'field-stack' }, field('Repository URL or path', remote),
    field('New folder', destination), field('Ubuntu distribution', distro));
  const ui = dialog('Clone repository', form);
  const submit = busy(async () => {
    ui.error('');
    const location = await invoke('host_clone', { remote: remote.value.trim(), path: destination.value.trim(), distro: distro.value });
    await normalizeProject(location.display, location.distro || distro.value);
    ui.close();
  }, ui.error);
  remote.addEventListener('change', () => {
    if (destination.value === model.settings.cloneRoot + '/') {
      const name = pathName(remote.value.trim().split(':').at(-1)).replace(/\.git$/i, '');
      if (name) destination.value += name;
    }
  });
  form.addEventListener('submit', event => { event.preventDefault(); submit(event); });
  ui.footer.append(button('Clone', submit, { class: 'primary' }));
  remote.focus();
}

function editItem(item, kind) {
  const title = input(kind === 'terminal' ? item.title : item.name, { maxlength: 70 });
  const color = input(safeColor(item.color), { type: 'color' });
  const role = kind === 'terminal' ? input(item.role, { maxlength: 64, placeholder: 'Principal engineer' }) : null;
  const ui = dialog(kind === 'terminal' ? 'Terminal details' : 'Project details', [
    el('div', { class: 'field-pair' }, field('Name', title), field('Colour', color)),
    role ? field('Role', role) : null,
  ]);
  ui.footer.append(button('Save', () => {
    const value = title.value.trim().slice(0, 70);
    if (!value) { ui.error('Enter a name.'); return; }
    if (role) {
      item.title = value;
      item.role = role.value.trim().slice(0, 64);
    } else item.name = value;
    item.color = color.value;
    ui.close();
    render();
    save();
  }, { class: 'primary' }));
  title.select();
}

async function openSettings() {
  await ready;
  const current = model.settings;
  const distro = select((distros.length ? distros : [projectDistro()]).map(name => [name, name]), projectDistro());
  const cloneRoot = input(current.cloneRoot);
  const font = input(current.font);
  const fontSize = input(current.fontSize, { type: 'number', min: 9, max: 32 });
  const claude = input(current.claude);
  const codex = input(current.codex);
  const intro = el('input', { type: 'checkbox', checked: current.intro !== false });
  const ui = dialog('Settings', [
    el('div', { class: 'field-pair' }, field('Default Ubuntu distribution', distro), field('Clone directory', cloneRoot)),
    el('div', { class: 'field-pair' }, field('Terminal font', font), field('Font size', fontSize)),
    field('Claude Code launch command', claude), field('Codex launch command', codex),
    el('label', { class: 'check-field' }, intro, 'Play the Tux intro on launch'),
  ]);
  ui.footer.append(button('Save settings', () => {
    const size = Number(fontSize.value);
    if (!font.value.trim() || !cloneRoot.value.trim() || !claude.value.trim() || !codex.value.trim() || size < 9 || size > 32) {
      ui.error('Enter a font, valid size, clone directory and both launch commands.');
      return;
    }
    model.settings = { distro: distro.value, cloneRoot: cloneRoot.value.trim(), font: font.value.trim(),
      fontSize: size, claude: claude.value.trim(), codex: codex.value.trim(), intro: intro.checked };
    for (const terminal of view.values()) terminal.applySettings(model.settings);
    save();
    ui.close();
  }, { class: 'primary' }));
}

function openWorktrees() {
  const item = project();
  if (!item) return;
  const container = el('div', { class: 'worktree-list', text: 'Discovering Git worktrees…' });
  const ui = dialog('Git worktrees', container, { class: 'wide' });
  const refresh = busy(async () => {
    await refreshGit(item);
    const info = gitInfo(item);
    container.replaceChildren();
    if (info?.error) { ui.error(info.error); return; }
    if (!info?.worktrees.length) container.append(el('p', { class: 'muted', text: 'No Git worktrees found for this project.' }));
    for (const tree of info?.worktrees || []) {
      container.append(el('div', { class: 'worktree-row' },
        el('div', {}, el('strong', { text: tree.branch || 'Git worktree' }),
          el('span', { class: 'dialog-path', text: tree.path })),
        button('Select', () => { chooseProject(item, tree.path); ui.close(); }, { disabled: tree.missing }),
        button('New terminal', busy(async () => {
          ui.close();
          await newTerminal('blank', null, item, tree.path);
        }), { disabled: tree.missing, icon: 'terminal' })));
    }
  }, ui.error);
  ui.footer.append(button('Refresh', refresh));
  refresh();
}

async function openWorkflow(action) {
  await workflowEditor(project(), activeSession(), action, async (id, text) => {
    if (id !== focused || !leaves(activeTab()?.tree).includes(id)) return false;
    return view.get(id)?.insert(text) ?? false;
  });
}

async function fullscreen() { await desktop.setFullscreen(!await desktop.isFullscreen()); }

function newMenu(session) {
  return pickCommand(session ? 'Split terminal' : 'New terminal',
    Object.entries(launchNames).map(([key, label]) => [label, () => newTerminal(key, session ? 'columns' : null)]));
}

function terminalMenu(session) {
  return pickCommand(session.title, [
    ['Find in terminal', () => view.get(session.id)?.find()],
    ['Rename, colour and role', () => editItem(session, 'terminal')],
    ['Split side by side', () => newTerminal('blank', 'columns')],
    ['Split top and bottom', () => newTerminal('blank', 'rows')],
    ['Maximize or restore pane', () => { maximized = maximized === session.id ? null : session.id; renderStage(); }],
    ['Toggle full-screen window', fullscreen],
    ['/goal objective', () => openWorkflow('goal')],
    ['/loop task', () => openWorkflow('loop')],
    ['Insert saved prompt', () => openWorkflow('prompt')],
    [session.profile === 'ubuntu' ? 'Detach terminal' : 'Hide terminal', () => detach(session.id)],
    ['Reconnect terminal', () => retryTerminal(session.id)],
    ['Terminate terminal', () => terminate(session)],
  ]);
}

function pickCommand(title, commands) {
  const query = input('', { 'aria-label': 'Search commands', placeholder: 'Type to filter…' });
  const results = el('div', { class: 'command-results' });
  const ui = dialog(title, [query, results], { class: 'palette' });
  let index = 0;
  let visible = [];
  const run = action => {
    ui.close();
    Promise.resolve().then(action).catch(reportError);
  };
  const paint = () => {
    const filter = query.value.toLocaleLowerCase().trim();
    visible = commands.filter(([name]) => name.toLocaleLowerCase().includes(filter));
    index = Math.max(0, Math.min(index, visible.length - 1));
    results.replaceChildren(...visible.map(([label, action], position) =>
      button(label, () => run(action), { class: position === index ? 'chosen' : '' })));
    if (!visible.length) results.append(el('p', { class: 'muted', text: 'No matching commands.' }));
    results.children[index]?.scrollIntoView({ block: 'nearest' });
  };
  query.addEventListener('input', () => { index = 0; paint(); });
  query.addEventListener('keydown', event => {
    if (event.key === 'Enter' && visible[index]) { event.preventDefault(); run(visible[index][1]); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      index += event.key === 'ArrowDown' ? 1 : -1;
      paint();
    }
  });
  paint();
  query.focus();
}

function openDevPanel() {
  const item = project();
  if (item) openDevelopment({ ...item, path: rootPath() }, tree => chooseProject(item, tree.path));
}

async function mergeBranch() {
  const item = project();
  if (!item) return;
  const args = { path: rootPath(), distro: item.distro };
  const preview = await invoke('merge_preview', args);
  const source = select(preview.branches.map(branch => [branch.name, branch.name]));
  const ui = dialog('Merge local branch', [
    el('p', { class: 'dialog-path', text: args.path }),
    el('p', { text: 'Destination branch ' + preview.branch }),
    preview.branches.length ? field('Source branch', source) : el('p', { class: 'muted', text: 'No other local branch is available.' }),
  ]);
  ui.footer.append(button('Merge branch', busy(async () => {
    const picked = preview.branches.find(branch => branch.name === source.value);
    if (!picked || mergeInFlight) return;
    if (!await confirmAction('Confirm local merge', 'Merge ' + picked.name + ' into ' + preview.branch + ' in the selected worktree?', 'Merge')) return;
    mergeInFlight = true;
    try {
      const result = await invoke('merge_execute', { ...args, expectedHead: preview.head,
        expectedBranch: preview.branch, source: picked.name, sourceOid: picked.oid });
      if (!result.changed) { ui.error('The branch is already up to date.'); return; }
      remember(appMergeNotices, mergeNoticeKey(item.distro, args.path, preview.head, result.head), 128);
      ui.close();
      celebrateShip(result);
      await refreshGit(item, args.path);
    } finally {
      mergeInFlight = false;
    }
  }, ui.error), { class: 'primary', disabled: !preview.branches.length }));
}

async function observeMerges() {
  if (mergeInFlight) return;
  const paths = new Map();
  function add(path, distro, item) { paths.set(distro + '\n' + path, { path, distro, item }); }
  for (const item of model.projects) {
    add(item.path, item.distro, item);
    for (const tree of gitInfo(item)?.worktrees || []) {
      if (!tree.missing) add(tree.path, item.distro, item);
    }
  }
  for (const session of Object.values(model.sessions)) {
    if (runtime.get(session.id)?.state !== 'ended') add(session.path, session.distro, model.projects.find(item => item.id === session.project));
  }
  if (!paths.size) return;
  const entries = [...paths];
  const selected = Array.from({ length: Math.min(entries.length, 3) }, () => entries[observationIndex++ % entries.length]);
  const started = Math.floor(Date.now() / 1000);
  await Promise.allSettled(selected.map(async ([key, { path, distro, item }]) => {
    const outcomes = await invoke('merge_observe', { path, distro, since: mergeSince.get(key) || observerStarted });
    if (mergeInFlight) return;
    mergeSince.set(key, started);
    for (const outcome of outcomes) {
      if (observedKeys.has(outcome.key)) continue;
      remember(observedKeys, outcome.key, 512);
      if (appMergeNotices.has(mergeNoticeKey(distro, path, outcome.oldHead, outcome.head))) continue;
      celebrateShip(outcome);
      if (item) refreshGit(item, path);
    }
  }));
}

function palette() {
  pickCommand('Command palette', [
    ['Open project folder', openProject], ['Clone repository', cloneProject],
    ['New blank terminal', () => newTerminal()], ['Launch Claude Code', () => newTerminal('claude')],
    ['Launch Codex', () => newTerminal('codex')], ['New PowerShell terminal', () => newTerminal('powershell')],
    ['Git worktrees', openWorktrees], ['Development status', openDevPanel], ['Merge local branch', mergeBranch], ['Environment variables', () => project() && dotenvEditor(project(), rootPath())],
    ['Workflow templates', () => openWorkflow('prompt')], ['/goal objective', () => openWorkflow('goal')],
    ['/loop task', () => openWorkflow('loop')], ['Toggle window fullscreen', fullscreen],
    ['Spotify', openSpotify], ['Replay Tux intro', playIntro], ['Settings', openSettings],
    ...model.projects.map(item => [`Project: ${item.name}`, () => chooseProject(item)]),
    ...Object.values(model.sessions).map(session => [`Terminal: ${session.title}`, () => activate(session.id)]),
    ...(project() ? (gitInfo(project())?.worktrees || []).map(tree => [
      `Worktree: ${tree.branch} ${pathName(tree.path)}`, () => chooseProject(project(), tree.path),
    ]) : []),
  ]);
}

function paintToolbar() {
  const item = project();
  const path = rootPath();
  const branch = item && gitInfo(item, path)?.branch;
  const primary = el('div', { class: 'toolbar-group' },
    button('Toggle project sidebar', () => { model.sidebar = !model.sidebar; applySidebar(); save(); },
      { icon: 'panel-left', only: true }),
    el('span', { class: 'wordmark' }, icon('terminal'), 'AgentDock'),
    el('div', { class: 'toolbar-location', title: path || '' },
      el('strong', { text: item?.name || 'Workspace' }),
      branch ? el('span', { class: 'branch' }, icon('git-branch'), branch) : null,
      model.worktree ? el('span', { class: 'branch' }, icon('git-fork'), pathName(model.worktree)) : null,
    ));
  const actions = el('div', { class: 'toolbar-group toolbar-actions' },
    button('Open', openProject, { icon: 'folder-open', title: 'Open project folder' }),
    button('Clone', cloneProject, { icon: 'git-fork', title: 'Clone repository' }),
    button('New terminal', () => newMenu(), { icon: 'plus', class: 'primary', title: 'New terminal' }),
    button('Worktrees', openWorktrees, { icon: 'git-branch', disabled: !item }),
    button('Development', openDevPanel, { icon: 'activity', only: true, disabled: !item }),
    button('Merge local branch', busy(mergeBranch), { icon: 'git-fork', only: true, disabled: !item }),
    button('.env', busy(async () => { if (item) await dotenvEditor(item, path); }),
      { icon: 'file-key-2', disabled: !item }),
    button('Workflows', busy(() => openWorkflow('prompt')), { icon: 'arrow-down-up' }),
    button('Spotify', openSpotify, { icon: 'music-2', only: true }),
    button('Command palette', palette, { icon: 'search', only: true, title: 'Command palette (Ctrl+Shift+P)' }),
    button('Settings', openSettings, { icon: 'settings-2', only: true }),
  );
  projectBar.replaceChildren(primary, actions);
}

function applySidebar() { sidebar.hidden = !model.sidebar; }

function paintSidebar() {
  const list = el('div', { class: 'project-list' });
  const head = el('div', { class: 'sidebar-heading' }, el('h1', { text: 'Projects' }),
    button('Open folder', openProject, { icon: 'folder-open', only: true }),
    button('Clone repository', cloneProject, { icon: 'git-fork', only: true }),
    button('New terminal', () => newMenu(), { icon: 'plus', only: true }));
  for (const item of model.projects) {
    const selected = item.id === model.project;
    const expanded = !collapsed.has(item.id);
    const section = el('section', { class: `project-group${selected ? ' selected' : ''}` });
    section.style.setProperty('--project-color', safeColor(item.color));
    const selectButton = button(item.name, () => chooseProject(item), { class: 'project-name', title: item.path });
    selectButton.setAttribute('aria-pressed', String(selected && !model.worktree));
    const toggle = button(`${expanded ? 'Collapse' : 'Expand'} ${item.name}`, () => {
      if (expanded) collapsed.add(item.id);
      else { collapsed.delete(item.id); refreshGit(item); }
      paintSidebar();
    }, { only: true, icon: expanded ? 'chevron-down' : 'chevron-right' });
    toggle.setAttribute('aria-expanded', String(expanded));
    section.append(el('div', { class: 'project-heading' }, toggle, selectButton,
      button(`Edit ${item.name}`, () => editItem(item, 'project'), { icon: 'ellipsis', only: true })));
    if (expanded) {
      const sub = el('div', { class: 'project-content' });
      const branches = gitInfo(item)?.worktrees || [];
      for (const tree of branches) {
        if (tree.path.toLowerCase() === item.path.toLowerCase()) continue;
        sub.append(button(tree.branch || pathName(tree.path), () => chooseProject(item, tree.path), {
          class: selected && model.worktree === tree.path ? 'worktree-link chosen' : 'worktree-link',
          icon: 'git-branch', disabled: tree.missing, title: tree.path,
        }));
      }
      for (const session of Object.values(model.sessions).filter(value => value.project === item.id)) {
        const [label, tone] = currentStatus(session);
        const activity = el('span', { class: `session-status ${tone}`, data: { statusId: session.id }, text: label });
        const text = el('span', { class: 'session-caption' }, el('span', { text: session.title }),
          session.role ? el('small', { text: session.role }) : null);
        const entry = el('button', { type: 'button', title: session.path, class: `session-link${focused === session.id ? ' chosen' : ''}`,
          onClick: () => activate(session.id), data: { terminalId: session.id } },
          icon('terminal'), text, activity);
        entry.style.setProperty('--session-color', safeColor(session.color));
        sub.append(entry);
      }
      if (selected) {
        sub.append(el('div', { class: 'quick-actions', 'aria-label': 'Launch in this project' },
          button('Claude', busy(() => newTerminal('claude')), { title: 'Launch Claude Code in this project' }),
          button('Codex', busy(() => newTerminal('codex')), { title: 'Launch Codex in this project' }),
          button('Shell', busy(() => newTerminal()), { title: 'New Ubuntu shell in this project' })));
      }
      section.append(sub);
    }
    list.append(section);
  }
  if (model.projects.length === 0) {
    list.append(el('p', { class: 'sidebar-empty', text: 'Open an existing Windows or Ubuntu folder.' }));
  }
  sidebar.replaceChildren(head, list);
}

function paintTabs() {
  tabbar.replaceChildren(...model.tabs.map(tab => {
    const ids = leaves(tab.tree);
    const first = model.sessions[ids[0]];
    const label = first ? first.title + (ids.length > 1 ? ` +${ids.length - 1}` : '') : 'Terminal';
    const tabButton = button(label, () => {
      const next = ids.includes(focused) ? focused : ids[0];
      if (next) activate(next);
    }, { icon: 'terminal', class: `tab${tab.id === model.active ? ' chosen' : ''}`, title: label,
      data: { tabId: tab.id } });
    tabButton.draggable = true;
    tabButton.setAttribute('aria-current', tab.id === model.active ? 'page' : 'false');
    tabButton.addEventListener('dragstart', event => event.dataTransfer.setData('application/x-agentdock-tab', tab.id));
    tabButton.addEventListener('dragover', event => event.preventDefault());
    tabButton.addEventListener('drop', event => {
      event.preventDefault();
      const source = event.dataTransfer.getData('application/x-agentdock-tab');
      const drag = event.dataTransfer.getData('application/x-agentdock-pane');
      if (source && source !== tab.id) {
        const from = model.tabs.findIndex(item => item.id === source);
        const to = model.tabs.findIndex(item => item.id === tab.id);
        if (from >= 0 && to >= 0) {
          const [moved] = model.tabs.splice(from, 1);
          model.tabs.splice(to, 0, moved);
        }
      } else if (drag && model.sessions[drag] && !ids.includes(drag)) {
        removeTerminal(model, drag);
        const destination = model.tabs.find(item => item.id === tab.id);
        destination.tree = splitLeaf(destination.tree, ids[0], drag, 'columns');
        model.active = destination.id;
        focused = drag;
      }
      render();
      save();
    });
    return tabButton;
  }), button('New terminal', () => newMenu(), { icon: 'plus', only: true }));
}

function addDivider(handle, group, node) {
  function ratio(next) {
    node.ratio = Math.min(0.87, Math.max(0.13, next));
    group.style.setProperty('--split', String(node.ratio));
    handle.setAttribute('aria-valuenow', String(Math.round(100 * node.ratio)));
  }
  handle.addEventListener('pointerdown', event => {
    handle.setPointerCapture(event.pointerId);
    handle.focus();
  });
  handle.addEventListener('pointermove', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const bounds = group.getBoundingClientRect();
    ratio(node.axis === 'columns' ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height);
  });
  handle.addEventListener('lostpointercapture', save);
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    ratio(node.ratio + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.04 : 0.04));
    save();
  });
  ratio(node.ratio || 0.5);
}

function buildLayout(tree, mounts) {
  if (!tree.id) {
    const divider = el('div', {
      class: 'divider', role: 'separator', tabindex: '0', 'aria-label': 'Resize split',
      'aria-orientation': tree.axis === 'columns' ? 'vertical' : 'horizontal',
      'aria-valuemin': '13', 'aria-valuemax': '87',
    });
    const group = el('div', { class: `split ${tree.axis}` },
      buildLayout(tree.first, mounts), divider, buildLayout(tree.second, mounts));
    addDivider(divider, group, tree);
    return group;
  }
  const session = model.sessions[tree.id];
  if (!session) return el('div', { class: 'empty-terminal' });
  const [label, tone] = currentStatus(session);
  const activity = el('span', { class: `session-status ${tone}`, text: label, data: { statusId: session.id } });
  paneLabels.set(session.id, activity);
  const caption = el('button', {
    type: 'button', class: 'pane-caption', draggable: 'true',
    title: `${profileName(session.profile)} • ${session.path}`, onClick: () => view.get(session.id)?.focus(),
  }, icon('terminal'), el('strong', { text: session.title }), session.role ? el('span', { text: session.role }) : null);
  caption.addEventListener('dragstart', event => event.dataTransfer.setData('application/x-agentdock-pane', session.id));
  const content = el('div', { class: 'pane-body' }, el('div', { class: 'terminal-feedback', text: 'Loading terminal…' }));
  const frame = el('section', {
    class: `pane${focused === session.id ? ' active' : ''}`, data: { session: session.id }, 'aria-label': session.title,
    onPointerdown: () => focusPane(session.id), onFocusin: () => focusPane(session.id),
  }, el('header', { class: 'pane-heading' }, caption, activity,
    button('Find in terminal', () => view.get(session.id)?.find(), { icon: 'search', only: true }),
    button('Split terminal', () => newMenu(session), { icon: 'split', only: true }),
    button(maximized === session.id ? 'Restore pane' : 'Maximize pane', () => {
      maximized = maximized === session.id ? null : session.id;
      renderStage();
    }, { icon: maximized === session.id ? 'minimize' : 'maximize', only: true }),
    button('Terminal actions', () => terminalMenu(session), { icon: 'ellipsis', only: true })), content);
  frame.style.setProperty('--session-color', safeColor(session.color));
  frame.addEventListener('dragover', event => event.preventDefault());
  frame.addEventListener('drop', event => {
    event.preventDefault();
    const source = event.dataTransfer.getData('application/x-agentdock-pane');
    if (source && source !== session.id && model.sessions[source]) {
      model.tabs = exchangeLeaves(model.tabs, source, session.id);
      focused = source;
      render();
      save();
    }
  });
  mounts.set(session.id, content);
  return frame;
}

function hideView(id, terminal, forget = false) {
  const keeping = terminal.session.profile === 'powershell' && !forget;
  const pending = terminal.conceal();
  if (!keeping) view.delete(id);
  mark(id, 'detached');
  hiding.set(id, pending);
  pending.finally(() => {
    if (!keeping) terminal.dispose();
    if (hiding.get(id) === pending) hiding.delete(id);
  });
}

async function retryTerminal(id) {
  const terminal = view.get(id);
  if (terminal) hideView(id, terminal);
  await hiding.get(id);
  renderStage();
}

async function mountViews(mounts, revision) {
  if (!mounts.size) return;
  const { TerminalView } = await import('./terminal-view.js');
  if (revision !== renderRevision) return;
  for (const [id, target] of mounts) {
    if (hiding.has(id)) await hiding.get(id);
    if (revision !== renderRevision || !target.isConnected) return;
    const session = model.sessions[id];
    if (!session) continue;
    let terminal = view.get(id);
    if (!terminal) {
      terminal = new TerminalView(session, model.settings, mark);
      view.set(id, terminal);
    }
    target.replaceChildren();
    terminal.mount(target, waiters.get(id));
  }
}

function renderStage() {
  const revision = ++renderRevision;
  const mounts = new Map();
  const tab = activeTab();
  paneLabels.clear();
  if (tab) {
    const ids = leaves(tab.tree);
    if (!ids.includes(focused)) focused = ids[0];
    if (!ids.includes(maximized)) maximized = null;
    stage.replaceChildren(buildLayout(maximized ? { id: maximized } : tab.tree, mounts));
  } else {
    const item = project();
    const empty = el('div', { class: 'empty-workspace' }, icon('terminal'),
      el('h2', { text: item ? item.name : 'Open a project' }),
      el('p', { class: 'muted', text: item ? rootPath() : 'Start with an existing folder or clone a repository.' }),
      el('div', { class: 'empty-actions' }, item
        ? [button('New terminal', () => newMenu(), { icon: 'plus', class: 'primary' }),
          button('Claude Code', busy(() => newTerminal('claude'))), button('Codex', busy(() => newTerminal('codex')))]
        : [button('Open folder', openProject, { icon: 'folder-open', class: 'primary' }),
          button('Clone repository', cloneProject, { icon: 'git-fork' })]));
    stage.replaceChildren(empty);
  }
  if (minimized) mounts.clear();
  for (const [id, terminal] of view) {
    if (!mounts.has(id) && (terminal.mounted || !model.sessions[id])) hideView(id, terminal, !model.sessions[id]);
  }
  mountViews(mounts, revision).catch(reportError);
}

function paintStats() {
  const values = [
    ['Windows RAM', sample ? `${formatBytes(sample.used)} / ${formatBytes(sample.total)}` : '—'],
    ['Available', formatBytes(sample?.available)],
    ['CPU', sample && Number.isFinite(sample.cpu) ? `${sample.cpu.toFixed(0)}%` : '—'],
    ['WSL', formatBytes(sample?.windowsSubsystem)],
    ['AgentDock', Number.isFinite(sample?.agentDockPrivate)
      ? formatBytes(sample.agentDockPrivate) + ' private / ' + formatBytes(sample.agentDock) + ' summed'
      : formatBytes(sample?.agentDock)],
    ['Sessions', String([...health.values()].filter(state => state.running && model.sessions[state.id]).length)],
  ];
  statusBar.replaceChildren(...values.map(([name, value]) =>
    el('span', { class: 'reading' }, name, el('strong', { text: value }))));
}

function render() {
  applySidebar();
  paintToolbar();
  paintTabs();
  renderStage();
  paintSidebar();
  paintStats();
}

function cycleTab(direction) {
  if (!model.tabs.length) return;
  const index = model.tabs.findIndex(tab => tab.id === model.active);
  const next = model.tabs[(index + direction + model.tabs.length) % model.tabs.length];
  const first = leaves(next.tree)[0];
  if (first) activate(first);
}

function shortcuts(event) {
  if (event.repeat || $('dialog[open]')) return;
  const key = event.key.toLowerCase();
  let action;
  if (event.ctrlKey && event.shiftKey) {
    const common = {
      p: palette, t: () => newTerminal(), o: openProject, f: () => view.get(focused)?.find(),
      c: event.altKey ? () => newTerminal('claude') : null,
      k: () => newTerminal('codex'), w: openWorktrees, e: () => openWorkflow('prompt'),
      b: () => { model.sidebar = !model.sidebar; applySidebar(); save(); },
      '|': () => newTerminal('blank', 'columns'), '_': () => newTerminal('blank', 'rows'),
    };
    action = common[key];
  }
  if (event.ctrlKey && key === 'tab') action = () => cycleTab(event.shiftKey ? -1 : 1);
  if (key === 'f11') action = fullscreen;
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve().then(action).catch(reportError);
  }
}

async function closeRequested(event) {
  if (closed) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  try {
    await Promise.allSettled(waiters.values());
    const count = await invoke('terminal_active_powershell');
    if (count && !await confirmAction('Close AgentDock',
      `Closing ends ${count} active PowerShell ${count === 1 ? 'terminal' : 'terminals'}. Ubuntu sessions will detach.`,
      'Close AgentDock')) return;
    await saved.catch(() => save());
    closed = true;
    await desktop.close();
  } catch (error) {
    closed = false;
    reportError(error);
  } finally {
    closing = false;
  }
}

async function tick() {
  try {
    const nowMinimized = await desktop.isMinimized();
    if (nowMinimized !== minimized) {
      minimized = nowMinimized;
      renderStage();
    }
    if (!minimized) {
      const item = project();
      if (item && Date.now() - gitRefreshTime > 16000) {
        gitRefreshTime = Date.now();
        refreshGit(item);
        if (model.worktree) refreshGit(item, model.worktree);
      }
      const results = await Promise.allSettled([
        invoke('stats_sample').then(value => { sample = value; paintStats(); }),
        refreshHealth(),
        observeMerges(),
      ]);
      if (!sample && results[0].status === 'rejected') paintStats();
    }
  } finally {
    if (!closed) setTimeout(tick, minimized ? 6500 : 4000);
  }
}

async function init() {
  render();
  const [workspaceResult, distroResult] = await Promise.allSettled([
    invoke('workspace_load'),
    invoke('host_distros'),
  ]);
  if (workspaceResult.status === 'fulfilled') model = initialModel(workspaceResult.value);
  else reportError(workspaceResult.reason);
  if (distroResult.status === 'fulfilled') distros = distroResult.value;
  const item = project();
  render();
  if (model.settings.intro !== false) playIntro();
  if (item) {
    refreshGit(item);
    if (model.worktree) refreshGit(item, model.worktree);
  }
  document.addEventListener('keydown', shortcuts, { capture: true });
  desktop.onCloseRequested(closeRequested).catch(reportError);
  window.addEventListener('focus', () => {
    if (minimized) desktop.isMinimized().then(isMinimized => {
      if (!isMinimized && minimized) {
        minimized = false;
        renderStage();
      }
    }).catch(() => {});
    const item = project();
    if (item) refreshGit(item, rootPath());
  });
  tick().catch(reportError);
}

const ready = init().catch(reportError);
