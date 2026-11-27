import assert from 'node:assert/strict';
import test from 'node:test';
import { composePrompt, exchangeLeaves, formatBytes, initialModel, leaves, removeTerminal, splitLeaf } from './model.js';

test('splits, exchanges and removes terminals without duplicating identities', () => {
  const model = initialModel();
  model.tabs = [
    { id: 'one', tree: splitLeaf({ id: 'a' }, 'a', 'b', 'rows') },
    { id: 'two', tree: { id: 'c' } },
  ];
  model.active = 'two';
  model.tabs = exchangeLeaves(model.tabs, 'b', 'c');
  assert.deepEqual(model.tabs.map(tab => leaves(tab.tree)), [['a', 'c'], ['b']]);
  removeTerminal(model, 'b');
  assert.equal(model.active, 'one');
  assert.deepEqual(leaves(model.tabs[0].tree), ['a', 'c']);
});

test('native slash prompts are scoped to the correct configured agent', () => {
  assert.equal(composePrompt('codex', 'goal', 'Reduce p95.', '', '', ''), '/goal Reduce p95.');
  assert.equal(composePrompt('claude', 'loop', 'Review progress', '', '5m', 'all checks pass'),
    '/loop 5m Review progress\n\nStop when all checks pass.');
  assert.equal(composePrompt('codex', 'loop', 'Review progress', '', '5m', ''),
    'Review progress\n\nRequested interval 5m.');
  assert.equal(composePrompt('blank', 'goal', 'Describe the root cause', 'Check logs.', '', ''),
    'Describe the root cause\n\nCheck logs.');
  assert.throws(() => composePrompt('claude', 'loop', 'Do work', '', '5x', ''), /interval/);
});

test('resource units consistently report MiB and GiB', () => {
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(64 * 1024 ** 2), '64 MiB');
  assert.equal(formatBytes(64 * 1024 ** 3), '64.0 GiB');
});
