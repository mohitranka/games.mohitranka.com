// input/pipeline.js — tracker + recognizer as one pure unit (no clock, no DOM). Owner: PD.
// Used by hand-source.js (camera and replay), eval.js and the recognizer unit specs, so all three run
// exactly the same code on the same results.

import { HANDS } from '../shared/constants.js';
import { createHandTracker } from './hand-tracker.js';
import { createRecognizer } from './recognizer.js';
import { DEFAULT_PROFILE } from './tuning.js';

/**
 * @param {{tuning: object, profile?: import('../shared/types.js').CalibrationProfile}} opts
 */
export function createInputPipeline({ tuning, profile = DEFAULT_PROFILE }) {
  const tracker = createHandTracker({ tuning });
  const recognizer = createRecognizer({ tuning });
  let prof = profile;

  return {
    tracker,
    recognizer,
    get profile() {
      return prof;
    },
    setProfile(p) {
      prof = p;
    },
    /**
     * Feed one detection result (t in sim seconds, landmarks as arrays).
     * @returns {{punches: object[], seen: {left:boolean, right:boolean}, t:number}}
     */
    ingest(result) {
      const upd = tracker.update(result);
      const punches = recognizer.update(tracker, upd, prof);
      return { punches, seen: upd.seen, t: upd.t };
    },
    /** Hands + guard for a frame at time t. */
    frameState(t) {
      const hands = {};
      for (const h of HANDS) {
        const hs = tracker.handState(h, t, prof);
        hs.punchPhase = recognizer.punchPhase(h, t);
        hands[h] = hs;
      }
      const guard = recognizer.guardAt(t);
      hands.left.inGuardZone = guard.left;
      hands.right.inGuardZone = guard.right;
      return { hands, guard };
    },
  };
}
