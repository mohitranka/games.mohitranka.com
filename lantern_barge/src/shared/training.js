// shared/training.js — D14 training: the move list and items from the features, and stored progress. Owner: PD.
// Every gate goes through `features`, so making ?next=1 the default is a one-line change in features.js.

import { TRAINING_MOVE as M, TRAINING_ITEM_KIND as K, TRAINING_STORAGE_KEY } from './constants.js';

/** The moves of the default build (no flags). The Box path skips the practice card when all are mastered. */
export const DEFAULT_MOVES = Object.freeze([M.GUARD, M.STRAIGHT, M.HOOK]);

/** Defensive moves are mastered through the defence drill; the rest through the mitt drill (rise: lesson only). */
export const DEFENSIVE_MOVES = Object.freeze([M.GUARD, M.PARRY, M.SLIP, M.DUCK]);
export const LESSON_ONLY_MOVES = Object.freeze([M.RISE]);

/**
 * Enabled moves in lesson order.
 * @param {import('./features.js').Features} features
 * @returns {string[]}
 */
export function trainingMoves(features) {
  const f = features ?? {};
  const out = [M.GUARD, M.STRAIGHT, M.HOOK];
  if (f.uppercut) out.push(M.UPPERCUT);
  if (f.body) out.push(M.BODY);
  if (f.parry) out.push(M.PARRY);
  if (f.rise) out.push(M.RISE);
  if (f.slip) out.push(M.SLIP, M.DUCK);
  return out;
}

/**
 * The training menu (§15.1): one lesson per enabled move, then the drills, free sparring and start match.
 * @returns {Array<{id:string, kind:string, move:string|null}>}
 */
export function trainingItems(features) {
  return [
    ...trainingMoves(features).map((move) => ({ id: `${K.LESSON}:${move}`, kind: K.LESSON, move })),
    { id: K.MITT, kind: K.MITT, move: null },
    { id: K.DEFENCE, kind: K.DEFENCE, move: null },
    { id: K.SPARRING, kind: K.SPARRING, move: null },
    { id: K.START_MATCH, kind: K.START_MATCH, move: null },
  ];
}

/** Mitt-drill shot pool: {hand, punchType, target} for every enabled punch (§15.4). */
export function mittShots(features) {
  const types = ['straight', 'hook', ...(features?.uppercut ? ['uppercut'] : [])];
  const shots = [];
  for (const punchType of types) for (const hand of ['left', 'right']) shots.push({ hand, punchType, target: 'head' });
  if (features?.body) for (const punchType of ['straight', 'hook']) for (const hand of ['left', 'right']) shots.push({ hand, punchType, target: 'body' });
  return shots;
}

/** The move a mitt-drill shot trains (body shots train 'body'). */
export const shotMove = (shot) => (shot.target === 'body' ? M.BODY : shot.punchType);

// ───────────────────────────────────────────── progress (§15.6)

/**
 * Session progress for one input: lessons done and best drill scores per move; `mastered` is derived.
 * Only `mastered` is persisted (localStorage, per input); everything else is per session.
 */
export function createTrainingProgress({ input, features, storage = defaultStorage() }) {
  const lessons = new Set();
  const drill = new Map(); // move → best score 0..1
  const stored = new Set(loadMastered(storage, input));
  const moves = trainingMoves(features);

  function isMastered(move) {
    if (stored.has(move)) return true;
    if (!lessons.has(move)) return false;
    if (LESSON_ONLY_MOVES.includes(move)) return true;
    return (drill.get(move) ?? 0) >= 0.8 - 1e-9;
  }

  return {
    input,
    /** Feed game events; returns true when `mastered` changed (then it has been saved). */
    handle(events) {
      const before = this.mastered.join();
      for (const e of events) {
        if (e.type !== 'training_result') continue;
        if (e.item?.startsWith(`${K.LESSON}:`) && e.score >= 1 - 1e-9) lessons.add(e.item.slice(K.LESSON.length + 1));
        for (const [move, score] of Object.entries(e.perMove ?? {})) drill.set(move, Math.max(drill.get(move) ?? 0, score));
      }
      const now = this.mastered;
      if (now.join() === before) return false;
      for (const m of now) stored.add(m);
      saveMastered(storage, input, [...stored]);
      return true;
    },
    /** Mastered moves among the enabled ones (stored ones for disabled features stay stored but aren't listed). */
    get mastered() {
      return moves.filter(isMastered);
    },
    get allDefaultMastered() {
      return DEFAULT_MOVES.every(isMastered);
    },
  };
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access itself can throw (blocked site data)
  }
}

/** Every read is wrapped: blocked or corrupt storage means "nothing stored". */
export function loadMastered(storage, input) {
  try {
    const raw = storage?.getItem(TRAINING_STORAGE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw);
    const list = all?.[input]?.mastered;
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

/** Every write is wrapped: with storage blocked, progress is simply per session. */
export function saveMastered(storage, input, mastered) {
  try {
    if (!storage) return false;
    let all = {};
    try {
      all = JSON.parse(storage.getItem(TRAINING_STORAGE_KEY) ?? '{}') ?? {};
    } catch {
      all = {};
    }
    all[input] = { mastered: [...new Set(mastered)].sort() };
    storage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
