// Converts a string into closed 2D polygons (in millimetres) using an
// OpenType font. The output is consumed by manifold's CrossSection, using the
// NonZero fill rule so overlapping glyphs (script fonts) merge cleanly.
import opentype from 'opentype.js';

export function parseFont(arrayBuffer) {
  return opentype.parse(arrayBuffer);
}

export function fontDisplayName(font, fallback) {
  const n = font.names || {};
  const pick = (rec) => rec && (rec.en || Object.values(rec)[0]);
  return pick(n.fullName) || pick(n.fontFamily) || fallback;
}

// Height of capital letters in font units (used so "letter height" means
// the height of an uppercase letter, which is what people usually measure).
function capHeightUnits(font) {
  const os2 = font.tables && font.tables.os2;
  if (os2 && os2.sCapHeight > 0) return os2.sCapHeight;
  const h = font.charToGlyph('H');
  if (h && h.yMax > 0) return h.yMax;
  return font.ascender * 0.7;
}

/**
 * @param {object} font opentype.js Font
 * @param {object} o
 * @param {string} o.text
 * @param {number} o.height        cap height in mm
 * @param {number} o.letterSpacing extra spacing between letters in mm
 * @param {number} o.lineSpacing   line pitch as a multiple of the cap height
 * @param {'left'|'center'|'right'} o.align
 * @param {number} o.tolerance     max chord error for curve flattening (mm)
 * @returns {{contours: number[][][], width: number, height: number}}
 */
export function textToContours(font, o) {
  const lines = o.text.replace(/\r/g, '').split('\n');
  const cap = capHeightUnits(font);
  const fontSize = (o.height * font.unitsPerEm) / cap; // mm per em
  const opts = {
    kerning: true,
    letterSpacing: (o.letterSpacing || 0) / fontSize,
    drawLayers: false,
    drawSVG: false,
  };
  const pitch = o.height * (o.lineSpacing || 1.6);
  const tol = Math.max(o.tolerance || 0.02, 1e-4);

  const contours = [];
  const lineInfo = [];
  lines.forEach((line, i) => {
    let w = font.getAdvanceWidth(line, fontSize, opts);
    if (line.length) w -= opts.letterSpacing * fontSize; // no trailing gap
    lineInfo.push({ line, w, y: -i * pitch });
  });
  const maxW = Math.max(0, ...lineInfo.map((l) => l.w));

  for (const { line, w, y } of lineInfo) {
    if (!line.trim()) continue;
    let x0 = 0;
    if (o.align === 'center') x0 = (maxW - w) / 2;
    else if (o.align === 'right') x0 = maxW - w;
    // opentype paths are y-down; we flip to y-up below.
    const path = font.getPath(line, x0, -y, fontSize, opts);
    flattenPath(path.commands, tol, contours);
  }

  // Centre the block on the origin (both axes) so the click point is the
  // middle of the text.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (const p of c) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!contours.length) return { contours, width: 0, height: 0 };
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (const c of contours) for (const p of c) { p[0] -= cx; p[1] -= cy; }
  return { contours, width: maxX - minX, height: maxY - minY };
}

function flattenPath(cmds, tol, out) {
  let cur = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  const push = (px, py) => cur.push([px, -py]);
  const close = () => {
    if (cur && cur.length >= 3) {
      const a = cur[0], b = cur[cur.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) cur.pop();
      if (cur.length >= 3) out.push(cur);
    }
    cur = null;
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        close();
        cur = [];
        x = sx = c.x; y = sy = c.y;
        push(x, y);
        break;
      case 'L':
        if (!cur) { cur = []; push(x, y); }
        x = c.x; y = c.y; push(x, y);
        break;
      case 'Q': {
        if (!cur) { cur = []; push(x, y); }
        const n = segs(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x - c.x1, c.y - c.y1), tol);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
        }
        x = c.x; y = c.y;
        break;
      }
      case 'C': {
        if (!cur) { cur = []; push(x, y); }
        const len = Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2);
        const n = segs(len, tol);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
          push(a * x + b * c.x1 + d * c.x2 + e * c.x, a * y + b * c.y1 + d * c.y2 + e * c.y);
        }
        x = c.x; y = c.y;
        break;
      }
      case 'Z':
        x = sx; y = sy;
        close();
        break;
    }
  }
  close();
}

// Number of segments so the chord error of a curve of control-polygon length
// `len` stays roughly below `tol`.
function segs(len, tol) {
  return Math.min(64, Math.max(2, Math.ceil(Math.sqrt(len / (8 * tol)) * 2)));
}
