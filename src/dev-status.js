import { invoke } from '@tauri-apps/api/core';
import { button, dialog, el } from './ui.js';

function section(title, emptyText, loadLabel, fetch, render) {
  const status = el('p', { class: 'muted', role: 'status' });
  const result = el('div', { class: 'development-results' });
  const content = el('section', { class: 'development-section' },
    el('h3', { text: title }), status, result);

  const load = async () => {
    if (action.disabled) return;
    action.disabled = true;
    content.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading…';
    result.replaceChildren();
    try {
      const records = await fetch();
      if (!content.isConnected) return;
      const elements = render(records);
      result.replaceChildren(...elements);
      status.textContent = elements.length ? '' : emptyText;
    } catch (error) {
      if (content.isConnected) {
        status.textContent = typeof error === 'string' ? error : 'Could not load this section.';
      }
    } finally {
      action.disabled = false;
      action.textContent = 'Refresh';
      content.setAttribute('aria-busy', 'false');
    }
  };

  const action = button(loadLabel, load);
  content.append(action);
  return { content, load };
}

function detail(text) {
  return el('span', { class: 'muted', text });
}

function listItem(label, secondary, action) {
  return el('li', { class: 'development-row' },
    el('div', { class: 'development-main' },
      el('span', { class: 'development-label', text: label }),
      secondary ? detail(secondary) : null),
    action);
}

function list(rows) {
  return el('ul', { class: 'development-list' }, rows);
}

export function openDevelopment(project, openWorktree) {
  const args = { path: project.path, distro: project.distro ?? '' };
  const repository = section('Repository', 'This repository has no branches or worktrees.',
    'Refresh', () => invoke('dev_branches', args), data => {
      const branches = data.branches.map(branch => listItem(
        branch.name,
        [branch.isCurrent ? 'Current branch' : '', branch.upstream].filter(Boolean).join(' / '),
      ));
      const worktrees = data.worktrees.map(tree => listItem(
        tree.branch || 'Worktree',
        [tree.path, tree.locked ? 'Locked' : '', tree.missing ? 'Unavailable' : '']
          .filter(Boolean).join(' / '),
        button('Open', async () => {
          try {
            await openWorktree(tree);
            ui.close();
          } catch (error) {
            ui.error(typeof error === 'string' ? error : 'Could not open the worktree.');
          }
        }, { disabled: tree.missing }),
      ));
      return [
        data.current ? el('p', { class: 'muted', text: 'Current branch ' + data.current }) : null,
        branches.length ? el('h4', { text: 'Local branches' }) : null,
        branches.length ? list(branches) : null,
        worktrees.length ? el('h4', { text: 'Worktrees' }) : null,
        worktrees.length ? list(worktrees) : null,
      ].filter(Boolean);
    });

  const pulls = section('Open pull requests', 'No open pull requests.', 'Load pull requests',
    () => invoke('dev_pulls', args), items => items.length ? [list(items.map(item => listItem(
      '#' + item.number + ' ' + item.title,
      [item.isDraft ? 'Draft' : '', item.headRefName + ' → ' + item.baseRefName].filter(Boolean).join(' / '),
      button('Open in browser', async () => {
        try {
          await invoke('open_terminal_link', { value: item.url });
        } catch (error) {
          ui.error(typeof error === 'string' ? error : 'Could not open the pull request.');
        }
      }),
    )))] : []);

  const containers = section('Running containers', 'No containers are running in this Docker context.',
    'Load containers', () => invoke('dev_containers', args), items => items.length ? [list(items.map(item =>
      listItem(item.name, [item.image, item.status, item.ports].filter(Boolean).join(' / ')),
    ))] : []);

  const ui = dialog('Development', el('div', { class: 'development-panel' },
    repository.content, pulls.content, containers.content), { class: 'development-dialog' });
  ui.footer.append(button('Done', ui.close));
  void repository.load();
  return ui;
}
