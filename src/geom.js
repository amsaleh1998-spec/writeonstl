// Solid-geometry helpers built on manifold-3d (exact, watertight booleans).
// Kept free of three.js so it can be exercised from Node as well.
import Module from 'manifold-3d';

let wasm = null;

export async function initManifold(locateFile) {
  if (wasm) return wasm;
  wasm = await Module(locateFile ? { locateFile } : undefined);
  wasm.setup();
  return wasm;
}

export function M() {
  if (!wasm) throw new Error('manifold not initialised');
  return wasm;
}

/**
 * Build a Manifold from a triangle soup (e.g. a freshly loaded STL).
 * Coincident vertices are welded first. Throws if the mesh isn't a closed,
 * oriented 2-manifold.
 * @param {Float32Array} positions xyz triples, 3 vertices per triangle (non-indexed)
 */
export function soupToManifold(positions) {
  const { Manifold, Mesh } = M();
  const nv = positions.length / 3;
  const map = new Map();
  const verts = [];
  const remap = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const key = x + ',' + y + ',' + z;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      verts.push(x, y, z);
      map.set(key, idx);
    }
    remap[i] = idx;
  }
  const tris = [];
  for (let t = 0; t < nv; t += 3) {
    const a = remap[t], b = remap[t + 1], c = remap[t + 2];
    if (a === b || b === c || a === c) continue; // degenerate
    tris.push(a, b, c);
  }
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
  });
  mesh.merge(); // weld near-coincident vertices along open edges
  const man = new Manifold(mesh);
  const status = man.status();
  if (status !== 'NoError') {
    man.delete();
    throw new Error('Mesh is not manifold: ' + status);
  }
  return man;
}

/** Non-indexed xyz triangle soup from a Manifold (for display / export). */
export function manifoldToSoup(man) {
  const mesh = man.getMesh();
  const { vertProperties: vp, triVerts: tv, numProp: np } = mesh;
  const out = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    const v = tv[i] * np;
    out[3 * i] = vp[v];
    out[3 * i + 1] = vp[v + 1];
    out[3 * i + 2] = vp[v + 2];
  }
  return out;
}

/**
 * Turn text outlines into a solid.
 *
 * The solid is built in a local frame: X right, Y up (along the text), Z along
 * the surface normal (out of the surface). It is then moved into place with
 * `matrix` (column-major 4x4, e.g. THREE.Matrix4.elements).
 *
 * @param {object} o
 * @param {number[][][]} o.contours  polygons in mm (from textToContours)
 * @param {boolean} o.mirror        mirror horizontally
 * @param {number} o.weight          outline offset in mm (+ bolder, - thinner)
 * @param {'emboss'|'engrave'} o.mode
 * @param {number} o.depth           raised height (emboss) / cut depth (engrave)
 * @param {number} o.embed           how far an embossed solid sinks into the surface
 * @param {boolean} o.conform        follow the surface instead of a flat plane
 * @param {(x:number,y:number)=>number|null} o.heightAt  surface height along Z
 *        at local (x, y), or null if the surface isn't hit there
 * @param {number} o.refine          max edge length used when conforming (mm)
 * @param {number[]} o.matrix
 * @returns {{solid: any, conformed: boolean} | null}
 */
export function buildTextSolid(o) {
  const { CrossSection, Manifold } = M();
  let contours = o.contours;
  if (!contours.length) return null;
  if (o.mirror) contours = contours.map((c) => c.map(([x, y]) => [-x, y]));

  let cs = new CrossSection(contours, 'NonZero');
  if (o.weight) {
    const off = cs.offset(o.weight, 'Round', 2, 24);
    cs.delete();
    cs = off;
  }
  if (cs.isEmpty()) { cs.delete(); return null; }

  // Probe the surface under the text outline to know how far it deviates
  // from the tangent plane at the click point.
  const step = Math.max(o.refine, 0.05);
  const polys = cs.toPolygons();
  let minH = Infinity, maxH = -Infinity, samples = 0, misses = 0, jumps = 0;
  for (const poly of polys) {
    let prev = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const h = o.heightAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        samples++;
        if (h === null) { misses++; prev = null; continue; }
        // a jump much steeper than 70° between neighbouring samples = an edge or step
        if (prev !== null && Math.abs(h - prev) > 3 * step + 0.05) jumps++;
        prev = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
  }
  if (minH === Infinity) { minH = 0; maxH = 0; }
  const curved = maxH - minH > 1e-3;
  const conform = o.conform && curved;

  const clearance = Math.max(0.5, o.depth * 0.5);
  let z0, z1;
  if (o.mode === 'emboss') {
    // At least `depth` above the highest point; sunk below the lowest.
    z0 = (conform ? 0 : minH) - o.embed;
    z1 = (conform ? 0 : maxH) + o.depth;
  } else {
    // Cut at least `depth` everywhere; start above the surface.
    z0 = (conform ? 0 : minH) - o.depth;
    z1 = (conform ? 0 : maxH) + clearance;
  }

  let solid = Manifold.extrude(cs, z1 - z0).translate([0, 0, z0]);
  cs.delete();

  if (conform) {
    const refined = solid.refineToLength(o.refine);
    solid.delete();
    const cache = new Map();
    let field = null; // built lazily, only if some rays miss the model
    const warped = refined.warp((v) => {
      const key = Math.round(v[0] * 1e4) + ':' + Math.round(v[1] * 1e4);
      let h = cache.get(key);
      if (h === undefined) {
        h = o.heightAt(v[0], v[1]);
        if (h === null) {
          field ??= filledHeightField(o.heightAt, polys, o.refine, minH);
          h = field(v[0], v[1]);
        }
        cache.set(key, h);
      }
      v[2] += h;
    });
    refined.delete();
    solid = warped;
  }

  const placed = solid.transform(o.matrix);
  solid.delete();
  return {
    solid: placed,
    conformed: conform,
    offSurface: samples > 0 && misses / samples > 0.002,
    crossesEdge: jumps > 0,
  };
}

/**
 * Surface heights on a grid covering the text, with holes (where the text
 * hangs off the model) filled from the nearest known height. Returns a
 * bilinear sampler. Used so text that overhangs an edge continues smoothly
 * instead of collapsing.
 */
function filledHeightField(heightAt, polys, step, fallback) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX -= step; minY -= step; maxX += step; maxY += step;
  const area = (maxX - minX) * (maxY - minY);
  const cell = Math.max(step, Math.sqrt(area / 40000)); // cap the ray count
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(2, Math.ceil((maxY - minY) / cell) + 1);
  const dx = (maxX - minX) / (nx - 1), dy = (maxY - minY) / (ny - 1);
  const val = new Float64Array(nx * ny);
  const known = new Uint8Array(nx * ny);
  const queue = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const h = heightAt(minX + i * dx, minY + j * dy);
    if (h !== null) { const k = j * nx + i; val[k] = h; known[k] = 1; queue.push(k); }
  }
  if (!queue.length) return () => fallback;
  // Breadth-first flood: each unknown cell takes its nearest known neighbour's height.
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q], i = k % nx, j = (k - i) / nx;
    const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
    for (const n of nb) if (n >= 0 && !known[n]) { val[n] = val[k]; known[n] = 1; queue.push(n); }
  }
  return (x, y) => {
    const fx = Math.min(Math.max((x - minX) / dx, 0), nx - 1.000001);
    const fy = Math.min(Math.max((y - minY) / dy, 0), ny - 1.000001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, w = fy - j;
    const k = j * nx + i;
    return (val[k] * (1 - u) + val[k + 1] * u) * (1 - w) + (val[k + nx] * (1 - u) + val[k + nx + 1] * u) * w;
  };
}

export function booleanOp(model, tool, mode) {
  const result = mode === 'emboss' ? model.add(tool) : model.subtract(tool);
  const status = result.status();
  if (status !== 'NoError') {
    result.delete();
    throw new Error('Boolean failed: ' + status);
  }
  return dropSlivers(result);
}

/**
 * Remove stray shells with no real volume (inverted or paper-thin slivers). They appear
 * when a label folds over an edge, and slicers would otherwise flag them. Takes
 * ownership of `man` and returns the cleaned manifold (or `man` itself).
 */
export function dropSlivers(man, minVolume = 1e-3) {
  const { Manifold } = M();
  const parts = man.decompose();
  if (parts.length <= 1) {
    for (const p of parts) p.delete();
    return man;
  }
  const keep = parts.filter((p) => p.volume() > minVolume);
  for (const p of parts) if (!keep.includes(p)) p.delete();
  if (keep.length === parts.length || !keep.length) {
    for (const p of keep) p.delete();
    return man;
  }
  const res = Manifold.compose(keep);
  for (const p of keep) p.delete();
  man.delete();
  return res;
}

/** Binary STL from a non-indexed xyz triangle soup. */
export function soupToSTL(positions, header = 'WriteOnSTL') {
  const triCount = positions.length / 9;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const p = t * 9;
    const ax = positions[p], ay = positions[p + 1], az = positions[p + 2];
    const bx = positions[p + 3], by = positions[p + 4], bz = positions[p + 5];
    const cx = positions[p + 6], cy = positions[p + 7], cz = positions[p + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    off += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(off, positions[p + k], true); off += 4; }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}
