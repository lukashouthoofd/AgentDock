import { Channel, invoke } from '@tauri-apps/api/core';
import { button, dialog, el, field, input, select, textarea } from './ui.js';

const models = [
  ['', 'Choose a model'], ['haiku', 'Haiku'], ['sonnet', 'Sonnet'],
  ['opus', 'Opus'], ['fable', 'Fable'], ['custom', 'Exact model ID'],
];
const terminalControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
let openWindow;

function requestId() {
  return 'studio-' + Array.from(crypto.getRandomValues(new Uint32Array(4)),
    value => value.toString(16).padStart(8, '0')).join('');
}

export function openPromptStudio({ distro, target, insert }) {
  if (openWindow?.open) return;
  const model = select(models, '');
  const custom = input('', { maxlength: 100, placeholder: 'claude-sonnet-4-6', spellcheck: 'false', autocomplete: 'off' });
  const customField = field('Model ID', custom);
  const prompt = textarea('', { rows: 5, maxlength: 24576, placeholder: 'What should the agent accomplish?', spellcheck: 'false' });
  const answer = textarea('', { rows: 8, placeholder: 'Review and edit the generated prompt here.', spellcheck: 'false' });
  const status = el('p', { class: 'muted', role: 'status', hidden: true });
  const generate = button('Generate', generateDraft, { class: 'primary' });
  const stop = button('Stop', stopDraft);
  const copy = button('Copy draft', () => transfer(false), { icon: 'copy' });
  const send = button('Insert draft', () => transfer(true));
  const targetTitle = target?.title || 'the selected terminal';
  let active;
  let transferring = false;
  const ui = dialog('Prompt Studio', [
    el('p', { class: 'muted', text: 'Generate a draft with your Claude Code subscription using the prompt you enter here.' }),
    field('Claude model', model), customField, field('Prompt request', prompt),
    el('div', { class: 'field-pair' }, generate, stop), status, field('Draft', answer),
    target ? el('p', { class: 'muted', text: `Insert places the draft in ${targetTitle} for you to submit.` }) : null,
  ], {
    class: 'wide',
    onClose: () => {
      if (openWindow === ui.window) openWindow = undefined;
      if (active) void invoke('prompt_studio_cancel', { requestId: active.id }).catch(() => {});
    },
  });
  openWindow = ui.window;
  ui.footer.append(copy, send);

  function selectedModel() {
    return model.value === 'custom' ? custom.value.trim() : model.value;
  }

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function update() {
    customField.hidden = model.value !== 'custom';
    model.disabled = Boolean(active);
    custom.disabled = Boolean(active);
    prompt.readOnly = Boolean(active);
    answer.readOnly = Boolean(active);
    generate.disabled = Boolean(active) || transferring || !distro || !selectedModel() || !prompt.value.trim();
    stop.hidden = !active;
    stop.disabled = !active || active.stopping;
    copy.disabled = Boolean(active) || transferring || !answer.value.trim();
    send.disabled = copy.disabled || !target || !insert;
  }

  async function generateDraft() {
    if (generate.disabled) return;
    const text = prompt.value.trim();
    if (new TextEncoder().encode(text).length > 24576 || text.includes('\0')) {
      ui.error('Enter a prompt of up to 24 KiB.');
      return;
    }
    const snapshot = { id: requestId(), stopping: false, previous: answer.value };
    active = snapshot;
    answer.value = '';
    showStatus('Starting Claude Code…');
    ui.error('');
    update();
    const onDelta = new Channel(part => {
      if (active !== snapshot || active.stopping || !ui.window.open || typeof part !== 'string') return;
      answer.value += part;
      if (status.textContent !== 'Generating draft…') showStatus('Generating draft…');
    });
    try {
      const result = await invoke('prompt_studio_generate', {
        distro, requestId: snapshot.id, model: selectedModel(), prompt: text, onDelta,
      });
      answer.value = result;
      showStatus('Draft ready to review.');
    } catch (error) {
      const partial = Boolean(answer.value);
      if (!partial) answer.value = snapshot.previous;
      showStatus(snapshot.stopping ? 'Draft generation stopped.' : partial ? 'Partial draft. Review before use.' : '');
      if (!snapshot.stopping) ui.error(typeof error === 'string' ? error : 'Claude Code could not generate a draft.');
    } finally {
      active = undefined;
      update();
    }
  }

  async function stopDraft() {
    if (!active || active.stopping) return;
    const snapshot = active;
    snapshot.stopping = true;
    showStatus('Stopping Claude Code…');
    update();
    try {
      await invoke('prompt_studio_cancel', { requestId: snapshot.id });
    } catch (error) {
      if (active === snapshot) {
        snapshot.stopping = false;
        ui.error(typeof error === 'string' ? error : 'Could not stop draft generation.');
        update();
      }
    }
  }

  async function transfer(toTerminal) {
    if ((toTerminal ? send : copy).disabled) return;
    const value = answer.value;
    if (terminalControl.test(value)) {
      ui.error('Remove terminal control characters from the draft before transferring it.');
      return;
    }
    transferring = true;
    update();
    ui.error('');
    try {
      if (toTerminal && await insert(target.id, value)) {
        ui.close();
      } else {
        await invoke('clipboard_write', { value });
        showStatus(toTerminal ? 'Copied. Paste into the intended terminal when ready.' : 'Draft copied.');
      }
    } catch (error) {
      ui.error(typeof error === 'string' ? error : (error?.message || 'The draft could not be transferred.'));
    } finally {
      transferring = false;
      update();
    }
  }

  for (const control of [model, custom, prompt, answer]) control.addEventListener('input', update);
  if (!distro) showStatus('Choose your Ubuntu distribution to generate a draft.');
  update();
  model.focus();
}
