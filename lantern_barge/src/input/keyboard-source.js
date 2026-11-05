// input/keyboard-source.js — keyboard bindings for the EventSource (GDD §10). Owner: PD.
// F / J = left / right straight, D / K = left / right hook, hold Space = guard.
// Taps fire on keydown; key repeat is ignored. Timestamps come from the clock (via the event source).
// Menu keys (Enter, P, Escape) are passed to onMenuKey for main.js to route to sim.command.

const PUNCH_KEYS = Object.freeze({
  KeyF: ['left', 'straight'],
  KeyJ: ['right', 'straight'],
  KeyD: ['left', 'hook'],
  KeyK: ['right', 'hook'],
});
const MENU_KEYS = new Set(['Enter', 'KeyP', 'Escape']);
const isTextField = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
const isControl = (el) => !!el && ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName);

/**
 * @param {ReturnType<import('./event-source.js').createEventSource>} source
 * @param {{target?: EventTarget, onMenuKey?: (code:string) => void, punches?: boolean}} [opts]
 *   punches=false attaches menu keys only (camera play still gets Enter/P/Esc).
 * @returns {() => void} detach
 */
export function attachKeyboard(source, { target = window, onMenuKey = () => {}, punches = true } = {}) {
  if (punches) source.attachKeyboard();

  const onDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    if (isTextField(e.target)) return; // typing in a field (e.g. the recorder's subject) is not a punch
    // Enter on a focused button activates that button (BUG-001); the menu-key meaning applies elsewhere
    if (e.code === 'Enter' && isControl(e.target)) return;
    if (MENU_KEYS.has(e.code)) {
      if (!e.repeat) onMenuKey(e.code);
      if (e.code === 'Enter') e.preventDefault();
      return;
    }
    if (!punches) return;
    if (e.code === 'Space') {
      e.preventDefault(); // no page scroll / button activation
      if (!e.repeat) source.setKeyGuard(true);
      return;
    }
    const p = PUNCH_KEYS[e.code];
    if (p) {
      e.preventDefault();
      if (!e.repeat) source.keyPunch(p[0], p[1]);
    }
  };
  const onUp = (e) => {
    if (punches && e.code === 'Space') {
      e.preventDefault();
      source.setKeyGuard(false);
    }
  };
  const onBlur = () => source.setKeyGuard(false);

  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
    if (punches) source.detachKeyboard();
  };
}
