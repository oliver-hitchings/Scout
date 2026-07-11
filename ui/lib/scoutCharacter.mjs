export const SCOUT_STATES = Object.freeze({
  idle: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: true, reducedMotionFrame: 0, label: 'Scout is ready' },
  welcome: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: false, reducedMotionFrame: 12, label: 'Scout welcomes you' },
  asking: { src: '/assets/scout-explaining.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: true, reducedMotionFrame: 8, label: 'Scout is asking a question' },
  listening: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 6, loop: true, reducedMotionFrame: 2, label: 'Scout is listening' },
  thinking: { src: '/assets/scout-thinking.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: true, reducedMotionFrame: 9, label: 'Scout is thinking' },
  searching: { src: '/assets/scout-searching.png', columns: 4, rows: 4, frames: 16, fps: 10, loop: true, reducedMotionFrame: 8, label: 'Scout is searching' },
  writing: { src: '/assets/scout-explaining.png', columns: 4, rows: 4, frames: 16, fps: 10, loop: true, reducedMotionFrame: 6, label: 'Scout is updating your files' },
  found: { src: '/assets/scout-found.png', columns: 4, rows: 4, frames: 16, fps: 10, loop: false, reducedMotionFrame: 15, label: 'Scout found a strong match' },
  explaining: { src: '/assets/scout-explaining.png', columns: 4, rows: 4, frames: 16, fps: 9, loop: true, reducedMotionFrame: 7, label: 'Scout is explaining' },
  success: { src: '/assets/scout-found.png', columns: 4, rows: 4, frames: 16, fps: 12, loop: false, reducedMotionFrame: 15, label: 'Scout finished successfully' },
  warning: { src: '/assets/scout-warning.png', columns: 4, rows: 4, frames: 16, fps: 8, loop: false, reducedMotionFrame: 12, label: 'Scout needs your attention' },
  sleeping: { src: '/assets/scout-idle.png', columns: 4, rows: 4, frames: 16, fps: 4, loop: true, reducedMotionFrame: 0, label: 'Scout is resting' },
});

export function scoutDefinition(state, definitions = SCOUT_STATES) {
  return definitions[state] || definitions.idle;
}

export function framePosition(frame, definition) {
  const safe = Math.max(0, Math.min(definition.frames - 1, Number(frame) || 0));
  return { column: safe % definition.columns, row: Math.floor(safe / definition.columns) };
}

export function activityState(activity) {
  const value = String(activity || '').toLowerCase();
  if (/search|read|fetch|browse|source|advert/.test(value)) return 'searching';
  if (/write|edit|patch|file|cv|resume/.test(value)) return 'writing';
  if (/explain|answer|respond|delta/.test(value)) return 'explaining';
  return 'thinking';
}

export function scoutMarkup(state = 'idle', className = '') {
  const def = scoutDefinition(state);
  return `<span class="scout-character ${className}" data-scout-state="${state}" role="img" aria-label="${def.label}"><span class="scout-sprite" aria-hidden="true"></span></span>`;
}

export function applyScoutState(element, state, { reducedMotion = false } = {}) {
  if (!element) return null;
  const def = scoutDefinition(state);
  const sprite = element.matches?.('.scout-sprite') ? element : element.querySelector?.('.scout-sprite');
  element.dataset.scoutState = state in SCOUT_STATES ? state : 'idle';
  element.setAttribute('aria-label', def.label);
  if (!sprite) return def;
  const duration = def.frames / def.fps;
  const still = framePosition(def.reducedMotionFrame, def);
  sprite.style.setProperty('--scout-src', `url("${def.src}")`);
  sprite.style.setProperty('--scout-columns', def.columns);
  sprite.style.setProperty('--scout-rows', def.rows);
  sprite.style.setProperty('--scout-frames', def.frames);
  sprite.style.setProperty('--scout-duration', `${duration}s`);
  sprite.style.setProperty('--scout-iterations', def.loop ? 'infinite' : '1');
  sprite.style.setProperty('--scout-still-x', `${still.column * 100 / Math.max(1, def.columns - 1)}%`);
  sprite.style.setProperty('--scout-still-y', `${still.row * 100 / Math.max(1, def.rows - 1)}%`);
  sprite.classList.toggle('reduced-motion', reducedMotion);
  observeCharacter(element);
  return def;
}

const observed = new WeakSet();
function observeCharacter(element) {
  if (observed.has(element) || typeof IntersectionObserver === 'undefined') return;
  observed.add(element);
  const observer = new IntersectionObserver(([entry]) => {
    element.classList.toggle('scout-offscreen', !entry.isIntersecting);
  });
  observer.observe(element);
}

if (typeof window !== 'undefined') {
  window.ScoutCharacter = { SCOUT_STATES, scoutDefinition, framePosition, activityState, scoutMarkup, applyScoutState };
  document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('scout-page-hidden', document.hidden));
}
