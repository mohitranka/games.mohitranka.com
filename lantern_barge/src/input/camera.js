// input/camera.js — getUserMedia + per-frame capture timestamps + stall detection (architecture §6.1). Owner: PD.
// Timestamps: rVFC metadata.captureTime, then expectedDisplayTime, then performance.now() at grab (perf ms).

/**
 * @param {HTMLVideoElement} video
 * @param {{width:number, height:number, fps:number}} want
 * @returns {Promise<MediaStream>}
 */
export async function openCamera(video, { width, height, fps }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser has no camera API');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  return stream;
}

/**
 * Calls onFrame(tsPerfMs) once per new video frame. Reports ok=false when the track ends or no frame arrives
 * for stallMs (not a watchdog: nothing is restarted).
 * @returns {{stop:() => void, readonly ok:boolean, readonly fps:number}}
 */
export function watchFrames(video, stream, onFrame, { stallMs }) {
  let stopped = false;
  let lastFrameAt = performance.now();
  let ended = false;
  let fps = 0;
  let n = 0;
  let nT = performance.now();
  const track = stream.getVideoTracks()[0];
  const onEnded = () => {
    ended = true;
  };
  track?.addEventListener('ended', onEnded);

  const tick = (ts) => {
    lastFrameAt = performance.now();
    n += 1;
    if (lastFrameAt - nT >= 1000) {
      fps = (n * 1000) / (lastFrameAt - nT);
      n = 0;
      nT = lastFrameAt;
    }
    onFrame(ts);
  };

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const loop = (now, md) => {
      if (stopped) return;
      tick(md?.captureTime ?? md?.expectedDisplayTime ?? now);
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
  } else {
    let lastTime = -1;
    const loop = () => {
      if (stopped) return;
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        tick(performance.now());
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  return {
    stop() {
      stopped = true;
      track?.removeEventListener('ended', onEnded);
      for (const t of stream.getTracks()) t.stop();
    },
    get ok() {
      return !ended && performance.now() - lastFrameAt < stallMs;
    },
    get fps() {
      return fps;
    },
  };
}
