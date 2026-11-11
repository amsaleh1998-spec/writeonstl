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

// ---- aligner export parsing (synthetic file list, no patient data) ----
import { parseAlignerFiles, labelText, firstStage, findModel } from '../src/aligner.js';
const fake = (path) => ({ path, read: async () => new ArrayBuffer(0) });
const c = parseAlignerFiles([
  fake('Models/Case_1-2-2026_Subsetup2/Mandibular.stl'),
  fake('Models/Case_1-2-2026_Subsetup1/Maxillary_with_attachments.stl'),
  fake('Models/Case_1-2-2026_Subsetup1/Maxillary.stl'),
  fake('Models/Case_1-2-2026_Subsetup1/Mandibular.stl'),
  fake('Models/Case_1-2-2026_Subsetup10/Maxillary.stl'),
  fake('Models/Case_1-2-2026_Subsetup3/Readme.txt'),
  fake('Models/Case_1-2-2026_Subsetup3/Other.stl'),
  fake('Models/ClearAlignerProductionResources.xml'),
]);
const assert = (cond, msg) => { if (!cond) throw new Error('aligner parse: ' + msg); };
assert(c && c.name === 'Case_1-2-2026', 'case name ' + c?.name);
assert(c.models.length === 5, 'model count ' + c.models.length);
assert(c.stages.join() === '1,2,10', 'stages ' + c.stages);
assert(c.jaws.join() === 'upper,lower', 'jaws');
assert(findModel(c, 'upper', 1, true)?.path === 'Case_1-2-2026_Subsetup1/Maxillary_with_attachments.stl', 'attachments path');
assert(firstStage(c, 'lower') === 1 && firstStage(c, 'upper') === 1, 'first stage');
assert(c.xml && c.skipped.length === 1, 'xml / skipped');
assert(parseAlignerFiles([fake('a/b.stl')]) === null, 'plain STL is not a case');
assert(labelText('{n}', 7) === '7' && labelText('U{n}', 12) === 'U12' && labelText('L', 3) === 'L3', 'labelText');
console.log('aligner export parsing ok');
import { outputName } from '../src/aligner.js';
{
  const names = c.models.map(outputName).sort().join(' | ');
  if (names !== 'Mandibular 1.stl | Mandibular 2.stl | Maxillary 1 with attachments.stl | Maxillary 1.stl | Maxillary 10.stl') throw new Error('outputName: ' + names);
  console.log('aligner output names ok');
}
