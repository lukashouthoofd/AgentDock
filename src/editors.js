import { invoke } from '@tauri-apps/api/core';
import { composePrompt } from './model.js';
import { $, busy, button, confirmAction, dialog, el, field, input, select, textarea } from './ui.js';

export async function dotenvEditor(project, path) {
  const args = { path, distro: project.distro };
  let names = await invoke('dotenv_list', args);
  let name = names[0];
  let document = name ? await invoke('dotenv_read', { ...args, name }) : null;
  let rows = [];
  let dirty = false;
  let saving = false;
  let reveal = new Set();
  const list = el('div', { class: 'env-list' });
  const selector = el('div', { class: 'env-file' });
  const ui = dialog('Environment variables', [
    el('p', { class: 'dialog-path', text: path }), selector, list,
  ], { class: 'wide' });
  const guarded = async () => !saving && (!dirty || await confirmAction(
    'Discard unsaved changes', 'The edits to this dotenv file will be discarded.',  'Discard'));
  function accept(value) {
    document = value;
    rows = value ? value.rows.map(row => ({ ...row, edited: false })) : [];
    reveal = new Set();
    dirty = false;
    ui.error('');
    render();
  }
  const oldClose = $('.dialog-heading button', ui.window);
  oldClose.addEventListener('click', async event => {
    event.stopImmediatePropagation();
    if (await guarded()) ui.close();
  }, { capture: true });
  ui.window.addEventListener('cancel', async event => {
    event.preventDefault();
    if (await guarded()) ui.close();
  });
  function render() {
    const file = select(names.map(item => [item, item]), name, { 'aria-label': 'Dotenv file', disabled: !names.length });
    file.addEventListener('change', busy(async () => {
      const nextName = file.value;
      if (!await guarded()) { file.value = name; return; }
      const next = await invoke('dotenv_read', { ...args, name: nextName });
      name = nextName;
      accept(next);
    }, ui.error));
    selector.replaceChildren(file, button('Create file', () => {
      const newName = input('.env', { maxlength: 120, spellcheck: 'false' });
      const create = dialog('Create dotenv file', field('Filename', newName));
      create.footer.append(button('Create', busy(async () => {
        if (!await guarded()) return;
        const filename = newName.value.trim();
        const doc = await invoke('dotenv_create', { ...args, name: filename });
        names = await invoke('dotenv_list', args);
        name = filename;
        accept(doc);
        create.close();
      }, create.error), { class: 'primary' }));
      newName.select();
    }), button('Reload', busy(async () => {
      if (name && await guarded()) accept(await invoke('dotenv_read', { ...args, name }));
    }, ui.error), { disabled: !name }));
    if (!document) {
      list.replaceChildren(el('p', { class: 'muted', text: 'This folder has no dotenv files.' }));
    } else {
      list.replaceChildren(...rows.map((row, index) => {
        const key = input(row.key, { 'aria-label': `Variable ${index + 1} name`, spellcheck: 'false' });
        key.addEventListener('input', () => { row.key = key.value; dirty = true; });
        const shown = reveal.has(row);
        const value = shown ? textarea(row.value, {
          rows: Math.min(5, row.value.split('\n').length), 'aria-label': `Variable ${index + 1} value`,
          autocomplete: 'off', spellcheck: 'false',
        }) : el('span', { class: 'secret-mask', 'aria-label': 'Value hidden', text: '••••••••' });
        if (shown) value.addEventListener('input', () => { row.value = value.value; row.edited = true; dirty = true; });
        return el('div', { class: 'env-row' }, key, value,
          button(shown ? 'Mask' : 'Reveal', () => {
            if (shown) reveal.delete(row); else reveal.add(row);
            render();
          }),
          button(`Remove ${row.key || 'variable'}`, () => {
            rows.splice(index, 1);
            dirty = true;
            reveal.delete(row);
            render();
          }, { only: true, icon: 'x' }));
      }));
    }
  }
  ui.footer.append(
    button('Add variable', () => {
      if (!document || saving) return;
      const row = { id: null, key: '', value: '', edited: true };
      dirty = true;
      reveal.add(row);
      rows.push(row);
      render();
      list.lastElementChild.querySelector('input').focus();
    }, { icon: 'plus' }),
    button('Save file', busy(async () => {
      if (!document || !dirty || saving) return;
      saving = true;
      list.inert = true;
      selector.inert = true;
      try {
        const edits = rows.map(row => ({ id: row.id, key: row.key, value: row.edited ? row.value : null }));
        accept(await invoke('dotenv_save', { ...args, name, version: document.version, edits }));
      } finally {
        saving = false;
        list.inert = false;
        selector.inert = false;
      }
    }, ui.error), { class: 'primary' }));
  accept(document);
}

const commands = [['prompt', 'Reusable prompt'], ['goal', '/goal objective'], ['loop', '/loop task']];

export async function workflowEditor(project, target, requested, insert) {
  let templates = [];
  const command = select(commands, requested);
  const template = select([], null, { 'aria-label': 'Workflow template' });
  const objective = textarea('', { rows: 3, placeholder: 'What should the agent accomplish?', spellcheck: 'false' });
  const repeat = input('', { placeholder: '5m, 2h or 1d', spellcheck: 'false' });
  const stop = input('', { placeholder: 'Optional stopping condition' });
  const preview = textarea('', { rows: 5, readonly: true, 'aria-label': 'Prompt preview', spellcheck: 'false' });
  const hint = el('p', { class: 'muted' });
  const schedule = el('div', { class: 'field-pair' }, field('Interval', repeat), field('Stop condition', stop));
  const ui = dialog('Workflow prompts', [
    hint, el('div', { class: 'field-pair' }, field('Action', command), field('Template', template)),
    field('Objective or task', objective), schedule, field('Preview', preview),
  ], { class: 'wide' });

  function selected() { return templates[Number(template.value)] || null; }
  function prompt() {
    return composePrompt(target?.kind, command.value, objective.value,
      selected()?.content || '', repeat.value, stop.value);
  }
  function renderPreview() {
    const native = (target?.kind === 'codex' && command.value === 'goal')
      || (target?.kind === 'claude' && command.value === 'loop');
    schedule.hidden = command.value !== 'loop';
    hint.textContent = target
      ? `Target: ${target.title}. ${native ? 'Uses the agent’s native slash command.' : 'Inserts a plain prompt.'} You submit it in the terminal.`
      : 'Choose a workflow and copy the prompt into a terminal.';
    try { preview.value = prompt(); ui.error(''); }
    catch (error) { preview.value = ''; ui.error(error.message); }
  }
  async function refresh(name) {
    const all = await invoke('templates_list', { project: project?.id ?? null });
    const effective = new Map();
    for (const entry of all) effective.set(entry.name.toLocaleLowerCase(), entry);
    templates = [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
    template.replaceChildren(el('option', { value: '-1', text: 'None' }),
      ...templates.map((entry, index) => el('option', {
        value: index,
        text: `${entry.name} (${entry.scope === 'built-in' ? 'built-in' : entry.scope === 'global' ? 'global' : 'project'})`,
      })));
    template.value = String(name ? templates.findIndex(entry => entry.name === name) : -1);
    renderPreview();
  }
  function editTemplate(existing) {
    const writer = input(existing?.name || '', { maxlength: 80, spellcheck: 'false' });
    const scope = select([
      ['global', 'Global'], ...(project ? [[project.id, project.name]] : []),
    ], existing?.scope === 'built-in' ? 'global' : existing?.scope || project?.id || 'global');
    const markdown = textarea(existing?.content || '', { rows: 13, spellcheck: 'false' });
    const editor = dialog(existing ? 'Edit template' : 'New template', [
      el('div', { class: 'field-pair' }, field('Name', writer), field('Scope', scope)),
      field('Markdown', markdown),
    ], { class: 'wide' });
    if (existing && existing.scope !== 'built-in') editor.footer.append(
      button('Delete', busy(async () => {
        if (!await confirmAction('Delete local template', `Delete “${existing.name}” from this scope?`, 'Delete')) return;
        await invoke('template_remove', { scope: existing.scope, name: existing.name });
        await refresh();
        editor.close();
      }, editor.error)));
    editor.footer.append(button('Save template', busy(async () => {
      const name = writer.value.trim();
      await invoke('template_save', { edit: { scope: scope.value, name, content: markdown.value } });
      await refresh(name);
      editor.close();
    }, editor.error), { class: 'primary' }));
  }
  for (const control of [command, template, objective, repeat, stop]) {
    control.addEventListener('input', renderPreview);
  }
  ui.footer.append(
    button('New template', () => editTemplate(null)),
    button('Edit template', () => { if (selected()) editTemplate(selected()); }),
    button('Copy', busy(async () => {
      const text = prompt();
      if (text) { await invoke('clipboard_write', { value: text }); ui.close(); }
    }, ui.error), { icon: 'copy' }),
    button('Insert', busy(async () => {
      const text = prompt();
      if (!text) return;
      if (!await insert(target.id, text)) {
        await invoke('clipboard_write', { value: text });
        ui.error('Copied to the clipboard. Paste it into the intended agent terminal when ready.');
        return;
      }
      ui.close();
    }, ui.error), { class: 'primary', disabled: !target }),
  );
  await refresh();
  objective.focus();
}
