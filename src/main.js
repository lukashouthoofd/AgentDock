import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { dotenvEditor, workflowEditor } from './editors.js';
import { agentProvider, arrangeTerminal, initialModel, launchCommand, leaves, formatBytes, pinnedProjects, projectTabs,
  removeTerminal, restoreLayout, splitLeaf, tabProject, terminalSpec as specFor, tmuxKey, tmuxPane, tmuxProject, usesTmux, validConversation } from './model.js';
import { playIntro } from './intro.js';
import { openDevelopment } from './dev-status.js';
import { celebrateShip } from './ship-celebration.js';
import { openSpotify } from './spotify.js';
import { openPromptStudio } from './prompt-studio.js';
import { createSessionsView } from './session-view.js';
import { ariaShortcut, createKeymap, moveListFocus, PASSTHROUGH_EXIT, SHORTCUTS, shortcutContext,
  shortcutLabel, validateKeybindings } from './keyboard.js';
import { $, busy, button, confirmAction, dialog, el, field, icon, input, pathName, replaceControls, reportError, safeColor, select } from './ui.js';
import './style.css';

const view = new Map();
const waiters = new Map();
const hiding = new Map();
const transportRetries = new Set();
const launchFailures = new Map();
const closingTerminals = new Set();
const worktreeInfo = new Map();
const projectExpansion = new Map();
const runtime = new Map();
const health = new Map();
const tmuxInventory = new Map();
const discovering = new Map();
const paneLabels = new Map();
const attention = new Map();
const tmuxBells = new Map();
const seenQuiet = new Map();
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
const workbench = el('div', { class: 'workbench' }, sidebar, workspace);
app.append(projectBar, workbench, statusBar, notice);

let model = initialModel();
let keymap = createKeymap();
let passthrough = false;
let distros = [];
let focused = null;
let focusAfterMount = null;
let maximized = null;
let minimized = false;
let renderRevision = 0;
let saved = Promise.resolve();
let closed = false;
let closing = false;
let sample;
let healthFlight;
let visibleSessionsKey;
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
const activeTab = () => projectTabs(model).find(item => item.id === model.active);
const activeSession = () => model.sessions[focused];
const rootPath = () => model.worktree || project()?.path;
const profileName = profile => profile === 'ubuntu' ? 'Ubuntu' : 'PowerShell';
const launchNames = { blank: 'Blank terminal', claude: 'Claude Code', codex: 'Codex',
  agy: 'Antigravity (Windows)', powershell: 'PowerShell', 'native-powershell': 'PowerShell (native compatibility)' };
const paneDrag = 'application/x-agentdock-pane';
const tabDrag = 'application/x-agentdock-tab';
let draggedTerminal;
let dropTarget;

function clearDropTarget() {
  if (dropTarget) delete dropTarget.dataset.dropPosition;
  dropTarget = null;
}

function draggableTerminal(element, id) {
  element.draggable = true;
  element.addEventListener('dragstart', event => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(paneDrag, id);
    draggedTerminal = id;
  });
  element.addEventListener('dragend', () => {
    if (!draggedTerminal) return;
    draggedTerminal = null;
    clearDropTarget();
    paintSidebar();
  });
}

function paneDropPosition(event, frame) {
  const box = frame.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width;
  const y = (event.clientY - box.top) / box.height;
  const [position, distance] = [['left', x], ['right', 1 - x], ['above', y], ['below', 1 - y]]
    .reduce((nearest, edge) => edge[1] < nearest[1] ? edge : nearest);
  return distance < 0.27 ? position : 'center';
}

function moveTerminal(source, target, position) {
  const destination = arrangeTerminal(model, source, target, position);
  if (!destination) return;
  maximized = null;
  activate(source);
}

function save() {
  const snapshot = structuredClone({ ...model, focused, maximized });
  saved = saved.catch(() => {}).then(() => invoke('workspace_save', { model: snapshot }));
  saved.catch(reportError);
  return saved;
}

function projectDistro() {
  return model.settings.distro || distros.find(name => /^ubuntu/i.test(name)) || project()?.distro
    || model.projects.find(item => /^ubuntu/i.test(item.distro))?.distro || distros[0] || 'Ubuntu';
}

const sessionRail = createSessionsView({
  activate: id => openSession(id),
  dock: (id, axis) => openSession(id, axis),
  hide: detach,
  terminate: id => model.sessions[id] ? closeTerminal(model.sessions[id]) : closeExternal(id),
  manage: id => manageTmuxPanes(model.sessions[id] || id),
  resume: id => model.sessions[id] && resumeAgent(model.sessions[id]),
  close: () => toggleSessions(false),
  saveLayout: saveCurrentLayout,
  restoreLayout: applyLayout,
  deleteLayout: id => {
    model.layouts = model.layouts.filter(layout => layout.id !== id);
    paintSessions();
    return save();
  },
  acknowledge: acknowledgeAttention,
  settings: id => model.sessions[id] && editItem(model.sessions[id], 'terminal'),
  pin: (id, value) => {
    const session = model.sessions[id];
    if (!session) return;
    session.pinned = value;
    paintSessions();
    return save();
  },
});
workbench.append(sessionRail.element);

function toggleSessions(show = !model.sessionsVisible) {
  model.sessionsVisible = show;
  paintSessions();
  tabbar.querySelector('.sessions-toggle')?.setAttribute('aria-pressed', String(show));
  save();
  if (show) sessionRail.focus();
}

function paintSessions() {
  sessionRail.element.hidden = !model.sessionsVisible;
  if (sessionRail.element.hidden) return;
  const inLayout = new Set(model.tabs.flatMap(tab => leaves(tab.tree)));
  const visible = minimized ? [] : maximized ? [maximized] : leaves(activeTab()?.tree);
  const rows = Object.values(model.sessions).map(session => {
    const item = model.projects.find(project => project.id === session.project);
    const [label, tone] = currentStatus(session);
    const info = health.get(session.id);
    const alert = attention.get(session.id);
    return {
      id: session.id, title: session.title, role: session.role, color: session.color,
      project: item?.name, projectId: session.project, path: session.path,
      distro: usesTmux(session) ? session.distro : 'Windows', kind: agentProvider(session) || session.kind, label, tone,
      lastOutput: Math.max(info?.lastActivity || 0, info?.lastOutput || 0, runtime.get(session.id)?.last || 0),
      quietSince: alert?.kind === 'quiet' ? alert.since : null,
      attention: alert?.kind === 'bell' ? 'Terminal bell' : alert ? 'Quiet-watch threshold reached' : null,
      running: sessionRunning(session),
      starting: runtime.get(session.id)?.state === 'starting',
      canResume: Boolean(agentProvider(session)), tmux: Boolean(tmuxRecord(session)),
      inLayout: inLayout.has(session.id), visible: visible.includes(session.id), pinned: session.pinned,
    };
  });
  const external = externalSessions().map(snapshot => {
    const { cwd } = tmuxPane(snapshot) || {};
    const item = projectForTmux(snapshot);
    const running = snapshot.panes.some(pane => !pane.dead);
    return {
      id: tmuxKey(snapshot.identity), title: snapshot.name, role: paneCount(snapshot),
      project: item?.name, projectId: item?.id, path: cwd,
      distro: snapshot.identity.distro, workspace: 'tmux', external: true, tmux: true,
      lastOutput: Math.max(0, ...snapshot.panes.map(pane => (pane.windowActivity || 0) * 1000)),
      running, tone: running ? 'ok' : 'quiet', label: running ? (snapshot.attached ? 'Attached' : 'Detached') : 'Exited',
    };
  });
  sessionRail.update(rows.concat(external), focused, { project: project(), presets: model.layouts });
}

function saveCurrentLayout(name) {
  const existing = model.layouts.find(layout => layout.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!existing && model.layouts.length >= 32) throw new Error('Delete a saved layout before adding another.');
  const layout = {
    id: existing?.id || crypto.randomUUID(), name, tabs: structuredClone(model.tabs),
    project: model.project, worktree: model.worktree, sidebar: model.sidebar,
    active: model.active, focused, maximized,
  };
  model.layouts = [...model.layouts.filter(item => item.id !== layout.id), layout];
  paintSessions();
  return save();
}

function applyLayout(id) {
  const layout = model.layouts.find(item => item.id === id);
  if (!layout) return false;
  ({ focused, maximized } = restoreLayout(model, layout));
  const restored = model.tabs.find(tab => tab.id === model.active);
  selectProject(restored ? tabProject(model, restored) : layout.project);
  selectTerminalPath(focused);
  if (!restored) model.worktree = layout.worktree;
  render();
  return save();
}

function markAttention(id, kind, since = Date.now()) {
  if (attention.get(id)?.kind === kind) return;
  attention.set(id, { kind, since });
  paintStatus(id);
  paintSessions();
  if (!document.hasFocus()) desktop.requestUserAttention(UserAttentionType.Informational).catch(() => {});
  if (model.settings.attentionPing) invoke('terminal_attention_ping').catch(() => {});
}

function acknowledgeAttention(id) {
  const alert = attention.get(id);
  if (alert?.kind === 'quiet') seenQuiet.set(id, alert.since);
  attention.delete(id);
  paintStatus(id);
  paintSessions();
}

function currentStatus(session) {
  const local = runtime.get(session.id);
  const observed = health.get(session.id);
  if (closingTerminals.has(session.id)) return ['Closing', 'cool'];
  if (local?.state === 'starting') return ['Starting', 'cool'];
  if (observed?.missing && !launchFailures.has(session.id)) return ['Session ended', 'quiet'];
  if (!observed?.running && observed?.exitCode != null) return observed.exitCode === 0
    ? ['Exited', 'quiet'] : [`Exit ${observed.exitCode}`, 'bad'];
  if (local?.state === 'unavailable') return ['Unavailable', 'bad'];
  if (local?.state === 'ended') return ['Exited', 'quiet'];
  if (observed?.running && (local?.state === 'detached' || !observed.attached)) return ['Detached', 'quiet'];
  if ((observed?.running || local?.state === 'attached') &&
    Date.now() - Math.max(observed?.lastOutput || 0, local?.last || 0) < 8000) return ['Output', 'ok'];
  if (observed?.running || local?.state === 'attached') return ['Quiet', 'quiet'];
  return [usesTmux(session) ? 'Detached' : 'Exited', 'quiet'];
}

function sessionRunning(session) {
  const local = runtime.get(session.id)?.state;
  const observed = health.get(session.id);
  if (usesTmux(session) && !observed?.tmuxConfirmed && !observed?.missing) return local === 'attached';
  if (!usesTmux(session) && local === 'ended') return false;
  return observed?.running ?? local === 'attached';
}

function sessionVisible(session) {
  if (!session) return false;
  const local = runtime.get(session.id);
  if (sessionRunning(session) || local?.state === 'starting') return true;
  const observed = health.get(session.id);
  return usesTmux(session) && local?.hasConnected === true && !observed?.tmuxConfirmed && !observed?.missing;
}

function sessionExited(session) {
  const observed = health.get(session.id);
  if (usesTmux(session)) return observed?.missing === true || (observed?.tmuxConfirmed === true && !observed.running);
  return runtime.get(session.id)?.state === 'ended' || observed?.running === false;
}

function visibleTabs() {
  return projectTabs(model).filter(tab =>
    tab.id === model.active || leaves(tab.tree).some(id => sessionVisible(model.sessions[id])));
}

function updateSessionLists() {
  const key = Object.values(model.sessions).filter(sessionVisible).map(session => session.id).join();
  if (key === visibleSessionsKey) return;
  visibleSessionsKey = key;
  paintSidebar();
  paintTabs();
}

function mark(id, state, message) {
  const session = model.sessions[id];
  if (!session) return;
  const previous = runtime.get(id) || {};
  if (state === 'detached' && previous.state === 'ended' && !usesTmux(session)) return;
  if (state === 'bell') {
    if (!usesTmux(session)) markAttention(id, 'bell');
  } else if (state === 'output') {
    runtime.set(id, { ...previous, last: Date.now() });
    if (!usesTmux(session) && attention.get(id)?.kind === 'quiet') acknowledgeAttention(id);
    if (Date.now() - (previous.last || 0) > 7500) paintStatus(id);
  } else {
    runtime.set(id, { ...previous, state, message, hasConnected: state === 'attached' || previous.hasConnected });
    updateSessionLists();
    paintStatus(id);
    if (state === 'attached') applyTerminalFocus(id);
  }
}

function applyTerminalFocus(id) {
  const terminal = view.get(id);
  if (focusAfterMount !== id || focused !== id || !terminal?.connected || !terminal.root.isConnected) return;
  focusAfterMount = null;
  if (!$('dialog[open]')) terminal.focus();
}

function paintStatus(id) {
  const session = model.sessions[id];
  if (!session) return;
  const [label, tone] = currentStatus(session);
  const status = attention.get(id)?.kind;
  for (const element of [paneLabels.get(id), ...sidebar.querySelectorAll('[data-status-id]')]) {
    if (!element || element.dataset.statusId !== id) continue;
    element.textContent = status === 'bell' ? 'Bell' : label;
    element.className = `session-status ${status === 'bell' ? 'bad' : tone}`;
    element.title = runtime.get(id)?.message || label;
    if (status) element.parentElement.dataset.alert = status;
    else delete element.parentElement.dataset.alert;
  }
  const pane = stage.querySelector(`[data-session="${CSS.escape(id)}"]`);
  if (pane && status) pane.dataset.alert = status;
  else if (pane) delete pane.dataset.alert;
}

function refreshHealth() {
  return healthFlight ??= readHealth().finally(() => { healthFlight = undefined; });
}

function recoverTmuxTransport(session, observed) {
  if (observed?.tmuxClients > 0) {
    transportRetries.delete(session.id);
    return;
  }
  const terminal = view.get(session.id);
  if (!observed?.running || observed.tmuxClients !== 0 || !terminal?.transportStarted
    || Date.now() - terminal.transportStarted < 10000 || closingTerminals.has(session.id)) return;
  if (transportRetries.has(session.id)) {
    if (terminal.connected) {
      terminal.connected = false;
      terminal.showFeedback('tmux is running. Reconnect to restore its terminal view.', 'retry');
      mark(session.id, 'unavailable');
    }
    return;
  }
  transportRetries.add(session.id);
  retryTerminal(session.id, false).catch(reportError);
}

function tmuxRecord(session) {
  return session?.tmux && tmuxInventory.get(tmuxKey(session.tmux));
}

function externalSessions() {
  const owned = new Set(Object.values(model.sessions).map(session => tmuxKey(session.tmux)).filter(Boolean));
  return [...tmuxInventory].filter(([key]) => !owned.has(key)).map(([, snapshot]) => snapshot);
}

function projectForTmux(snapshot) {
  const distro = snapshot.identity.distro;
  const cwd = tmuxPane(snapshot)?.cwd;
  if (!cwd) return undefined;
  const roots = model.projects.flatMap(item => (gitInfo(item)?.worktrees || []).map(tree =>
    ({ ...item, path: tree.path })));
  const matched = tmuxProject([...model.projects, ...roots], distro, cwd);
  return matched && model.projects.find(item => item.id === matched.id);
}

function paneCount(snapshot) {
  const count = snapshot.panes.length;
  return `${count} ${count === 1 ? 'pane' : 'panes'}`;
}

async function readHealth() {
  const tracked = Object.values(model.sessions);
  const requested = [...new Set([projectDistro(), ...distros.filter(name => /^ubuntu/i.test(name)),
    ...model.projects.map(item => item.distro), ...tracked.filter(usesTmux).map(session => session.distro)]
    .filter(name => name && !/^docker-desktop(?:-data)?$/i.test(name)))];
  const result = await invoke('terminal_inventory', { distros: requested, tracked: tracked.map(session => specFor(session)) });
  const complete = new Set(result.completeDistros);
  for (const [key, snapshot] of tmuxInventory) {
    if (complete.has(snapshot.identity.distro)) tmuxInventory.delete(key);
  }
  for (const snapshot of result.tmux) tmuxInventory.set(tmuxKey(snapshot.identity), snapshot);
  let acquiredIdentity = false;
  for (const session of tracked) {
    if (!usesTmux(session) || session.tmux || model.sessions[session.id] !== session) continue;
    const snapshot = result.tmux.find(item => item.identity.distro === session.distro
      && item.managed && item.name === `ad-${session.id}`);
    if (snapshot) {
      session.tmux = snapshot.identity;
      acquiredIdentity = true;
    }
  }
  if (acquiredIdentity) save();
  const records = new Map(result.terminals.map(item => [item.id, item]));
  let visibilityChanged = false;
  for (const session of Object.values(model.sessions)) {
    const observed = records.get(session.id);
    const previous = health.get(session.id);
    if (observed?.tmuxConfirmed || observed?.missing || !usesTmux(session) || !previous?.tmuxConfirmed) {
      if (observed) health.set(session.id, observed);
      else if (!usesTmux(session)) health.delete(session.id);
    }
    const info = health.get(session.id);
    recoverTmuxTransport(session, observed);
    if (!waiters.has(session.id) && !launchFailures.has(session.id)
      && Boolean(info?.missing) !== Boolean(previous?.missing)
      && leaves(activeTab()?.tree).includes(session.id)) visibilityChanged = true;
    const previousBell = tmuxBells.get(session.id) || 0;
    const bell = info?.bellCount || (info?.bell ? -1 : 0);
    if (bell && bell !== previousBell) markAttention(session.id, 'bell');
    if (info) tmuxBells.set(session.id, bell);
    const minutes = session.quietWatch;
    const last = Math.max(info?.lastActivity || 0, info?.lastOutput || 0, runtime.get(session.id)?.last || 0);
    if (attention.get(session.id)?.kind === 'quiet' && last > attention.get(session.id).since) {
      acknowledgeAttention(session.id);
    }
    if (minutes && last && info?.running && !attention.has(session.id)
      && seenQuiet.get(session.id) !== last && Date.now() - last >= minutes * 60000) {
      markAttention(session.id, 'quiet', last);
    }
    paintStatus(session.id);
  }
  updateSessionLists();
  if (visibilityChanged) renderStage();
  paintSessions();
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
  paintSessions();
}

function gitInfo(item, path = item.path) { return worktreeInfo.get(`${item.id}\n${path}`); }

function selectProject(id) {
  if (model.project !== id) projectExpansion.clear();
  model.project = id;
}

function selectTerminalPath(id) {
  const item = project();
  const session = model.sessions[id];
  model.worktree = item && session?.project === item.id && session.path !== item.path ? session.path : null;
}

function selectTab(tab, id) {
  selectProject(tabProject(model, tab));
  if (maximized !== id) maximized = null;
  model.active = tab.id;
  const item = project();
  if (item) item.lastTab = tab.id;
  focused = focusAfterMount = id;
  selectTerminalPath(id);
}

function chooseProject(item, path = null) {
  const sameProject = model.project === item.id;
  selectProject(item.id);
  model.recent = [item.id, ...model.recent.filter(id => id !== item.id)].slice(0, 36);
  model.worktree = path && path !== item.path ? path : null;
  projectExpansion.delete(item.id);
  const tabs = projectTabs(model);
  const preferred = tabs.find(tab => tab.id === (sameProject ? model.active : item.lastTab));
  const match = tab => leaves(tab?.tree).filter(id => {
    const session = model.sessions[id];
    return sessionVisible(session) && (!path || (session.project === item.id && session.path === path));
  });
  const fromPreferred = match(preferred);
  const matchTab = fromPreferred.length ? preferred : tabs.findLast(tab => match(tab).length);
  const candidates = match(matchTab);
  const candidate = candidates.includes(focused) ? focused : candidates[0];
  if (candidate) {
    selectTab(matchTab, candidate);
    model.worktree = path && path !== item.path ? path : null;
  } else {
    model.active = null;
    focused = focusAfterMount = maximized = null;
  }
  render();
  save();
  refreshGit(item);
  if (path && path !== item.path) refreshGit(item, path);
}

function activate(id) {
  const session = model.sessions[id];
  if (!session) return;
  let tab = model.tabs.find(item => leaves(item.tree).includes(id));
  if (!tab) {
    tab = { id: crypto.randomUUID(), project: session.project, tree: { id } };
    model.tabs.push(tab);
  }
  selectTab(tab, id);
  render();
  save();
}

function focusPane(id) {
  if (focused === id) return;
  focused = id;
  selectTerminalPath(id);
  paintToolbar();
  paintSidebar();
  paintSessions();
  for (const pane of stage.querySelectorAll('.pane')) pane.classList.toggle('active', pane.dataset.session === id);
  save();
}

function makeTab(id, projectId) {
  const tab = { id: crypto.randomUUID(), project: projectId, tree: { id } };
  model.tabs.push(tab);
  return tab;
}

async function newTerminal(kind = 'blank', { axis, item = project(), path = item?.path, anchor = focused, resume } = {}) {
  if (closing) return;
  if (!item) { await openProject(); return; }
  if (Object.keys(model.sessions).length >= 64) {
    throw new Error('Close an unused terminal from Sessions. Select All sessions to find previous terminals.');
  }
  const profile = ['powershell', 'native-powershell', 'agy'].includes(kind) ? 'powershell' : 'ubuntu';
  const id = crypto.randomUUID();
  const session = {
    id, project: item.id, path: path || item.path, distro: item.distro, kind, profile,
    backend: kind === 'native-powershell' ? 'native' : 'tmux',
    title: resume?.title || (kind === 'blank' ? `${profileName(profile)} ${1 + Object.values(model.sessions).filter(term => term.project === item.id && term.kind === 'blank').length}` : launchNames[kind]),
    role: resume?.role || '', color: resume?.color || item.color,
    agentResumeId: resume ? resume.agentResumeId : kind === 'claude' && model.settings.claude.trim() === 'claude' ? id : undefined,
    resumeLaunch: resume ? true : undefined,
  };
  const launcher = launcherFor(session);
  const splitTab = axis && leaves(activeTab()?.tree).includes(anchor) ? activeTab() : null;
  const tab = splitTab || makeTab(session.id, item.id);
  if (splitTab) tab.tree = splitLeaf(tab.tree, anchor, session.id, axis);
  model.sessions[session.id] = session;
  maximized = null;
  selectTab(tab, session.id);
  const starting = startTerminal(session, launcher);
  render();
  await starting;
}

function launcherFor(session) {
  return launchCommand(session.kind, model.settings, { id: session.agentResumeId, resume: session.resumeLaunch });
}

function startTerminal(session, launcher) {
  mark(session.id, 'starting');
  const starting = save().then(() => invoke('terminal_create', {
    spec: specFor(session, launcher), cols: 100, rows: 30,
  }));
  waiters.set(session.id, starting);
  starting.then(() => launchFailures.delete(session.id), error => {
    launchFailures.set(session.id, String(error));
    mark(session.id, 'unavailable', String(error));
  })
    .finally(() => { waiters.delete(session.id); });
  return starting;
}

function detach(id) {
  if (closingTerminals.has(id)) return;
  removeTerminal(model, id);
  if (focused === id) focused = null;
  if (maximized === id) maximized = null;
  mark(id, 'detached');
  render();
  save();
}

async function closeTerminal(session) {
  const { id } = session;
  if (!model.sessions[id] || closingTerminals.has(id)) return;
  closingTerminals.add(id);
  try {
    if (!sessionExited(session) && !await confirmAction('Close terminal',
      `Close “${session.title}” and end its processes?`, 'Close terminal')) return;
    paintStatus(id);
    await Promise.allSettled([waiters.get(id), hiding.get(id)]);
    if (!health.get(id)?.missing || launchFailures.has(id)) {
      await invoke('terminal_terminate', { spec: specFor(session) });
    }
    removeTerminal(model, id);
    delete model.sessions[id];
    health.delete(id);
    transportRetries.delete(id);
    if (session.tmux) tmuxInventory.delete(tmuxKey(session.tmux));
    runtime.delete(id);
    attention.delete(id);
    tmuxBells.delete(id);
    seenQuiet.delete(id);
    launchFailures.delete(id);
    if (focused === id) {
      focused = focusAfterMount = leaves(activeTab()?.tree)[0] ?? null;
      selectTerminalPath(focused);
    } else if (focusAfterMount === id) focusAfterMount = null;
    if (maximized === id) maximized = null;
    render();
    await save();
  } finally {
    closingTerminals.delete(id);
    paintStatus(id);
  }
}

async function normalizeProject(path, distro, select = true) {
  const location = await invoke('host_location', { path, distro });
  let item = model.projects.find(existing => existing.path === location.display
    && existing.distro === (location.distro || distro));
  if (!item) {
    item = { id: crypto.randomUUID(), name: pathName(location.display), path: location.display,
      native: location.native, distro: location.distro || distro, color: '#b7c9e7' };
    model.projects.push(item);
  }
  if (select) chooseProject(item);
  return item;
}

async function openProject() {
  await ready;
  const path = input('', { placeholder: 'C:\\Projects\\repo or ~/projects/repo', spellcheck: 'false' });
  const options = [...new Set([projectDistro(), ...distros].filter(name => !/^docker-desktop(?:-data)?$/i.test(name)))];
  const distro = select(options.map(name => [name, name]), projectDistro());
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
  const separator = model.settings.cloneRoot.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : '/';
  const root = model.settings.cloneRoot.replace(/[\\/]+$/, '') + separator;
  const destination = input(root, { spellcheck: 'false' });
  let customDestination = false;
  const options = [...new Set([projectDistro(), ...distros].filter(name => !/^docker-desktop(?:-data)?$/i.test(name)))];
  const distro = select(options.map(name => [name, name]), projectDistro());
  const form = el('form', { class: 'field-stack' }, field('Repository URL or path', remote),
    field('New folder', destination), field('Ubuntu distribution', distro),
    el('p', { class: 'muted', text: 'Use an Ubuntu folder such as ~/projects for Linux development.' }));
  const ui = dialog('Clone repository', form);
  const submit = busy(async () => {
    ui.error('');
    const location = await invoke('host_clone', { remote: remote.value.trim(), path: destination.value.trim(), distro: distro.value });
    await normalizeProject(location.display, location.distro || distro.value);
    ui.close();
  }, ui.error);
  destination.addEventListener('input', () => { customDestination = true; });
  remote.addEventListener('input', () => {
    if (!customDestination) {
      const name = pathName(remote.value.trim().split(':').at(-1)).replace(/\.git$/i, '');
      destination.value = root + name;
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
  const quiet = role ? input(item.quietWatch || 0, { type: 'number', min: 0, max: 1440 }) : null;
  const provider = role ? select([['', 'None'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['agy', 'Antigravity']],
    agentProvider(item) || '') : null;
  const conversation = provider ? input(item.agentResumeId || '', { maxlength: 128, spellcheck: 'false' }) : null;
  const conversationField = conversation ? field('Conversation ID for resume', conversation) : null;
  if (provider) {
    provider.addEventListener('change', () => { conversationField.hidden = !provider.value; });
    conversationField.hidden = !provider.value;
  }
  const ui = dialog(kind === 'terminal' ? 'Terminal details' : 'Project details', [
    el('div', { class: 'field-pair' }, field('Name', title), field('Colour', color)),
    role ? field('Role', role) : null,
    quiet ? field('Quiet alert after minutes of observed silence (0 turns it off)', quiet) : null,
    provider ? field('Agent CLI', provider) : null, conversationField,
  ]);
  ui.footer.append(button('Save', () => {
    const value = title.value.trim().slice(0, 70);
    if (!value) { ui.error('Enter a name.'); return; }
    if (role) {
      const minutes = Number(quiet.value);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        ui.error('Enter a quiet alert between 0 and 1440 minutes.'); return;
      }
      const id = provider.value ? conversation.value.trim() : '';
      if (id && !validConversation(id)) { ui.error('Enter a valid conversation ID.'); return; }
      item.title = value;
      item.role = role.value.trim().slice(0, 64);
      item.quietWatch = minutes;
      item.agentKind = provider.value || undefined;
      item.agentResumeId = id || undefined;
      if (attention.get(item.id)?.kind === 'quiet') acknowledgeAttention(item.id);
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
  const options = [...new Set([projectDistro(), ...distros].filter(name => !/^docker-desktop(?:-data)?$/i.test(name)))];
  const distro = select(options.map(name => [name, name]), projectDistro());
  const cloneRoot = input(current.cloneRoot);
  const font = input(current.font);
  const fontSize = input(current.fontSize, { type: 'number', min: 9, max: 32 });
  const claude = input(current.claude);
  const codex = input(current.codex);
  const agy = input(current.agy);
  const fullAccess = el('input', { type: 'checkbox', checked: current.fullAccess });
  const ping = el('input', { type: 'checkbox', checked: current.attentionPing });
  const intro = el('input', { type: 'checkbox', checked: current.intro !== false });
  const ui = dialog('Settings', [
    el('div', { class: 'field-pair' }, field('Default Ubuntu distribution', distro), field('Default clone directory', cloneRoot)),
    el('div', { class: 'field-pair' }, field('Terminal font', font), field('Font size', fontSize)),
    field('Claude Code launch command', claude), field('Codex launch command', codex),
    field('Antigravity Windows launch command', agy),
    el('label', { class: 'check-field' }, fullAccess, 'Full access for new coding agent sessions'),
    el('label', { class: 'check-field' }, ping, 'Play a sound for terminal attention alerts'),
    el('label', { class: 'check-field' }, intro, 'Play the Tux intro on launch'),
  ]);
  ui.footer.append(button('Keyboard shortcuts', () => { ui.close(); openKeyboardSettings(); }));
  ui.footer.append(button('Save settings', () => {
    const size = Number(fontSize.value);
    if (!font.value.trim() || !cloneRoot.value.trim() || !claude.value.trim() || !codex.value.trim() || !agy.value.trim() || size < 9 || size > 32) {
      ui.error('Enter a font, valid size, clone directory and launch commands.');
      return;
    }
    model.settings = { distro: distro.value, cloneRoot: cloneRoot.value.trim(), font: font.value.trim(),
      fontSize: size, claude: claude.value.trim(), codex: codex.value.trim(), agy: agy.value.trim(),
      fullAccess: fullAccess.checked, attentionPing: ping.checked, intro: intro.checked };
    for (const terminal of view.values()) terminal.applySettings(model.settings);
    save();
    ui.close();
  }, { class: 'primary' }));
}

function openKeyboardSettings() {
  const fields = new Map(SHORTCUTS.map(({ id, label }) =>
    [id, { label, control: input(keymap.bindings[id] || '', { spellcheck: 'false', maxlength: 48 }) }]));
  const form = el('div', { class: 'keyboard-settings' },
    ...[...fields.values()].map(({ label, control }) => field(label, control)));
  const ui = dialog('Keyboard shortcuts', [
    el('p', { class: 'muted', text: `Enter a shortcut or leave it blank to disable it. ${PASSTHROUGH_EXIT} always exits terminal passthrough.` }),
    form,
  ], { class: 'wide' });
  ui.footer.append(button('Restore defaults', () => {
    for (const shortcut of SHORTCUTS) fields.get(shortcut.id).control.value = shortcut.defaultKey || '';
    ui.error('');
  }), button('Save shortcuts', busy(async () => {
    const overrides = {};
    for (const { id, defaultKey } of SHORTCUTS) {
      const value = fields.get(id).control.value.trim() || null;
      if (value !== defaultKey) overrides[id] = value;
    }
    const checked = validateKeybindings(overrides);
    if (checked.errors.length) {
      const { id, message } = checked.errors[0];
      const { label, control } = fields.get(id);
      ui.error(`${label}. ${message}`);
      control.focus();
      return;
    }
    model.keybindings = overrides;
    keymap = createKeymap(overrides);
    await save();
    ui.close();
    paintSidebar();
    paintToolbar();
    paintTabs();
  }, ui.error), { class: 'primary' }));
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
          await newTerminal('blank', { item, path: tree.path });
        }), { disabled: tree.missing, icon: 'terminal' })));
    }
  }, ui.error);
  ui.footer.append(button('Refresh', refresh));
  refresh();
}

async function openWorkflow(action) {
  const target = activeSession();
  await workflowEditor(project(), target && { ...target, kind: agentProvider(target) || target.kind }, action, insertInFocusedTerminal);
}

function insertInFocusedTerminal(id, text) {
  if (id !== focused || !leaves(activeTab()?.tree).includes(id)) return false;
  return view.get(id)?.insert(text) ?? false;
}

async function openStudio() {
  await ready;
  openPromptStudio({ distro: project()?.distro || projectDistro(), target: activeSession(),
    insert: insertInFocusedTerminal });
}

async function fullscreen() { await desktop.setFullscreen(!await desktop.isFullscreen()); }

function splitTerminal(session, kind, axis) {
  if (!session) return newTerminal(kind);
  const item = model.projects.find(project => project.id === session.project);
  return newTerminal(kind, { item, path: session.path, axis, anchor: session.id });
}

function replacementTerminal(session) {
  const item = model.projects.find(project => project.id === session.project);
  return newTerminal(session.kind, { item, path: session.path });
}

async function resumeAgent(session) {
  const kind = agentProvider(session);
  if (!kind) return;
  if (usesTmux(session)) await refreshHealth().catch(() => {});
  if (sessionRunning(session)) { activate(session.id); return; }
  if (usesTmux(session) && !sessionExited(session)) {
    throw new Error('tmux has not confirmed that this session ended. Refresh Sessions before attempting a resume.');
  }
  const item = model.projects.find(project => project.id === session.project);
  if (!item) throw new Error('Open the agent’s project first.');
  if (!await confirmAction('Resume agent', `Open a new terminal to resume “${session.title}” with ${launchNames[kind]}?`, 'Resume agent')) return;
  await newTerminal(kind, { item, path: session.path, resume: session });
}

async function adoptSession(id) {
  const snapshot = tmuxInventory.get(id);
  if (!snapshot) throw new Error('This tmux session is no longer in the inventory.');
  const known = Object.values(model.sessions).find(session => tmuxKey(session.tmux) === id);
  if (known) return known;
  if (Object.keys(model.sessions).length >= 64) throw new Error('Close an unused terminal to attach another session.');
  const distro = snapshot.identity.distro;
  const cwd = tmuxPane(snapshot)?.cwd;
  let item = projectForTmux(snapshot);
  if (!item && cwd) item = await normalizeProject(cwd, distro, false).catch(() => undefined);
  if (!item) {
    const candidates = model.projects.filter(project => project.distro === distro);
    item = await chooseTmuxProject(candidates);
    if (!item) return undefined;
  }
  const session = {
    id: crypto.randomUUID(), project: item.id, path: cwd || item.path, distro, kind: 'blank', profile: 'ubuntu',
    backend: 'tmux', tmux: snapshot.identity, title: snapshot.name, color: item.color,
  };
  model.sessions[session.id] = session;
  return session;
}

function chooseTmuxProject(candidates) {
  if (!candidates.length) throw new Error('Open a project in this Ubuntu distribution before attaching the session.');
  return new Promise(resolve => {
    const ui = dialog('Choose a project for this tmux session', candidates.map(item =>
      button(item.name, () => { resolve(item); ui.close(); })), { onClose: () => resolve(undefined) });
  });
}

async function openSession(id, axis) {
  const adoption = !model.sessions[id];
  if (adoption && !discovering.has(id)) {
    discovering.set(id, adoptSession(id).finally(() => discovering.delete(id)));
  }
  const session = model.sessions[id] || await discovering.get(id);
  if (!session) return false;
  if (axis && focused !== session.id && focused && leaves(activeTab()?.tree).includes(focused)) {
    moveTerminal(session.id, focused, axis === 'rows' ? 'below' : 'right');
  } else activate(session.id);
  if (adoption) refreshHealth().catch(() => {});
}

async function closeExternal(id) {
  const snapshot = tmuxInventory.get(id);
  if (!snapshot || closingTerminals.has(id)) return;
  closingTerminals.add(id);
  try {
    if (await confirmAction('Terminate tmux session', `End all processes in “${snapshot.name}”?`, 'Terminate session')) {
      await performTmux(snapshot, ['kill-session']);
    }
  } finally { closingTerminals.delete(id); }
}

async function performTmux(snapshot, args) {
  await invoke('terminal_tmux_action', { identity: snapshot.identity, args });
  if (args[0] === 'kill-session') tmuxInventory.delete(tmuxKey(snapshot.identity));
  await refreshHealth().catch(() => {});
}

async function getTmux(target) {
  if (!target) throw new Error('Focus a tmux terminal first.');
  await refreshHealth().catch(() => {});
  const snapshot = typeof target === 'string' ? tmuxInventory.get(target) : tmuxRecord(target);
  if (!snapshot) throw new Error('This tmux session is currently unavailable.');
  return snapshot;
}

async function renameTmux(target) {
  const snapshot = await getTmux(target);
  const name = input(snapshot.name, { maxlength: 100 });
  const ui = dialog('Rename tmux session', [field('Session name', name)]);
  const submit = busy(async () => {
    await performTmux(snapshot, ['rename-session', name.value.trim()]);
    if (typeof target !== 'string') {
      target.title = name.value.trim();
      render();
      await save();
    }
    ui.close();
  }, ui.error);
  ui.footer.append(button('Rename', submit, { class: 'primary' }));
  name.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
  name.select();
}

async function closeTmuxPane(target, snapshot, pane) {
  if (snapshot.panes.length === 1) {
    return typeof target === 'string' ? closeExternal(target) : closeTerminal(target);
  }
  if (await confirmAction('Close tmux pane', `End processes in pane ${pane.id} of “${snapshot.name}”?`, 'Close pane')) {
    await performTmux(snapshot, ['kill-pane', pane.id]);
  }
}

async function tmuxPaneAction(target, action, chosen) {
  if (!target) return;
  const snapshot = await getTmux(target);
  const pane = chosen ? snapshot.panes.find(item => item.id === chosen) : tmuxPane(snapshot);
  if (!pane) throw new Error('This tmux pane is no longer available.');
  if (action === 'close') return closeTmuxPane(target, snapshot, pane);
  if (action === 'next') {
    const next = snapshot.panes[(snapshot.panes.indexOf(pane) + 1) % snapshot.panes.length];
    return performTmux(snapshot, ['select-pane', next.windowId, next.id]);
  }
  return performTmux(snapshot, ['split-window', action === 'right' ? '-h' : '-v', pane.id]);
}

async function manageTmuxPanes(target = activeSession()) {
  const snapshot = await getTmux(target);
  const pane = tmuxPane(snapshot);
  const actions = snapshot.panes.map(item => {
    const state = item.dead ? 'exited' : item.windowActive && item.active ? 'focused' : 'running';
    return [`Focus ${item.id} · ${item.command || 'shell'} · ${state}`, async () => {
      await performTmux(snapshot, ['select-pane', item.windowId, item.id]);
      await openSession(typeof target === 'string' ? target : target.id);
    }];
  });
  pickCommand('Manage tmux panes', [
    ...actions, ['Split tmux pane right', () => tmuxPaneAction(target, 'right')],
    ['Split tmux pane below', () => tmuxPaneAction(target, 'below')],
    ['Close focused tmux pane', () => closeTmuxPane(target, snapshot, pane)],
    ['Rename tmux session', () => renameTmux(target)],
  ]);
}

async function browseTmux() {
  await refreshHealth().catch(() => {});
  pickCommand('Browse tmux sessions', [...tmuxInventory].map(([id, snapshot]) => {
    const tracked = Object.values(model.sessions).find(session => tmuxKey(session.tmux) === id);
    return [`${tracked?.title || snapshot.name} · ${snapshot.identity.distro} · ${paneCount(snapshot)}`,
      () => openSession(tracked?.id || id)];
  }));
}

function newMenu(session) {
  return pickCommand(session ? 'Split terminal' : 'New terminal',
    Object.entries(launchNames).map(([key, label]) => [label, () => splitTerminal(session, key, 'columns')]));
}

function newProjectMenu() {
  return pickCommand('New project', [['Open folder', openProject], ['Clone repository', cloneProject]]);
}

function moveTerminalMenu(session) {
  const targets = [...new Set(model.tabs.flatMap(tab => leaves(tab.tree)))].filter(id => id !== session.id);
  const positions = [['Left', 'left'], ['Right', 'right'], ['Above', 'above'], ['Below', 'below'], ['Swap', 'center']];
  pickCommand('Move terminal to another pane', targets.map(id => {
    const other = model.sessions[id];
    const item = model.projects.find(project => project.id === other.project);
    return [`${other.title} · ${item?.name || 'Workspace'}`, () => pickCommand('Place terminal', positions.map(
      ([label, position]) => [label, () => moveTerminal(session.id, id, position)]))];
  }));
}

function terminalMenu(session) {
  return pickCommand(session.title, [
    ['Find in terminal', () => view.get(session.id)?.find()],
    ['Terminal details, colour and role', () => editItem(session, 'terminal')],
    ...(usesTmux(session) && !health.get(session.id)?.missing ? [
      ['Manage tmux panes', () => manageTmuxPanes(session)], ['Rename tmux session', () => renameTmux(session)],
    ] : []),
    ['Split side by side', () => splitTerminal(session, 'blank', 'columns')],
    ['Split top and bottom', () => splitTerminal(session, 'blank', 'rows')],
    ['Move terminal to another pane', () => moveTerminalMenu(session)],
    ['Maximize or restore pane', () => { maximized = maximized === session.id ? null : session.id; renderStage(); save(); }],
    ...(attention.has(session.id) ? [['Acknowledge terminal attention', () => acknowledgeAttention(session.id)]] : []),
    ['Toggle full-screen window', fullscreen],
    ['/goal objective', () => openWorkflow('goal')],
    ['/loop task', () => openWorkflow('loop')],
    ['Insert saved prompt', () => openWorkflow('prompt')],
    ['Hide terminal and keep running', () => detach(session.id)],
    ['Reconnect terminal', () => retryTerminal(session.id)],
    ...(agentProvider(session) ? [['Resume agent', () => resumeAgent(session)]] : []),
    ['Close terminal', () => closeTerminal(session)],
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
  if (mergeInFlight || waiters.size || hiding.size || $('dialog[open]')) return;
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
  for (const [key, { path, distro, item }] of selected) {
    if (waiters.size || hiding.size || $('dialog[open]')) break;
    const outcomes = await invoke('merge_observe', { path, distro, since: mergeSince.get(key) || observerStarted })
      .catch(() => null);
    if (!outcomes) continue;
    if (mergeInFlight) return;
    mergeSince.set(key, started);
    for (const outcome of outcomes) {
      if (observedKeys.has(outcome.key)) continue;
      remember(observedKeys, outcome.key, 512);
      if (appMergeNotices.has(mergeNoticeKey(distro, path, outcome.oldHead, outcome.head))) continue;
      celebrateShip(outcome);
      if (item) refreshGit(item, path);
    }
  }
}

function palette() {
  pickCommand('Command palette', [
    ['Open project folder', openProject], ['Clone repository', cloneProject],
    ['New blank terminal', () => newTerminal()], ['Launch Claude Code', () => newTerminal('claude')],
    ['Launch Codex', () => newTerminal('codex')], ['New PowerShell terminal', () => newTerminal('powershell')],
    ['Launch Antigravity on Windows', () => newTerminal('agy')], ['Toggle Sessions', () => toggleSessions()],
    ['Git worktrees', openWorktrees], ['Development status', openDevPanel], ['Merge local branch', mergeBranch], ['Environment variables', () => project() && dotenvEditor(project(), rootPath())],
    ['Workflow templates', () => openWorkflow('prompt')], ['/goal objective', () => openWorkflow('goal')],
    ['/loop task', () => openWorkflow('loop')], ['Toggle window fullscreen', fullscreen],
    ['Prompt Studio', openStudio], ['Spotify', openSpotify], ['Replay Tux intro', playIntro], ['Settings', openSettings],
    ['Keyboard shortcuts', openKeyboardSettings], ['Toggle terminal passthrough', togglePassthrough],
    ['Browse tmux sessions', browseTmux],
    ...(usesTmux(activeSession()) ? [['Manage tmux panes', () => manageTmuxPanes()],
      ['Rename tmux session', () => renameTmux(activeSession())]] : []),
    ['Switch project', quickProjects], ['Switch terminal session', quickSessions], ['Switch visible pane', quickPanes],
    ...(activeSession() ? [
      ['Terminal actions', () => terminalMenu(activeSession())], ['Close terminal', () => closeTerminal(activeSession())],
      ['Hide terminal', () => detach(focused)], ['Reconnect terminal', () => retryTerminal(focused)],
      ['Move terminal to another pane', () => moveTerminalMenu(activeSession())],
    ] : []),
    ...model.projects.map(item => [`Project: ${item.name}`, () => chooseProject(item)]),
    ...Object.values(model.sessions).filter(session => session.project === model.project && sessionVisible(session))
      .map(session => [`Terminal: ${session.title}`, () => activate(session.id)]),
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
    button('Prompt Studio', busy(openStudio), { icon: 'square-pen', only: true }),
    button('Spotify', openSpotify, { icon: 'music-2', only: true }),
    button('Command palette', palette, { icon: 'search', only: true, title: 'Command palette (Ctrl+Shift+P)' }),
    button('Settings', openSettings, { icon: 'settings-2', only: true }),
  );
  replaceControls(projectBar, primary, actions);
}

function applySidebar() { sidebar.hidden = !model.sidebar; }

function terminalCloseButton(session, className = '') {
  return button(`Close terminal ${session.title}`, busy(() => closeTerminal(session)),
    { icon: 'x', only: true, class: className });
}

function paintSidebar() {
  if (draggedTerminal) return;
  const list = el('div', { class: 'project-list' });
  const head = el('div', { class: 'sidebar-heading' }, el('h1', { text: 'Projects' }),
    button('New project', newProjectMenu, { icon: 'plus', only: true }));
  const pinned = pinnedProjects(model);
  const unpinned = model.projects.filter(item => !model.pinnedProjects.includes(item.id));
  for (const item of [...pinned, ...unpinned]) {
    const selected = item.id === model.project;
    const pinIndex = pinned.indexOf(item);
    const isPinned = pinIndex !== -1;
    const binding = isPinned && pinIndex < 9 ? keymap.bindings[`pinnedProject${pinIndex + 1}`] : '';
    const shortcut = shortcutLabel(binding);
    const expanded = projectExpansion.get(item.id) ?? selected;
    const section = el('section', { class: `project-group${selected ? ' selected' : ''}` });
    section.style.setProperty('--project-color', safeColor(item.color));
    const selectButton = button(item.name, () => chooseProject(item), {
      class: 'project-name', title: shortcut ? `${item.path} • ${shortcut}` : item.path,
    });
    selectButton.setAttribute('aria-pressed', String(selected));
    if (shortcut) selectButton.setAttribute('aria-keyshortcuts', binding.startsWith('Ctrl+') ? ariaShortcut(binding) : binding);
    const toggle = button(`${expanded ? 'Collapse' : 'Expand'} ${item.name}`, () => {
      projectExpansion.set(item.id, !expanded);
      paintSidebar();
    }, { only: true, icon: expanded ? 'chevron-down' : 'chevron-right' });
    toggle.setAttribute('aria-expanded', String(expanded));
    const pin = button(`${isPinned ? 'Unpin' : 'Pin'} ${item.name}`, () => {
      model.pinnedProjects = isPinned ? model.pinnedProjects.filter(id => id !== item.id)
        : [...model.pinnedProjects, item.id];
      paintSidebar();
      sidebar.querySelector(`[data-pin-project="${CSS.escape(item.id)}"]`)?.focus({ preventScroll: true });
      save();
    }, { icon: 'pin', only: true, class: 'project-pin', data: { pinProject: item.id } });
    pin.setAttribute('aria-pressed', String(isPinned));
    section.append(el('div', { class: 'project-heading' }, toggle, selectButton,
      pin,
      button(`Edit ${item.name}`, () => editItem(item, 'project'), { icon: 'ellipsis', only: true })));
    if (expanded) {
      const sub = el('div', { class: 'project-content' });
      for (const session of Object.values(model.sessions).filter(value => value.project === item.id && sessionVisible(value))) {
        const [label, tone] = currentStatus(session);
        const activity = el('span', { class: `session-status ${tone}`, data: { statusId: session.id }, text: label });
        const text = el('span', { class: 'session-caption' }, el('span', { text: session.title }),
          session.role ? el('small', { text: session.role }) : null);
        const entry = el('button', { type: 'button', title: session.path, class: `session-link${focused === session.id ? ' chosen' : ''}`,
          onClick: () => activate(session.id), data: { terminalId: session.id } },
          icon('terminal'), text, activity);
        entry.style.setProperty('--session-color', safeColor(session.color));
        draggableTerminal(entry, session.id);
        sub.append(el('div', { class: 'session-entry' }, entry, terminalCloseButton(session, 'session-close')));
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
  replaceControls(sidebar, head, list);
}

function paintTabs() {
  const sessions = button('Sessions', () => toggleSessions(), { icon: 'activity', class: 'sessions-toggle',
    title: 'Show terminal sessions (Ctrl+Shift+J)' });
  sessions.setAttribute('aria-pressed', String(model.sessionsVisible));
  const tabs = visibleTabs().map(tab => {
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
    tabButton.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(tabDrag, tab.id);
    });
    tabButton.addEventListener('dragover', event => {
      if (!event.dataTransfer.types.some(type => type === tabDrag || type === paneDrag)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    tabButton.addEventListener('drop', event => {
      event.preventDefault();
      const source = event.dataTransfer.getData(tabDrag);
      const drag = event.dataTransfer.getData(paneDrag);
      if (source && source !== tab.id) {
        const from = model.tabs.findIndex(item => item.id === source);
        const to = model.tabs.findIndex(item => item.id === tab.id);
        if (from >= 0 && to >= 0) {
          const [moved] = model.tabs.splice(from, 1);
          model.tabs.splice(to, 0, moved);
        }
      } else if (drag && !ids.includes(drag)) {
        draggedTerminal = null;
        clearDropTarget();
        moveTerminal(drag, ids[0], 'right');
        return;
      }
      render();
      save();
    });
    return ids.length === 1 && first
      ? el('div', { class: 'tab-entry' }, tabButton, terminalCloseButton(first, 'tab-close'))
      : tabButton;
  });
  replaceControls(tabbar, el('div', { class: 'tab-strip' }, tabs),
    el('div', { class: 'tab-actions' }, sessions, button('New terminal', () => newMenu(), { icon: 'plus', only: true })));
  tabbar.querySelector('.tab.chosen')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
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
    type: 'button', class: 'pane-caption',
    title: `${profileName(session.profile)} • ${session.path}`, onClick: () => view.get(session.id)?.focus(),
  }, icon('terminal'), el('strong', { text: session.title }), session.role ? el('span', { text: session.role }) : null);
  draggableTerminal(caption, session.id);
  const missing = health.get(session.id)?.missing && !launchFailures.has(session.id) && !waiters.has(session.id);
  const content = el('div', { class: 'pane-body' }, el('div', { class: 'terminal-feedback', role: 'status' },
    missing ? ['This tmux session has ended.', agentProvider(session)
      ? button('Resume agent', busy(() => resumeAgent(session)))
      : button('Open new terminal here', busy(() => replacementTerminal(session)))] : 'Loading terminal…'));
  const frame = el('section', {
    class: `pane${focused === session.id ? ' active' : ''}`, data: { session: session.id }, 'aria-label': session.title,
    onPointerdown: () => focusPane(session.id), onFocusin: () => focusPane(session.id),
  }, el('header', { class: 'pane-heading' }, caption, activity,
    button('Find in terminal', () => view.get(session.id)?.find(), { icon: 'search', only: true }),
    button('Split terminal', () => newMenu(session), { icon: 'split', only: true }),
    button(maximized === session.id ? 'Restore pane' : 'Maximize pane', () => {
      maximized = maximized === session.id ? null : session.id;
      renderStage();
      save();
    }, { icon: maximized === session.id ? 'minimize' : 'maximize', only: true }),
    button('Terminal actions', () => terminalMenu(session), { icon: 'ellipsis', only: true }),
    terminalCloseButton(session)), content);
  frame.style.setProperty('--session-color', safeColor(session.color));
  frame.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes(paneDrag) || draggedTerminal === session.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget !== frame) {
      clearDropTarget();
      dropTarget = frame;
    }
    frame.dataset.dropPosition = paneDropPosition(event, frame);
  });
  frame.addEventListener('dragleave', event => {
    if (dropTarget === frame && !frame.contains(event.relatedTarget)) clearDropTarget();
  });
  frame.addEventListener('drop', event => {
    const source = event.dataTransfer.getData(paneDrag);
    if (!source) return;
    event.preventDefault();
    const position = paneDropPosition(event, frame);
    draggedTerminal = null;
    clearDropTarget();
    moveTerminal(source, session.id, position);
  });
  if (!missing) mounts.set(session.id, content);
  return frame;
}

function hideView(id, terminal, forget = false) {
  const keeping = !usesTmux(terminal.session) && !forget;
  const pending = terminal.conceal();
  if (!keeping) view.delete(id);
  mark(id, 'detached');
  hiding.set(id, pending);
  pending.finally(() => {
    if (!keeping) terminal.dispose();
    if (hiding.get(id) === pending) hiding.delete(id);
  });
}

async function retryTerminal(id, manual = true) {
  const session = model.sessions[id];
  if (!session || closingTerminals.has(id) || waiters.has(id)) return;
  if (manual) transportRetries.delete(id);
  const terminal = view.get(id);
  if (terminal) hideView(id, terminal);
  await hiding.get(id);
  if (!model.sessions[id] || closingTerminals.has(id) || waiters.has(id)) return;
  if (launchFailures.has(id)) {
    const starting = startTerminal(session, launcherFor(session));
    renderStage();
    await starting;
    return;
  }
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
      terminal = new TerminalView(session, model.settings, mark, {
        retry: () => retryTerminal(id), replace: () => replacementTerminal(session),
      });
      view.set(id, terminal);
    }
    target.replaceChildren();
    terminal.mount(target, waiters.get(id), launchFailures.get(id));
    applyTerminalFocus(id);
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
    for (const id of mounts.keys()) paintStatus(id);
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
  paintSessions();
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
  replaceControls(statusBar, ...values.map(([name, value]) =>
    el('span', { class: 'reading' }, name, el('strong', { text: value }))),
    ...(passthrough ? [button(`Terminal keys · ${PASSTHROUGH_EXIT}`, togglePassthrough,
      { title: 'Return to workspace shortcuts', class: 'terminal-key-mode' })] : []));
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
  const tabs = visibleTabs();
  if (!tabs.length) return;
  const index = tabs.findIndex(tab => tab.id === model.active);
  const next = tabs[index < 0 && direction < 0 ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length];
  const first = leaves(next.tree)[0];
  if (first) activate(first);
}

function toggleProjects() {
  model.sidebar = !model.sidebar;
  applySidebar();
  save();
}

function togglePassthrough() {
  passthrough = !passthrough;
  paintStats();
  if (passthrough) view.get(focused)?.focus();
}

function focusRegion(step) {
  const regions = [
    [projectBar, () => projectBar.querySelector('button:not(:disabled)')?.focus()],
    [sidebar, () => (sidebar.querySelector('.selected .project-name') || sidebar.querySelector('button'))?.focus()],
    [tabbar, () => (tabbar.querySelector('.tab.chosen') || tabbar.querySelector('button'))?.focus()],
    [stage, () => {
      if (view.get(focused)?.connected) view.get(focused).focus();
      else stage.querySelector('.pane.active button, .empty-actions button')?.focus();
    }],
    [sessionRail.element, sessionRail.focus],
  ].filter(([element]) => !element.hidden);
  const index = regions.findIndex(([element]) => element.contains(document.activeElement));
  const next = index === -1 ? (step > 0 ? 0 : regions.length - 1) : (index + step + regions.length) % regions.length;
  regions[next][1]();
}

function focusAdjacentPane(x, y) {
  const panes = [...stage.querySelectorAll('.pane')];
  const center = pane => {
    const bounds = pane.getBoundingClientRect();
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
  };
  const origin = panes.find(pane => pane.dataset.session === focused);
  if (!origin) return;
  const [ox, oy] = center(origin);
  let best;
  let score = Infinity;
  for (const pane of panes) {
    const [px, py] = center(pane);
    const dx = px - ox;
    const dy = py - oy;
    const along = dx * x + dy * y;
    const offset = Math.abs(dx * y + dy * x);
    if (along > 1 && along + offset * 2 < score) {
      score = along + offset * 2;
      best = pane;
    }
  }
  if (best) activate(best.dataset.session);
}

function quickProjects() {
  pickCommand('Switch project', model.projects.map(item => [item.name, () => chooseProject(item)]));
}

function quickSessions() {
  pickCommand('Switch terminal session', Object.values(model.sessions).filter(sessionVisible).map(session => {
    const item = model.projects.find(project => project.id === session.project);
    return [`${item?.name || 'Workspace'} · ${session.title}`, () => activate(session.id)];
  }).concat(externalSessions().map(snapshot => [`${snapshot.identity.distro} · ${snapshot.name}`,
    () => openSession(tmuxKey(snapshot.identity))])));
}

function quickPanes() {
  pickCommand('Switch visible pane', leaves(activeTab()?.tree).flatMap(id =>
    model.sessions[id] ? [[model.sessions[id].title, () => activate(id)]] : []));
}

function shortcuts(event) {
  const context = shortcutContext(event, Boolean($('dialog[open]')));
  if (context === 'dialog') return;
  const id = keymap.resolve(event, { context, passthrough });
  if (!id) return;
  const session = activeSession();
  const pinned = /^pinnedProject([1-9])$/.exec(id);
  const item = pinned && pinnedProjects(model)[Number(pinned[1]) - 1];
  const actions = {
    palette, newTerminal: () => newTerminal(), openProject, findTerminal: () => view.get(focused)?.find(),
    launchClaude: () => newTerminal('claude'), launchCodex: () => newTerminal('codex'),
    launchAgy: () => newTerminal('agy'), launchPowerShell: () => newTerminal('powershell'),
    worktrees: openWorktrees, workflows: () => openWorkflow('prompt'), toggleProjects,
    toggleSessions: () => toggleSessions(), quickSessions, quickProjects, quickPanes,
    renameSession: session && (() => tmuxRecord(session) ? renameTmux(session) : editItem(session, 'terminal')),
    tmuxSplitRight: usesTmux(session) && (() => tmuxPaneAction(session, 'right')),
    tmuxSplitBelow: usesTmux(session) && (() => tmuxPaneAction(session, 'below')),
    tmuxNextPane: usesTmux(session) && (() => tmuxPaneAction(session, 'next')),
    tmuxClosePane: usesTmux(session) && (() => tmuxPaneAction(session, 'close')),
    splitRight: () => splitTerminal(session, 'blank', 'columns'), splitBelow: () => splitTerminal(session, 'blank', 'rows'),
    closeTerminal: session && (() => closeTerminal(session)), detachTerminal: session && (() => detach(session.id)),
    resumeAgent: agentProvider(session) && (() => resumeAgent(session)),
    nextTab: () => cycleTab(1), previousTab: () => cycleTab(-1),
    focusNextRegion: () => focusRegion(1), focusPreviousRegion: () => focusRegion(-1),
    focusLeftPane: () => focusAdjacentPane(-1, 0), focusRightPane: () => focusAdjacentPane(1, 0),
    focusAbovePane: () => focusAdjacentPane(0, -1), focusBelowPane: () => focusAdjacentPane(0, 1),
    fullscreen, togglePassthrough,
  };
  const action = item ? () => chooseProject(item) : actions[id];
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  Promise.resolve().then(action).catch(reportError);
}

sidebar.addEventListener('keydown', event => moveListFocus(event,
  sidebar.querySelectorAll('.project-name, .session-link')));
tabbar.addEventListener('keydown', event => moveListFocus(event,
  tabbar.querySelectorAll('.tab, .tab-actions button'), { orientation: 'horizontal' }));
projectBar.addEventListener('keydown', event => moveListFocus(event, projectBar.querySelectorAll('button'),
  { orientation: 'horizontal' }));

async function closeRequested(event) {
  if (closed) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  try {
    await Promise.allSettled(waiters.values());
    const count = await invoke('terminal_active_powershell');
    if (count && !await confirmAction('Close AgentDock',
      `Closing ends ${count} native PowerShell ${count === 1 ? 'terminal' : 'terminals'}. tmux sessions will detach.`,
      'Close AgentDock')) return;
    await saved.catch(() => save());
    closed = true;
    await desktop.destroy();
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
        waiters.size || hiding.size ? undefined : refreshHealth(),
        observeMerges(),
      ]);
      if (!sample && results[0].status === 'rejected') paintStats();
    } else if (Object.values(model.sessions).some(session => session.quietWatch || session.kind !== 'blank')) {
      await refreshHealth().catch(() => {});
    }
  } finally {
    if (!closed) setTimeout(tick, minimized ? 6500 : 4000);
  }
}

async function init() {
  render();
  invoke('host_distros').then(names => { distros = names; return refreshHealth(); }).catch(() => {});
  try {
    model = initialModel(await invoke('workspace_load'));
    keymap = createKeymap(model.keybindings);
    if (activeTab()) {
      focused = model.focused ?? null;
      maximized = model.maximized ?? null;
    } else {
      model.active = projectTabs(model).find(tab => tab.id === project()?.lastTab)?.id ?? null;
    }
  } catch (error) { reportError(error); }
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
