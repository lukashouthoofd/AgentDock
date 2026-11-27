const icons = import.meta.glob([
  '/node_modules/lucide/icons/activity.svg',
  '/node_modules/lucide/icons/arrow-down-up.svg',
  '/node_modules/lucide/icons/chevron-down.svg',
  '/node_modules/lucide/icons/chevron-right.svg',
  '/node_modules/lucide/icons/copy.svg',
  '/node_modules/lucide/icons/ellipsis.svg',
  '/node_modules/lucide/icons/file-key-2.svg',
  '/node_modules/lucide/icons/folder-git-2.svg',
  '/node_modules/lucide/icons/folder-open.svg',
  '/node_modules/lucide/icons/git-branch.svg',
  '/node_modules/lucide/icons/git-fork.svg',
  '/node_modules/lucide/icons/maximize.svg',
  '/node_modules/lucide/icons/minimize.svg',
  '/node_modules/lucide/icons/music-2.svg',
  '/node_modules/lucide/icons/panel-left.svg',
  '/node_modules/lucide/icons/pin.svg',
  '/node_modules/lucide/icons/plus.svg',
  '/node_modules/lucide/icons/search.svg',
  '/node_modules/lucide/icons/settings-2.svg',
  '/node_modules/lucide/icons/square-pen.svg',
  '/node_modules/lucide/icons/split.svg',
  '/node_modules/lucide/icons/terminal.svg',
  '/node_modules/lucide/icons/x.svg',
], { query: '?raw', import: 'default', eager: true });

export const $ = (selector, from = document) => from.querySelector(selector);

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'data') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (typeof value === 'boolean' && !key.startsWith('aria-')) {
      if (value) node.setAttribute(key, '');
    } else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter(child => child != null));
  return node;
}

export function icon(name) {
  const element = el('span', { class: 'icon', 'aria-hidden': 'true' });
  element.innerHTML = icons[`/node_modules/lucide/icons/${name}.svg`] || '';
  return element;
}

export function button(label, action, options = {}) {
  return el('button', {
    type: 'button', title: options.title || (options.only ? label : undefined),
    class: options.class, 'aria-label': options.only ? label : undefined,
    disabled: options.disabled, onClick: action, data: options.data,
  }, options.icon && icon(options.icon), options.only ? null : label);
}

export function replaceControls(region, ...children) {
  const focused = document.activeElement;
  if (!region.contains(focused) || !focused.matches('button')) {
    region.replaceChildren(...children);
    return;
  }
  const label = button => button.getAttribute('aria-label') || button.title || button.textContent;
  const name = label(focused);
  const matches = () => [...region.querySelectorAll('button')].filter(button => label(button) === name);
  const index = matches().indexOf(focused);
  region.replaceChildren(...children);
  const restored = matches()[index];
  if (restored && !restored.disabled) restored.focus({ preventScroll: true });
}

export function input(value = '', options = {}) {
  const field = el('input', { ...options });
  field.value = value;
  return field;
}

export function textarea(value = '', options = {}) {
  const field = el('textarea', { ...options });
  field.value = value;
  return field;
}

export function field(label, control) {
  return el('label', { class: 'field' }, el('span', { text: label }), control);
}

export function select(items, value, options = {}) {
  const control = el('select', options, items.map(([item, label]) => el('option', { value: item, text: label })));
  if (value != null) control.value = value;
  return control;
}

export function dialog(title, content, options = {}) {
  const window = el('dialog', { class: ['dialog', options.class].filter(Boolean).join(' '), 'aria-label': title });
  const close = () => window.close();
  const body = el('div', { class: 'dialog-body' }, content);
  const footer = el('div', { class: 'dialog-footer' });
  window.append(el('header', { class: 'dialog-heading' },
    el('h2', { text: title }), button('Close', close, { icon: 'x', only: true })),
  body, footer);
  window.addEventListener('close', () => {
    window.remove();
    options.onClose?.(window.returnValue);
  }, { once: true });
  document.body.append(window);
  window.showModal();
  return { window, body, footer, close, error: message => {
    let node = $('.dialog-error', body);
    if (!node) {
      node = el('p', { class: 'dialog-error', role: 'alert' });
      body.append(node);
    }
    node.textContent = message || '';
    node.hidden = !message;
  } };
}

export function confirmAction(title, message, label = 'Continue') {
  return new Promise(resolve => {
    const ui = dialog(title, el('p', { text: message }), {
      onClose: result => resolve(result === 'yes'),
    });
    ui.footer.append(button('Cancel', ui.close),
      button(label, () => ui.window.close('yes'), { class: 'primary' }));
    ui.footer.firstElementChild.focus();
  });
}

export function reportError(error) {
  const text = typeof error === 'string' ? error : (error?.message || 'The local operation failed.');
  const notice = $('#notice');
  if (notice) {
    notice.hidden = false;
    $('.notice-message', notice).textContent = text;
  }
}

export function busy(action, onError = reportError) {
  return async event => {
    const target = event?.currentTarget;
    if (target) target.disabled = true;
    try { await action(event); }
    catch (error) { onError(error); }
    finally { if (target?.isConnected) target.disabled = false; }
  };
}

export const pathName = value => value?.split(/[\\/]/).filter(Boolean).at(-1) || value || '';
export const safeColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#b7c9e7';
