// view/features.js — which not-yet-default actions the view may show (owner: TA).
// PD's flags (shared/features.js) arrive on every InputFrame as frame.features (?next=1 turns them all on). The view
// never reads the URL. Without a flag, the HUD looks exactly as it did before the feature.
import { NO_FEATURES } from '../shared/features.js';
import * as KM from '../shared/keymap.js';

export function featuresOf(frame, state) {
  return frame?.features ?? state?.features ?? NO_FEATURES;
}

/** @returns {boolean} */
export function featureOn(name, state, frame) {
  return !!featuresOf(frame, state)[name];
}

/** Key labels bound for a punch type / guard under the active features (shared/keymap.js is the source). */
function boundKeys(features, pred) {
  return KM.activeKeymap(features).filter(pred).map((b) => b.label);
}

/** Keymap labels once PD has added the binding; the §10 table until then. */
function orTable(fromKeymap, table) {
  return fromKeymap.length ? fromKeymap : table;
}

/**
 * Every player action with its keyboard and camera form (game-design §10; P1 input parity).
 * `feature` = null for the MVP actions; `lamp` = a practice lamp that lights when performed.
 * Keys for punches and guard come from the shared keymap; D12 keys not in it yet use the §10 table.
 */
export const MOVES = Object.freeze([
  { id: 'straight', label: 'Straight', feature: null, lamp: true, keys: (f) => boundKeys(f, (b) => b.punchType === 'straight'), keyText: '', cam: 'punch straight out' },
  { id: 'hook', label: 'Hook', feature: null, lamp: true, keys: (f) => boundKeys(f, (b) => b.punchType === 'hook'), keyText: '', cam: 'swing in from the side' },
  { id: 'uppercut', label: 'Uppercut', feature: 'uppercut', lamp: true, keys: (f) => boundKeys(f, (b) => b.punchType === 'uppercut'), keyText: '', cam: 'dip low, drive up' },
  { id: 'body', label: 'Body', feature: 'body', lamp: true, keys: (f) => orTable(boundKeys(f, (b) => b.modifier === 'Shift').length ? ['Shift'] : [], ['Shift']), keyText: 'hold + F/J/D/K', cam: 'punch with your fist low' },
  { id: 'parry', label: 'Parry', feature: 'parry', lamp: true, keys: (f) => orTable(boundKeys(f, (b) => b.action === 'parry'), ['A', ';']), keyText: 'tap as she swings', cam: 'swipe one glove outward as she swings' },
  { id: 'guard', label: 'Guard', feature: null, lamp: true, keys: (f) => boundKeys(f, (b) => b.action === 'guard'), keyText: 'hold', cam: 'both fists at your chin' },
  { id: 'slip', label: 'Slip', feature: 'slip', lamp: true, keys: (f) => orTable(boundKeys(f, (b) => b.action === 'slip'), ['Q', 'P']), keyText: 'hold', cam: 'lean your head left or right' },
  { id: 'duck', label: 'Duck', feature: 'slip', lamp: true, keys: (f) => orTable(boundKeys(f, (b) => b.action === 'duck'), ['Z', '/']), sep: ' or ', keyText: 'hold', cam: 'drop your head' },
  { id: 'rise', label: 'Get up', feature: 'rise', lamp: false, keys: (f) => boundKeys(f, (b) => b.action === 'guard'), keyText: 'hold while down', cam: 'hold your guard while down' },
]);

export function activeMoves(state, frame) {
  const f = featuresOf(frame, state);
  return MOVES.filter((m) => !m.feature || f[m.feature]);
}

/** True when any gated move is on, i.e. the practice card should use the full per-input moves table. */
export function anyGatedMove(state, frame) {
  const f = featuresOf(frame, state);
  return MOVES.some((m) => m.feature && f[m.feature]);
}

/**
 * Menu key label (confirm / pause / cancel) from PD's hint data in shared/keymap.js. With ?next=1 the pause key may
 * depend on the features (Esc in FIGHT, since P becomes slip right): a `menuKeys(features)` export wins if present.
 */
export function menuKey(action, frame, state) {
  const f = featuresOf(frame, state);
  const src = typeof KM.menuKeys === 'function' ? KM.menuKeys(f, state?.phase) : KM.MENU_KEYMAP;
  return src?.[action] ?? KM.MENU_KEYMAP[action];
}
