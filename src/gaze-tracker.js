// Hidden page: reads the webcam, runs MediaPipe Face Landmarker locally (WASM, nothing leaves this computer)
// and reports head yaw ~12 times a second. The camera is only open between 'start' and 'stop'.
import { FaceLandmarker, FilesetResolver } from './gaze-vendor/vision_bundle.mjs';

const FPS = 24;
// While the head has hardly moved for a moment (or no face is in view) the camera is read less often: the first real movement brings the
// full rate back within one slow frame. This roughly halves the work of keeping Look to switch on.
const SLOW_FPS = 15, CALM_DEG = 1.2, CALM_MS = 1500;
let lastYaw = null, calmSince = 0, slow = false;
let landmarker = null, make = null, delegateUsed = '', switching = false, stream = null, timer = null, running = false, preview = false, fails = 0;
const video = document.getElementById('v');
const canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
const info = document.getElementById('info'), yawEl = document.getElementById('yaw');

async function load() {
  if (landmarker) return;
  const fileset = await FilesetResolver.forVisionTasks('./gaze-vendor/wasm');
  make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: './gaze-vendor/face_landmarker.task', delegate },
    runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
    outputFacialTransformationMatrixes: true,
  });
  try { landmarker = await make('GPU'); delegateUsed = 'GPU'; } catch (e) { console.log('gaze GPU delegate unavailable, using CPU: ' + e.message); landmarker = await make('CPU'); delegateUsed = 'CPU'; }
}

// yaw in degrees from the 4x4 (column-major) face transform
const yawOf = (m) => (Math.atan2(m[8], m[10]) * 180) / Math.PI;
const pitchOf = (m) => (Math.atan2(-m[9], m[10]) * 180) / Math.PI;

function tick() {
  if (!running) return;
  const t0 = performance.now();
  try {
    if (video.readyState >= 2) {
      const r = landmarker.detectForVideo(video, t0);
      const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
      const yaw = m ? yawOf(m.data) : null, pitch = m ? pitchOf(m.data) : null;
      window.gaze.sample(m ? { yaw, pitch } : null);
      const moved = m && lastYaw !== null ? Math.abs(yaw - lastYaw) : m ? 99 : 0; // no face counts as calm
      lastYaw = m ? yaw : null;
      if (moved > CALM_DEG) { calmSince = 0; slow = false; } else { if (!calmSince) calmSince = t0; if (t0 - calmSince > CALM_MS) slow = true; }
      if (preview) draw(r.faceLandmarks && r.faceLandmarks[0], yaw, pitch);
    }
    fails = 0;
  } catch (e) {
    console.log('gaze frame failed: ' + e.message);
    if (delegateUsed === 'GPU' && !switching) {
      switching = true;
      console.log('gaze: the GPU delegate cannot run here, switching to the CPU delegate');
      make('CPU').then((l) => { landmarker = l; delegateUsed = 'CPU'; fails = 0; switching = false; }).catch((err) => { console.log('gaze: CPU delegate failed: ' + err.message); switching = false; });
    }
    // a broken model/WebGL state fails on every frame and eats memory: stop the camera instead of looping forever
    if (!switching && ++fails >= 30) { console.log('gaze: tracking stopped after repeated failures'); stop(); window.gaze.state({ on: false, error: 'head tracking stopped (' + e.message.slice(0, 60) + ')' }); return; }
  }
  timer = setTimeout(tick, Math.max(0, 1000 / (slow && !preview ? SLOW_FPS : FPS) - (performance.now() - t0)));
}

// preview: only drawn while the preview window is visible (saves CPU otherwise)
function draw(pts, yaw, pitch) {
  // the frame itself is drawn on the canvas, so the picture and the mesh always share one coordinate system
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  if (canvas.width !== 320 || canvas.height !== Math.round((320 * vh) / vw)) { canvas.width = 320; canvas.height = Math.round((320 * vh) / vw); }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (pts) {
    ctx.fillStyle = '#30d158';
    for (const p of pts) ctx.fillRect(p.x * canvas.width - 1, p.y * canvas.height - 1, 2, 2);
  }
  info.className = pts ? '' : 'no';
  info.firstElementChild.textContent = pts ? 'Face found' : 'No face - face the camera, check lighting';
  yawEl.textContent = yaw == null ? '' : 'yaw ' + yaw.toFixed(1) + '°  pitch ' + pitch.toFixed(1) + '°';
}

async function start() {
  if (running) return;
  running = true;
  try {
    await load();
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 }, audio: false });
    if (!running) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; } // stopped while starting
    video.srcObject = stream;
    await video.play();
    window.gaze.state({ on: true });
    tick();
  } catch (e) {
    running = false;
    stop();
    window.gaze.state({ on: false, error: e.name === 'NotAllowedError' ? 'camera access denied' : e.message });
  }
}

function stop() {
  running = false;
  clearTimeout(timer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  window.gaze.state({ on: false });
}

window.gaze.onCmd((c) => { if (c === 'start') start(); else if (c === 'stop') stop(); else if (c === 'preview-on') preview = true; else if (c === 'preview-off') { preview = false; } });
