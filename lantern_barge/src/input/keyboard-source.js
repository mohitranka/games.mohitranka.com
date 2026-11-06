// input/keyboard-source.js — keyboard bindings for the EventSource (GDD §10). Owner: PD.
// Home row (D11): left hand S D F = uppercut, hook, straight; right hand J K L = straight, hook, uppercut.
// Hold Space = guard.
// Taps fire on keydown; key repeat is ignored. Timestamps come from the clock (via the event source).
// Menu keys (Enter, P, Escape) are passed to onMenuKey for main.js to route to sim.command.

import { activeKeymap } from '../shared/keymap.js';
import { NO_FEATURES } from '../shared/features.js';

const MENU_KEYS = new Set(['Enter', 'KeyP', 'Escape', 'KeyR', 'Backspace', 'KeyM']); // R / Backspace / M: D14 training menu
const isTextField = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
const isControl = (el) => !!el && ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName);

/**
 * @param {ReturnType<import('./event-source.js').createEventSource>} source
 * @param {{target?: EventTarget, onMenuKey?: (code:string) => void, punches?: boolean, features?: object}} [opts]
 *   punches=false attaches menu keys only (camera play still gets Enter/P/Esc).
 * @returns {() => void} detach
 */
export function attachKeyboard(source, { target = window, onMenuKey = () => {}, punches = true, features = NO_FEATURES } = {}) {
  if (punches) source.attachKeyboard();
  // feature-gated bindings (shared/keymap.js): S / L uppercuts, Shift + F/J/D/K body, A / ; parry only with ?next=1
  const active = activeKeymap(features);
  const PUNCH_KEYS = Object.fromEntries(active.filter((b) => b.action === 'punch' && !b.modifier).map((b) => [b.code, b]));
  const SHIFT_KEYS = Object.fromEntries(active.filter((b) => b.action === 'body' && b.modifier === 'Shift').map((b) => [b.code, b]));
  const PARRY_KEYS = Object.fromEntries(active.filter((b) => b.action === 'parry').map((b) => [b.code, b]));

  const onDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone (Shift is the one modifier we use)
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
    const pr = PARRY_KEYS[e.code];
    if (pr) {
      e.preventDefault();
      if (!e.repeat) source.keyParry(pr.hand);
      return;
    }
    const p = (e.shiftKey && SHIFT_KEYS[e.code]) || PUNCH_KEYS[e.code];
    if (p) {
      e.preventDefault();
      if (!e.repeat) source.keyPunch(p.hand, p.variantOf ?? p.punchType, p.target ?? 'head');
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
