import { invoke } from '@tauri-apps/api/core';
import { button, dialog, el, field, input, select } from './ui.js';

const categories = [['track', 'Tracks'], ['playlist', 'Playlists'], ['show', 'Podcasts'], ['episode', 'Episodes']];
const browserRoutes = { track: 'tracks', playlist: 'playlists', show: 'podcasts', episode: 'episodes' };
const statusInterval = 2500;
let openWindow;

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

export function openSpotify() {
  if (openWindow?.open) return;
  const heading = el('strong', { text: 'Checking Spotify…' });
  const artist = el('p', { hidden: true });
  const previous = button('Previous', () => control('previous'), { disabled: true });
  const toggle = button('Play / pause', () => control('toggle'), { disabled: true });
  const next = button('Next', () => control('next'), { disabled: true });
  const playback = el('div', { 'aria-live': 'polite' }, heading, artist);
  const transport = el('div', { class: 'dialog-footer', role: 'group', 'aria-label': 'Spotify playback' },
    previous, toggle, next);

  const query = input('', { type: 'search', placeholder: 'Track, playlist or podcast name', maxlength: 240 });
  const category = select(categories, 'playlist');
  const submit = el('button', { type: 'submit', class: 'primary', text: 'Search' });
  const library = button('My library', () => loadPage({ kind: category.value, offset: 0 }));
  const external = button('Search in browser', openSearch);
  const search = el('form', { onSubmit: submitSearch },
    field('Search Spotify', query), field('Category', category),
    el('div', { class: 'dialog-footer' }, library, external, submit));

  const authorizationStatus = el('p', { role: 'status' });
  const clientId = input('', {
    maxlength: 32, autocomplete: 'off', spellcheck: 'false', required: true, pattern: '[a-fA-F0-9]{32}',
  });
  const connect = el('button', { type: 'submit', class: 'primary', text: 'Authorize in browser' });
  const cancel = button('Cancel', () => disconnect());
  cancel.hidden = true;
  const connectionDetails = el('details', {}, el('summary', { text: 'Connect Spotify for search and library' }),
    el('form', { onSubmit: connectAccount }, field('Spotify Client ID', clientId), connect, cancel));
  const disconnectButton = button('Disconnect Spotify', () => disconnect());
  const account = el('div', {}, authorizationStatus, connectionDetails, disconnectButton);

  const resultStatus = el('p', { role: 'status', hidden: true });
  const resultList = el('ul', { class: 'spotify-results' });
  const previousPage = button('Previous page', () => loadPage({ ...currentPage, offset: Math.max(currentPage.offset - 10, 0) }));
  const nextPage = button('Next page', () => loadPage({ ...currentPage, offset: currentPage.nextOffset }));
  const resultNav = el('div', { class: 'dialog-footer', hidden: true }, previousPage, nextPage);
  const results = el('section', { 'aria-label': 'Spotify results' }, resultStatus, resultList, resultNav);

  let timer;
  let revision = 0;
  let controlling = false;
  let status = null;
  let connected = false;
  let authorizing = false;
  let changingAccount = false;
  let loadingPage = false;
  let startingPlayback = false;
  let currentPage;
  const ui = dialog('Spotify', [playback, transport, search, results, account], {
    class: 'spotify-dialog',
    onClose: () => {
      clearTimeout(timer);
      if (openWindow === ui.window) openWindow = undefined;
    },
  });
  openWindow = ui.window;

  function render(unavailable = false) {
    setText(heading, unavailable ? 'Spotify controls unavailable'
      : status?.title || (status ? 'Spotify connected' : 'No Spotify desktop media session'));
    setText(artist, status?.artist || (status ? '' : 'Open Spotify on Windows and select something to play.'));
    artist.hidden = !artist.textContent || unavailable;
    setText(toggle, status?.playing === true ? 'Pause' : status?.playing === false ? 'Play' : 'Play / pause');
    previous.disabled = controlling || !status?.canPrevious;
    toggle.disabled = controlling || !status?.canToggle;
    next.disabled = controlling || !status?.canNext;
  }

  async function refresh() {
    if (!ui.window.open) return;
    const request = ++revision;
    try {
      const snapshot = await invoke('media_status');
      if (request !== revision || !ui.window.open) return;
      status = snapshot;
      render();
    } catch {
      if (request !== revision || !ui.window.open) return;
      status = null;
      render(true);
    } finally {
      if (request === revision && ui.window.open) timer = setTimeout(refresh, statusInterval);
    }
  }

  async function control(action) {
    if (controlling) return;
    controlling = true;
    revision++;
    clearTimeout(timer);
    render();
    ui.error('');
    try {
      await invoke('media_action', { action });
    } catch (error) {
      ui.error(typeof error === 'string' ? error : 'Spotify could not apply the control.');
    } finally {
      controlling = false;
      if (ui.window.open) {
        render();
        await refresh();
      }
    }
  }

  function searchName() {
    const name = query.value.trim().toWellFormed();
    if (!name || name === '.' || name === '..') {
      ui.error('Enter a track, playlist or podcast name.');
      query.focus();
      return '';
    }
    return name;
  }

  async function openLink(value, control) {
    if (control?.disabled) return;
    if (control) control.disabled = true;
    ui.error('');
    try {
      await invoke('open_terminal_link', { value });
    } catch (error) {
      ui.error(typeof error === 'string' ? error : 'Spotify could not open in your browser.');
    } finally {
      if (control) control.disabled = false;
    }
  }

  function openSearch() {
    const name = searchName();
    if (name) {
      const route = Object.hasOwn(browserRoutes, category.value) ? browserRoutes[category.value] : 'playlists';
      void openLink(`https://open.spotify.com/search/${encodeURIComponent(name)}/${route}`, external);
    }
  }

  function showAccount() {
    setText(authorizationStatus, authorizing ? 'Finish authorizing in your browser.' : connected ? 'Spotify account connected.' : '');
    authorizationStatus.hidden = !authorizationStatus.textContent;
    connectionDetails.hidden = connected;
    disconnectButton.hidden = !connected;
    disconnectButton.disabled = changingAccount;
    connect.disabled = authorizing || changingAccount;
    cancel.hidden = !authorizing;
    cancel.disabled = changingAccount;
    clientId.disabled = authorizing;
    library.hidden = !connected;
    library.disabled = loadingPage || changingAccount;
    submit.hidden = !connected;
    submit.disabled = loadingPage || changingAccount;
  }

  async function connectAccount(event) {
    event.preventDefault();
    if (authorizing || changingAccount) return;
    authorizing = true;
    showAccount();
    ui.error('');
    try {
      await invoke('spotify_connect', { clientId: clientId.value.trim() });
      connected = true;
      clientId.value = '';
    } catch (error) {
      ui.error(typeof error === 'string' ? error : 'Spotify could not connect.');
    } finally {
      authorizing = false;
      showAccount();
    }
  }

  async function disconnect() {
    if (changingAccount) return;
    changingAccount = true;
    showAccount();
    ui.error('');
    try {
      await invoke('spotify_disconnect');
      connected = false;
      currentPage = undefined;
      resultList.replaceChildren();
      resultNav.hidden = true;
      resultStatus.hidden = true;
    } catch (error) {
      ui.error(typeof error === 'string' ? error : 'Spotify could not disconnect.');
    } finally {
      changingAccount = false;
      showAccount();
    }
  }

  function submitSearch(event) {
    event.preventDefault();
    if (!connected) {
      openSearch();
      return;
    }
    const name = searchName();
    if (name) void loadPage({ query: name, kind: category.value, offset: 0 });
  }

  async function loadPage(request) {
    if (!connected || loadingPage || changingAccount) return;
    loadingPage = true;
    showAccount();
    ui.error('');
    resultStatus.hidden = false;
    setText(resultStatus, request.query ? 'Searching Spotify…' : 'Loading your library…');
    try {
      const page = await invoke(request.query ? 'spotify_search' : 'spotify_library', request);
      if (!connected || !ui.window.open) return;
      currentPage = { ...request, nextOffset: page.nextOffset };
      resultList.replaceChildren(...page.items.map(item => result(item, request.kind)));
      setText(resultStatus, page.items.length ? (request.query ? 'Search results' : 'Your Spotify library') : 'No results on this page.');
      resultNav.hidden = !request.offset && page.nextOffset === null;
      previousPage.disabled = !request.offset;
      nextPage.disabled = page.nextOffset === null;
    } catch (error) {
      if (!connected) return;
      setText(resultStatus, 'Spotify results unavailable.');
      ui.error(typeof error === 'string' ? error : 'Spotify results could not be loaded.');
    } finally {
      loadingPage = false;
      showAccount();
    }
  }

  function result(item, kind) {
    const open = button('Open in Spotify', () => openLink(item.url, open));
    const play = item.canPlay ? button('Play', async () => {
      if (startingPlayback || changingAccount) return;
      startingPlayback = true;
      play.disabled = true;
      ui.error('');
      try {
        await invoke('spotify_play', { kind, id: item.id });
        if (connected && !loadingPage) setText(resultStatus, 'Playback started on your active Spotify device.');
      } catch (error) {
        ui.error(typeof error === 'string' ? error : 'Spotify could not start playback.');
      } finally {
        startingPlayback = false;
        play.disabled = false;
      }
    }, { title: 'Play on your active Spotify device', class: 'primary' }) : null;
    return el('li', {}, el('strong', { text: item.name }), item.subtitle && el('p', { text: item.subtitle }),
      el('div', { class: 'dialog-footer' }, open, play));
  }

  async function restoreAccount() {
    try {
      const restored = await invoke('spotify_status');
      if (authorizing || changingAccount || !ui.window.open) return;
      connected = restored;
      showAccount();
    } catch (error) {
      ui.error(typeof error === 'string' ? error : 'Spotify connection is unavailable.');
      // Allow a corrupt or moved protected connection to be cleared locally.
      disconnectButton.hidden = false;
    }
  }

  showAccount();
  query.focus();
  void restoreAccount();
  void refresh();
}
