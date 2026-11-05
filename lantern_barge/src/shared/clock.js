// shared/clock.js — the single time base (architecture §2.2, D4). Owner: PD.
// clock.now() returns SIM SECONDS. Live: performance.now()/1000 - offset. Manual: a value set by main.js.
// game/* must not import this (it reads time only from dt).

/**
 * @typedef {Object} Clock
 * @property {boolean} manual          true: time only moves when main.js calls set()
 * @property {() => number} now        sim seconds
 * @property {(t:number) => void} set  manual mode: set the current sim time
 * @property {(ms:number) => number} fromPerfMs  map a performance.now()-domain timestamp (ms) to sim seconds
 * @property {(dt:number) => void} rebase        live mode: drop dt seconds of lag (grows the offset)
 */

/** @returns {Clock} */
export function createClock({ manual = false } = {}) {
  const perfS = () => performance.now() / 1000;
  let offset = perfS(); // sim time 0 == clock creation
  let isManual = false;
  let manualT = 0;

  const clock = {
    get manual() {
      return isManual;
    },
    set manual(v) {
      v = !!v;
      if (v === isManual) return;
      if (v) manualT = perfS() - offset; // freeze at the current live time
      else offset = perfS() - manualT; // resume live from the frozen time, no jump
      isManual = v;
    },
    now() {
      return isManual ? manualT : perfS() - offset;
    },
    set(t) {
      manualT = t;
    },
    fromPerfMs(ms) {
      return ms / 1000 - offset;
    },
    rebase(dt) {
      if (dt > 0) offset += dt;
    },
  };
  if (manual) {
    isManual = true;
    manualT = 0;
  }
  return clock;
}
