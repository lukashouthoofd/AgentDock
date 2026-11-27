import { button, el } from './ui.js';

export function playIntro() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const video = el('video', { class: 'intro-video', muted: true, playsinline: true, 'aria-hidden': 'true',
    src: `${import.meta.env.BASE_URL}agentdock-intro.webm` });
  video.muted = true;
  const surface = el('dialog', { class: 'intro-dialog', 'aria-label': 'AgentDock launch animation' });
  let deadline;
  function dismiss() {
    if (surface.open) surface.close();
  }
  surface.append(video, button('Skip intro', dismiss, { class: 'intro-skip' }));
  surface.addEventListener('close', () => {
    clearTimeout(deadline);
    video.pause();
    video.removeAttribute('src');
    surface.remove();
  }, { once: true });
  for (const event of ['ended', 'error']) video.addEventListener(event, dismiss, { once: true });
  document.body.append(surface);
  surface.showModal();
  deadline = setTimeout(dismiss, 4000);
  video.play().catch(dismiss);
}
