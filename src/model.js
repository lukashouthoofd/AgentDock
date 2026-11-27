const defaults = {
  distro: '',
  cloneRoot: '~/projects',
  font: 'Cascadia Mono, Consolas, monospace',
  fontSize: 14,
  claude: 'claude',
  codex: 'codex',
  agy: 'agy.exe',
  fullAccess: true,
  attentionPing: false,
};

export function initialModel(stored) {
  const fresh = { version: 1, projects: [], recent: [], sessions: {}, tabs: [],
    active: null, project: null, worktree: null, sidebar: true, sessionsVisible: false,
    layouts: [], pinnedProjects: [], settings: { ...defaults } };
  if (stored?.version !== 1 || !Array.isArray(stored.projects) || !Array.isArray(stored.tabs)
    || !stored.sessions || typeof stored.sessions !== 'object') return fresh;
  return { ...fresh, ...stored, layouts: Array.isArray(stored.layouts) ? stored.layouts : [],
    pinnedProjects: Array.isArray(stored.pinnedProjects) ? [...new Set(stored.pinnedProjects)] : [],
    settings: { ...defaults, ...stored.settings } };
}

export function pinnedProjects(model) {
  return model.pinnedProjects.map(id => model.projects.find(item => item.id === id)).filter(Boolean);
}

export function restoreLayout(model, layout) {
  model.tabs = structuredClone(layout.tabs);
  const recorded = new Set(model.tabs.flatMap(tab => leaves(tab.tree)));
  for (const id of recorded) {
    if (!Object.hasOwn(model.sessions, id)) removeTerminal(model, id);
  }
  const tab = model.tabs.find(tab => tab.id === layout.active) || model.tabs.at(0);
  model.active = tab?.id ?? null;
  model.sidebar = layout.sidebar !== false;
  const visible = leaves(tab?.tree);
  return {
    focused: visible.includes(layout.focused) ? layout.focused : visible[0] ?? null,
    maximized: visible.includes(layout.maximized) ? layout.maximized : null,
  };
}

const fullAccessFlag = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  agy: '--dangerously-skip-permissions',
};

export function agentProvider(session) {
  if (!session) return null;
  const kind = session.agentKind || session.kind;
  return Object.hasOwn(fullAccessFlag, kind) ? kind : null;
}

export function validConversation(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(id);
}

export function usesTmux(session) {
  return Boolean(session?.tmux || session?.backend === 'tmux' || session?.profile === 'ubuntu');
}

export function terminalSpec(session, launcher) {
  return {
    id: session.id, path: session.path, distro: session.distro, profile: session.profile,
    backend: session.backend, tmux: session.tmux, launcher,
  };
}

export function tmuxKey(identity) {
  return identity && JSON.stringify([identity.distro, identity.socket, identity.bootId, identity.serverPid,
    identity.serverStarted, identity.sessionId, identity.sessionCreated]);
}

export function tmuxPane(snapshot) {
  return snapshot?.panes.find(pane => pane.windowActive && pane.active)
    || snapshot?.panes.find(pane => !pane.dead) || snapshot?.panes[0];
}

function linuxPath(path, distro) {
  if (path.startsWith('/')) return path.replace(/\/+$/, '') || '/';
  const parts = path.replaceAll('\\', '/');
  const unc = /^\/\/(?:wsl\.local(?:host)?|wsl\$)\/([^/]+)(\/.*)?$/i.exec(parts);
  if (unc && unc[1].toLowerCase() === distro.toLowerCase()) return unc[2]?.replace(/\/+$/, '') || '/';
  const drive = /^([a-z]):\/(.*)$/i.exec(parts);
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}`.replace(/\/+$/, '') : null;
}

export function tmuxProject(projects, distro, cwd) {
  if (!cwd?.startsWith('/')) return undefined;
  const normalized = cwd.replace(/\/+$/, '') || '/';
  let best;
  let length = -1;
  for (const item of projects) {
    if (item.distro !== distro) continue;
    let root = linuxPath(item.path, distro);
    if (!root) continue;
    const windows = /^\/mnt\/[a-z](?:\/|$)/i.test(root);
    const path = windows ? normalized.toLowerCase() : normalized;
    if (windows) root = root.toLowerCase();
    if ((path === root || path.startsWith(root === '/' ? '/' : `${root}/`)) && root.length > length) {
      best = item;
      length = root.length;
    }
  }
  return best;
}

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function agentAttentionOptions(kind) {
  if (kind === 'codex') {
    return [
      'tui.notification_method="bel"',
      'tui.notification_condition="always"',
      'tui.notifications=["approval-requested","plan-mode-prompt","async-question"]',
    ].map(value => `-c ${shellArgument(value)}`).join(' ');
  }
  if (kind === 'claude') {
    const notification = JSON.stringify({ terminalSequence: '\u0007' });
    const settings = { hooks: { Notification: [{
      matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input',
      hooks: [{ type: 'command', command: `printf '%s\\n' ${shellArgument(notification)}` }],
    }] } };
    return `--settings ${shellArgument(JSON.stringify(settings))}`;
  }
  return '';
}

export function launchCommand(kind, settings, agent = undefined) {
  const flag = fullAccessFlag[kind];
  if (!flag) return null;
  let command = settings[kind].trim();
  let conversation = '';
  if (agent?.id && !validConversation(agent.id)) throw new Error('Enter a valid conversation ID.');
  if (agent?.resume) {
    if (kind === 'agy' && !agent.id) throw new Error('Save an Antigravity conversation ID in Terminal details first.');
    conversation = { claude: '--resume', codex: 'resume', agy: '--conversation' }[kind];
    if (agent.id) conversation += ' ' + agent.id;
  } else if (kind === 'claude' && command === 'claude' && agent?.id) {
    conversation = '--session-id ' + agent.id;
  }
  if (command.includes('{permissions}')) {
    if (conversation) throw new Error('Use a standard launch command or resume with the CLI in a blank terminal.');
    return command.replace('{permissions}', settings.fullAccess ? flag : '');
  }
  const attention = kind === command ? agentAttentionOptions(kind) : '';
  if (kind === 'agy' && command === 'agy.exe') {
    command = '& $(if (Test-Path (Join-Path $env:LOCALAPPDATA "agy\\bin\\agy.exe")) { Join-Path $env:LOCALAPPDATA "agy\\bin\\agy.exe" } else { "agy.exe" })';
  } else if (settings.fullAccess && /[&|;<>]/.test(kind === 'agy' ? command.replace(/^&\s+/, '') : command)) {
    throw new Error('Place {permissions} after the agent executable in a launch command with shell operators.');
  }
  const permissions = settings.fullAccess && !command.split(/\s+/).includes(flag) ? flag : '';
  return [command, permissions, attention, conversation].filter(Boolean).join(' ');
}

export function leaves(tree) {
  return tree?.id ? [tree.id] : tree ? [...leaves(tree.first), ...leaves(tree.second)] : [];
}

export function tabProject(model, tab) {
  return tab?.project || leaves(tab?.tree).map(id => model.sessions[id]?.project).find(Boolean);
}

export function projectTabs(model, project = model.project) {
  return model.tabs.filter(tab => tabProject(model, tab) === project);
}

export function updateLeaf(tree, id, transform) {
  if (tree?.id) return tree.id === id ? transform(tree) : tree;
  if (!tree) return null;
  const first = updateLeaf(tree.first, id, transform);
  const second = updateLeaf(tree.second, id, transform);
  return first && second ? { ...tree, first, second } : first || second;
}

export function splitLeaf(tree, id, newId, axis, before = false) {
  return updateLeaf(tree, id, original => {
    const added = { id: newId };
    return { axis, ratio: 0.5, first: before ? added : original, second: before ? original : added };
  });
}

export function exchangeLeaves(tabs, first, second) {
  return tabs.map(tab => {
    function exchange(tree) {
      if (tree.id) {
        return { id: tree.id === first ? second : tree.id === second ? first : tree.id };
      }
      return { ...tree, first: exchange(tree.first), second: exchange(tree.second) };
    }
    return { ...tab, tree: exchange(tab.tree) };
  });
}

export function removeTerminal(model, id) {
  model.tabs = model.tabs.map(tab => ({
    ...tab, project: tabProject(model, tab), tree: updateLeaf(tab.tree, id, () => null),
  }))
    .filter(tab => tab.tree);
  const tabs = model.project ? projectTabs(model) : model.tabs;
  if (!tabs.some(tab => tab.id === model.active)) model.active = tabs.at(-1)?.id ?? null;
}

export function arrangeTerminal(model, source, target, position) {
  const destination = model.tabs.find(tab => leaves(tab.tree).includes(target));
  if (source === target || !model.sessions[source] || !destination) return null;
  destination.project = tabProject(model, destination);
  const alreadyPlaced = model.tabs.some(tab => leaves(tab.tree).includes(source));
  if (position === 'center' && alreadyPlaced) {
    model.tabs = exchangeLeaves(model.tabs, source, target);
  } else {
    const axis = position === 'above' || position === 'below' ? 'rows' : 'columns';
    const before = position === 'left' || position === 'above';
    removeTerminal(model, source);
    const tab = model.tabs.find(item => item.id === destination.id);
    tab.tree = splitLeaf(tab.tree, target, source, axis, before);
  }
  return destination.id;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function composePrompt(kind, command, objective, template, recurrence, stop) {
  const native = (kind === 'codex' && command === 'goal') || (kind === 'claude' && command === 'loop');
  const goal = objective.trim();
  const interval = recurrence.trim();
  if (command === 'loop' && interval && !/^[1-9]\d{0,4}[mhd]$/i.test(interval)) {
    throw new Error('Enter an interval such as 5m, 2h or 1d.');
  }
  const condition = stop.trim() ? `Stop when ${stop.trim()}.` : '';
  const cadence = command === 'loop' && interval && !native ? `Requested interval ${interval}.` : '';
  const text = [goal, cadence, condition, template.trim()].filter(Boolean).join('\n\n');
  if (!text) return '';
  const prefix = native ? `/${command} ${command === 'loop' && interval ? `${interval} ` : ''}` : '';
  return (prefix + text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
