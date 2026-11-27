/* Native UI verification. Use an empty AgentDock profile and disposable repositories. */
import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const execFile = promisify(exec);
const [exeArg, ubuntu, windows, distro, output] = process.argv.slice(2);
if (process.platform !== 'win32' || ![exeArg, ubuntu, windows, distro, output].every(Boolean)) {
  throw new Error('Usage on Windows: node scripts/test-windows.mjs <exe> <Ubuntu repo> <Windows repo> <distro> <evidence directory>');
}
const exe = resolve(exeArg);
const report = [];
const suite = process.env.AGENTDOCK_VERIFY_SUITE || 'desktop';
const identifier = process.env.AGENTDOCK_VERIFY_IDENTIFIER || '';
if (!new Set(['desktop', 'tmux-keyboard', 'clipboard']).has(suite)) throw new Error('Unknown AgentDock verification suite.');
if (!/^local\.agentdock\.(?:[A-Za-z0-9-]+\.)*(?:verification|qa)$/i.test(identifier)) {
  throw new Error('Set AGENTDOCK_VERIFY_IDENTIFIER to the disposable identifier compiled into this QA executable.');
}
if (!(await readFile(exe)).includes(Buffer.from(identifier))) {
  throw new Error('The executable does not contain the disposable application identifier.');
}
const profile = join(process.env.LOCALAPPDATA, identifier, 'workspace.json');
const evidence = resolve(output);
await mkdir(evidence, { recursive: true });
const sessionIds = new Set();
const fixtureSockets = new Set();
let socketDirectory;
const fixturePaths = new Set([ubuntu, windows, ubuntu + '-clone']);
const projectName = path => path.split(/[\\/]/).at(-1);
let launched;
let browser;
let port = 19281;
const measure = process.env.AGENTDOCK_MEASURE_SCRIPT;
let ipcTiming = [];

function result(message) {
  report.push({ name: message, time: new Date().toISOString() });
  console.log('PASS ' + message);
}

async function until(check, description, milliseconds = 24000) {
  const deadline = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error; }
    await wait(150);
  }
  throw new Error('Timed out: ' + description + (lastError ? ' (' + lastError.message + ')' : ''));
}

async function start() {
  const present = await readFile(profile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (present?.projects?.some(item => ![ubuntu, windows, ubuntu + '-clone'].includes(item.path))) {
    throw new Error('Use a disposable AgentDock profile. Existing workspace data was found.');
  }
  port += 2;
  const launchTime = performance.now();
  const browserProfile = join(evidence, 'browser-profile-' + port);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$sw=[Diagnostics.Stopwatch]::StartNew(); $p=Start-Process -FilePath ' + quote(exe) + ' -WorkingDirectory ' + quote(dirname(exe)) +
    ' -PassThru; do { Start-Sleep -Milliseconds 50; $p.Refresh() } until ($p.MainWindowHandle -ne [IntPtr]::Zero -or $p.HasExited -or $sw.ElapsedMilliseconds -gt 10000); if ($p.MainWindowHandle -eq [IntPtr]::Zero) { exit 1 }; [Console]::Write([string]$p.Id + "," + $sw.ElapsedMilliseconds)'], {
    timeout: 15000,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--disable-gpu --disable-accelerated-video-decode --remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1',
      WEBVIEW2_USER_DATA_FOLDER: browserProfile },
  });
  const [pid, nativeStartup] = stdout.trim().split(',').map(Number);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('The native AgentDock process identifier was not returned.');
  launched = { pid };
  const endpoint = 'http://127.0.0.1:' + port;
  const debuggerURL = await until(async () => {
    const { stdout } = await execFile('curl.exe', ['--noproxy', '*', '--max-time', '2', '-fsS', endpoint + '/json/version'], { timeout: 2600 });
    return JSON.parse(stdout).webSocketDebuggerUrl;
  }, 'WebView2 inspector');
  browser = await chromium.connectOverCDP(debuggerURL, { timeout: 10000 });
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(item => !item.url().startsWith('devtools')), 'workspace page');
  page.setDefaultTimeout(10000);
  if (suite === 'desktop') {
    page.on('pageerror', error => console.log('WEBVIEW ERROR ' + error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('WEBVIEW CONSOLE ' + message.text().slice(0, 350)); });
  }
  await page.getByRole('main', { name: 'Terminal workspace' }).waitFor();
  if (process.env.AGENTDOCK_TRACE_IPC === '1') {
    ipcTiming = [];
    const track = phase => request => {
      const url = new URL(request.url());
      if (url.hostname !== 'ipc.localhost' || !/^\/(workspace_save|terminal_create|terminal_attach|terminal_conceal)$/.test(url.pathname)) return;
      ipcTiming.push({ command: url.pathname.slice(1), phase, at: Math.round(performance.now()) });
      if (ipcTiming.length > 60) ipcTiming.shift();
    };
    page.on('request', track('start'));
    page.on('requestfinished', track('end'));
    page.on('requestfailed', track('failed'));
  }
  return { page, startup: nativeStartup, ready: Math.round(performance.now() - launchTime), browserProfile };
}

async function close(page) {
  const pid = launched.pid;
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process -Id ' + pid + ').CloseMainWindow() | Out-Null']);
  const decision = page.getByRole('dialog', { name: 'Close AgentDock' });
  await until(async () => !alive(pid) || await decision.isVisible().catch(() => false), 'close confirmation');
  if (alive(pid) && await decision.isVisible().catch(() => false)) {
    await decision.getByRole('button', { name: 'Close AgentDock' }).click();
  }
  await until(() => !alive(pid), 'AgentDock close');
  browser = null;
  launched = null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

const tty = page => page.locator('.pane.active .xterm-helper-textarea');
const buffer = page => page.locator('.pane.active .xterm-rows');
const textInTerminal = (page, text, timeout) => until(async () => (await buffer(page).textContent({ timeout: 1500 }))?.includes(text), 'terminal output ' + text, timeout);
function toolbar(page, name) {
  return page.getByRole('banner', { name: 'Workspace toolbar' }).getByRole('button', { name, exact: true });
}

function projects(page) {
  return page.getByRole('complementary', { name: 'Projects and terminals' });
}

async function switchProject(page, path) {
  await projects(page).getByRole('button', { name: projectName(path), exact: true }).click();
}

async function terminateActive(page) {
  const panel = page.locator('.pane.active');
  const id = await panel.getAttribute('data-session');
  await panel.getByRole('button', { name: /^Close terminal / }).click();
  const confirmation = page.getByRole('dialog', { name: 'Close terminal', exact: true });
  if (await confirmation.isVisible()) await confirmation.getByRole('button', { name: 'Close terminal' }).click();
  await page.locator('.pane[data-session="' + id + '"]').waitFor({ state: 'hidden', timeout: 100000 });
}

async function restoreFixtureWindow(page) {
  const minimized = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized', { label: 'main' }));
  if (!await minimized()) return;
  const script = `[void](Add-Type -Name AgentDockFixtureWindow -Namespace QA -PassThru -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);'); $p=Get-Process -Id ${launched.pid}; [void][QA.AgentDockFixtureWindow]::ShowWindowAsync($p.MainWindowHandle,9)`;
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000 });
  await until(async () => !await minimized(), 'restore the disposable QA window', 15000);
}

async function command(page, value) {
  await restoreFixtureWindow(page);
  await tty(page).focus();
  await page.keyboard.insertText(value);
  await page.keyboard.press('Enter');
}

async function openProject(page, folder, fromSidebar = false) {
  if (fromSidebar) {
    await page.getByRole('complementary', { name: 'Projects and terminals' })
      .getByRole('button', { name: 'New project' }).click();
    const menu = page.getByRole('dialog', { name: 'New project' });
    await menu.getByRole('button', { name: 'Clone repository' }).waitFor();
    await menu.getByRole('button', { name: 'Open folder' }).click();
  } else await toolbar(page, 'Open').click();
  const dialog = page.getByRole('dialog', { name: 'Open project folder' });
  await dialog.getByLabel('Folder path').fill(folder);
  await dialog.getByLabel('Ubuntu distribution').selectOption(distro);
  await dialog.getByRole('button', { name: 'Open project' }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function newShell(page, title = 'Blank terminal') {
  await page.getByRole('navigation', { name: 'Terminal tabs' }).getByRole('button', { name: 'New terminal' }).click();
  await page.getByRole('dialog', { name: 'New terminal' }).getByRole('button', { name: title, exact: true }).click();
  await restoreFixtureWindow(page);
  await tty(page).waitFor({ state: 'attached', timeout: 20000 });
  await until(() => page.locator('.pane.active .terminal-feedback:visible').count().then(count => count === 0), 'terminal attachment', 125000);
  if (title === 'Blank terminal') {
    await until(async () => /[$#%❯›>]\s*$/.test((await buffer(page).textContent({ timeout: 1500 }))?.trimEnd() || ''),
      'interactive Ubuntu shell prompt', 90000);
  }
}

async function dockToEdge(page, source, terminal, edge, order) {
  const target = page.locator('.pane[data-session="' + terminal + '"]');
  const bounds = await target.boundingBox();
  assert.ok(bounds);
  const x = edge === 'left' ? 10 : edge === 'right' ? bounds.width - 10 : bounds.width / 2;
  const y = edge === 'above' ? 10 : edge === 'below' ? bounds.height - 10 : bounds.height / 2;
  await source.dragTo(target, { targetPosition: { x, y } });
  const axis = edge === 'left' || edge === 'right' ? 'columns' : 'rows';
  await until(() => page.locator('.stage > .split.' + axis + ' > .pane').evaluateAll((panes, expected) =>
    panes.map(pane => pane.dataset.session).join(',') === expected.join(','), order), 'terminal docking ' + edge);
}

async function sample(label, count, startup, browserProfile) {
  if (!measure) return;
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `& '${measure.replaceAll("'", "''")}' -RootProcessId ${launched.pid} -RootExecutable '${exe.replaceAll("'", "''")}' -Label AgentDock -TerminalCount ${count} -StartupMilliseconds ${startup} -WebViewUserDataDirectory '${browserProfile.replaceAll("'", "''")}' -Samples 7 -IntervalSeconds 2 -QuietSeconds 4 -Proportional | ConvertTo-Json -Depth 6`],
  { timeout: 120000, maxBuffer: 1024 * 1024 });
  await writeFile(join(evidence, 'agentdock-' + label + '.json'), stdout);
  if (!count) return;
  const workspace = JSON.parse(await readFile(profile, 'utf8'));
  const expected = new Set(Object.values(workspace.sessions)
    .filter(session => session.profile === 'ubuntu' && fixturePaths.has(session.path))
    .map(session => 'ad-' + session.id));
  try {
    const panes = await wsl(['/usr/bin/tmux', '-L', 'agentdock-v1', 'list-panes', '-a', '-F',
      '#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}']);
    const pids = panes.stdout.trim().split(/\r?\n/).flatMap(row => {
      const [name, pid, dead, program] = row.split('\t');
      return expected.has(name) && dead === '0' && program === 'bash' && /^\d+$/.test(pid) ? [pid] : [];
    });
    if (pids.length === count) {
      const rss = await wsl(['/usr/bin/ps', '-o', 'rss=', '-p', pids.join(',')]);
      const samples = rss.stdout.trim().split(/\s+/).map(Number);
      if (samples.length === count && samples.every(value => Number.isFinite(value) && value > 0)) {
        const bashRssMiB = samples.reduce((total, current) => total + current, 0) / 1024;
        await writeFile(join(evidence, 'agentdock-' + label + '-linux.json'), JSON.stringify({ count, bashRssMiB }));
      }
    }
  } catch {
    console.log('INFO Linux shell RSS unavailable for this Windows sample');
  }
}

async function captureWorkspace() {
  const workspace = await readFile(profile, 'utf8').then(JSON.parse).catch(() => null);
  for (const session of Object.values(workspace?.sessions || {})) {
    const managed = !session.tmux || session.tmux.socket.endsWith('/agentdock-v1');
    if (managed && (session.profile === 'ubuntu' || session.backend === 'tmux') && fixturePaths.has(session.path)) {
      sessionIds.add(session.id);
    }
  }
}

function wsl(args) {
  return execFile('wsl.exe', ['--distribution', distro, '--exec', ...args], { timeout: 8000 });
}

function tmux(socket, ...args) {
  return wsl(['/usr/bin/tmux', '-S', socket, '-f', '/dev/null', ...args]);
}

async function closeTmuxFixture(socket) {
  await tmux(socket, 'kill-server').catch(() => {});
  await until(() => tmux(socket, 'list-sessions').then(() => false, error =>
    /no server running|No such file or directory/i.test(error.stderr || '')), 'fixture tmux server shutdown', 3000);
  await wsl(['/usr/bin/rm', '-f', '--', socket, socket + '.lock']);
}

async function openTmuxFixture(socket, name) {
  fixtureSockets.add(socket);
  await wsl(['/bin/sh', '-c', 'cd -- "$1" || exit; shift; exec "$@"', 'agentdock-qa', ubuntu,
    '/usr/bin/tmux', '-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', name,
    '/bin/bash', '--noprofile', '--norc', '-i']);
}

async function tmuxPanes(socket) {
  const { stdout } = await tmux(socket, 'list-panes', '-a', '-F',
    '#{session_id}\t#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_active}\t#{window_active}\t#{pane_left}\t#{pane_top}\t#{pane_current_command}');
  return stdout.trimEnd().split(/\r?\n/).filter(Boolean).map(row => {
    const [session, name, id, pid, paneActive, windowActive, left, top, command] = row.split('\t');
    return { session, name, id, pid: Number(pid), active: paneActive === '1' && windowActive === '1',
      left: Number(left), top: Number(top), command };
  });
}

async function waitForPanes(socket, name, predicate, check) {
  return until(async () => {
    const panes = (await tmuxPanes(socket)).filter(pane => pane.name === name);
    return predicate(panes) && panes;
  }, check);
}

async function pick(page, title, choice, search = choice) {
  const popup = page.getByRole('dialog', { name: title, exact: true });
  await popup.getByLabel('Search commands').fill(search);
  const entry = popup.getByRole('button', { name: choice, exact: true });
  await entry.waitFor();
  assert.equal(await popup.locator('.command-results button').count(), 1);
  await page.keyboard.press('Enter');
  await popup.waitFor({ state: 'hidden' });
}

async function paletteCommand(page, choice, shortcut = 'Control+Shift+P') {
  await page.keyboard.press(shortcut);
  await pick(page, 'Command palette', choice);
}

async function dismissIntro(page) {
  await page.waitForFunction(() => document.querySelector('.statusbar .reading strong')?.textContent.includes('GiB'));
  const skip = page.getByRole('button', { name: 'Skip intro' });
  if (await skip.isVisible()) await skip.click();
}

async function checkTmuxKeyboard() {
  const token = randomUUID().slice(0, 8);
  const name = 'adqa-' + token;
  const renamed = name + '-renamed';
  const other = name + '-other';
  const keeper = name + '-keeper';
  const temp = (await wsl(['/usr/bin/mktemp', '-d', '/tmp/agentdock-qa.XXXXXXXXXX'])).stdout.trim();
  assert.match(temp, /^\/tmp\/agentdock-qa\.[A-Za-z0-9]+$/);
  socketDirectory = temp;
  const socket = socketDirectory + '/default';
  const otherSocket = socketDirectory + '/alternate';
  await openTmuxFixture(socket, name);
  await openTmuxFixture(socket, keeper);
  await openTmuxFixture(otherSocket, other);
  const [original] = await waitForPanes(socket, name, panes => panes.length === 1, 'fixture tmux pane');
  const [secondary] = await waitForPanes(otherSocket, other, panes => panes.length === 1, 'other tmux socket');

  let { page } = await start();
  await dismissIntro(page);
  await openProject(page, ubuntu);
  const pin = projects(page).getByRole('button', { name: 'Pin ' + projectName(ubuntu), exact: true });
  if (await pin.isVisible()) await pin.click();
  await openProject(page, windows);
  if (!await projects(page).isVisible()) await toolbar(page, 'Toggle project sidebar').click();
  const keyboard = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  const saveShortcuts = keyboard.getByRole('button', { name: 'Save shortcuts' });
  await toolbar(page, 'Command palette').click();
  await pick(page, 'Command palette', 'Keyboard shortcuts');
  await keyboard.getByRole('button', { name: 'Restore defaults' }).click();
  await saveShortcuts.click();
  await keyboard.waitFor({ state: 'hidden' });
  const branch = page.getByRole('banner', { name: 'Workspace toolbar' }).locator('.branch');
  await until(() => branch.textContent({ timeout: 1000 }).then(text => text.trim() === 'main'), 'Windows fixture branch');
  await until(async () => {
    await toolbar(page, 'Command palette').focus();
    await page.keyboard.press('F6');
    return projects(page).evaluate(region => region.contains(document.activeElement));
  }, 'F6 from toolbar to Projects');
  await until(async () => {
    await projects(page).getByRole('button', { name: projectName(windows), exact: true }).focus();
    await page.keyboard.press('F6');
    return page.getByRole('navigation', { name: 'Terminal tabs' }).evaluate(region => region.contains(document.activeElement));
  }, 'F6 from Projects to terminal tabs');
  await page.keyboard.press('Control+Shift+L');
  await pick(page, 'Switch project', projectName(ubuntu));
  await switchProject(page, windows);
  await toolbar(page, 'Command palette').evaluate(button => button.dispatchEvent(new KeyboardEvent('keydown', {
    key: '&', code: 'Digit1', altKey: true, bubbles: true, cancelable: true,
  })));
  await until(() => projects(page).getByRole('button', { name: projectName(ubuntu), exact: true })
    .getAttribute('aria-pressed').then(value => value === 'true'), 'physical AZERTY pinned project key');
  result('Keyboard workspace region traversal, project picker and physical AZERTY number-row shortcut');

  await paletteCommand(page, 'Browse tmux sessions');
  const browse = page.getByRole('dialog', { name: 'Browse tmux sessions', exact: true });
  await browse.getByLabel('Search commands').fill(other);
  await browse.getByRole('button', { name: `${other} · ${distro} · 1 pane`, exact: true }).waitFor();
  const attachStart = performance.now();
  let promptTime;
  await pick(page, 'Browse tmux sessions', `${name} · ${distro} · 1 pane`);
  try {
    await until(async () => /\bbash-[\d.]+[$#]/.test(await buffer(page).textContent({ timeout: 1500 })), 'external Bash prompt');
    promptTime = Math.round(performance.now() - attachStart);
    await cmdAfterMount(page, `export AD_QA_TMUX_TOKEN=${token}; printf 'AD%s=%s\\n' 'QA_TMUX' "$AD_QA_TMUX_TOKEN"`);
    await textInTerminal(page, 'ADQA_TMUX=' + token);
  } catch (error) {
    const rows = await tmux(socket, 'capture-pane', '-p', '-t', original.id).catch(() => null);
    if (rows) console.error('Synthetic initial Bash diagnostic', rows.stdout.trim().slice(-600));
    throw error;
  }
  const external = await page.locator('.pane.active').getAttribute('data-session');
  const [adopted] = await waitForPanes(socket, name, panes => panes.length === 1, 'external attach PID');
  assert.equal(adopted.pid, original.pid);
  assert.equal(adopted.session, original.session);
  result(`Discovered external tmux sessions on two sockets and attached to the original interactive shell (${promptTime} ms to Bash prompt)`);

  const historyMarker = 'ADQA_HISTORY_' + token;
  await command(page, `printf 'AD%s%s\\n' 'QA_HISTORY_' '${token}'; for ((i=0;i<120;i++)); do printf 'qa scrollback %s\\n' "$i"; done`);
  await textInTerminal(page, 'qa scrollback 119');
  assert.ok(!(await buffer(page).textContent()).includes(historyMarker), 'search term is past the visible terminal rows');
  const pane = page.locator('.pane.active');
  await pane.getByRole('button', { name: 'Find in terminal', exact: true }).click();
  const find = pane.getByRole('textbox', { name: 'Find in terminal', exact: true });
  await find.fill(historyMarker);
  await pane.getByRole('button', { name: 'tmux history', exact: true }).click();
  try {
    await find.waitFor({ state: 'hidden', timeout: 25000 });
    await textInTerminal(page, historyMarker);
  } catch (error) {
    const notice = page.locator('#notice:visible .notice-message');
    if (await notice.isVisible()) console.error('Synthetic tmux history notice', await notice.textContent());
    throw error;
  }
  await until(async () => {
    const { stdout } = await tmux(socket, 'display-message', '-p', '-t', original.id, '#{pane_in_mode} #{scroll_position}');
    const [mode, scroll] = stdout.trim().split(' ').map(Number);
    return mode === 1 && scroll > 0;
  }, 'tmux scrollback search enters copy mode and scrolls');
  await tty(page).focus();
  await page.keyboard.press('Escape');
  await until(async () => (await tmux(socket, 'display-message', '-p', '-t', original.id, '#{pane_in_mode}')).stdout.trim() === '0',
    'leave tmux history copy mode');
  result('The terminal Find toolbar searched native tmux scrollback and returned to interactive input');

  await paletteCommand(page, 'Rename tmux session');
  const rename = page.getByRole('dialog', { name: 'Rename tmux session', exact: true });
  assert.equal(await rename.getByLabel('Session name').inputValue(), name);
  await rename.getByLabel('Session name').fill(renamed);
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  await rename.waitFor({ state: 'hidden' });
  const [renamedPane] = await waitForPanes(socket, renamed, panes => panes.length === 1, 'external rename');
  assert.equal(renamedPane.pid, original.pid);
  assert.equal(renamedPane.session, original.session);
  assert.deepEqual((await tmuxPanes(otherSocket)).find(pane => pane.name === other), secondary);
  result('Renamed the intended external tmux session without restarting it or touching the other socket');

  await paletteCommand(page, 'Manage tmux panes');
  await pick(page, 'Manage tmux panes', 'Split tmux pane right');
  const rightSplit = await waitForPanes(socket, renamed, panes => panes.length === 2, 'right tmux split');
  const right = rightSplit.find(pane => pane.id !== original.id);
  assert.ok(right.active && right.left > 0 && right.top === 0);
  assert.equal(rightSplit.find(pane => pane.id === original.id).pid, original.pid);
  await paletteCommand(page, 'Manage tmux panes');
  await pick(page, 'Manage tmux panes', `Focus ${original.id} · ${original.command} · running`);
  await waitForPanes(socket, renamed, panes => panes.some(pane => pane.id === original.id && pane.active), 'focus original tmux pane');
  await paletteCommand(page, 'Manage tmux panes');
  await pick(page, 'Manage tmux panes', `Focus ${right.id} · ${right.command} · running`);
  await waitForPanes(socket, renamed, panes => panes.some(pane => pane.id === right.id && pane.active), 'focus right tmux pane');
  await paletteCommand(page, 'Manage tmux panes');
  await pick(page, 'Manage tmux panes', 'Close focused tmux pane');
  await page.getByRole('dialog', { name: 'Close tmux pane', exact: true }).getByRole('button', { name: 'Close pane', exact: true }).click();
  const [remaining] = await waitForPanes(socket, renamed, panes => panes.length === 1, 'close selected tmux pane');
  assert.equal(remaining.pid, original.pid);
  result('Managed real tmux right split, exact focus, and confirmed pane close without ending the original shell');

  await paletteCommand(page, 'Keyboard shortcuts');
  const paletteBinding = keyboard.getByLabel('Command palette', { exact: true });
  await paletteBinding.fill('Ctrl+Shift+T');
  await saveShortcuts.click();
  await keyboard.getByRole('alert').filter({ hasText: 'also assigned' }).waitFor();
  await paletteBinding.fill('Ctrl+F9');
  await keyboard.getByLabel('Toggle terminal passthrough', { exact: true }).fill('Ctrl+F8');
  await keyboard.getByLabel('Split tmux pane below', { exact: true }).fill('Ctrl+F7');
  await saveShortcuts.click();
  await keyboard.waitFor({ state: 'hidden' });

  await tty(page).focus();
  await page.keyboard.press('Control+F8');
  const passThrough = page.getByRole('button', { name: 'Terminal keys · Ctrl+Shift+Space', exact: true });
  await passThrough.waitFor();
  await page.keyboard.press('Control+F9');
  assert.equal(await page.getByRole('dialog', { name: 'Command palette', exact: true }).count(), 0);
  await page.keyboard.press('Control+Shift+Space');
  await passThrough.waitFor({ state: 'hidden' });
  // The deliberate passthrough chord may leave a partial readline input in this disposable shell.
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+F7');
  const bottomSplit = await waitForPanes(socket, renamed, panes => panes.length === 2, 'custom binding for bottom tmux split');
  const bottom = bottomSplit.find(pane => pane.id !== original.id);
  assert.ok(bottom.active && bottom.top > 0 && bottom.left === 0);
  await paletteCommand(page, 'Manage tmux panes', 'Control+F9');
  await pick(page, 'Manage tmux panes', 'Close focused tmux pane');
  await page.getByRole('dialog', { name: 'Close tmux pane', exact: true }).getByRole('button', { name: 'Close pane', exact: true }).click();
  await waitForPanes(socket, renamed, panes => panes.length === 1 && panes[0].pid === original.pid, 'restore single external pane');
  result('Rejected a conflicting shortcut, honored custom palette and tmux split keys, and recovered from terminal passthrough');

  await tty(page).focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await until(() => page.locator('.stage > .split.columns > .pane').count().then(count => count === 2), 'workspace keyboard split');
  const adjacent = await page.locator('.pane.active').getAttribute('data-session');
  assert.notEqual(adjacent, external);
  await tty(page).focus();
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await until(() => page.locator('.pane.active').getAttribute('data-session').then(id => id === external), 'keyboard focus left workspace pane');
  await page.keyboard.press('Control+Alt+ArrowRight');
  await until(() => page.locator('.pane.active').getAttribute('data-session').then(id => id === adjacent), 'keyboard focus right workspace pane');
  const neighbor = await page.locator('.pane.active').getAttribute('aria-label');
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await until(() => page.locator('.pane.active').getAttribute('data-session').then(id => id === external), 'focus tmux shell before keyboard move');
  await paletteCommand(page, 'Move terminal to another pane', 'Control+F9');
  await pick(page, 'Move terminal to another pane', `${neighbor} · ${projectName(ubuntu)}`);
  await pick(page, 'Place terminal', 'Below');
  await until(() => page.locator('.stage > .split.rows > .pane').evaluateAll((panes, ids) =>
    panes.length === ids.length && panes.every((pane, index) => pane.dataset.session === ids[index]), [adjacent, external]),
    'keyboard move to bottom workspace pane');
  await waitForPanes(socket, renamed, panes => panes.length === 1 && panes[0].pid === original.pid, 'keyboard move preserves tmux Bash');
  await tty(page).focus();
  await page.keyboard.press('Control+Alt+ArrowUp');
  await until(() => page.locator('.pane.active').getAttribute('data-session').then(id => id === adjacent), 'keyboard focus above moved pane');
  await terminateActive(page);
  await waitForPanes(socket, renamed, panes => panes.length === 1 && panes[0].pid === original.pid, 'workspace split is independent of tmux');
  result('Keyboard split, directional focus, and pane movement preserved the original tmux Bash process');

  await page.keyboard.press('Control+Shift+H');
  await page.locator('.pane[data-session="' + external + '"]').waitFor({ state: 'hidden' });
  await waitForPanes(socket, renamed, panes => panes.length === 1 && panes[0].pid === original.pid, 'external shell survives detach');
  const sessions = page.getByRole('complementary', { name: 'Sessions' });
  if (!await sessions.isVisible()) await paletteCommand(page, 'Toggle Sessions', 'Control+F9');
  await sessions.getByLabel('Find sessions').fill(other);
  await sessions.getByLabel('Filter sessions').selectOption({ label: 'Discovered tmux sessions' });
  await sessions.getByRole('listitem').getByText(other, { exact: true }).waitFor();
  await sessions.getByLabel('Find sessions').fill(renamed);
  await sessions.getByLabel('Filter sessions').selectOption('all');
  const hidden = sessions.getByRole('listitem').filter({ hasText: renamed });
  await hidden.getByText('Hidden', { exact: true }).waitFor();
  await hidden.locator('[data-session-action=open]').click();
  try {
    await cmdAfterMount(page, `printf 'AD%s=%s\\n' 'QA_REATTACHED' "$AD_QA_TMUX_TOKEN"`);
    await textInTerminal(page, 'ADQA_REATTACHED=' + token);
  } catch (error) {
    const rows = await tmux(socket, 'capture-pane', '-p', '-t', original.id, '-S', '-8').catch(() => null);
    if (rows) console.error('Synthetic tmux pane diagnostic', rows.stdout.trim().slice(-600));
    throw error;
  }
  const closeSessions = sessions.getByRole('button', { name: 'Hide Sessions panel', exact: true });
  if (await closeSessions.isVisible()) await closeSessions.click();
  result('Detached with the keyboard, discovered a separate socket in Sessions and reattached without losing shell state');

  await switchProject(page, windows);
  await newShell(page, 'PowerShell');
  const powershell = await page.locator('.pane.active').getAttribute('data-session');
  try {
    await textInTerminal(page, `PS ${windows}>`);
    await command(page, `$env:AD_QA_WINDOWS_TOKEN='${token}'; Write-Output ('AD'+'QA_WINDOWS_PID='+$PID); (Get-Location).Path`);
    await textInTerminal(page, 'ADQA_WINDOWS_PID=');
    await textInTerminal(page, windows);
  } catch (error) {
    assert.match(powershell, /^[a-f0-9-]{36}$/i);
    const rows = await wsl(['/usr/bin/tmux', '-L', 'agentdock-v1', '-f', '/dev/null',
      'capture-pane', '-p', '-t', '=ad-' + powershell + ':', '-S', '-6']).catch(() => null);
    if (rows) console.error('Synthetic PowerShell pane diagnostic', rows.stdout.trim().slice(-700));
    throw error;
  }
  const shellPid = Number((await buffer(page).textContent()).match(/ADQA_WINDOWS_PID=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(shellPid) && alive(shellPid), 'fixture Windows PowerShell process exists');
  await captureWorkspace();
  assert.ok(sessionIds.has(powershell), 'the default PowerShell profile saves app-owned tmux metadata');
  await close(page);
  assert.equal(alive(shellPid), true, 'Windows PowerShell survives closing AgentDock');
  await waitForPanes(socket, renamed, panes => panes.length === 1 && panes[0].pid === original.pid, 'external shell survives desktop close');
  ({ page } = await start());
  await dismissIntro(page);
  await page.locator('[data-terminal-id="' + powershell + '"]').click();
  await cmdAfterMount(page, "Write-Output ('AD'+'QA_WINDOWS_REATTACHED='+$PID+'/'+$env:AD_QA_WINDOWS_TOKEN)");
  await textInTerminal(page, `ADQA_WINDOWS_REATTACHED=${shellPid}/${token}`);
  await page.keyboard.press('Control+Shift+U');
  await pick(page, 'Switch terminal session', `${projectName(ubuntu)} · ${renamed}`);
  await cmdAfterMount(page, `printf 'AD%s=%s\\n' 'QA_REOPENED' "$AD_QA_TMUX_TOKEN"`);
  await textInTerminal(page, 'ADQA_REOPENED=' + token);
  result('Reopened the native window with both external Ubuntu and managed Windows PowerShell processes intact');

  await paletteCommand(page, 'Rename tmux session', 'Control+F9');
  const staleRename = page.getByRole('dialog', { name: 'Rename tmux session', exact: true });
  await staleRename.getByLabel('Session name').fill(name + '-stale-write');
  await tmux(socket, 'kill-session', '-t', original.session);
  await openTmuxFixture(socket, renamed);
  const [replacement] = await waitForPanes(socket, renamed, panes => panes.length === 1, 'replacement external session');
  assert.notEqual(replacement.session, original.session);
  await staleRename.getByRole('button', { name: 'Rename', exact: true }).click();
  await staleRename.getByRole('alert').filter({ hasText: 'changed or is no longer available' }).waitFor();
  assert.deepEqual((await tmuxPanes(socket)).find(pane => pane.name === renamed), replacement);
  await staleRename.getByRole('button', { name: 'Close', exact: true }).click();
  result('Persisted the custom shortcut and rejected a stale tmux rename without touching the replacement session');

  await switchProject(page, windows);
  await page.locator('[data-terminal-id="' + powershell + '"]').click();
  await terminateActive(page);
  await until(() => !alive(shellPid), 'explicit close ends the owned default PowerShell process');
  result('Explicit close ended the managed Windows PowerShell process');
  await close(page);
}

async function checkDesktop() {
  let { page, startup, ready, browserProfile } = await start();
  await page.waitForFunction(() => document.querySelector('.statusbar .reading strong')?.textContent.includes('GiB'));
  const clip = page.locator('.intro-video');
  if (!await clip.count()) {
    await toolbar(page, 'Command palette').click();
    await page.getByRole('button', { name: 'Replay Tux intro', exact: true }).click();
  }
  await until(() => clip.evaluate(video => video.currentTime > 0 && video.videoWidth === 640), 'Tux video decoding', 2800);
  await page.getByRole('button', { name: 'Skip intro' }).click();
  result('Native WebView2 Tux clip decoded, playback and skip');
  await sample('idle', 0, startup, browserProfile);
  result('Native window in ' + startup + ' ms and workspace observed through CDP in ' + ready + ' ms');
  await restoreFixtureWindow(page);
  await openProject(page, ubuntu, true);
  await newShell(page);
  await command(page, "export ADKEEP=keep; printf '\\033[31mAD%s λ雪\\033[0m\\n' 'ANSI'; pwd");
  await textInTerminal(page, 'ADANSI λ雪');
  await textInTerminal(page, ubuntu);
  await command(page, 'printf "ADPLATFORM=%s/%s\\n" "$(uname -s)" "$WSL_DISTRO_NAME"');
  await textInTerminal(page, 'ADPLATFORM=Linux/' + distro);
  const linuxId = await page.locator('.pane.active').getAttribute('data-session');
  const linuxTab = await page.locator('.tab[aria-current=page]').getAttribute('data-tab-id');
  result('Ubuntu real PTY, ANSI, Unicode, Linux kernel, exact WSL distribution and cwd');
  await projects(page).getByRole('button', { name: 'Pin ' + projectName(ubuntu), exact: true }).click();
  assert.equal(await projects(page).getByRole('button', { name: projectName(ubuntu), exact: true })
    .getAttribute('aria-keyshortcuts'), 'Alt+1');

  await openProject(page, windows);
  assert.equal(await page.locator('.pane').count(), 0);
  assert.equal(await page.locator('.tab').count(), 0);
  assert.equal(await projects(page).locator('[data-terminal-id]').count(), 0);
  result('A new project starts with an empty workspace while the other project stays live');
  await projects(page).getByRole('button', { name: 'Pin ' + projectName(windows), exact: true }).click();
  assert.equal(await projects(page).getByRole('button', { name: projectName(windows), exact: true })
    .getAttribute('aria-keyshortcuts'), 'Alt+2');
  await newShell(page, 'PowerShell (native compatibility)');
  await command(page, "Write-Output ('AD'+'POWER'); (Get-Location).Path");
  await textInTerminal(page, 'ADPOWER');
  await textInTerminal(page, windows);
  await command(page, "$t=Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 90' -WindowStyle Hidden -PassThru; Write-Output ('AD'+'CHILD='+$t.Id)");
  await textInTerminal(page, 'ADCHILD=');
  const childPid = Number((await buffer(page).textContent()).match(/ADCHILD=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(childPid) && alive(childPid), 'controlled PowerShell child process exists');
  const windowsId = await page.locator('.pane.active').getAttribute('data-session');
  result('Windows folder and interactive PowerShell ConPTY');
  await toolbar(page, 'Worktrees').click();
  const nativeTrees = page.getByRole('dialog', { name: 'Git worktrees' });
  await nativeTrees.getByText('windows-linked', { exact: true }).waitFor();
  await nativeTrees.getByRole('button', { name: 'Close' }).click();
  result('Discovered linked worktree created by Git for Windows');
  await page.keyboard.press('Alt+Digit1');
  await until(() => projects(page).getByRole('button', { name: projectName(ubuntu), exact: true })
    .getAttribute('aria-pressed').then(value => value === 'true'), 'pinned project shortcut');
  result('Project pinning assigns keyboard shortcuts that switch workspaces');
  assert.equal(await page.locator('.tab').count(), 1);
  await projects(page).getByRole('button', { name: 'Expand ' + windows.split(/\\/).at(-1) }).click();
  const windowsRow = page.locator('[data-terminal-id="' + windowsId + '"]');
  await windowsRow.dragTo(page.locator('[data-tab-id="' + linuxTab + '"]'));
  await until(() => page.locator('.pane').count().then(count => count === 2), 'cross-project split');
  result('Dragged PowerShell across tabs into a split with the Ubuntu terminal');
  const windowsPane = page.locator('.pane[data-session="' + windowsId + '"] .pane-caption');
  await dockToEdge(page, windowsRow, linuxId, 'left', [windowsId, linuxId]);
  await dockToEdge(page, windowsPane, linuxId, 'above', [windowsId, linuxId]);
  await dockToEdge(page, windowsPane, linuxId, 'below', [linuxId, windowsId]);
  await dockToEdge(page, windowsPane, linuxId, 'right', [linuxId, windowsId]);
  assert.ok(alive(childPid), 'moving the pane preserved the running Windows process');
  result('Projects plus and terminal plus are distinct. Sidebar and pane drag dock across projects on all four edges');
  const terminalTabs = page.getByRole('navigation', { name: 'Terminal tabs' });
  const sessionsPanel = page.getByRole('complementary', { name: 'Sessions' });
  await terminalTabs.getByRole('button', { name: 'Sessions' }).click();
  assert.equal(await sessionsPanel.locator('[data-session-action=open][data-session-id="' + windowsId + '"]').count(), 0);
  await sessionsPanel.getByLabel('Filter sessions').selectOption('running');
  await sessionsPanel.getByRole('button', { name: 'Layouts' }).click();
  const layouts = page.getByRole('dialog', { name: 'Layout presets' });
  await layouts.getByLabel('Name for current layout').fill('Verification split');
  await layouts.getByRole('button', { name: 'Save current layout' }).click();
  await layouts.getByText('Verification split', { exact: true }).waitFor();
  await layouts.getByRole('button', { name: 'Close' }).click();
  await sessionsPanel.locator('[data-session-action=hide][data-session-id="' + windowsId + '"]').click();
  await until(() => page.locator('.pane').count().then(count => count === 1), 'session renderer hidden');
  assert.ok(alive(childPid), 'hiding the pane preserved its process');
  await sessionsPanel.getByRole('button', { name: 'Layouts' }).click();
  await layouts.getByRole('button', { name: 'Restore' }).click();
  await until(() => page.locator('.pane').count().then(count => count === 2), 'saved layout restored');
  await layouts.waitFor({ state: 'hidden' });
  if (await page.evaluate(() => matchMedia('(max-width: 1399px)').matches)) {
    await sessionsPanel.waitFor({ state: 'hidden' });
  } else {
    await sessionsPanel.getByRole('button', { name: 'Hide Sessions panel' }).click();
  }
  result('Sessions rail hides renderers, keeps their processes alive and restores a named layout');
  await page.locator('.pane.active').getByRole('button', { name: /^Close terminal / }).click();
  await page.getByRole('dialog', { name: 'Close terminal', exact: true }).getByRole('button', { name: 'Cancel' }).click();
  assert.ok(alive(childPid), 'canceling Close preserved the process');
  await terminateActive(page);
  assert.equal(await page.locator('.pane.active').getAttribute('data-session'), linuxId);
  await until(() => page.locator('[data-terminal-id]').count().then(count => count === 1), 'bounded PowerShell termination');
  await until(() => !alive(childPid), 'PowerShell process job cleanup');
  result('Explicit PowerShell termination cleaned its controlled child process');

  await page.locator('[data-terminal-id="' + linuxId + '"]').click();
  await cmdAfterMount(page, 'printf "AD%s\\n" "$ADKEEP"');
  await textInTerminal(page, 'ADkeep');
  result('Project switch detached and reattached Ubuntu without replacing its shell');
  await command(page, "printf '\\a'");
  await page.locator('.pane.active[data-alert=bell]').waitFor({ timeout: 14000 });
  await page.locator('.pane.active').getByRole('button', { name: 'Terminal actions' }).click();
  await page.getByRole('button', { name: 'Acknowledge terminal attention' }).click();
  await page.locator('.pane.active[data-alert=bell]').waitFor({ state: 'hidden' });
  result('An actual Ubuntu terminal bell lights the pane and can be acknowledged');

  await page.locator('.pane.active').getByRole('button', { name: 'Terminal actions' }).click();
  await page.getByRole('button', { name: 'Split top and bottom' }).click();
  const divider = page.getByRole('separator', { name: 'Resize split' });
  await divider.waitFor();
  assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal');
  const prior = await divider.getAttribute('aria-valuenow');
  await divider.press('ArrowDown');
  assert.notEqual(await divider.getAttribute('aria-valuenow'), prior);
  await page.locator('.pane.active').getByRole('button', { name: 'Maximize pane' }).click();
  await until(() => page.locator('.pane').count().then(count => count === 1), 'pane maximize');
  await page.locator('.pane.active').getByRole('button', { name: 'Restore pane' }).click();
  await until(() => page.locator('.pane').count().then(count => count === 2), 'pane restore');
  result('Split, keyboard resize, maximize and restore');

  await toolbar(page, '.env').click();
  const env = page.getByRole('dialog', { name: 'Environment variables' });
  await env.getByRole('button', { name: 'Reveal', exact: true }).first().waitFor();
  assert.equal(await env.getByLabel('Variable 1 value').count(), 0);
  await env.getByRole('button', { name: 'Reveal', exact: true }).first().click();
  await env.getByLabel('Variable 1 value').fill('agentdock-fixture\nsecond line');
  await env.getByRole('button', { name: 'Save file' }).click();
  await until(() => env.getByLabel('Variable 1 value').count().then(count => count === 0), 'masked saved value');
  await env.getByRole('button', { name: 'Close' }).click();
  result('Masked WSL dotenv reveal, multiline atomic save and remask');

  await toolbar(page, 'Worktrees').click();
  const trees = page.getByRole('dialog', { name: 'Git worktrees' });
  await trees.getByText('dock-worktree', { exact: true }).waitFor();
  assert.equal(await projects(page).getByText('dock-worktree', { exact: true }).count(), 0);
  const linked = trees.locator('.worktree-row').filter({ hasText: 'dock-worktree' });
  const linkedPath = await linked.locator('.dialog-path').textContent();
  fixturePaths.add(linkedPath);
  await linked.getByRole('button', { name: 'New terminal' }).click();
  await cmdAfterMount(page, 'printf "AD%s=%s\\n" LINKED "$PWD"');
  await textInTerminal(page, 'ADLINKED=' + linkedPath);
  const worktreeId = await page.locator('.pane.active').getAttribute('data-session');
  await newShell(page);
  await command(page, 'printf "AD%s=%s\\n" ROOT "$PWD"');
  await textInTerminal(page, 'ADROOT=' + ubuntu);
  const exitedId = await page.locator('.pane.active').getAttribute('data-session');
  await command(page, 'exit');
  await projects(page).locator('[data-terminal-id="' + exitedId + '"]').waitFor({ state: 'hidden', timeout: 15000 });
  await terminateActive(page);
  await page.locator('[data-terminal-id="' + worktreeId + '"]').click();
  await terminateActive(page);
  await page.locator('[data-terminal-id="' + linuxId + '"]').click();
  result('Worktrees stay off the sidebar. Explicit worktree launch works, regular New Terminal opens the root, and exited sessions leave the sidebar');
  await toolbar(page, 'Development').click();
  const dev = page.getByRole('dialog', { name: 'Development' });
  await dev.getByText('Local branches', { exact: true }).waitFor();
  await dev.getByRole('button', { name: 'Load pull requests' }).click();
  await until(() => dev.getByRole('button', { name: 'Refresh' }).count().then(count => count > 1), 'GitHub CLI response');
  await dev.getByRole('button', { name: 'Load containers' }).click();
  await until(() => dev.getByRole('button', { name: 'Refresh' }).count().then(count => count > 2), 'Docker CLI response');
  if (process.env.AGENTDOCK_REQUIRE_DOCKER === '1') {
    await dev.getByText(/^(Local Windows Docker Desktop|Ubuntu Docker context|Windows Docker context)$/).waitFor();
    result('Development panel connected to the existing Docker engine');
  }
  await dev.getByRole('button', { name: 'Done' }).click();
  result('CLI-based worktree, branch and on-demand Docker panel');

  await toolbar(page, 'Merge local branch').click();
  await page.getByLabel('Source branch').selectOption('dock-feature');
  await page.getByRole('dialog', { name: 'Merge local branch' }).getByRole('button', { name: 'Merge branch' }).click();
  await page.getByRole('dialog', { name: 'Confirm local merge' }).getByRole('button', { name: 'Merge', exact: true }).click();
  await page.getByText('SHHHHHIPPPPP ITTTTTTTTT 🚂🚂🚂🚂', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dismiss merge celebration' }).click();
  result('Local branch merge triggered the exact train celebration');
  await cmdAfterMount(page, 'git merge --no-edit agent-feature');
  await page.getByText('SHHHHHIPPPPP ITTTTTTTTT 🚂🚂🚂🚂', { exact: true }).waitFor({ timeout: 26000 });
  await page.getByRole('button', { name: 'Dismiss merge celebration' }).click();
  result('Terminal-performed Git merge triggered Ship It via the worktree reflog');

  await toolbar(page, 'Clone').click();
  const clone = page.getByRole('dialog', { name: 'Clone repository' });
  await clone.getByLabel('Repository URL or path').fill(ubuntu);
  assert.equal(await clone.getByLabel('New folder').inputValue(), '~/projects/' + projectName(ubuntu));
  await clone.getByLabel('New folder').fill(ubuntu + '-clone');
  await clone.getByRole('button', { name: 'Clone' }).click();
  await clone.waitFor({ state: 'hidden', timeout: 30000 });
  await until(async () => {
    const current = JSON.parse(await readFile(profile, 'utf8'));
    return current.projects.some(item => item.path === ubuntu + '-clone');
  }, 'exact clone destination');
  result('Local Git CLI clone created and opened the requested Ubuntu path');
  assert.equal(await page.locator('.tab').count(), 0);
  await switchProject(page, ubuntu);
  await page.locator('[data-terminal-id="' + linuxId + '"]').click();

  const outputStarted = performance.now();
  await cmdAfterMount(page, "seq 1 12000; printf 'AD%s\\n' HIGHOUTPUT");
  await textInTerminal(page, 'ADHIGHOUTPUT', 30000);
  result('ConPTY/tmux rendered the marker after 12,000 lines in ' + Math.round(performance.now() - outputStarted) + ' ms');

  await toolbar(page, 'Workflows').click();
  const workflows = page.getByRole('dialog', { name: 'Workflow prompts' });
  await workflows.getByRole('combobox', { name: 'Workflow template' }).selectOption({ label: 'Engineering workflow (built-in)' });
  assert.match(await workflows.getByLabel('Preview').inputValue(), /Agentic engineering workflow/);
  await workflows.getByRole('button', { name: 'Close' }).click();
  result('Built-in Markdown workflow is selectable in the active terminal');

  const total = () => page.locator('[data-terminal-id]').count();
  while (await total() < 10) await newShell(page);
  await sample('ten', 10, startup, browserProfile);
  while (await total() < 20) await newShell(page);
  await until(() => page.getByRole('contentinfo', { name: 'System resources' }).getByText('20', { exact: true }).isVisible(), 'twenty active sessions', 28000);
  assert.equal(await page.locator('.terminal-renderer').count(), 1);
  await page.screenshot({ path: join(evidence, 'twenty-sessions.png') });
  await captureWorkspace();
  result('Twenty live controlled terminals, single workspace and bounded renderer attachment');

  for (let index = 0; index < 3; index++) {
    await newShell(page);
    const pane = page.locator('.pane.active');
    const id = await pane.getAttribute('data-session');
    await terminateActive(page);
    await until(() => page.locator('[data-terminal-id="' + id + '"]').count().then(count => count === 0), 'fixture terminal termination');
  }
  result('Three repeated Ubuntu create-and-terminate cycles under the 20-session load');

  await openProject(page, windows);
  await newShell(page, 'PowerShell (native compatibility)');
  const closingPowerShell = await page.locator('.pane.active').getAttribute('data-session');
  await switchProject(page, ubuntu);
  await page.locator('[data-terminal-id="' + linuxId + '"]').click();
  await tty(page).waitFor({ state: 'attached', timeout: 20000 });
  await close(page);
  ({ page } = await start());
  const skip = page.getByRole('button', { name: 'Skip intro' });
  if (await skip.isVisible()) await skip.click();
  assert.equal(await projects(page).getByRole('button', { name: projectName(ubuntu), exact: true })
    .getAttribute('aria-keyshortcuts'), 'Alt+1');
  assert.equal(await projects(page).getByRole('button', { name: projectName(windows), exact: true })
    .getAttribute('aria-keyshortcuts'), 'Alt+2');
  await page.locator('[data-terminal-id="' + linuxId + '"]').click();
  await cmdAfterMount(page, 'printf "AD%s\\n" "$ADKEEP"');
  await textInTerminal(page, 'ADkeep');
  result('Native close/reopen restored the persisted Ubuntu shell');
  await page.getByRole('navigation', { name: 'Terminal tabs' }).getByRole('button', { name: 'Sessions' }).click();
  const restoredSessions = page.getByRole('complementary', { name: 'Sessions' });
  await restoredSessions.getByLabel('Filter sessions').selectOption('all');
  await restoredSessions.locator('[data-session-action=open][data-session-id="' + closingPowerShell + '"]').click();
  await page.getByText('This PowerShell terminal has ended.', { exact: false }).waitFor();
  result('Closing with an active PowerShell prompted and reopening did not start a new PowerShell');
  await close(page);
}

async function checkClipboard() {
  const { page } = await start();
  await dismissIntro(page);
  await openProject(page, ubuntu);
  await newShell(page);
  await page.evaluate(() => {
    const endpoint = window.__TAURI_INTERNALS__.convertFileSrc('clipboard_read', 'ipc');
    const fetchNative = window.fetch.bind(window);
    window.clipboardFixture = { value: null, reads: 0 };
    window.fetch = (url, options) => {
      if (url !== endpoint) return fetchNative(url, options);
      const fixture = window.clipboardFixture;
      fixture.reads++;
      return Promise.resolve(new Response(JSON.stringify(fixture.value), {
        headers: { 'content-type': 'application/json', 'tauri-response': 'ok' },
      }));
    };
  });
  const setClipboard = value => page.evaluate(value => { window.clipboardFixture.value = value; }, value);
  const waitForTerminalText = text => until(async () => {
    await restoreFixtureWindow(page);
    return (await buffer(page).textContent({ timeout: 1500 }))?.includes(text);
  }, `clipboard fixture output ${text}`);
  const pressInTerminal = async chord => {
    await restoreFixtureWindow(page);
    await tty(page).press(chord);
  };
  for (const [chord, text] of [['Control+v', 'AgentDock λ雪 text'], ['Control+Shift+V', 'AgentDock second paste']]) {
    await setClipboard(text);
    await command(page, `IFS= read -r line; printf 'AD_%s<%s>\\n' 'CLIP' "$line"`);
    await pressInTerminal(chord);
    await waitForTerminalText(text);
    await pressInTerminal('Enter');
    await waitForTerminalText(`AD_CLIP<${text}>`);
    result(`${chord} pasted the fixture text into the Ubuntu terminal exactly once`);
  }

  await setClipboard(null);
  await command(page, `python3 -c 'import os, termios, tty; fd = 0; old = termios.tcgetattr(fd); tty.setraw(fd); print("AD_RAW_" + "READY", flush=True); byte = os.read(fd, 1); termios.tcsetattr(fd, termios.TCSADRAIN, old); print("AD_RAW_BYTE=" + byte.hex())'`);
  await waitForTerminalText('AD_RAW_READY');
  await pressInTerminal('Control+v');
  await waitForTerminalText('AD_RAW_BYTE=16');
  result('Ctrl+V forwarded the native control key when the clipboard supplied no text');
  await terminateActive(page);

  if (process.env.AGENTDOCK_VERIFY_CODEX === '1') {
    await newShell(page, 'Codex');
    await waitForTerminalText('Codex');
    const text = 'AgentDock clipboard Codex fixture';
    await setClipboard(text);
    await pressInTerminal('Control+v');
    await waitForTerminalText(text);
    result('Ctrl+V inserted text into the Codex input');
    await terminateActive(page);
  }
  await close(page);
}

try {
  if (suite === 'tmux-keyboard') await checkTmuxKeyboard();
  else if (suite === 'clipboard') await checkClipboard();
  else await checkDesktop();
} catch (error) {
  console.error(error);
  const faultPage = browser?.contexts()[0]?.pages()[0];
  if (faultPage) {
    const diagnostics = await faultPage.evaluate(async () => ({
      visibility: document.visibilityState,
      pane: document.querySelector('.pane.active .terminal-feedback:not([hidden])')?.textContent,
      clipboardFixtureReads: window.clipboardFixture?.reads,
      minimized: await window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized', { label: 'main' }).catch(() => null),
    })).catch(() => null);
    console.error('Window diagnostic', JSON.stringify(diagnostics));
    if (ipcTiming.length) console.error('Native IPC timing', JSON.stringify(ipcTiming));
  }
  if (suite === 'desktop') await faultPage?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await captureWorkspace();
  // This is only the exact child created by this script and fixture session IDs.
  if (launched && alive(launched.pid)) process.kill(launched.pid);
  for (const id of sessionIds) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
    const owned = ['/usr/bin/tmux', '-L', 'agentdock-v1', '-f', '/dev/null'];
    const target = '=ad-' + id;
    await wsl([...owned, 'has-session', '-t', target])
      .then(() => wsl([...owned, 'kill-session', '-t', target])).catch(() => {});
  }
  for (const socket of fixtureSockets) {
    await closeTmuxFixture(socket).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
  if (socketDirectory) {
    await wsl(['/usr/bin/rmdir', '--', socketDirectory]).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
  await writeFile(join(evidence, suite + '-checks.json'), JSON.stringify(report, null, 2));
}

async function cmdAfterMount(page, value) {
  await restoreFixtureWindow(page);
  await tty(page).waitFor({ state: 'attached', timeout: 20000 });
  await until(() => page.locator('.pane.active .terminal-feedback:visible').count().then(count => count === 0), 'terminal reattachment');
  await command(page, value);
}
