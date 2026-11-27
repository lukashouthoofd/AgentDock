/* Native UI verification. Use an empty AgentDock profile and disposable repositories. */
import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
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
const identifier = process.env.AGENTDOCK_VERIFY_IDENTIFIER || 'local.agentdock.workspace';
if (!/^[A-Za-z0-9.-]+$/.test(identifier)) throw new Error('Invalid fixture application identifier.');
const profile = join(process.env.LOCALAPPDATA, identifier, 'workspace.json');
const evidence = resolve(output);
await mkdir(evidence, { recursive: true });
const sessionIds = new Set();
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
  page.on('pageerror', error => console.log('WEBVIEW ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('WEBVIEW CONSOLE ' + message.text().slice(0, 350)); });
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

async function command(page, value) {
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
  await tty(page).waitFor({ state: 'attached', timeout: 20000 });
  await until(() => page.locator('.pane.active .terminal-feedback:visible').count().then(count => count === 0), 'terminal attachment', 30000);
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
}

async function captureWorkspace() {
  const workspace = await readFile(profile, 'utf8').then(JSON.parse).catch(() => null);
  for (const session of Object.values(workspace?.sessions || {})) {
    if (session.profile === 'ubuntu' && [ubuntu, windows, ubuntu + '-clone'].some(path => session.path.startsWith(path))) {
      sessionIds.add(session.id);
    }
  }
}

try {
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

  await openProject(page, windows);
  await newShell(page, 'PowerShell');
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
  await page.locator('.pane.active .pane-caption').dragTo(page.locator('[data-tab-id="' + linuxTab + '"]'));
  await until(() => page.locator('.pane').count().then(count => count === 2), 'cross-project split');
  result('Dragged PowerShell across tabs into a split with the Ubuntu terminal');
  const windowsRow = page.locator('[data-terminal-id="' + windowsId + '"]');
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
    await sessionsPanel.getByRole('button', { name: 'Close sessions' }).click();
  }
  result('Sessions rail hides renderers, keeps their processes alive and restores a named layout');
  await page.locator('.pane.active').getByRole('button', { name: 'Terminal actions' }).click();
  await page.getByRole('button', { name: 'Terminate terminal' }).click();
  await page.getByRole('dialog', { name: 'Terminate terminal' }).getByRole('button', { name: 'Terminate' }).click();
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
  await trees.getByRole('button', { name: 'Close' }).click();
  await toolbar(page, 'Development').click();
  const dev = page.getByRole('dialog', { name: 'Development' });
  await dev.getByText('Local branches', { exact: true }).waitFor();
  await dev.getByRole('button', { name: 'Load pull requests' }).click();
  await until(() => dev.getByRole('button', { name: 'Refresh' }).count().then(count => count > 1), 'GitHub CLI response');
  await dev.getByRole('button', { name: 'Load containers' }).click();
  await until(() => dev.getByRole('button', { name: 'Refresh' }).count().then(count => count > 2), 'Docker CLI response');
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
  await clone.getByLabel('New folder').fill(ubuntu + '-clone');
  await clone.getByRole('button', { name: 'Clone' }).click();
  await clone.waitFor({ state: 'hidden', timeout: 30000 });
  await until(async () => {
    const current = JSON.parse(await readFile(profile, 'utf8'));
    return current.projects.some(item => item.path === ubuntu + '-clone');
  }, 'exact clone destination');
  result('Local Git CLI clone created and opened the requested Ubuntu path');
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
    await pane.getByRole('button', { name: 'Terminal actions' }).click();
    await page.getByRole('button', { name: 'Terminate terminal' }).click();
    await page.getByRole('dialog', { name: 'Terminate terminal' }).getByRole('button', { name: 'Terminate' }).click();
    await until(() => page.locator('[data-terminal-id="' + id + '"]').count().then(count => count === 0), 'fixture terminal termination');
  }
  result('Three repeated Ubuntu create-and-terminate cycles under the 20-session load');

  await openProject(page, windows);
  await newShell(page, 'PowerShell');
  const closingPowerShell = await page.locator('.pane.active').getAttribute('data-session');
  await page.locator('[data-terminal-id="' + linuxId + '"]').click();
  await tty(page).waitFor({ state: 'attached', timeout: 20000 });
  await close(page);
  ({ page } = await start());
  const skip = page.getByRole('button', { name: 'Skip intro' });
  if (await skip.isVisible()) await skip.click();
  await page.locator('[data-terminal-id="' + linuxId + '"]').click();
  await cmdAfterMount(page, 'printf "AD%s\\n" "$ADKEEP"');
  await textInTerminal(page, 'ADkeep');
  result('Native close/reopen restored the persisted Ubuntu shell');
  await page.locator('[data-terminal-id="' + closingPowerShell + '"]').click();
  await page.getByText('This PowerShell terminal has ended.', { exact: false }).waitFor();
  result('Closing with an active PowerShell prompted and reopening did not start a new PowerShell');
  await close(page);
} catch (error) {
  console.error(error);
  const faultPage = browser?.contexts()[0]?.pages()[0];
  if (faultPage) {
    const diagnostics = await faultPage.evaluate(async () => ({
      visibility: document.visibilityState,
      pane: document.querySelector('.pane.active .terminal-feedback:not([hidden])')?.textContent,
      minimized: await window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized', { label: 'main' }).catch(() => null),
    })).catch(() => null);
    console.error('Window diagnostic', JSON.stringify(diagnostics));
    if (ipcTiming.length) console.error('Native IPC timing', JSON.stringify(ipcTiming));
  }
  await faultPage?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await captureWorkspace();
  // This is only the exact child created by this script and fixture session IDs.
  if (launched && alive(launched.pid)) process.kill(launched.pid);
  for (const id of sessionIds) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
    await execFile('wsl.exe', ['--distribution', distro, '--exec', '/usr/bin/tmux', '-L', 'agentdock-v1', 'kill-session', '-t', '=ad-' + id], { timeout: 8000 }).catch(() => {});
  }
  await writeFile(join(evidence, 'desktop-checks.json'), JSON.stringify(report, null, 2));
}

async function cmdAfterMount(page, value) {
  await tty(page).waitFor({ state: 'attached', timeout: 20000 });
  await until(() => page.locator('.pane.active .terminal-feedback:visible').count().then(count => count === 0), 'terminal reattachment');
  await command(page, value);
}
