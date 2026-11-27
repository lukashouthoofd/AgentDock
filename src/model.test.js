import { agentProvider, tmuxKey, tmuxPane, tmuxProject } from './model.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeTerminal, composePrompt, exchangeLeaves, formatBytes, initialModel, launchCommand, leaves,
  pinnedProjects, projectTabs, removeTerminal, restoreLayout, splitLeaf } from './model.js';

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

test('edge docking places cross-project terminals in order and preserves hidden sessions', () => {
  const model = initialModel();
  model.sessions = { a: { project: 'one' }, b: { project: 'two' }, c: { project: 'two' } };
  model.tabs = [{ id: 'first', tree: { id: 'a' } }, { id: 'second', tree: { id: 'b' } }];
  model.active = 'second';
  assert.equal(arrangeTerminal(model, 'b', 'a', 'above'), 'first');
  assert.equal(model.tabs.length, 1);
  assert.equal(model.tabs[0].tree.axis, 'rows');
  assert.deepEqual(leaves(model.tabs[0].tree), ['b', 'a']);
  assert.equal(arrangeTerminal(model, 'c', 'a', 'right'), 'first');
  assert.equal(model.tabs[0].tree.second.axis, 'columns');
  assert.deepEqual(leaves(model.tabs[0].tree), ['b', 'a', 'c']);
  arrangeTerminal(model, 'b', 'c', 'center');
  assert.deepEqual(leaves(model.tabs[0].tree), ['c', 'a', 'b']);

  const saved = { tabs: model.tabs, active: 'first', maximized: 'b', focused: 'b' };
  delete model.sessions.b;
  model.sessions.d = { project: 'one' };
  assert.deepEqual(restoreLayout(model, saved), { focused: 'c', maximized: null });
  assert.deepEqual(leaves(model.tabs[0].tree), ['c', 'a']);
  assert.ok(model.sessions.d);
});

test('agent launchers apply the requested permissions only to new agent launches', () => {
  const { settings } = initialModel();
  assert.equal(launchCommand('blank', settings), null);
  assert.match(launchCommand('codex', settings), /^codex --dangerously-bypass-approvals-and-sandbox .*notification_method/);
  assert.match(launchCommand('claude', settings), /^claude --dangerously-skip-permissions --settings .*agent_needs_input/);
  assert.match(launchCommand('agy', settings), /agy\.exe.* --dangerously-skip-permissions$/);
  assert.match(launchCommand('codex', { ...settings, fullAccess: false }), /^codex -c /);
  assert.throws(() => launchCommand('claude', { ...settings, claude: 'claude && echo done' }), /\{permissions\}/);
  assert.equal(launchCommand('claude', { ...settings, claude: 'claude {permissions} && echo done' }),
    'claude --dangerously-skip-permissions && echo done');
});

test('project tabs stay scoped after docking and closing terminals', () => {
  const model = initialModel();
  model.project = 'first';
  model.sessions = { a: { project: 'first' }, b: { project: 'second' }, c: { project: 'second' } };
  model.tabs = [{ id: 'a-tab', tree: { id: 'a' } }, { id: 'b-tab', tree: { id: 'b' } },
    { id: 'c-tab', tree: { id: 'c' } }];
  model.active = 'a-tab';
  assert.deepEqual(projectTabs(model, 'new-project'), []);
  arrangeTerminal(model, 'b', 'a', 'left');
  assert.deepEqual(projectTabs(model).map(tab => tab.id), ['a-tab']);
  assert.deepEqual(leaves(projectTabs(model)[0].tree), ['b', 'a']);
  assert.deepEqual(projectTabs(model, 'second').map(tab => tab.id), ['c-tab']);
  removeTerminal(model, 'a');
  assert.equal(model.active, 'a-tab');
  assert.deepEqual(leaves(projectTabs(model)[0].tree), ['b']);
  assert.deepEqual(projectTabs(model, 'second').map(tab => tab.id), ['c-tab']);
});

test('saved projects keep their pin order and stale pins are ignored', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const model = initialModel({ ...initialModel(), projects, pinnedProjects: ['c', 'gone', 'b', 'c'] });
  assert.deepEqual(pinnedProjects(model).map(item => item.id), ['c', 'b']);
  assert.deepEqual(pinnedProjects(initialModel({ ...model, pinnedProjects: null })), []);
});


test('tmux identity survives renames and distinguishes a reused socket or session ID', () => {
  const identity = { distro: 'Ubuntu', socket: '/tmp/tmux-1000/dev', bootId: 'boot', serverPid: 50,
    serverStarted: 800, sessionId: '$0', sessionCreated: 101 };
  assert.equal(tmuxKey(identity), tmuxKey({ ...identity, name: 'renamed' }));
  assert.notEqual(tmuxKey(identity), tmuxKey({ ...identity, serverStarted: 801 }));
  assert.notEqual(tmuxKey(identity), tmuxKey({ ...identity, sessionCreated: 103 }));
  const panes = [{ id: '%0', active: true }, { id: '%1', windowActive: true, active: true }];
  assert.equal(tmuxPane({ panes }).id, '%1');
});

test('discovered panes match the longest boundary-aware Ubuntu or Windows project path', () => {
  const distro = 'Ubuntu-24.04';
  const windows = { distro, path: 'C:\\Code\\One', id: 'win' };
  const scoped = { distro, path: '/mnt/c/Code/One/nested', id: 'nested' };
  const linux = { distro, path: '/home/user/Code', id: 'linux' };
  const projects = [windows, scoped, linux];
  assert.equal(tmuxProject(projects, distro, '/mnt/c/code/one/NESTED/x').id, 'nested');
  assert.equal(tmuxProject(projects, distro, '/mnt/c/code/one/x').id, 'win');
  assert.equal(tmuxProject(projects, distro, '/mnt/c/code/onerous'), undefined);
  assert.equal(tmuxProject(projects, distro, '/home/user/code'), undefined);
  assert.equal(tmuxProject(projects, 'Other', '/home/user/Code'), undefined);
});

test('agent resume launches use the installed agent syntax and reject shell tokens in IDs', () => {
  const { settings } = initialModel();
  const id = '257eacfc-03dc-41ee-8caf-04f85f02a3f3';
  assert.match(launchCommand('claude', settings, { id }), new RegExp(`--session-id ${id}$`));
  assert.match(launchCommand('claude', settings, { id, resume: true }), new RegExp(`--resume ${id}$`));
  assert.match(launchCommand('codex', settings, { resume: true }), / resume$/);
  assert.match(launchCommand('agy', settings, { id, resume: true }), new RegExp(`--conversation ${id}$`));
  assert.throws(() => launchCommand('codex', settings, { resume: true, id: '"; exit' }), /valid conversation ID/);
  assert.throws(() => launchCommand('agy', settings, { resume: true }), /conversation ID/);
  assert.equal(agentProvider({ kind: 'blank', agentKind: 'claude' }), 'claude');
});
