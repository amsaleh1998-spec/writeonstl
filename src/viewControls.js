// Camera control for the 3D view, matching the 3D view of Quick DICOM Planning:
//
// - left-drag rotates freely: turn around the vertical axis and tilt over the top, no pole lock;
//   a quick flick keeps the model turning and slows down like a scroll
// - right-drag zooms (down = closer) around the pressed point, the wheel zooms at the cursor
// - middle-drag / Shift+drag / Alt+drag pans
// - middle-click on the surface makes that point the centre of rotation, without moving the view
// - SpaceMouse in "object mode": the model follows the cap
//
// The camera is a perspective camera described by a target, an orthonormal basis
// (right, up, fwd), a zoom given as mm per screen pixel at the target, and a pan offset.
import * as THREE from 'three';

export const FOV_DEG = 30;
const FOV = THREE.MathUtils.degToRad(FOV_DEG);
const MIN_SCALE = 1e-4;
const MAX_SCALE = 100;

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Rodrigues rotation of v around a unit axis (same convention as Quick DICOM Planning). */
function rotate(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = new THREE.Vector3().crossVectors(axis, v);
  const d = axis.dot(v) * (1 - c);
  return v.clone().multiplyScalar(c).addScaledVector(k, s).addScaledVector(axis, d);
}

const PRESETS = {
  // [fwd, up] in world axes (Z up, as STL files usually are)
  front: [[0, 1, 0], [0, 0, 1]],
  back: [[0, -1, 0], [0, 0, 1]],
  left: [[1, 0, 0], [0, 0, 1]],
  right: [[-1, 0, 0], [0, 0, 1]],
  top: [[0, 0, -1], [0, 1, 0]],
  bottom: [[0, 0, 1], [0, 1, 0]],
  iso: [[-1, 1.3, -0.9], [0, 0, 1]],
};
/** SpaceMouse right button cycles through these */
const CYCLE = ['front', 'right', 'back', 'left', 'top', 'bottom'];

export class ViewControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} el  element whose size is the viewport
   */
  constructor(camera, el) {
    this.camera = camera;
    this.el = el;
    camera.fov = FOV_DEG;
    this.worldUp = new THREE.Vector3(0, 0, 1);
    this.target = new THREE.Vector3();
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 0, 1);
    this.fwd = new THREE.Vector3(0, 1, 0);
    this.scale = 0.3; // mm per CSS pixel at the target
    this.panU = 0;
    this.panV = 0;
    this.bounds = new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    this.homeView = 'iso';
    this.orbiting = false;
    this.pivotFlashUntil = 0;
    this.dragHist = [];
    this.coast = 0;
    this.presetIdx = 0;
  }

  get w() { return Math.max(1, this.el.clientWidth); }
  get h() { return Math.max(1, this.el.clientHeight); }

  /** distance from the camera to the (panned) target */
  dist() {
    return (this.h * this.scale) / 2 / Math.tan(FOV / 2);
  }

  /** the point at the centre of the screen */
  center() {
    return this.target.clone().addScaledVector(this.right, this.panU).addScaledVector(this.up, -this.panV);
  }

  /** Write the state into the three.js camera (call every frame). */
  update() {
    const cam = this.camera;
    const t = this.center();
    const dist = this.dist();
    cam.position.copy(t).addScaledVector(this.fwd, -dist);
    cam.up.copy(this.up);
    cam.lookAt(t);
    const diag = this.bounds.getSize(new THREE.Vector3()).length() || 100;
    const far = dist + diag * 3 + 10;
    // as far out as possible (depth precision) while nothing of the model is clipped
    const near = Math.max(1e-4, dist * 0.01, dist - diag * 1.5);
    if (cam.near !== near || cam.far !== far) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  /** Re-orthonormalise after incremental rotations (keeps right exact). */
  setBasis(r, u) {
    this.right.copy(r).normalize();
    this.up.copy(u).addScaledVector(this.right, -u.dot(this.right)).normalize();
    this.fwd.crossVectors(this.right, this.up).negate();
  }

  // ---- views ------------------------------------------------------------------------

  setPreset(name) {
    this.stopCoast();
    const [f, u] = PRESETS[name] || PRESETS.front;
    const fwd = new THREE.Vector3(...f).normalize();
    const up = new THREE.Vector3(...u);
    up.addScaledVector(fwd, -up.dot(fwd)).normalize();
    this.fwd.copy(fwd);
    this.up.copy(up);
    this.right.crossVectors(fwd, up);
    this.panU = 0;
    this.panV = 0;
  }

  /** Centre on the model, zoom to fit and look from `name` (initial view by default). */
  fit(name = this.homeView) {
    this.pivotFlashUntil = 0;
    this.target.copy(this.bounds.getCenter(new THREE.Vector3()));
    const diag = this.bounds.getSize(new THREE.Vector3()).length() || 100;
    // the whole model in view (Quick DICOM Planning uses 0.7 × the diagonal for scan volumes)
    this.scale = (diag * 1.1) / Math.min(this.w, this.h);
    this.setPreset(name);
  }

  /** Reset view: the initial position and rotation centre. */
  reset() {
    this.presetIdx = 0;
    this.fit(this.homeView);
  }

  // ---- mouse --------------------------------------------------------------------------

  /** Free rotation: turn around the vertical axis, tilt around the screen's horizontal axis. */
  orbit(dx, dy) {
    const axis = this.worldUp;
    const a = -dx * 0.008;
    const b = -dy * 0.008;
    let u = rotate(this.up, axis, a);
    const r = rotate(this.right, axis, a);
    u = rotate(u, r, b);
    this.setBasis(r, u);
  }

  pan(dx, dy) {
    this.panU -= dx * this.scale;
    this.panV -= dy * this.scale;
  }

  /** Zoom keeping the point under p (CSS px in the viewport) fixed. factor < 1 = closer. */
  zoomAt(p, factor) {
    const s0 = this.scale;
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s0 * factor));
    this.panU += (p[0] - this.w / 2) * (s0 - s1);
    this.panV += (p[1] - this.h / 2) * (s0 - s1);
    this.scale = s1;
  }

  /**
   * Make P the orbit pivot while keeping the camera exactly where it is: the
   * target moves to P, the pan offsets take up the sideways difference and the
   * zoom (distance) takes up the depth difference.
   */
  setPivot(P) {
    const t = this.center();
    const dist = this.dist();
    const d = t.clone().sub(P);
    const depth = dist - d.dot(this.fwd); // distance of P in front of the camera
    if (depth <= 1e-3) return false;
    this.target.copy(P);
    this.panU = d.dot(this.right);
    this.panV = -d.dot(this.up);
    this.scale = (depth * 2 * Math.tan(FOV / 2)) / this.h;
    this.flashPivot(1500);
    return true;
  }

  flashPivot(ms) {
    this.pivotFlashUntil = Math.max(this.pivotFlashUntil, performance.now() + ms);
  }

  /** Screen position of the rotation centre while it should be shown, else null. */
  pivotMarker() {
    if (!this.orbiting && performance.now() > this.pivotFlashUntil) return null;
    const q = this.target.clone().sub(this.camera.position);
    const z = q.dot(this.fwd);
    if (z <= 1e-6) return null;
    const th = Math.tan(FOV / 2);
    return [
      (this.w / 2) * (1 + q.dot(this.right) / (z * th * (this.w / this.h))),
      (this.h / 2) * (1 - q.dot(this.up) / (z * th)),
    ];
  }

  // ---- flick: released while moving, the model keeps turning and slows like a scroll ----

  beginOrbit() {
    this.stopCoast();
    this.orbiting = true;
    this.dragHist = [];
  }

  dragOrbit(dx, dy) {
    this.dragHist.push({ t: performance.now(), dx, dy });
    if (this.dragHist.length > 12) this.dragHist.shift();
    this.orbit(dx, dy);
  }

  endOrbit(moved) {
    this.orbiting = false;
    if (moved) this.startCoast();
    this.dragHist = [];
  }

  stopCoast() {
    if (this.coast) cancelAnimationFrame(this.coast);
    this.coast = 0;
  }

  /** Carry on at the release velocity (px/ms), decaying at the scroll rate (0.996 per ms). */
  startCoast() {
    const now = performance.now();
    const h = this.dragHist.filter((s) => now - s.t < 100);
    // no flick after a pause before letting go, or with less motion asked for
    if (reducedMotion() || h.length < 3 || now - h[h.length - 1].t > 40) return;
    const span = h[h.length - 1].t - h[0].t;
    if (span < 8) return;
    let vx = 0, vy = 0;
    for (const s of h.slice(1)) { vx += s.dx; vy += s.dy; }
    vx /= span;
    vy /= span;
    const speed = Math.hypot(vx, vy);
    if (speed < 0.3) return;
    const cap = Math.min(1, 4 / speed);
    vx *= cap;
    vy *= cap;
    let last = now;
    const step = (t) => {
      const dt = Math.min(48, t - last);
      last = t;
      this.orbit(vx * dt, vy * dt);
      const k = Math.pow(0.996, dt);
      vx *= k;
      vy *= k;
      this.coast = Math.hypot(vx, vy) < 0.02 ? 0 : requestAnimationFrame(step);
    };
    this.coast = requestAnimationFrame(step);
  }

  // ---- 3Dconnexion SpaceMouse ("object mode": the model follows the cap) ----------------

  /** t / r in screen axes (X right, Y up, Z towards the user), ±1 = full deflection. */
  spaceMotion(t, r, dt) {
    this.stopCoast();
    // pan: full deflection moves the model ~0.8 view heights per second
    const pan = this.h * this.scale * 0.8 * dt;
    this.panU -= t[0] * pan;
    this.panV += t[1] * pan;
    // zoom: pulling the cap towards you brings the model closer
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * Math.exp(-t[2] * 1.6 * dt)));
    // rotation: the model turns with the cap = the camera turns the other way around the target
    const axis = new THREE.Vector3()
      .addScaledVector(this.right, r[0])
      .addScaledVector(this.up, r[1])
      .addScaledVector(this.fwd, -r[2]);
    const mag = axis.length();
    if (mag > 1e-6) {
      this.flashPivot(400);
      axis.normalize();
      const ang = -mag * 2.2 * dt; // ~125°/s at full deflection
      this.setBasis(rotate(this.right, axis, ang), rotate(this.up, axis, ang));
    }
  }

  /** Left button: fit / reset · right button: next standard view. */
  spaceButton(i) {
    if (i === 0) {
      this.reset();
    } else {
      this.presetIdx = (this.presetIdx + 1) % CYCLE.length;
      this.setPreset(CYCLE[this.presetIdx]);
    }
  }
}
