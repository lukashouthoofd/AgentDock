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
    layouts: [], settings: { ...defaults } };
  if (stored?.version !== 1 || !Array.isArray(stored.projects) || !Array.isArray(stored.tabs)
    || !stored.sessions || typeof stored.sessions !== 'object') return fresh;
  return { ...fresh, ...stored, layouts: Array.isArray(stored.layouts) ? stored.layouts : [],
    settings: { ...defaults, ...stored.settings } };
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

export function launchCommand(kind, settings) {
  const flag = fullAccessFlag[kind];
  if (!flag) return null;
  let command = settings[kind].trim();
  if (command.includes('{permissions}')) return command.replace('{permissions}', settings.fullAccess ? flag : '');
  const attention = kind === command ? agentAttentionOptions(kind) : '';
  if (kind === 'agy' && command === 'agy.exe') {
    command = '& $(if (Test-Path (Join-Path $env:LOCALAPPDATA "agy\\bin\\agy.exe")) { Join-Path $env:LOCALAPPDATA "agy\\bin\\agy.exe" } else { "agy.exe" })';
  } else if (settings.fullAccess && /[&|;<>]/.test(kind === 'agy' ? command.replace(/^&\s+/, '') : command)) {
    throw new Error('Place {permissions} after the agent executable in a launch command with shell operators.');
  }
  const permissions = settings.fullAccess && !command.split(/\s+/).includes(flag) ? flag : '';
  return [command, permissions, attention].filter(Boolean).join(' ');
}

export function leaves(tree) {
  return tree?.id ? [tree.id] : tree ? [...leaves(tree.first), ...leaves(tree.second)] : [];
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
  model.tabs = model.tabs.map(tab => ({ ...tab, tree: updateLeaf(tab.tree, id, () => null) }))
    .filter(tab => tab.tree);
  if (!model.tabs.some(tab => tab.id === model.active)) model.active = model.tabs.at(-1)?.id ?? null;
}

export function arrangeTerminal(model, source, target, position) {
  const destination = model.tabs.find(tab => leaves(tab.tree).includes(target));
  if (source === target || !model.sessions[source] || !destination) return null;
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
