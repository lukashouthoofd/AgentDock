const defaults = {
  distro: '',
  cloneRoot: '~/projects',
  font: 'Cascadia Mono, Consolas, monospace',
  fontSize: 14,
  claude: 'claude',
  codex: 'codex',
};

export function initialModel(stored) {
  const fresh = { version: 1, projects: [], recent: [], sessions: {}, tabs: [],
    active: null, project: null, worktree: null, sidebar: true, settings: { ...defaults } };
  if (stored?.version !== 1 || !Array.isArray(stored.projects) || !Array.isArray(stored.tabs)
    || !stored.sessions || typeof stored.sessions !== 'object') return fresh;
  return { ...fresh, ...stored, settings: { ...defaults, ...stored.settings } };
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

export function splitLeaf(tree, id, newId, axis) {
  return updateLeaf(tree, id, first => ({ axis, ratio: 0.5, first, second: { id: newId } }));
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
