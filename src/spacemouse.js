/**
 * 3Dconnexion SpaceMouse input for the 3D view.
 * Ported from Quick DICOM Planning (src/spacemouse.ts) so both apps behave the same.
 *
 * Chrome / Edge: WebHID (one "Connect" click grants access; afterwards the
 * device reconnects automatically on every visit). Other browsers: some expose
 * the SpaceMouse as a game controller, which is picked up automatically.
 *
 * Device values are converted to screen axes – X right, Y up, Z towards the
 * user – for translation and rotation (right-handed), normalised to ±1.
 *
 * The target must implement:
 *   spaceMotion(t, r, dt)  t / r: [x, y, z] translation / rotation in screen axes, ±1 at full deflection
 *   spaceButton(index)     a device button was pressed (0 = left, 1 = right, …)
 */
const SETTINGS_KEY = "writeonstl.spacemouse";
const VENDOR_3DCONNEXION = 9583;
const VENDOR_LOGITECH = 1133;
const MULTI_AXIS = { usagePage: 1, usage: 8 };
const FULL_SCALE = 350;
const DEAD_ZONE = 0.04;
const GAMEPAD_RE = /3dconnexion|spacemouse|space ?navigator|space ?pilot|space ?explorer|cadmouse|256f|046d.*c6[23]/i;
export class SpaceMouse {
  constructor(target) {
    this.target = target;
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
      if (s) this.settings = { ...this.settings, ...s };
    } catch {
    }
    const hid = this.hid;
    if (hid) {
      hid.addEventListener("connect", (e) => this.open(e.device));
      hid.addEventListener("disconnect", (e) => {
        if (e.device === this.device) this.detach();
      });
    }
    window.addEventListener("gamepadconnected", (e) => this.gamepadConnected(e.gamepad));
    window.addEventListener("gamepaddisconnected", (e) => {
      if (e.gamepad.index === this.gamepadIndex) {
        this.gamepadIndex = null;
        if (this.via === "gamepad") this.detach();
      }
    });
  }
  target;
  /** connected device name ('' = none) and how it is connected */
  name = "";
  via = null;
  settings = { speed: 1, invertRotation: false, invertTranslation: false };
  /** UI refresh hook (connection changes) */
  onChange = () => {
  };
  /**
   * Called while the cap is moved. The 3Dconnexion driver also turns cap motion
   * into mouse-wheel scrolling / Ctrl+wheel zooming for browsers, which the app
   * ignores meanwhile (otherwise both inputs fight and the view jitters).
   */
  onActivity = () => {
  };
  device = null;
  /** latest raw device axes (HID convention: x right, y towards user, z down) */
  raw = { t: [0, 0, 0], r: [0, 0, 0] };
  buttons = 0;
  gamepadIndex = null;
  loopRunning = false;
  lastTime = 0;
  /** smoothed motion (screen axes) */
  smT = [0, 0, 0];
  smR = [0, 0, 0];
  /** devices with our report listener (never attach twice) */
  listening = /* @__PURE__ */ new WeakSet();
  opening = null;
  /** WebHID is available (Chrome / Edge on desktop). */
  get supported() {
    return !!this.hid;
  }
  get hid() {
    return navigator.hid ?? null;
  }
  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
    }
  }
  /** Reconnect a device the user already granted (no prompt). */
  async autoConnect() {
    const hid = this.hid;
    if (!hid) return;
    try {
      for (const d of await hid.getDevices()) if (await this.open(d)) return;
    } catch (e) {
      console.warn("SpaceMouse:", e);
    }
  }
  /** Ask the user to pick the SpaceMouse (needs a click). Returns an error message or ''. */
  async connect() {
    const hid = this.hid;
    if (!hid) return "This browser cannot access a SpaceMouse directly \u2013 use Chrome or Edge.";
    try {
      const devices = await hid.requestDevice({
        filters: [
          { vendorId: VENDOR_3DCONNEXION },
          { vendorId: VENDOR_LOGITECH, ...MULTI_AXIS }
        ]
      });
      for (const d of devices) if (await this.open(d)) return "";
      return devices.length ? "Could not open the SpaceMouse (is another program using it exclusively?)" : "";
    } catch (e) {
      return e.message;
    }
  }
  async disconnect() {
    const d = this.device;
    this.detach();
    if (d?.opened) await d.close().catch(() => {
    });
  }
  /** One open at a time (auto-connect, the connect event and a click can overlap). */
  open(d) {
    const prev = this.opening ?? Promise.resolve(false);
    const p = prev.then(() => this.openNow(d));
    this.opening = p.finally(() => {
      if (this.opening === p) this.opening = null;
    });
    return p;
  }
  async openNow(d) {
    if (this.device === d) return true;
    if (d.collections.length && !d.collections.some((c) => c.usagePage === MULTI_AXIS.usagePage && c.usage === MULTI_AXIS.usage)) return false;
    try {
      if (!d.opened) await d.open();
    } catch (e) {
      console.warn("SpaceMouse: cannot open", d.productName, e);
      return false;
    }
    if (this.device && this.device !== d) await this.disconnect();
    this.device = d;
    this.via = "hid";
    this.name = d.productName || "SpaceMouse";
    if (!this.listening.has(d)) {
      this.listening.add(d);
      d.addEventListener("inputreport", (e) => {
        if (d === this.device) this.onReport(e);
      });
    }
    this.onChange();
    return true;
  }
  detach() {
    this.device = null;
    this.via = this.gamepadIndex !== null ? "gamepad" : null;
    this.name = this.via ? this.name : "";
    this.raw = { t: [0, 0, 0], r: [0, 0, 0] };
    this.smT = [0, 0, 0];
    this.smR = [0, 0, 0];
    this.onChange();
  }
  /**
   * HID reports: id 1 = translation (x, y, z; newer devices append rx, ry, rz),
   * id 2 = rotation, id 3 = buttons. Values are little-endian int16.
   */
  handleReport(reportId, d) {
    const i16 = (o) => d.byteLength >= o + 2 ? d.getInt16(o, true) : 0;
    if (reportId === 1) {
      this.raw.t = [i16(0), i16(2), i16(4)];
      if (d.byteLength >= 12) this.raw.r = [i16(6), i16(8), i16(10)];
    } else if (reportId === 2) {
      this.raw.r = [i16(0), i16(2), i16(4)];
    } else if (reportId === 3) {
      let b = 0;
      for (let k = 0; k < Math.min(4, d.byteLength); k++) b |= d.getUint8(k) << 8 * k;
      this.pressed(b);
    }
    if (this.raw.t.some((v) => v !== 0) || this.raw.r.some((v) => v !== 0)) this.onActivity();
    this.startLoop();
  }
  onReport(e) {
    this.handleReport(e.reportId, e.data);
  }
  /** Fire spaceButton for newly pressed buttons. */
  pressed(b) {
    const down = b & ~this.buttons;
    this.buttons = b;
    for (let i = 0; i < 32; i++) if (down & 1 << i) this.target.spaceButton(i);
  }
  gamepadConnected(g) {
    if (!GAMEPAD_RE.test(g.id) || g.axes.length < 6) return;
    this.gamepadIndex = g.index;
    if (!this.device) {
      this.via = "gamepad";
      this.name = g.id.replace(/\s*\(.*\)\s*/g, " ").trim() || "SpaceMouse";
      this.onChange();
    }
    this.startLoop();
  }
  pollGamepad() {
    if (this.gamepadIndex === null || this.device) return;
    const g = navigator.getGamepads?.()[this.gamepadIndex];
    if (!g) return;
    const a = g.axes;
    this.raw.t = [a[0] * FULL_SCALE, a[1] * FULL_SCALE, a[2] * FULL_SCALE];
    this.raw.r = [a[3] * FULL_SCALE, a[4] * FULL_SCALE, a[5] * FULL_SCALE];
    let b = 0;
    g.buttons.forEach((btn, i) => btn.pressed && i < 32 && (b |= 1 << i));
    this.pressed(b);
  }
  startLoop() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.tick);
  }
  /** Rate control: deflection = speed; runs while the cap is moved (or a gamepad is connected). */
  tick = (now) => {
    const dt = Math.min(0.12, Math.max(0, (now - this.lastTime) / 1e3));
    this.lastTime = now;
    this.pollGamepad();
    const n = (v) => {
      let x2 = Math.max(-1, Math.min(1, v / FULL_SCALE));
      const s = Math.sign(x2);
      x2 = Math.abs(x2) < DEAD_ZONE ? 0 : (Math.abs(x2) - DEAD_ZONE) / (1 - DEAD_ZONE);
      return s * (0.4 * x2 + 0.6 * x2 * x2);
    };
    const [x, y, z] = this.raw.t;
    const [rx, ry, rz] = this.raw.r;
    const st = this.settings.invertTranslation ? -1 : 1;
    const sr = this.settings.invertRotation ? -1 : 1;
    const t = [st * n(x), st * n(-z), st * n(y)];
    const r = [sr * n(rx), sr * n(-rz), sr * n(ry)];
    const a = dt > 0 ? 1 - Math.exp(-dt / 0.04) : 0;
    let any = false;
    for (let i = 0; i < 3; i++) {
      this.smT[i] += (t[i] - this.smT[i]) * a;
      this.smR[i] += (r[i] - this.smR[i]) * a;
      if (t[i] === 0 && Math.abs(this.smT[i]) < 3e-3) this.smT[i] = 0;
      if (r[i] === 0 && Math.abs(this.smR[i]) < 3e-3) this.smR[i] = 0;
      any ||= this.smT[i] !== 0 || this.smR[i] !== 0;
    }
    if (any && dt > 0) {
      this.onActivity();
      this.target.spaceMotion([...this.smT], [...this.smR], dt * this.settings.speed);
    }
    if (any || this.gamepadIndex !== null) requestAnimationFrame(this.tick);
    else this.loopRunning = false;
  };
}
