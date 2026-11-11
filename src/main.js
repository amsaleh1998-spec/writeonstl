import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { Brush, Evaluator, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import {
  initManifold, M, soupToManifold, manifoldToSoup, buildTextSolid, booleanOp, soupToSTL,
} from './geom.js';
import { parseFont, fontDisplayName, textToContours } from './text.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- settings --

const FONTS = [
  { name: 'Lato Bold', file: 'Lato-Bold.ttf' },
  { name: 'Lato Regular', file: 'Lato-Regular.ttf' },
  { name: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf' },
  { name: 'Anton', file: 'Anton-Regular.ttf' },
  { name: 'Bebas Neue', file: 'BebasNeue-Regular.ttf' },
  { name: 'Righteous', file: 'Righteous-Regular.ttf' },
  { name: 'Black Ops One', file: 'BlackOpsOne-Regular.ttf' },
  { name: 'Allerta Stencil', file: 'AllertaStencil-Regular.ttf' },
  { name: 'Courier Prime Bold', file: 'CourierPrime-Bold.ttf' },
  { name: 'Permanent Marker', file: 'PermanentMarker-Regular.ttf' },
  { name: 'Pacifico', file: 'Pacifico-Regular.ttf' },
  { name: 'Lobster', file: 'Lobster-Regular.ttf' },
];

const DEFAULTS = {
  text: 'Hello',
  fontName: 'Lato Bold',
  align: 'center',
  mode: 'emboss',
  height: 8,
  depth: 1.2,
  weight: 0,
  letterSpacing: 0,
  lineSpacing: 1.4,
  rotation: 0,
  conform: true,
  mirror: false,
  embed: 0.4,
  quality: 3,
};
const QUALITY_TOLERANCE = { 1: 0.1, 2: 0.05, 3: 0.02, 4: 0.01, 5: 0.005 };
const STORAGE_KEY = 'writeonstl.settings.v1';

const params = { ...DEFAULTS };
try {
  Object.assign(params, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
} catch { /* storage unavailable */ }
const save = () => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)); } catch { /* ignore */ }
};

// ------------------------------------------------------------------ helpers --

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

let toastTimer;
function toast(msg, isError = false, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

async function busy(msg, fn) {
  $('#busyText').textContent = msg;
  $('#busy').classList.add('on');
  // let the browser paint the spinner before blocking work
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true, 6000);
    return undefined;
  } finally {
    $('#busy').classList.remove('on');
  }
}

function geometryFromSoup(soup, smooth = false) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  if (smooth && soup.length / 9 < 3e6) {
    // Smooth shading on curved surfaces, crisp edges where faces meet at an angle.
    return toCreasedNormals(g, THREE.MathUtils.degToRad(35));
  }
  g.computeVertexNormals();
  return g;
}

// -------------------------------------------------------------------- scene --

const canvas = $('#canvas');
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
camera.up.set(0, 0, 1);
camera.position.set(120, -160, 110);
scene.add(camera);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

// Lights ride along with the camera so the model is always well lit, with
// the key light coming from the upper left so raised/cut letters cast shading.
scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(-1.2, 1.4, 1);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
fillLight.position.set(1.5, -0.5, 0.8);
camera.add(keyLight, keyLight.target, fillLight, fillLight.target);
keyLight.target.position.set(0, 0, -1);
fillLight.target.position.set(0, 0, -1);

let grid = new THREE.GridHelper(200, 20, 0x888888, 0x888888);
grid.rotation.x = Math.PI / 2;
grid.material.transparent = true;
grid.material.opacity = 0.25;
scene.add(grid);

function applyBackground() {
  const css = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim();
  renderer.setClearColor(new THREE.Color(css || '#e9ebef'));
}
applyBackground();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyBackground);

const modelMaterial = new THREE.MeshStandardMaterial({
  color: 0xc9ced8, roughness: 0.7, metalness: 0.05,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const embossMaterial = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.55 });
const engraveMaterial = new THREE.MeshStandardMaterial({
  color: 0xe11d48, roughness: 0.6, transparent: true, opacity: 0.85,
});
const ghostMaterial = new THREE.MeshBasicMaterial({
  color: 0xe11d48, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false,
});

const modelMesh = new THREE.Mesh(new THREE.BufferGeometry(), modelMaterial);
modelMesh.visible = false;
scene.add(modelMesh);

const previewMesh = new THREE.Mesh(new THREE.BufferGeometry(), embossMaterial);
const ghostMesh = new THREE.Mesh(previewMesh.geometry, ghostMaterial);
ghostMesh.renderOrder = 10;
previewMesh.visible = ghostMesh.visible = false;
scene.add(previewMesh, ghostMesh);

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// -------------------------------------------------------------- model state --

/** @type {{soup: Float32Array, manifold: any|null}[]} */
let versions = [];
let modelName = 'model';
let modelBox = new THREE.Box3();
let modelDiag = 100;
const current = () => versions[versions.length - 1];

function showVersion(v) {
  modelMesh.geometry.dispose();
  const g = geometryFromSoup(v.soup, true);
  g.boundsTree = new MeshBVH(g);
  g.computeBoundingBox();
  modelMesh.geometry = g;
  modelMesh.visible = true;
  modelBox = g.boundingBox.clone();
  modelDiag = modelBox.getSize(new THREE.Vector3()).length() || 100;
  $('#empty').classList.add('hidden');
  updateModelInfo();
  updateButtons();
}

function updateModelInfo() {
  const v = current();
  if (!v) return;
  const s = modelBox.getSize(new THREE.Vector3());
  const tris = v.soup.length / 9;
  const status = v.manifold
    ? '<span class="ok">● Watertight — exact booleans</span>'
    : '<span class="warn">● Not watertight — using approximate booleans; results may need repair</span>';
  $('#modelInfo').classList.remove('muted');
  $('#modelInfo').innerHTML =
    `<b>${escapeHtml(modelName)}</b><br>` +
    `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm · ${tris.toLocaleString()} triangles<br>${status}` +
    (versions.length > 1 ? `<br>${versions.length - 1} text edit${versions.length > 2 ? 's' : ''} applied` : '');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function loadModel(name, soup, manifold) {
  for (const v of versions) v.manifold?.delete();
  if (manifold === undefined) {
    try {
      manifold = soupToManifold(soup);
    } catch (e) {
      console.warn(e);
      manifold = null;
      toast('This STL is not watertight. Text can still be added, but the result may need repair.', true, 6000);
    }
  }
  versions = [{ soup, manifold }];
  modelName = name.replace(/\.stl$/i, '');
  clearPlacement();
  showVersion(current());

  // Pick sensible default sizes for this model.
  const dims = modelBox.getSize(new THREE.Vector3()).toArray().sort((a, b) => a - b);
  params.height = clamp(Math.round(dims[1] * 0.18 * 2) / 2, 1, 50);
  params.depth = clamp(Math.round(params.height * 0.15 * 10) / 10, 0.4, 3);
  syncControls();
  save();

  updateGrid();
  setView('iso');
  updateHint();
  return !!manifold;
}

function updateGrid() {
  scene.remove(grid);
  grid.geometry.dispose();
  const size = modelBox.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y) * 1.6;
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(span / 4, 1))));
  const divisions = Math.ceil(span / step);
  grid = new THREE.GridHelper(divisions * step, divisions, 0x888888, 0x888888);
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
  const c = modelBox.getCenter(new THREE.Vector3());
  grid.position.set(c.x, c.y, modelBox.min.z - 0.01);
  scene.add(grid);
}

function pushVersion(v) {
  versions.push(v);
  // Keep memory bounded: always keep the original, drop the oldest edits.
  while (versions.length > 30) {
    const [old] = versions.splice(1, 1);
    old.manifold?.delete();
  }
  showVersion(v);
}

function undo() {
  if (versions.length < 2) return;
  versions.pop().manifold?.delete();
  showVersion(current());
  scheduleRebuild();
  toast('Undone');
}

function reset() {
  if (versions.length < 2) return;
  while (versions.length > 1) versions.pop().manifold?.delete();
  showVersion(current());
  scheduleRebuild();
  toast('Back to the original model');
}

// ---------------------------------------------------------------- loading --

async function loadSTLFile(file) {
  await busy(`Loading ${file.name}…`, async () => {
    const buf = await file.arrayBuffer();
    const geom = new STLLoader().parse(buf);
    const g = geom.index ? geom.toNonIndexed() : geom;
    const soup = new Float32Array(g.attributes.position.array);
    if (!soup.length) throw new Error('That STL file has no triangles.');
    if (loadModel(file.name, soup)) toast(`Loaded ${file.name}`);
  });
}

function loadSample(kind) {
  const { Manifold, CrossSection } = M();
  let m;
  if (kind === 'plate') {
    const cs = CrossSection.square([70, 30], true).offset(5, 'Round', 2, 64);
    m = Manifold.extrude(cs, 4);
  } else if (kind === 'cylinder') {
    m = Manifold.cylinder(50, 18, 18, 192);
  } else if (kind === 'sphere') {
    m = Manifold.sphere(25, 192).translate([0, 0, 25]);
  } else {
    m = Manifold.cylinder(3, 20, 20, 192);
  }
  loadModel(`${kind}.stl`, manifoldToSoup(m), m);
}

const fontCache = new Map(); // name -> Promise<Font>
const customFonts = []; // { name, font }

function getFont(name) {
  const custom = customFonts.find((f) => f.name === name);
  if (custom) return Promise.resolve(custom.font);
  if (!fontCache.has(name)) {
    const entry = FONTS.find((f) => f.name === name) || FONTS[0];
    const url = `${import.meta.env.BASE_URL}fonts/${entry.file}`;
    fontCache.set(
      name,
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`Could not load font ${entry.name}`);
          return r.arrayBuffer();
        })
        .then(parseFont),
    );
  }
  return fontCache.get(name);
}

async function loadFontFile(file) {
  try {
    const font = parseFont(await file.arrayBuffer());
    let name = fontDisplayName(font, file.name.replace(/\.\w+$/, ''));
    if (FONTS.some((f) => f.name === name) || customFonts.some((f) => f.name === name)) name += ' (uploaded)';
    customFonts.push({ name, font });
    params.fontName = name;
    fillFontSelect();
    await selectFont(name);
    toast(`Font “${name}” added`);
  } catch (e) {
    console.error(e);
    toast('Could not read that font. Use a .ttf, .otf or .woff file.', true);
  }
}

// -------------------------------------------------------------- placement --

/** @type {{point: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3} | null} */
let placement = null;
let font = null;
let textSolid = null; // manifold of the current text, in world space
let textSolidFull = false; // false while dragging (surface following skipped)
let textSize = null;
let textOffSurface = false;

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

function pointerRay(e) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

function pickModel(e) {
  if (!modelMesh.visible) return null;
  pointerRay(e);
  const hit = raycaster.intersectObject(modelMesh, false)[0];
  if (!hit) return null;
  const normal = hit.face.normal.clone().normalize();
  if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
  return { point: hit.point.clone(), normal };
}

function hitsPreview(e) {
  if (!previewMesh.visible) return false;
  pointerRay(e);
  return raycaster.intersectObject(previewMesh, false).length > 0;
}

// Text "up" follows the screen's up direction at the moment of placing, so
// the text reads naturally from the current view.
function upFromCamera(normal) {
  const candidates = [
    new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 1, 0),
  ];
  for (const c of candidates) {
    const up = c.sub(normal.clone().multiplyScalar(c.dot(normal)));
    if (up.lengthSq() > 1e-4) return up.normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

function placeAt(hit) {
  placement = { point: hit.point, normal: hit.normal, up: upFromCamera(hit.normal) };
}

function clearPlacement() {
  placement = null;
  textSolid?.delete();
  textSolid = null;
  textSize = null;
  previewMesh.visible = ghostMesh.visible = false;
  updateButtons();
  updateHint();
}

function placementMatrix() {
  const { point, normal } = placement;
  const up = placement.up.clone().applyAxisAngle(normal, THREE.MathUtils.degToRad(params.rotation));
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  up.crossVectors(normal, right).normalize();
  return new THREE.Matrix4().makeBasis(right, up, normal).setPosition(point);
}

// Surface height (along the placement normal) under local text coords (x, y).
function makeHeightAt(matrix, normal) {
  const bvh = modelMesh.geometry.boundsTree;
  const R = modelDiag * 1.5 + 10;
  const ray = new THREE.Ray();
  const dir = normal.clone().negate();
  const origin = new THREE.Vector3();
  return (x, y) => {
    origin.set(x, y, R).applyMatrix4(matrix);
    ray.set(origin, dir);
    const hits = bvh.raycast(ray, THREE.DoubleSide);
    let best = null, bestFront = null;
    for (const h of hits) {
      const z = R - h.distance;
      if (h.face.normal.dot(normal) > 0) {
        if (bestFront === null || Math.abs(z) < Math.abs(bestFront)) bestFront = z;
      }
      if (best === null || Math.abs(z) < Math.abs(best)) best = z;
    }
    return bestFront ?? best;
  };
}

let contourCache = { key: '', value: null };
function getContours() {
  const key = JSON.stringify([params.fontName, params.text, params.height, params.letterSpacing, params.lineSpacing, params.align, params.quality]);
  if (contourCache.key !== key) {
    contourCache = {
      key,
      value: textToContours(font, {
        text: params.text,
        height: params.height,
        letterSpacing: params.letterSpacing,
        lineSpacing: params.lineSpacing,
        align: params.align,
        tolerance: QUALITY_TOLERANCE[params.quality] ?? 0.02,
      }),
    };
  }
  return contourCache.value;
}

function rebuildText(full = true) {
  textSolid?.delete();
  textSolid = null;
  textSize = null;
  if (!placement || !font || !versions.length) {
    previewMesh.visible = ghostMesh.visible = false;
    updateButtons();
    updateHint();
    return;
  }
  const { contours, width, height } = getContours();
  const matrix = placementMatrix();
  const res = contours.length
    ? buildTextSolid({
        contours,
        mirror: params.mirror,
        weight: params.weight,
        mode: params.mode,
        depth: params.depth,
        embed: params.embed,
        conform: params.conform && full,
        heightAt: makeHeightAt(matrix, placement.normal),
        refine: clamp(params.height / 12, 0.2, 2),
        matrix: matrix.elements,
      })
    : null;

  if (res) {
    textSolid = res.solid;
    textSolidFull = full;
    textOffSurface = res.offSurface;
    textSize = { width: width + 2 * params.weight, height: height + 2 * params.weight };
    const old = previewMesh.geometry;
    const g = geometryFromSoup(manifoldToSoup(textSolid), true);
    previewMesh.geometry = ghostMesh.geometry = g;
    old.dispose();
    previewMesh.material = params.mode === 'emboss' ? embossMaterial : engraveMaterial;
    previewMesh.visible = true;
    ghostMesh.visible = params.mode === 'engrave';
  } else {
    previewMesh.visible = ghostMesh.visible = false;
  }
  updateButtons();
  updateHint();
}

let rebuildTimer = 0;
let rebuildFrame = 0;
function scheduleRebuild(delay = 80) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    try {
      rebuildText(true);
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), true);
    }
  }, delay);
}
function scheduleFastRebuild() {
  if (rebuildFrame) return;
  rebuildFrame = requestAnimationFrame(() => {
    rebuildFrame = 0;
    rebuildText(false);
  });
}

async function selectFont(name) {
  params.fontName = name;
  save();
  $('#font').value = name;
  try {
    font = await getFont(name);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  contourCache.key = '';
  scheduleRebuild(0);
}

// ----------------------------------------------------------------- apply --

function fallbackBoolean(soup, toolSoup, mode) {
  const a = new Brush(geometryFromSoup(soup));
  const b = new Brush(geometryFromSoup(toolSoup));
  a.updateMatrixWorld();
  b.updateMatrixWorld();
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = false;
  const r = ev.evaluate(a, b, mode === 'emboss' ? ADDITION : SUBTRACTION);
  const g = r.geometry.index ? r.geometry.toNonIndexed() : r.geometry;
  return new Float32Array(g.attributes.position.array);
}

async function applyText() {
  if (!placement || !versions.length) return;
  await busy(params.mode === 'emboss' ? 'Embossing text…' : 'Engraving text…', () => {
    if (!textSolid || !textSolidFull) rebuildText(true);
    if (!textSolid) throw new Error('Nothing to apply — type some text first.');
    const cur = current();
    let next;
    if (cur.manifold) {
      const r = booleanOp(cur.manifold, textSolid, params.mode);
      if (r.isEmpty()) { r.delete(); throw new Error('The result was empty.'); }
      next = { soup: manifoldToSoup(r), manifold: r };
    } else {
      next = { soup: fallbackBoolean(cur.soup, manifoldToSoup(textSolid), params.mode), manifold: null };
    }
    pushVersion(next);
    clearPlacement();
    toast(params.mode === 'emboss' ? 'Text embossed ✓ — click to add more, or download.' : 'Text engraved ✓ — click to add more, or download.');
  });
}

function exportSTL() {
  const v = current();
  if (!v) return;
  const data = soupToSTL(v.soup, `WriteOnSTL ${modelName}`);
  const blob = new Blob([data], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${modelName}${versions.length > 1 ? '-text' : ''}.stl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// -------------------------------------------------------------------- views --

function setView(name) {
  const box = versions.length ? modelBox : new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  const dirs = {
    iso: [1, -1.3, 0.9],
    top: [0, -0.001, 1],
    bottom: [0, 0.001, -1],
    front: [0, -1, 0],
    right: [1, 0, 0],
  };
  let dir;
  if (name === 'fit') dir = camera.position.clone().sub(controls.target).normalize();
  else dir = new THREE.Vector3(...dirs[name]).normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

// --------------------------------------------------------------------- UI --

function updateButtons() {
  const has = versions.length > 0;
  $('#apply').disabled = !(has && placement && textSolid);
  $('#undo').disabled = versions.length < 2;
  $('#reset').disabled = versions.length < 2;
  $('#export').disabled = !has;
  $('#apply').textContent = params.mode === 'emboss' ? 'Emboss text onto model' : 'Engrave text into model';
}

function updateHint() {
  const el = $('#hint');
  let msg;
  let ready = false;
  if (!versions.length) msg = 'Load a model, then click on it to place the text.';
  else if (!placement) msg = 'Click on the model where the text should go.';
  else if (!params.text.trim()) msg = 'Type some text above.';
  else if (!textSolid) msg = 'Building text…';
  else {
    ready = true;
    msg = `Text is ${fmt(textSize.width)} × ${fmt(textSize.height)} mm. Drag it to move, click elsewhere to re-place.`;
    if (textOffSurface) msg = `⚠ Part of the text hangs off the surface — make it smaller or move it. ${msg}`;
  }
  el.textContent = msg;
  el.classList.toggle('ready', ready);
}

function setSeg(id, value) {
  for (const b of document.querySelectorAll(`#${id} button`)) b.classList.toggle('on', b.dataset.v === value);
}

const ctlInputs = {};
function buildControls() {
  for (const el of document.querySelectorAll('.ctl')) {
    const key = el.dataset.key;
    const range = document.createElement('input');
    range.type = 'range';
    range.min = el.dataset.min;
    range.max = el.dataset.max;
    range.step = el.dataset.step;
    const num = document.createElement('input');
    num.type = 'number';
    num.step = el.dataset.step;
    const wrap = document.createElement('div');
    wrap.className = 'num';
    const unit = document.createElement('span');
    unit.textContent = el.dataset.unit;
    wrap.append(num, unit);
    el.append(range, wrap);
    const label = el.querySelector('label');
    label.htmlFor = num.id = `ctl-${key}`;
    range.setAttribute('aria-label', label.textContent);
    ctlInputs[key] = { range, num };

    const commit = (v, from) => {
      if (!Number.isFinite(v)) return;
      params[key] = v;
      if (from !== range) range.value = v;
      if (from !== num) num.value = v;
      save();
      scheduleRebuild();
    };
    range.addEventListener('input', () => commit(parseFloat(range.value), range));
    num.addEventListener('input', () => commit(parseFloat(num.value), num));
    num.addEventListener('change', () => { num.value = params[key]; });
  }
}

function syncControls() {
  for (const [key, { range, num }] of Object.entries(ctlInputs)) {
    range.value = params[key];
    num.value = params[key];
  }
  $('#text').value = params.text;
  $('#conform').checked = params.conform;
  $('#mirror').checked = params.mirror;
  setSeg('align', params.align);
  setSeg('mode', params.mode);
  $('#depthLabel').textContent = params.mode === 'emboss' ? 'Raised height' : 'Engrave depth';
}

function fillFontSelect() {
  const sel = $('#font');
  sel.innerHTML = '';
  const add = (name, group) => {
    const o = document.createElement('option');
    o.value = o.textContent = name;
    group.append(o);
  };
  const builtIn = document.createElement('optgroup');
  builtIn.label = 'Built-in';
  FONTS.forEach((f) => add(f.name, builtIn));
  sel.append(builtIn);
  if (customFonts.length) {
    const up = document.createElement('optgroup');
    up.label = 'Uploaded';
    customFonts.forEach((f) => add(f.name, up));
    sel.append(up);
  }
  if (![...FONTS, ...customFonts].some((f) => f.name === params.fontName)) params.fontName = FONTS[0].name;
  sel.value = params.fontName;
}

function wireUI() {
  buildControls();
  fillFontSelect();
  syncControls();

  $('#stlInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadSTLFile(f);
    e.target.value = '';
  });
  $('#fontInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadFontFile(f);
    e.target.value = '';
  });
  for (const b of document.querySelectorAll('[data-sample]')) {
    b.addEventListener('click', () => loadSample(b.dataset.sample));
  }
  $('#text').addEventListener('input', (e) => {
    params.text = e.target.value;
    save();
    scheduleRebuild(150);
  });
  $('#font').addEventListener('change', (e) => selectFont(e.target.value));
  for (const b of document.querySelectorAll('#align button')) {
    b.addEventListener('click', () => {
      params.align = b.dataset.v;
      setSeg('align', params.align);
      save();
      scheduleRebuild(0);
    });
  }
  for (const b of document.querySelectorAll('#mode button')) {
    b.addEventListener('click', () => {
      params.mode = b.dataset.v;
      syncControls();
      save();
      updateButtons();
      scheduleRebuild(0);
    });
  }
  for (const id of ['conform', 'mirror']) {
    $(`#${id}`).addEventListener('change', (e) => {
      params[id] = e.target.checked;
      save();
      scheduleRebuild(0);
    });
  }
  $('#apply').addEventListener('click', applyText);
  $('#undo').addEventListener('click', undo);
  $('#reset').addEventListener('click', reset);
  $('#export').addEventListener('click', exportSTL);
  for (const b of document.querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }

  window.addEventListener('keydown', (e) => {
    const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape' && placement) {
      clearPlacement();
    }
  });

  // Drag & drop of STL / font files anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    for (const f of e.dataTransfer.files) {
      if (/\.stl$/i.test(f.name)) loadSTLFile(f);
      else if (/\.(ttf|otf|woff)$/i.test(f.name)) loadFontFile(f);
      else toast(`Unsupported file: ${f.name}`, true);
    }
  });

  // Click on the model to place text, drag the text to move it.
  let down = null;
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY };
    if (hitsPreview(e)) {
      dragging = true;
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const hit = pickModel(e);
      if (hit) {
        placeAt(hit);
        scheduleFastRebuild();
      }
      return;
    }
    if (e.buttons) return;
    canvas.style.cursor = hitsPreview(e) ? 'grab' : pickModel(e) ? 'crosshair' : '';
  });
  canvas.addEventListener('pointerup', (e) => {
    if (dragging) {
      dragging = false;
      controls.enabled = true;
      canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = 'grab';
      scheduleRebuild(0);
    } else if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      const hit = pickModel(e);
      if (hit) {
        placeAt(hit);
        scheduleRebuild(0);
      }
    }
    down = null;
  });
}

// --------------------------------------------------------------------- boot --

async function main() {
  wireUI();
  setView('iso');
  updateButtons();
  await busy('Loading geometry engine…', async () => {
    await initManifold(() => wasmUrl);
    font = await getFont(params.fontName);
  });
}

main();
