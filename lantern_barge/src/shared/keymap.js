// shared/keymap.js — the keyboard map, single source for keyboard-source.js (bindings) and the HUD (key hints).
// Owner: PD. Home row (game-design §10): left hand S D F = uppercut, hook, straight; right hand J K L = straight,
// hook, uppercut; Space = guard. An entry with `feature` is bound only when that feature flag is on (?next=1).
// D12: Shift (held, either side) + F/J/D/K = body variant; A / ; = parry (pinkies). D13 adds Q / P slip, Z or / duck.

/**
 * @typedef {Object} KeyBinding
 * @property {string} code        KeyboardEvent.code
 * @property {string} label       what the HUD shows
 * @property {'punch'|'guard'|'body'|'parry'} action   'body' = the Shift variant of a straight / hook
 * @property {'left'|'right'|null} hand
 * @property {'straight'|'hook'|'uppercut'|null} punchType
 * @property {'Shift'} [modifier]  held modifier for this variant (D12 body shots)
 * @property {'body'} [target]     the variant's punch target
 * @property {'straight'|'hook'} [variantOf]   for action 'body': which punch it is (punchType stays null, so
 *           punch-type lookups such as the HUD's 'Straight F / J' row don't pick up the Shift variants)
 * @property {string|null} feature   FEATURE_KEYS entry that must be on, or null (always bound)
 */

/** @type {ReadonlyArray<KeyBinding>} */
export const KEYMAP = Object.freeze([
  { code: 'KeyF', label: 'F', action: 'punch', hand: 'left', punchType: 'straight', feature: null },
  { code: 'KeyJ', label: 'J', action: 'punch', hand: 'right', punchType: 'straight', feature: null },
  { code: 'KeyD', label: 'D', action: 'punch', hand: 'left', punchType: 'hook', feature: null },
  { code: 'KeyK', label: 'K', action: 'punch', hand: 'right', punchType: 'hook', feature: null },
  { code: 'KeyS', label: 'S', action: 'punch', hand: 'left', punchType: 'uppercut', feature: 'uppercut' },
  { code: 'KeyL', label: 'L', action: 'punch', hand: 'right', punchType: 'uppercut', feature: 'uppercut' },
  { code: 'Space', label: 'Space', action: 'guard', hand: null, punchType: null, feature: null },
  // D12 body shots: Shift + F/J/D/K
  { code: 'KeyF', label: 'Shift+F', modifier: 'Shift', action: 'body', hand: 'left', punchType: null, variantOf: 'straight', target: 'body', feature: 'body' },
  { code: 'KeyJ', label: 'Shift+J', modifier: 'Shift', action: 'body', hand: 'right', punchType: null, variantOf: 'straight', target: 'body', feature: 'body' },
  { code: 'KeyD', label: 'Shift+D', modifier: 'Shift', action: 'body', hand: 'left', punchType: null, variantOf: 'hook', target: 'body', feature: 'body' },
  { code: 'KeyK', label: 'Shift+K', modifier: 'Shift', action: 'body', hand: 'right', punchType: null, variantOf: 'hook', target: 'body', feature: 'body' },
  // D12 parry (tap)
  { code: 'KeyA', label: 'A', action: 'parry', hand: 'left', punchType: null, feature: 'parry' },
  { code: 'Semicolon', label: ';', action: 'parry', hand: 'right', punchType: null, feature: 'parry' },
].map(Object.freeze));

/** Menu keys (D10 gestures mirror these). */
export const MENU_KEYMAP = Object.freeze({ confirm: 'Enter', pause: 'P', cancel: 'Esc' });

/**
 * Menu keys for the active features and phase (TA's hints and main.js routing agree on this).
 * With the slip feature (?next=1), P is "slip right" during FIGHT, so pause moves to Esc there; while paused,
 * Esc or P resumes. Without it, P is pause exactly as before.
 * @param {object} features
 * @param {string} phase
 * @returns {{confirm:string, pause:string, resume:string, cancel:string}}
 */
export function menuKeys(features, phase) {
  const slipKeys = !!features?.slip && phase === 'fight';
  return { confirm: 'Enter', pause: slipKeys ? 'Esc' : 'P', resume: slipKeys ? 'Esc' : 'P', cancel: 'Esc' };
}

/** Bindings active under a features object. */
export function activeKeymap(features) {
  return KEYMAP.filter((b) => !b.feature || features?.[b.feature]);
}
