import './ship-celebration.css';

export const SHIP_TEXT = 'SHHHHHIPPPPP ITTTTTTTTT 🚂🚂🚂🚂';

let current;

function make(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function celebrateShip(outcome) {
  if (outcome?.changed !== true) return;
  current?.();

  const stage = make('aside', 'ship-moment');
  stage.setAttribute('aria-label', 'Merge celebration');
  const title = make('div', 'ship-text', SHIP_TEXT);
  title.setAttribute('role', 'status');

  const route = make('div', 'ship-route');
  route.append(make('span', 'ship-source', outcome.source),
    make('span', 'ship-route-arrow', '→'),
    make('span', 'ship-destination', outcome.branch));
  route.title = [outcome.source, outcome.branch].join(' → ');

  const railway = make('div', 'ship-railway');
  railway.setAttribute('aria-hidden', 'true');
  const train = make('div', 'ship-train');
  train.append(make('span', 'ship-car ship-caboose', 'SHIP'),
    make('span', 'ship-car', 'IT'),
    make('span', 'ship-engine', '>_'));
  for (const size of ['small', 'medium', 'large']) {
    train.append(make('span', 'ship-steam ship-steam-' + size));
  }
  railway.append(train, make('div', 'ship-track'));

  const close = make('button', 'ship-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss merge celebration');
  const events = new AbortController();
  const options = { signal: events.signal };
  let timeout;
  const clearTimer = () => window.clearTimeout(timeout);
  const remove = () => {
    clearTimer();
    events.abort();
    stage.remove();
    if (current === remove) current = undefined;
  };
  const schedule = () => {
    clearTimer();
    timeout = window.setTimeout(remove, 4300);
  };
  current = remove;
  close.addEventListener('click', remove, options);
  stage.addEventListener('focusin', clearTimer, options);
  stage.addEventListener('focusout', schedule, options);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') remove();
  }, options);
  stage.append(close, title, route, railway);
  document.body.append(stage);
  schedule();
}
