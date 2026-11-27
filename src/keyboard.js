export const PASSTHROUGH_EXIT = 'Ctrl+Shift+Space';

const commandRows = [
  ['palette', 'Command palette', 'Ctrl+Shift+P'],
  ['newTerminal', 'New Ubuntu terminal', 'Ctrl+Shift+T'],
  ['openProject', 'Open project folder', 'Ctrl+Shift+O'],
  ['findTerminal', 'Find in terminal', 'Ctrl+Shift+F'],
  ['launchClaude', 'Launch Claude Code', 'Ctrl+Alt+Shift+C'],
  ['launchCodex', 'Launch Codex', 'Ctrl+Shift+K'],
  ['launchAgy', 'Launch Antigravity', null],
  ['launchPowerShell', 'New PowerShell terminal', null],
  ['worktrees', 'Git worktrees', 'Ctrl+Shift+W'],
  ['workflows', 'Workflow templates', 'Ctrl+Shift+E'],
  ['toggleProjects', 'Toggle Projects sidebar', 'Ctrl+Shift+B'],
  ['toggleSessions', 'Toggle Sessions rail', 'Ctrl+Shift+J'],
  ['quickSessions', 'Switch terminal sessions', 'Ctrl+Shift+U'],
  ['quickProjects', 'Switch projects', 'Ctrl+Shift+L'],
  ['quickPanes', 'Switch visible panes', 'Ctrl+Shift+M'],
  ['renameSession', 'Rename terminal session', 'F2'],
  ['splitRight', 'Split terminal right', 'Ctrl+Shift+ArrowRight'],
  ['splitBelow', 'Split terminal below', 'Ctrl+Shift+ArrowDown'],
  ['closeTerminal', 'Close terminal', 'Ctrl+Shift+Backspace'],
  ['detachTerminal', 'Hide or detach terminal', 'Ctrl+Shift+H'],
  ['resumeAgent', 'Resume agent in this terminal', null],
  ['nextTab', 'Next terminal tab', 'Ctrl+Tab'],
  ['previousTab', 'Previous terminal tab', 'Ctrl+Shift+Tab'],
  ['focusNextRegion', 'Focus next workspace region', 'F6'],
  ['focusPreviousRegion', 'Focus previous workspace region', 'Shift+F6'],
  ['focusLeftPane', 'Focus pane to the left', 'Ctrl+Alt+ArrowLeft'],
  ['focusRightPane', 'Focus pane to the right', 'Ctrl+Alt+ArrowRight'],
  ['focusAbovePane', 'Focus pane above', 'Ctrl+Alt+ArrowUp'],
  ['focusBelowPane', 'Focus pane below', 'Ctrl+Alt+ArrowDown'],
  ['tmuxSplitRight', 'Split tmux pane right', null],
  ['tmuxSplitBelow', 'Split tmux pane below', null],
  ['tmuxNextPane', 'Focus next tmux pane', null],
  ['tmuxClosePane', 'Close tmux pane', null],
  ['fullscreen', 'Toggle full screen', 'F11'],
  ['togglePassthrough', 'Toggle terminal passthrough', PASSTHROUGH_EXIT],
  ...Array.from({ length: 9 }, (_, index) => [
    `pinnedProject${index + 1}`, `Open pinned project ${index + 1}`, `Alt+${index + 1}`,
  ]),
];

export const SHORTCUTS = Object.freeze(commandRows.map(([id, label, defaultKey]) =>
  Object.freeze({ id, label, defaultKey })));

const defaults = Object.fromEntries(SHORTCUTS.map(({ id, defaultKey }) => [id, defaultKey]));
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const modifierAlias = new Map([
  ['ctrl', 'Ctrl'], ['control', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'],
  ['meta', 'Meta'], ['win', 'Meta'], ['super', 'Meta'], ['cmd', 'Meta'],
]);
const knownKeys = [
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Tab', 'Enter', 'Escape',
  'Space', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Plus', 'Minus', 'Equal', 'Comma', 'Period', 'Slash', 'Backslash', 'Semicolon',
  'Quote', 'Backquote', 'BracketLeft', 'BracketRight', 'Pipe', 'Underscore',
];
const keyAlias = new Map(knownKeys.map(key => [key.toLowerCase(), key]));
for (const [alias, key] of [
  [' ', 'Space'], ['spacebar', 'Space'], ['esc', 'Escape'], ['del', 'Delete'], ['return', 'Enter'],
  ['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['up', 'ArrowUp'], ['down', 'ArrowDown'],
  ['pgup', 'PageUp'], ['pgdn', 'PageDown'], ['+', 'Plus'], ['-', 'Minus'], ['=', 'Equal'],
  [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'], ['\\', 'Backslash'], [';', 'Semicolon'],
  ["'", 'Quote'], ['`', 'Backquote'], ['[', 'BracketLeft'], [']', 'BracketRight'],
  ['|', 'Pipe'], ['_', 'Underscore'],
]) keyAlias.set(alias, key);

const reserved = new Set([
  'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'Meta+L',
  'Ctrl+Shift+C', 'Ctrl+Shift+V', 'Shift+Insert',
]);

function keyName(raw) {
  if (typeof raw !== 'string') return null;
  const lower = raw.toLowerCase();
  if (keyAlias.has(lower)) return keyAlias.get(lower);
  const upper = raw.toUpperCase();
  if (/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(upper)) return upper;
  return /^\p{L}$/u.test(upper) ? upper : null;
}

export function normalizeKeybinding(value) {
  if (typeof value !== 'string') return null;
  const source = value.trim();
  const tokens = (source.endsWith('++') ? source.slice(0, -1) + 'Plus' : source)
    .split('+').map(token => token.trim());
  const key = keyName(tokens.pop());
  const names = tokens.map(token => modifierAlias.get(token.toLowerCase()));
  if (!key || names.some(name => !name) || new Set(names).size !== names.length) return null;
  return [...modifiers.filter(name => names.includes(name)), key].join('+');
}

export function captureKeybinding(event) {
  if (!event || event.isComposing || event.getModifierState?.('AltGraph')) return null;
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1]
    ?? (/^[0-9]$/.test(event.key) ? /^Numpad([0-9])$/.exec(event.code)?.[1] : null);
  // Digit codes stay stable even though an AZERTY number row also produces letters and punctuation.
  const key = keyName(digit ?? event.key);
  if (!key) return null;
  const pressed = [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey];
  return [...modifiers.filter((_, index) => pressed[index]), key].join('+');
}

export function shortcutLabel(binding) {
  const canonical = normalizeKeybinding(binding);
  if (!canonical) return '';
  return canonical.replace(/\bArrow(Left|Right|Up|Down)\b/, '$1');
}

export function ariaShortcut(binding) {
  const canonical = normalizeKeybinding(binding);
  return canonical?.replace(/^Ctrl(?=\+)/, 'Control') || '';
}

export function validateKeybindings(overrides) {
  const bindings = { ...defaults };
  const errors = [];
  for (const { id } of SHORTCUTS) {
    if (!overrides || !Object.hasOwn(overrides, id)) continue;
    const value = overrides[id];
    if (value === null || value === '') { bindings[id] = null; continue; }
    const normalized = normalizeKeybinding(value);
    if (!normalized || (!normalized.includes('+') && !/^F\d+$/.test(normalized))) {
      errors.push({ id, message: 'Use a function key or a key with one or more modifiers.' });
      continue;
    }
    if (reserved.has(normalized) || (normalized === PASSTHROUGH_EXIT && id !== 'togglePassthrough')) {
      errors.push({ id, message: `${shortcutLabel(normalized)} is reserved.` });
      continue;
    }
    bindings[id] = normalized;
  }
  const claims = new Map();
  for (const { id, label } of SHORTCUTS) {
    const key = bindings[id];
    if (!key) continue;
    const previous = claims.get(key);
    if (previous) {
      errors.push({ id, message: `${shortcutLabel(key)} is also assigned to ${previous}.` });
    } else claims.set(key, label);
  }
  return { bindings, errors };
}

export function shortcutContext(event, dialogOpen = false) {
  const target = event?.target;
  if (dialogOpen || target?.closest?.('dialog[open]')) return 'dialog';
  if (target?.closest?.('.xterm')) return 'terminal';
  if (target?.isContentEditable || target?.closest?.('input, textarea, select')) return 'editable';
  return 'workspace';
}

export function createKeymap(overrides) {
  const checked = validateKeybindings(overrides);
  // Persisted invalid input can never shadow reserved shortcuts or a working default keymap.
  const bindings = checked.errors.length ? { ...defaults } : checked.bindings;
  const actions = new Map(Object.entries(bindings)
    .filter(([, binding]) => binding).map(([id, binding]) => [binding, id]));
  return {
    bindings,
    errors: checked.errors,
    resolve(event, { context = shortcutContext(event), passthrough = false } = {}) {
      if (!event || event.repeat) return null;
      if (passthrough && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
        && (event.code === 'Space' || keyName(event.key) === 'Space')) return 'togglePassthrough';
      const binding = captureKeybinding(event);
      if (binding === 'Ctrl+V' && context === 'terminal') return null;
      if (passthrough) return actions.get(binding) === 'togglePassthrough' ? 'togglePassthrough' : null;
      if (context !== 'workspace' && context !== 'terminal') return null;
      return actions.get(binding) ?? null;
    },
  };
}

export function nextListIndex(key, current, count, { orientation = 'vertical', wrap = true } = {}) {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const vertical = orientation === 'vertical' || orientation === 'both';
  const horizontal = orientation === 'horizontal' || orientation === 'both';
  let step;
  if ((vertical && key === 'ArrowDown') || (horizontal && key === 'ArrowRight')) step = 1;
  if ((vertical && key === 'ArrowUp') || (horizontal && key === 'ArrowLeft')) step = -1;
  if (!step) return null;
  if (!Number.isInteger(current) || current < 0 || current >= count) return step > 0 ? 0 : count - 1;
  const next = current + step;
  return wrap ? (next + count) % count : Math.max(0, Math.min(next, count - 1));
}

export function moveListFocus(event, elements, options) {
  const target = event.target;
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
    || target?.isContentEditable || target?.closest?.('input, textarea, select, .xterm')) return false;
  const items = Array.from(elements).filter(item => !item.disabled && !item.hidden
    && item.getAttribute?.('aria-disabled') !== 'true' && !item.closest?.('[hidden]'));
  const current = items.findIndex(item => item === target || item.contains?.(target));
  const next = nextListIndex(event.key, current, items.length, options);
  if (next === null) return false;
  event.preventDefault();
  items[next].focus();
  return true;
}
