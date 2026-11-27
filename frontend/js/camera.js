// Webcam + MediaPipe loading, shared by the eye and balance tests.
// All MediaPipe files are served locally from /vendor (downloaded by install.py) -> works offline.

let stream = null;
let visionMod = null, fileset = null;
const tasks = {};

export class CameraError extends Error {}

// Virtual cameras (OBS, Snap, Teams effects…) often output a "camera off" picture and would silently
// break detection, so a physical camera is preferred unless the user picked one explicitly.
export const VIRTUAL = /virtual|obs|snap|manycam|xsplit|transcreen|droidcam|epoccam|nvidia broadcast|mmhmm|camo|voicemeeter|vb-audio|cable output|stereo mix/i;
const PREF_KEY = 'safecheck.cameraId';

export async function listCameras() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
}

function currentDeviceId() {
  return stream?.getVideoTracks()[0]?.getSettings().deviceId;
}

async function open(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) },
    audio: false,
  });
}

/** Start (or reuse) the webcam. Throws CameraError with a human-friendly message. */
export async function startCamera(video, deviceId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('This browser cannot access a camera. Use Chrome or Edge on http://localhost.');
  }
  if (deviceId && deviceId !== currentDeviceId()) stopCamera();
  if (!stream || !stream.active) {
    try {
      const saved = deviceId || localStorage.getItem(PREF_KEY);
      try {
        stream = await open(saved);
      } catch (e) {
        if (!saved || e.name === 'NotAllowedError') throw e;
        stream = await open(null);                 // saved camera unplugged -> default
      }
      // Labels are only visible after permission: swap a virtual default for a physical camera.
      if (!saved) {
        const label = stream.getVideoTracks()[0]?.label || '';
        const physical = (await listCameras()).find((d) => d.label && !VIRTUAL.test(d.label));
        if (VIRTUAL.test(label) && physical) {
          stopCamera();
          stream = await open(physical.deviceId);
        }
      }
    } catch (e) {
      const msg = {
        NotAllowedError: 'Camera permission was denied. Click the camera icon in the address bar and allow access.',
        NotFoundError: 'No camera found. Plug in a webcam, or use Demo mode.',
        NotReadableError: 'The camera is being used by another app (Zoom/Teams?). Close it and retry.',
        OverconstrainedError: 'The camera does not support the requested resolution.',
      }[e.name] || `Could not start the camera: ${e.message}`;
      throw new CameraError(msg);
    }
  }
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    await video.play().catch(() => {});
  }
  // wait until real frames arrive
  for (let i = 0; i < 50 && video.readyState < 2; i++) await new Promise((r) => setTimeout(r, 100));
  return video;
}

export function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

/** A <select> to switch camera; remembers the choice. onChange(stream) lets previews re-attach. */
export async function cameraPicker(video, onChange) {
  const sel = document.createElement('select');
  sel.className = 'input';
  const cams = await listCameras();
  const cur = currentDeviceId();
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = (c.label || 'Camera') + (VIRTUAL.test(c.label) ? '  (virtual)' : '');
    o.selected = c.deviceId === cur;
    sel.appendChild(o);
  }
  sel.onchange = async () => {
    localStorage.setItem(PREF_KEY, sel.value);
    await startCamera(video, sel.value);
    onChange?.(video.srcObject);
  };
  return sel;
}

/** Average brightness 0..255 of the current frame (for the "bad lighting" warning). */
const probe = document.createElement('canvas');
probe.width = 32; probe.height = 18;
export function brightness(video) {
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 32, 18);
  const d = ctx.getImageData(0, 0, 32, 18).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4);
}
export function lightingMessage(b) {
  if (b < 55) return 'Too dark - turn on a light facing you.';
  if (b > 215) return 'Too bright / backlit - avoid a window behind you.';
  return null;
}

async function loadVision() {
  if (!visionMod) {
    try {
      visionMod = await import('/vendor/mediapipe/vision_bundle.mjs');
      fileset = await visionMod.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    } catch (e) {
      visionMod = null;
      console.error(e);
      throw new CameraError(`Could not load the vision engine (${e.message}). Run \`python install.py\`, or use Demo mode.`);
    }
  }
  return visionMod;
}

async function create(Klass, options) {
  // Try GPU first (fast), fall back to CPU (works everywhere).
  try {
    return await Klass.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch {
    return await Klass.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
}

export async function getFaceLandmarker() {
  if (!tasks.face) {
    const { FaceLandmarker } = await loadVision();
    tasks.face = await create(FaceLandmarker, {
      baseOptions: { modelAssetPath: '/vendor/models/face_landmarker.task' },
      runningMode: 'VIDEO', numFaces: 1,
    });
  }
  return tasks.face;
}

export async function getPoseLandmarker() {
  if (!tasks.pose) {
    const { PoseLandmarker } = await loadVision();
    tasks.pose = await create(PoseLandmarker, {
      baseOptions: { modelAssetPath: '/vendor/models/pose_landmarker_full.task' },
      runningMode: 'VIDEO', numPoses: 1,
    });
  }
  return tasks.pose;
}

/** MediaPipe VIDEO mode needs strictly increasing timestamps. */
let lastTs = 0;
export function videoTs() {
  const t = performance.now();
  lastTs = t > lastTs ? t : lastTs + 1;
  return lastTs;
}
