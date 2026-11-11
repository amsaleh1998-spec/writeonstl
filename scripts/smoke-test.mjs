// Node smoke test for the geometry pipeline: node scripts/smoke-test.mjs
import { readFileSync } from 'node:fs';
import { initManifold, buildTextSolid, booleanOp, manifoldToSoup, soupToManifold, soupToSTL } from '../src/geom.js';
import { parseFont, textToContours } from '../src/text.js';

const w = await initManifold();
const buf = readFileSync(new URL('../public/fonts/Pacifico-Regular.ttf', import.meta.url));
const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const { contours, width, height } = textToContours(font, { text: 'Hello\nWorld!', height: 6, letterSpacing: 0, lineSpacing: 1.6, align: 'center', tolerance: 0.02 });
console.log('contours', contours.length, 'size', width.toFixed(2), height.toFixed(2));

const R = 20;
const cyl = w.Manifold.cylinder(40, R, R, 128).rotate([0, 90, 0]); // axis along X
// Place on top of the cylinder (point (20,0,R), normal +Z). Local x -> world x.
const matrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 20,0,R,1];
const heightAt = (x, y) => (Math.abs(y) < R ? Math.sqrt(R * R - y * y) - R : null);
for (const mode of ['emboss', 'engrave']) for (const conform of [false, true]) {
  const t0 = performance.now();
  const r = buildTextSolid({ contours, mirror: false, weight: 0.1, mode, depth: 1, embed: 0.3, conform, heightAt, refine: 0.5, matrix });
  const res = booleanOp(cyl, r.solid, mode);
  console.log(mode, 'conform', conform, '->', r.conformed, 'tris', res.numTri(), 'genus', res.genus(), 'vol', res.volume().toFixed(1), 'cyl vol', cyl.volume().toFixed(1), (performance.now() - t0).toFixed(0) + 'ms');
  // round-trip through STL soup
  const soup = manifoldToSoup(res);
  const back = soupToManifold(soup);
  console.log('  roundtrip ok, tris', back.numTri(), 'stl bytes', soupToSTL(soup).byteLength);
}
