import { busy, button, confirmAction, dialog, el, field, icon, input, safeColor, select } from './ui.js';
import './session-view.css';

const kinds = {
  blank: 'Ubuntu shell',
  claude: 'Claude Code',
  codex: 'Codex',
  powershell: 'PowerShell',
};

const tones = new Set(['ok', 'cool', 'bad']);
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'short' });
const narrow = '(max-width: 1399px)';

function relativeTime(value, now, prefix) {
  if (!Number.isFinite(value) || value <= 0 || value > 8.64e15) return null;
  const elapsed = Math.max(0, Math.floor((now - value) / 60000));
  const date = new Date(value);
  const label = elapsed < 1 ? 'just now'
    : elapsed < 60 ? relative.format(-elapsed, 'minute')
      : elapsed < 1440 ? relative.format(-Math.floor(elapsed / 60), 'hour')
        : relative.format(-Math.floor(elapsed / 1440), 'day');
  return [`${prefix} ${label}`, date.toISOString(), date.toLocaleString('en')];
}

function snapshot(row, now) {
  return {
    id: row.id,
    title: row.title || 'Terminal',
    role: row.role || '',
    color: safeColor(row.color),
    project: row.project || '',
    projectId: row.projectId,
    distro: row.distro || (row.kind === 'powershell' ? 'Windows' : ''),
    workspace: row.workspace || '',
    path: row.path || '',
    kind: kinds[row.kind] || '',
    label: row.label || 'Unobserved',
    tone: tones.has(row.tone) ? row.tone : '',
    running: row.running === true,
    visible: row.visible === true,
    inLayout: row.inLayout === true || row.visible === true,
    pinned: row.pinned === true,
    attention: typeof row.attention === 'string' ? row.attention : '',
    output: relativeTime(row.lastOutput, now, 'Output'),
    quiet: relativeTime(row.quietSince, now, 'Quiet since'),
  };
}

function timeNode(time) {
  return el('time', { text: time[0], datetime: time[1], title: time[2] });
}

export function createSessionsView({
  activate, dock, hide, close, saveLayout, restoreLayout, deleteLayout, acknowledge, settings, pin,
}) {
  const search = input('', {
    type: 'search', placeholder: 'Find a session…', 'aria-label': 'Find sessions', spellcheck: 'false',
  });
  const scope = select([
    ['all', 'All sessions'], ['running', 'Running'], ['project', 'This project'],
    ['pinned', 'Pinned'], ['attention', 'Needs attention'],
  ], 'all', { 'aria-label': 'Filter sessions' });
  const count = el('span', { class: 'session-rail-count' });
  const projectName = el('strong', { class: 'session-rail-ellipsis' });
  const list = el('ul', { class: 'session-rail-list', 'aria-label': 'Matching sessions' });
  const empty = el('p', { class: 'session-rail-empty', role: 'status', hidden: true });
  const accessLayouts = saveLayout || restoreLayout || deleteLayout;
  const element = el('aside', { class: 'session-rail', 'aria-label': 'Sessions' },
    el('header', { class: 'session-rail-heading' },
      el('h2', { text: 'Sessions' }), count,
      accessLayouts ? button('Layouts', openLayouts, { title: 'Named layout presets', class: 'session-rail-layout-trigger' }) : null,
      button('Close sessions', close, { only: true, icon: 'x' })),
    el('div', { class: 'session-rail-controls' },
      el('p', { class: 'session-rail-project' }, el('span', { text: 'Current project' }), projectName),
      search, scope),
    el('div', { class: 'session-rail-content' }, list, empty));

  let rows = [];
  let presets = [];
  let activeId;
  let currentProject;
  let signature;
  let layouts;

  function isCurrent(row) {
    if (!currentProject) return false;
    if (currentProject.id && row.projectId) return currentProject.id === row.projectId;
    return currentProject.name === row.project;
  }

  function hideOverlay() {
    if (matchMedia(narrow).matches) close();
  }

  function draw(row) {
    const active = row.id === activeId;
    const context = [row.project, row.distro, row.workspace].filter(Boolean).join(' / ');
    const placement = row.visible ? 'Showing' : row.inLayout ? 'Out of view' : 'Hidden';
    const run = (name, action, options = {}) => button(name, busy(action), {
      ...options, data: { sessionAction: options.action || name, sessionId: row.id },
    });
    const follow = action => async () => {
      if (await action(row.id) !== false) hideOverlay();
    };
    const item = el('li', {
      class: 'session-rail-row', 'aria-current': active ? 'true' : null,
      'data-attention': row.attention ? 'true' : null,
    },
    el('div', { class: 'session-rail-row-heading' },
      icon('terminal'), el('strong', { class: 'session-rail-ellipsis', text: row.title, title: row.title }),
      el('span', { class: `session-status ${row.tone}`, text: row.label })),
    el('div', { class: 'session-rail-meta' },
      row.role || row.kind ? el('span', { class: 'session-rail-ellipsis', text: row.role || row.kind,
        title: [row.role, row.kind].filter(Boolean).join(' / ') }) : null,
      context ? el('span', { class: 'session-rail-ellipsis', text: context, title: context }) : null,
      row.path ? el('span', { class: 'session-rail-ellipsis session-rail-path', text: row.path, title: row.path }) : null,
      row.output ? timeNode(row.output) : el('span', { text: 'No output observed' }),
      row.quiet ? timeNode(row.quiet) : null),
    el('div', { class: 'session-rail-flags' },
      el('span', { class: row.visible ? 'session-rail-visible' : '', text: placement }),
      row.pinned ? el('span', { text: 'Pinned' }) : null,
      pin ? run(row.pinned ? 'Unpin' : 'Pin', () => pin(row.id, !row.pinned),
        { action: 'pin', title: `${row.pinned ? 'Unpin' : 'Pin'} ${row.title}` }) : null,
      settings ? run('Quiet-watch settings', () => settings(row.id),
        { action: 'settings', only: true, icon: 'settings-2', title: `Quiet-watch settings for ${row.title}` }) : null),
    row.attention ? el('div', { class: 'session-rail-attention' },
      el('span', { text: row.attention }),
      acknowledge ? run('Acknowledge', () => acknowledge(row.id), { action: 'acknowledge' }) : null) : null,
    el('div', { class: 'session-rail-actions' },
      run(active ? 'Focus' : 'Open', follow(activate), {
        action: 'open', title: `${active ? 'Focus' : 'Open'} ${row.title}`,
      }),
      run('Beside', follow(dock), {
        action: 'dock', icon: 'split', disabled: active, title: `Place ${row.title} beside the focused terminal`,
      }),
      hide ? run('Hide', () => hide(row.id), {
        action: 'hide', disabled: !row.inLayout, title: `Hide ${row.title} and keep the terminal session`,
      }) : null));
    item.style.setProperty('--rail-session-color', row.color);
    return item;
  }

  function render() {
    const currentName = currentProject?.name || 'None';
    projectName.textContent = currentName;
    projectName.title = currentName;
    scope.options[2].disabled = !currentProject;
    if (scope.value === 'project' && !currentProject) scope.value = 'all';
    const terms = search.value.trim().toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
    const now = Date.now();
    const visible = rows.map(row => snapshot(row, now)).filter(row => {
      if (scope.value === 'running' && !row.running) return false;
      if (scope.value === 'project' && !isCurrent(row)) return false;
      if (scope.value === 'pinned' && !row.pinned) return false;
      if (scope.value === 'attention' && !row.attention) return false;
      const text = [row.title, row.role, row.project, row.distro, row.workspace, row.path, row.kind, row.label, row.attention]
        .join('\n').toLocaleLowerCase('en');
      return terms.every(term => text.includes(term));
    }).sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const key = JSON.stringify([activeId, rows.length, visible]);
    if (key === signature) return;
    signature = key;
    count.textContent = visible.length === rows.length ? String(visible.length) : `${visible.length} of ${rows.length}`;
    empty.textContent = rows.length ? 'No sessions match these filters.' : 'No terminal sessions yet.';
    empty.hidden = visible.length > 0;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset : null;
    list.replaceChildren(...visible.map(draw));
    if (focused) {
      const sameButton = Array.from(list.querySelectorAll('[data-session-action]')).find(node =>
        node.dataset.sessionId === focused.sessionId && node.dataset.sessionAction === focused.sessionAction && !node.disabled);
      (sameButton || search).focus({ preventScroll: true });
    }
  }

  function renderLayouts() {
    if (!layouts) return;
    const { ui, entries } = layouts;
    if (!presets.length) {
      entries.replaceChildren(el('li', { class: 'muted', text: 'No saved layouts.' }));
      return;
    }
    entries.replaceChildren(...presets.map(preset => el('li', {},
      el('strong', { class: 'session-rail-ellipsis', text: preset.name, title: preset.name }),
      restoreLayout ? button('Restore', busy(async () => {
        if (await restoreLayout(preset.id) === false) return;
        ui.close();
        hideOverlay();
      }, ui.error), { title: `Restore ${preset.name}` }) : null,
      deleteLayout ? button('Delete', busy(async () => {
        if (await confirmAction('Delete layout preset', `Delete “${preset.name}” from saved layouts?`, 'Delete')) {
          await deleteLayout(preset.id);
        }
      }, ui.error), { title: `Delete ${preset.name}` }) : null)));
  }

  function openLayouts() {
    if (layouts) return;
    const name = input('', { maxlength: 64, placeholder: 'Example. Laptop focus', spellcheck: 'false' });
    const entries = el('ul', { class: 'session-layout-list', 'aria-label': 'Saved layout presets' });
    const ui = dialog('Layout presets', [entries, saveLayout ? field('Name for current layout', name) : null],
      { onClose: () => { layouts = null; } });
    layouts = { ui, entries };
    if (saveLayout) ui.footer.append(button('Save current layout', busy(async () => {
      const value = name.value.trim();
      if (!value) { ui.error('Enter a name for this layout.'); name.focus(); return; }
      const previous = presets.find(preset => preset.name.toLocaleLowerCase('en') === value.toLocaleLowerCase('en'));
      if (previous && !await confirmAction('Replace layout preset', `Replace the layout saved as “${previous.name}”?`, 'Replace')) return;
      await saveLayout(value);
      name.value = '';
      ui.error('');
    }, ui.error), { class: 'primary' }));
    renderLayouts();
    if (saveLayout) name.focus();
  }

  search.addEventListener('input', render);
  scope.addEventListener('change', render);
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });
  render();

  return {
    element,
    focus: () => search.focus(),
    update(next, active, context = {}) {
      rows = Array.isArray(next) ? next.filter(row => typeof row?.id === 'string' && row.id) : [];
      activeId = active;
      const activeRow = rows.find(row => row.id === active);
      const project = context.project;
      currentProject = typeof project === 'string' ? { name: project }
        : project ?? (activeRow?.project ? { name: activeRow.project, id: activeRow.projectId } : null);
      const nextPresets = Array.isArray(context.presets) ? context.presets.filter(preset =>
        typeof preset?.id === 'string' && typeof preset.name === 'string').map(({ id, name }) => ({ id, name })) : [];
      if (JSON.stringify(nextPresets) !== JSON.stringify(presets)) {
        presets = nextPresets;
        renderLayouts();
      }
      render();
    },
  };
}
