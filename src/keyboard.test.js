import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PASSTHROUGH_EXIT, SHORTCUTS, ariaShortcut, captureKeybinding, createKeymap, moveListFocus,
  nextListIndex, normalizeKeybinding, shortcutContext, shortcutLabel, validateKeybindings,
} from './keyboard.js';

test('key codec follows letters, AZERTY physical number keys, and standard labels', () => {
  assert.equal(normalizeKeybinding(' Shift + control + p '), 'Ctrl+Shift+P');
  assert.equal(normalizeKeybinding('ctrl++'), 'Ctrl+Plus');
  assert.equal(normalizeKeybinding('Control+Ctrl+p'), null);
  assert.equal(captureKeybinding({ key: '&', code: 'Digit1', altKey: true }), 'Alt+1');
  assert.equal(captureKeybinding({ key: '1', code: 'Numpad1', altKey: true }), 'Alt+1');
  assert.equal(captureKeybinding({ key: 'End', code: 'Numpad1', altKey: true }), 'Alt+End');
  assert.equal(captureKeybinding({ key: 'q', code: 'KeyA', ctrlKey: true }), 'Ctrl+Q');
  assert.equal(captureKeybinding({
    key: '@', code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: kind => kind === 'AltGraph',
  }), null);
  assert.equal(captureKeybinding({ key: 'Dead' }), null);
  assert.equal(shortcutLabel('Ctrl+Alt+ArrowRight'), 'Ctrl+Alt+Right');
  assert.equal(ariaShortcut('Ctrl+Alt+ArrowRight'), 'Control+Alt+ArrowRight');
});

test('all defaults are valid and resolve without collisions', () => {
  const map = createKeymap();
  assert.deepEqual(map.errors, []);
  assert.equal(Object.keys(map.bindings).length, SHORTCUTS.length);
  assert.equal(map.resolve({ key: '&', code: 'Digit1', altKey: true }), 'pinnedProject1');
  assert.equal(map.resolve({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }), 'splitRight');
  assert.equal(map.resolve({ key: 'Tab', ctrlKey: true }), 'nextTab');
  assert.equal(map.resolve({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'previousTab');
  assert.equal(map.resolve({ key: 'F6' }), 'focusNextRegion');
  assert.equal(map.resolve({ key: 'F6', shiftKey: true }), 'focusPreviousRegion');
});

test('user overrides can move or clear defaults and never swallow native paste chords', () => {
  const map = createKeymap({ palette: 'ctrl+shift+2', pinnedProject1: null, worktrees: '' });
  assert.equal(map.resolve({ key: '2', code: 'Digit2', ctrlKey: true, shiftKey: true }), 'palette');
  assert.equal(map.resolve({ key: '&', code: 'Digit1', altKey: true }), null);
  assert.equal(map.resolve({ key: 'p', ctrlKey: true, shiftKey: true }), null);
  assert.equal(map.bindings.worktrees, null);
  assert.equal(map.resolve({ key: 'Enter' }), null);
  assert.equal(map.resolve({ key: 'V', ctrlKey: true, shiftKey: true }), null);
  assert.equal(map.resolve({ key: 'X', isComposing: true }), null);
});

test('duplicate, unsafe unmodified, and reserved keybindings fail validation with safe runtime defaults', () => {
  const overrides = {
    palette: 'Ctrl+Shift+T',
    findTerminal: 'a',
    launchAgy: 'Alt+F4',
    launchCodex: PASSTHROUGH_EXIT,
    launchPowerShell: 'Ctrl+Shift+C',
  };
  const checked = validateKeybindings(overrides);
  assert.equal(checked.errors.length, 5);
  assert.ok(checked.errors.some(error => error.message.includes('reserved')));
  assert.ok(checked.errors.some(error => error.message.includes('also assigned')));
  const map = createKeymap(overrides);
  assert.equal(map.resolve({ key: 'T', ctrlKey: true, shiftKey: true }), 'newTerminal');
  assert.equal(map.resolve({ key: 'P', ctrlKey: true, shiftKey: true }), 'palette');
});

test('terminal passthrough leaves native keys alone and always retains its exit', () => {
  const map = createKeymap({ togglePassthrough: 'Ctrl+F9' });
  const context = { context: 'terminal', passthrough: true };
  assert.equal(map.resolve({ key: 'p', ctrlKey: true, shiftKey: true }, context), null);
  assert.equal(map.resolve({ key: 'F11' }, context), null);
  assert.equal(map.resolve({ key: 'F9', ctrlKey: true }, context), 'togglePassthrough');
  assert.equal(map.resolve({
    key: 'Process', code: 'Space', ctrlKey: true, shiftKey: true, isComposing: true,
  }, context), 'togglePassthrough');
  assert.equal(map.resolve({
    key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, repeat: true,
  }, context), null);
  const unbound = createKeymap({ togglePassthrough: null });
  assert.equal(unbound.resolve({ key: ' ', ctrlKey: true, shiftKey: true }, context), 'togglePassthrough');
});

test('dialogs and editable fields keep their keys whereas xterm can invoke designated app chords', () => {
  const map = createKeymap();
  const shortcut = { key: 'p', ctrlKey: true, shiftKey: true };
  const input = { closest: selector => selector.startsWith('input') ? {} : null };
  const terminal = { closest: selector => selector === '.xterm' ? {} : null };
  assert.equal(shortcutContext({ target: input }), 'editable');
  assert.equal(shortcutContext({ target: terminal }), 'terminal');
  assert.equal(shortcutContext({ target: terminal }, true), 'dialog');
  assert.equal(map.resolve({ ...shortcut, target: input }), null);
  assert.equal(map.resolve({ ...shortcut, target: terminal }), 'palette');
  assert.equal(map.resolve(shortcut, { context: 'dialog' }), null);
  assert.equal(map.resolve({ ...shortcut, repeat: true }), null);
});

test('arrow, Home, and End traverse stable list actions, including nested focus', () => {
  assert.equal(nextListIndex('ArrowDown', -1, 3), 0);
  assert.equal(nextListIndex('ArrowUp', -1, 3), 2);
  assert.equal(nextListIndex('ArrowDown', 2, 3), 0);
  assert.equal(nextListIndex('ArrowDown', 2, 3, { wrap: false }), 2);
  assert.equal(nextListIndex('ArrowDown', 2, 3, { orientation: 'horizontal' }), null);
  assert.equal(nextListIndex('ArrowLeft', 1, 3, { orientation: 'horizontal' }), 0);
  assert.equal(nextListIndex('End', 1, 3), 2);
  assert.equal(nextListIndex('Home', 1, 0), null);

  const focus = [];
  const nested = { closest: () => null };
  const first = { contains: element => element === nested, focus: () => focus.push('first') };
  const disabled = { disabled: true, focus: () => focus.push('disabled') };
  const hidden = { hidden: true, focus: () => focus.push('hidden') };
  const last = { focus: () => focus.push('last') };
  let suppressed = false;
  const event = { key: 'ArrowDown', target: nested, preventDefault: () => { suppressed = true; } };
  assert.equal(moveListFocus(event, [first, disabled, hidden, last]), true);
  assert.deepEqual(focus, ['last']);
  assert.equal(suppressed, true);
  const textField = { closest: selector => selector.includes('input') ? {} : null };
  assert.equal(moveListFocus({ ...event, target: textField }, [first, last]), false);
  assert.equal(moveListFocus({ ...event, altKey: true }, [first, last]), false);
  assert.deepEqual(focus, ['last']);
});
