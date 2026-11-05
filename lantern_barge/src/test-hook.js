// test-hook.js — window.__game (architecture §3.10, D7). Owner: PD.
// Installed synchronously by main.js; every call except `ready` throws until boot has finished.

/**
 * @param {Object} core  internals handed over by main.js
 */
export function installTestHook(core) {
  let booted = false;
  core.ready.then(() => {
    booted = true;
  }, () => {});
  const need = () => {
    if (!booted) throw new Error('__game: not ready yet (await __game.ready)');
    return core.getSim();
  };

  const api = {
    version: 2,
    ready: core.ready,

    // ── time (any call switches to the manual clock for the rest of the session)
    /** @returns {{ticks:number, state:object}} */
    advance(ms, opts) {
      need();
      return core.advance(ms, opts);
    },
    /** @returns {{ticks:number, state:object}} */
    step(n = 1, opts) {
      need();
      return core.step(n, opts);
    },
    now() {
      return core.now();
    },

    // ── state
    state() {
      return need().snapshot();
    },
    input() {
      need();
      return structuredClone(core.getLastFrame());
    },
    /** [{tick, ...event}] with tick >= sinceTick (and type, if given); `.dropped` = entries lost to the 10 000 cap */
    events({ sinceTick = 0, type } = {}) {
      need();
      const list = core.log.entries.filter((e) => e.tick >= sinceTick && (!type || e.type === type));
      const outList = structuredClone(list);
      outList.dropped = core.log.dropped;
      return outList;
    },
    clearEvents() {
      need();
      core.log.entries.length = 0;
    },
    /** [{tick, cmd}] — tick at which each command is (or was) applied */
    commandLog() {
      return structuredClone(core.commandLog);
    },

    // ── input (works on top of ANY source; lands on the next sample())
    inject: {
      /** @returns {object} the queued punch event (with its id) */
      punch(hand, punchType = 'straight', power = 0.8, { tOnset, tCommit, inferred = false, aimX = 0.5, id } = {}) {
        need();
        if (hand !== 'left' && hand !== 'right') throw new Error(`inject.punch: bad hand ${hand}`);
        return structuredClone(core.events.pushPunch({ hand, punchType, power, tOnset, tCommit, inferred, aimX, id }));
      },
      /** 'none' | 'full' persists until changed; null releases the override */
      guard(level) {
        need();
        core.events.setGuard(level === undefined ? null : level);
      },
      /** later injected events are stamped now − ms */
      latency(ms) {
        need();
        core.events.setLatency(ms);
      },
    },
    /** url or JSONL text → Promise<{results, cues, durationS, calibrate}>; switches to the replay HandSource */
    loadReplay(urlOrJsonl, opts = {}) {
      need();
      return core.loadReplay(urlOrJsonl, opts);
    },

    // ── sim
    command(cmd) {
      need();
      core.command(cmd);
    },

    // ── tuning: {input, game, view} by reference
    tuning: core.tuning,
    /** e.g. setTuning('input.refractoryMs', 180) → returns the previous value */
    setTuning(path, value) {
      const root = path.split('.')[0];
      if (!(root in core.tuning)) throw new Error(`setTuning: path must start with input|game|view (${path})`);
      return core.setTuning(path, value);
    },

    // ── diagnostics
    /** {fps, drawCalls, triangles, inferHz?, simMs, renderMs, tracking}; inferHz only for camera/replay sources */
    perf() {
      return core.perf();
    },
    /** kind of the active input source: 'camera' | 'replay' | 'keyboard' | 'none' */
    get sourceKind() {
      return core.getSource()?.kind ?? 'none';
    },
    /** ?debug=1 only: the overlay API (copyText, setSlider, startRecording, recorder); null otherwise */
    get debugOverlay() {
      return core.getOverlay();
    },
    /** which layers are real vs stubbed */
    get layers() {
      return { ...core.layers };
    },
  };

  window.__game = api;
  window.advanceTime = (ms) => api.advance(ms).state;
  window.render_game_to_text = () => JSON.stringify(api.state());
  return api;
}
