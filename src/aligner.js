// Clear-aligner export (e.g. 3Shape Clear Aligner Studio): one folder per stage,
//
//   <case>_Subsetup1/Maxillary.stl
//   <case>_Subsetup1/Maxillary_with_attachments.stl   (attachment template, stage 1 only)
//   <case>_Subsetup1/Mandibular.stl
//   <case>_Subsetup2/Maxillary.stl
//   …
//   ClearAlignerProductionResources.xml
//
// A folder may hold only one jaw. All models share one coordinate system, so a
// spot picked on stage 1 is the same spot on every other stage.

/**
 * @typedef {{ path: string, read: () => Promise<ArrayBuffer> }} Entry  a file with its path inside the export
 * @typedef {{ stage: number, jaw: 'upper'|'lower', attachments: boolean, path: string, entry: Entry }} AlignerModel
 * @typedef {{ name: string, models: AlignerModel[], stages: number[], jaws: ('upper'|'lower')[], xml: Entry|null, skipped: string[] }} AlignerCase
 */

const SUBSETUP_RE = /^(.*?)[\s_-]*sub[\s_-]*setup[\s_-]*(\d+)$/i;

/** 'upper' | 'lower' | null from a file name. */
export function jawOf(name) {
  if (/maxill|upper|oberkiefer/i.test(name)) return 'upper';
  if (/mandib|lower|unterkiefer/i.test(name)) return 'lower';
  return null;
}

export const JAW_LABEL = { upper: 'Maxillary', lower: 'Mandibular' };

/**
 * Recognise an aligner export among a set of files (from a folder, a drop or ZIPs).
 * Returns null when no file sits in a "…Subsetup<N>" folder.
 * @param {Entry[]} entries
 * @returns {AlignerCase|null}
 */
export function parseAlignerFiles(entries) {
  /** @type {AlignerModel[]} */
  const models = [];
  const skipped = [];
  let name = '';
  let xml = null;
  for (const entry of entries) {
    const parts = entry.path.replace(/\\/g, '/').split('/').filter(Boolean);
    const file = parts[parts.length - 1] || '';
    if (/\.xml$/i.test(file)) {
      if (!xml || /ClearAligner/i.test(file)) xml = entry;
      continue;
    }
    if (!/\.stl$/i.test(file) || parts.length < 2) continue;
    const m = SUBSETUP_RE.exec(parts[parts.length - 2]);
    if (!m) continue;
    const jaw = jawOf(file.replace(/\.stl$/i, ''));
    if (!jaw) {
      skipped.push(`${parts[parts.length - 2]}/${file}`);
      continue;
    }
    const stage = Number(m[2]);
    const attachments = /attach/i.test(file);
    if (models.some((x) => x.stage === stage && x.jaw === jaw && x.attachments === attachments)) continue;
    name ||= m[1].replace(/[\s_-]+$/, '');
    models.push({ stage, jaw, attachments, path: `${parts[parts.length - 2]}/${file}`, entry });
  }
  if (!models.length) return null;
  models.sort((a, b) => (a.jaw === b.jaw ? 0 : a.jaw === 'upper' ? -1 : 1) || a.stage - b.stage || Number(a.attachments) - Number(b.attachments));
  const stages = [...new Set(models.map((x) => x.stage))].sort((a, b) => a - b);
  const jaws = ['upper', 'lower'].filter((j) => models.some((x) => x.jaw === j));
  return { name: name || 'aligner', models, stages, jaws, xml, skipped };
}

/** The label for a stage: every "{n}" in the template becomes the subsetup number. */
export function labelText(template, stage) {
  const t = template.includes('{n}') ? template : template + '{n}';
  return t.replace(/\{n\}/g, String(stage));
}

/** The first stage of a jaw (where the user places the labels). */
export function firstStage(c, jaw) {
  const s = c.models.filter((m) => m.jaw === jaw && !m.attachments).map((m) => m.stage);
  return s.length ? Math.min(...s) : null;
}

/** The model shown for a jaw / stage / attachment choice, or null. */
export function findModel(c, jaw, stage, attachments = false) {
  return c.models.find((m) => m.jaw === jaw && m.stage === stage && m.attachments === attachments) || null;
}

/**
 * File name of a labelled model in the flat export: the model's name, then the
 * subsetup number, e.g. "Mandibular 3.stl" or "Maxillary 1 with attachments.stl".
 */
export function outputName(m) {
  const file = m.path.replace(/\\/g, '/').split('/').pop().replace(/\.stl$/i, '');
  const base =
    file
      .replace(/[\s_-]*(with[\s_-]*)?attach(ment)?s?/i, '')
      .replace(/[\s_]+/g, ' ')
      .trim() || JAW_LABEL[m.jaw];
  return `${base} ${m.stage}${m.attachments ? ' with attachments' : ''}.stl`;
}
