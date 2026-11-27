import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { button, confirmAction, el, input, reportError } from './ui.js';

const binary = new TextEncoder();

export function specFor(session, launcher) {
  return { id: session.id, path: session.path, distro: session.distro, profile: session.profile, launcher };
}

export class TerminalView {
  constructor(session, settings, onState) {
    this.session = session;
    this.onState = onState;
    this.root = el('div', { class: 'terminal-content' });
    this.surface = el('div', { class: 'terminal-renderer', 'aria-label': `Terminal ${session.title}` });
    this.feedback = el('div', { class: 'terminal-feedback', role: 'status', text: 'Connecting terminal…' });
    this.root.append(this.surface, this.feedback);
    this.attachment = Promise.resolve();
    this.writes = Promise.resolve();
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    const styles = getComputedStyle(document.documentElement);
    const openLink = (event, value) => {
      if (event.ctrlKey) invoke('open_terminal_link', { value }).catch(reportError);
    };
    this.term = new Terminal({
      allowProposedApi: true,
      linkHandler: { activate: openLink },
      fontFamily: settings.font,
      fontSize: settings.fontSize,
      scrollback: 1200,
      cursorBlink: false,
      cursorStyle: 'bar',
      rescaleOverlappingGlyphs: true,
      macOptionIsMeta: true,
      theme: {
        background: styles.getPropertyValue('--color-terminal').trim(),
        foreground: styles.getPropertyValue('--color-ink').trim(),
        cursor: styles.getPropertyValue('--color-accent').trim(),
        selectionBackground: styles.getPropertyValue('--color-selection').trim(),
      },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon(openLink));
    this.surface.addEventListener('paste', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.pasteText(event.clipboardData?.getData('text/plain') || '').catch(reportError);
    }, { capture: true });
    this.term.parser.registerOscHandler(52, () => true);
    this.term.onData(value => this.send(binary.encode(value)));
    this.term.onBinary(value => this.send(Uint8Array.from(value, character => character.charCodeAt(0))));
    this.term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === 'c') {
        if (this.term.hasSelection()) invoke('clipboard_write', { value: this.term.getSelection() }).catch(reportError);
        return false;
      }
      if ((event.ctrlKey && event.shiftKey && key === 'v') || (event.shiftKey && key === 'insert')) {
        this.pasteClipboard();
        return false;
      }
      return true;
    });
    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.surface);
  }

  pasteClipboard() {
    const epoch = this.epochCounter;
    invoke('clipboard_read').then(value => this.pasteText(value, epoch)).catch(reportError);
  }

  async pasteText(value, epoch = this.epochCounter) {
    if (!value || !this.connected || epoch !== this.epochCounter) return;
    if (value.length > 1024 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
      throw new Error('The clipboard contains terminal control characters or exceeds 1 MiB.');
    }
    if (/[\r\n]/.test(value) && !this.term.modes.bracketedPasteMode
      && !await confirmAction('Paste multiple lines', 'The foreground program may execute a line when it is pasted.', 'Paste')) return;
    if (this.connected && this.mounted && epoch === this.epochCounter) this.term.paste(value);
  }

  insert(value) {
    if (!this.connected || (/[\r\n]/.test(value) && !this.term.modes.bracketedPasteMode)) return false;
    this.term.paste(value);
    this.focus();
    return true;
  }

  scheduleFit() {
    if (this.fitTimer) cancelAnimationFrame(this.fitTimer);
    this.fitTimer = requestAnimationFrame(() => {
      if (!this.surface.isConnected || !this.surface.clientWidth || !this.surface.clientHeight) return;
      this.fit.fit();
      if (this.connected && (this.cols !== this.term.cols || this.rows !== this.term.rows)) {
        this.cols = this.term.cols;
        this.rows = this.term.rows;
        invoke('terminal_resize', { id: this.session.id, attachment: this.nonce, cols: this.cols, rows: this.rows }).catch(() => {});
      }
    });
  }

  applySettings(settings) {
    this.term.options.fontFamily = settings.font;
    this.term.options.fontSize = settings.fontSize;
    this.scheduleFit();
  }

  focus() {
    if (this.connected) this.term.focus();
  }

  mount(container, starting) {
    container.append(this.root);
    if (!this.opened) {
      this.term.open(this.surface);
      this.opened = true;
    }
    if (this.mounted) {
      this.scheduleFit();
      return;
    }
    this.mounted = true;
    this.feedback.hidden = false;
    const epoch = ++this.epochCounter;
    const previous = this.attachment.catch(() => {});
    this.attachment = previous.then(async () => {
      if (starting) await starting;
      if (!this.mounted || epoch !== this.epochCounter) return;
      this.fit.fit();
      this.cols = this.term.cols;
      this.rows = this.term.rows;
      const { cursor, attachment } = await invoke('terminal_attach', {
        spec: specFor(this.session), cols: this.cols, rows: this.rows,
      });
      if (!this.mounted || epoch !== this.epochCounter) return;
      this.nonce = attachment;
      this.connected = true;
      this.feedback.hidden = true;
      this.onState(this.session.id, 'attached');
      this.pump(epoch, attachment, this.cursor ?? cursor);
    }).catch(error => {
      if (this.mounted && epoch === this.epochCounter) {
        this.feedback.hidden = false;
        this.feedback.textContent = String(error);
        this.onState(this.session.id, 'unavailable', String(error));
      }
    });
  }

  async pump(epoch, attachment, cursor) {
    try {
      while (this.mounted && epoch === this.epochCounter) {
        const data = await invoke('terminal_read', { id: this.session.id, attachment, cursor });
        if (!this.mounted || epoch !== this.epochCounter) return;
        const bytes = new Uint8Array(data);
        if (bytes.byteLength < 9) throw new Error('Unexpected terminal output frame.');
        cursor = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true));
        const flags = bytes[8];
        if (flags & 2) {
          this.term.reset();
          await new Promise(resolve => this.term.write('\r\n[Earlier output was discarded while hidden.]\r\n', resolve));
        }
        if (bytes.length > 9) {
          await new Promise(resolve => this.term.write(bytes.subarray(9), resolve));
          this.onState(this.session.id, 'output');
        }
        this.cursor = cursor;
        if (flags & 1) {
          this.connected = false;
          this.onState(this.session.id, 'ended');
          return;
        }
      }
    } catch (error) {
      if (this.mounted && epoch === this.epochCounter) this.onState(this.session.id, 'unavailable', String(error));
    }
  }

  send(bytes) {
    if (!this.connected) return;
    if (this.pendingInput + bytes.length > 1024 * 1024) {
      reportError('Terminal input is busy. Wait for it to catch up before pasting more.');
      return;
    }
    this.pendingInput += bytes.length;
    const epoch = this.epochCounter;
    const attachment = this.nonce;
    this.writes = this.writes.then(async () => {
      if (!this.connected || epoch !== this.epochCounter) return;
      for (let index = 0; index < bytes.length; index += 4096) {
        if (!this.connected || epoch !== this.epochCounter) return;
        await invoke('terminal_write', { id: this.session.id, attachment,
          input: Array.from(bytes.subarray(index, index + 4096)) });
      }
    }).catch(error => {
      if (this.connected && epoch === this.epochCounter) reportError(error);
    }).finally(() => { this.pendingInput -= bytes.length; });
  }

  find() {
    if (this.findBar) {
      this.findBar.querySelector('input').focus();
      return;
    }
    const query = input('', { placeholder: 'Find in terminal', 'aria-label': 'Find in terminal' });
    const close = () => { this.findBar.remove(); this.findBar = null; this.search.clearDecorations(); this.focus(); };
    const navigate = (backward, history = false) => {
      if (!query.value) return;
      if (history) {
        invoke('terminal_search', { spec: specFor(this.session), query: query.value, backward }).then(close).catch(reportError);
      } else if (backward) this.search.findPrevious(query.value);
      else this.search.findNext(query.value);
    };
    this.findBar = el('div', { class: 'terminal-find' }, query,
      button('Previous', () => navigate(true)), button('Next', () => navigate(false)),
      this.session.profile === 'ubuntu' ? button('tmux history', () => navigate(true, true)) : null,
      button('Close search', close, { icon: 'x', only: true }));
    query.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Enter') navigate(event.shiftKey, event.altKey && this.session.profile === 'ubuntu');
    });
    this.root.append(this.findBar);
    query.focus();
  }

  conceal() {
    if (!this.mounted) return this.attachment;
    this.mounted = false;
    this.connected = false;
    this.epochCounter++;
    this.root.remove();
    this.attachment = this.attachment.catch(() => {}).then(() =>
      invoke('terminal_conceal', { spec: specFor(this.session) })).catch(() => {});
    return this.attachment;
  }

  dispose() {
    this.observer.disconnect();
    this.term.dispose();
    this.root.remove();
  }

  pendingInput = 0;
  mounted = false;
  connected = false;
  epochCounter = 0;
}
