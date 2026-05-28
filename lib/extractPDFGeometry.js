// lib/extractPDFGeometry.js
//
// Phase E week 1 — Cue Universal Ingestion: deterministic PDF-digital geometry
// extractor.
//
// PURE-ish: takes a digital PDF Buffer (one with a selectable text layer) and
// returns the SAME canonical geometry shape as lib/extractGeometry.js (the
// .docx path), so the existing slot identifier (identifySlots.js) and renderer
// (buildReportDocxV2.js) consume it UNCHANGED. No network, no DB, NO LLM
// (§13 / Mirror C2: the LLM never sees format).
//
// A PDF carries no explicit block / cell / paragraph structure — it is a flat
// stream of positioned glyphs, vector paths and images. This module INFERS the
// structure: glyphs are clustered into lines and paragraphs, and tables are
// reconstructed from drawn ruling lines. Inference quality (not parsing) is what
// scales the architecture as Phase E expands to image / scanned paths — see
// docs/audit/phase-e-findings.md ("Cue is building an inference engine").
//
// Units: PDF user space is points (1/72"). Canonical geometry uses DXA
// (twentieths of a point, ×20) for page / paragraph / table widths, and EMU
// (×12700) for image anchors — matching extractGeometry.js. PDF origin is
// bottom-left (y up); canonical/.docx is top-left (y down), so y is flipped to
// a top-down coordinate per page (toTop = pageHeight − y).
//
// Output additions over the .docx path (all NON-breaking; downstream ignores
// unknown keys): geometry.source='pdf'; every inferred block carries
// _bbox {x,y,w,h} in DXA (page-local, top-down) and _inferred=true.
// numbering_definitions is empty — PDF list markers (e.g. "I.", "II.") are
// literal run text, and the renderer's buildNumbering no-ops on empty defs.

const { PNG } = require('pngjs');

const DXA_PER_PT = 20; // twentieths of a point
const EMU_PER_PT = 12700; // 914400 EMU/in ÷ 72 pt/in

// pdfjs ImageKind (lib/shared/util.js) — re-declared so we don't depend on the
// ESM enum at require time.
const IMAGE_KIND_GRAYSCALE_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

// pdfjs 4.x is ESM-only; the proxy is CommonJS. Load the Node ("legacy") build
// once via dynamic import and cache the promise.
let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjsPromise;
}

// ── unit conversion ───────────────────────────────────────────────────────────
function ptToDxa(pt) {
  return Math.round((pt || 0) * DXA_PER_PT);
}
function ptToEmu(pt) {
  return Math.round((pt || 0) * EMU_PER_PT);
}

// ── 2-D affine matrices ([a,b,c,d,e,f], PDF row-vector convention) ────────────
// matMul(m1, m2) = the matrix that applies m1 FIRST, then m2.
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ── fonts ──────────────────────────────────────────────────────────────────
// Strip the 6-letter subset tag ("ABCDEE+") and style suffixes Word bakes into
// embedded PostScript names to recover a clean family ("ArialMT" → "Arial").
function cleanFontFamily(name) {
  if (!name) return null;
  let n = String(name).replace(/^[A-Z]{6}\+/, ''); // subset tag "ABCDEE+"
  n = n.replace(/[-,](BoldItalic|SemiBold|Bold|Italic|Oblique|Regular|Light|Medium|Black|Heavy)/gi, '');
  n = n.replace(/(PSMT|MT|PS)$/i, ''); // PostScript suffixes (PSMT before MT/PS so it wins)
  n = n.replace(/[-,]\s*$/, '').trim();
  // Frame-normalization (E-3): the PDF carries the PostScript family
  // ("TimesNewRoman"); the .docx carries the friendly family ("Times New
  // Roman"). Split camelCase so both paths agree and the renderer picks the
  // installed face rather than substituting.
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2');
  return n || null;
}
function fontIsBold(name, style) {
  const n = String(name || '').toLowerCase();
  if (/bold|black|heavy|semibold|[-,]bd\b/.test(n)) return true;
  return !!(style && typeof style.fontWeight === 'number' && style.fontWeight >= 600);
}
function fontIsItalic(name) {
  return /italic|oblique/i.test(String(name || ''));
}
// Resolve the embedded PostScript name via page.commonObjs (guarded with .has so
// we never hit the "object isn't resolved yet" throw), falling back to the CSS
// family pdfjs exposes in textContent.styles.
function resolveFontMeta(page, fontName, style) {
  let rawName = '';
  if (fontName && page.commonObjs && page.commonObjs.has(fontName)) {
    const f = page.commonObjs.get(fontName);
    rawName = (f && (f.name || f.loadedName)) || '';
  }
  const nameForFlags = rawName || (style && style.fontFamily) || '';
  return {
    family: cleanFontFamily(rawName) || cleanFontFamily(style && style.fontFamily),
    bold: fontIsBold(nameForFlags, style),
    italic: fontIsItalic(nameForFlags),
  };
}

// ── 1-D clustering ────────────────────────────────────────────────────────────
// Greedy: sort, merge values within `tol`, return each cluster's mean.
function clusterPositions(values, tol) {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  const out = [];
  let bucket = [];
  for (const v of sorted) {
    if (bucket.length === 0 || v - bucket[bucket.length - 1] <= tol) bucket.push(v);
    else {
      out.push(bucket.reduce((a, b) => a + b, 0) / bucket.length);
      bucket = [v];
    }
  }
  if (bucket.length) out.push(bucket.reduce((a, b) => a + b, 0) / bucket.length);
  return out;
}

// ── glyph → line → runs ───────────────────────────────────────────────────────
// Concatenate a line's glyphs (already x-sorted) into canonical runs, splitting
// a run whenever font/size/bold/italic changes and inserting a space across a
// real horizontal gap. Returns runs + joined text + the line bbox (points).
function buildLineRuns(glyphs) {
  const gs = glyphs.slice().sort((a, b) => a.xLeft - b.xLeft);
  const runs = [];
  let cur = null;
  let prevG = null;
  let xLeft = Infinity;
  let xRight = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let lineHeight = 0;
  for (const g of gs) {
    xLeft = Math.min(xLeft, g.xLeft);
    xRight = Math.max(xRight, g.xRight);
    top = Math.min(top, g.top);
    bottom = Math.max(bottom, g.bottom);
    lineHeight = Math.max(lineHeight, g.size);
    let piece = g.str;
    if (prevG) {
      const gap = g.xLeft - prevG.xRight;
      const prevText = cur ? cur.text : '';
      if (gap > g.size * 0.25 && !/\s$/.test(prevText) && !/^\s/.test(piece)) piece = ' ' + piece;
    }
    const key = `${g.font || ''}|${g.sizeHp}|${g.bold ? 1 : 0}|${g.italic ? 1 : 0}`;
    if (cur && cur._key === key) {
      cur.text += piece;
    } else {
      cur = {
        text: piece,
        font: g.font || undefined,
        size: g.sizeHp,
        bold: g.bold || undefined,
        italic: g.italic || undefined,
        _key: key,
      };
      runs.push(cur);
    }
    prevG = g;
  }
  for (const r of runs) delete r._key;
  if (runs.length) runs[0].text = runs[0].text.replace(/^\s+/, '');
  const text = runs.map((r) => r.text).join('');
  return { runs, text, xLeft, xRight, top, bottom, lineHeight: lineHeight || 0 };
}

// Cluster glyphs (one page) into baseline-aligned lines, top→bottom. Each line
// keeps its raw glyphs (for table-cell splitting) plus its runs/bbox.
function groupGlyphsIntoLines(glyphs) {
  const sorted = glyphs.slice().sort((a, b) => a.baseTop - b.baseTop || a.xLeft - b.xLeft);
  const raw = [];
  for (const g of sorted) {
    const last = raw[raw.length - 1];
    const tol = Math.max(2, g.size * 0.5);
    if (last && Math.abs(g.baseTop - last.key) <= tol) last.glyphs.push(g);
    else raw.push({ key: g.baseTop, glyphs: [g] });
  }
  const lines = [];
  for (const l of raw) {
    const built = buildLineRuns(l.glyphs);
    if (built.text.trim() === '' && built.runs.length === 0) continue;
    lines.push(Object.assign({ baseTop: l.key, glyphs: l.glyphs.slice().sort((a, b) => a.xLeft - b.xLeft) }, built));
  }
  return lines;
}

// ── paragraph inference (alignment, indent, wrap detection) ───────────────────
function detectAlignment(ln, pageW, marginLeftPt, marginRightPt) {
  const center = (ln.xLeft + ln.xRight) / 2;
  const startsAtLeft = ln.xLeft - marginLeftPt <= pageW * 0.04;
  if (Math.abs(center - pageW / 2) < pageW * 0.06 && !startsAtLeft) return 'center';
  const endsAtRight = pageW - marginRightPt - ln.xRight <= pageW * 0.04;
  if (endsAtRight && !startsAtLeft && ln.xLeft - marginLeftPt > pageW * 0.15) return 'right';
  return undefined; // left / default
}
function indentLeftDxa(ln, marginLeftPt) {
  const d = ln.xLeft - marginLeftPt;
  return d > 6 ? ptToDxa(d) : 0; // ignore sub-6pt jitter
}

// Group free (non-table) lines into paragraph blocks. Default is one block per
// line (matches a field-per-line assessment template); a line folds into the
// previous block only when it reads as a soft-wrapped continuation: same left
// edge, tight vertical gap, and the previous line ran near the right margin.
function linesToParagraphs(lines, pageW, marginLeftPt, marginRightPt) {
  const blocks = [];
  let cur = null;
  let curLast = null;
  for (const ln of lines) {
    const continuation =
      cur &&
      curLast &&
      Math.abs(ln.xLeft - curLast.xLeft) <= 3 &&
      ln.top - curLast.bottom < curLast.lineHeight * 0.6 &&
      curLast.xRight >= pageW - marginRightPt - (pageW - marginLeftPt - marginRightPt) * 0.15;
    if (continuation) {
      const appended = ln.runs.map((r) => Object.assign({}, r));
      if (appended.length) appended[0] = Object.assign({}, appended[0], { text: ' ' + appended[0].text });
      cur.runs.push(...appended);
      cur._bottom = ln.bottom;
      cur._xRight = Math.max(cur._xRight, ln.xRight);
      curLast = ln;
      continue;
    }
    cur = { type: 'paragraph', runs: ln.runs.map((r) => Object.assign({}, r)), images: [] };
    const align = detectAlignment(ln, pageW, marginLeftPt, marginRightPt);
    if (align) cur.alignment = align;
    const indent = indentLeftDxa(ln, marginLeftPt);
    if (indent) cur.indent = { left: indent };
    cur._top = ln.top;
    cur._bottom = ln.bottom;
    cur._xLeft = ln.xLeft;
    cur._xRight = ln.xRight;
    cur._lineHeight = ln.lineHeight;
    blocks.push(cur);
    curLast = ln;
  }
  return blocks;
}

// ── vector ruling lines → table regions ───────────────────────────────────────
const SIDE_BORDER = { style: 'single', size: 4, color: '000000' };
function fullBorders(withInside) {
  const b = { top: SIDE_BORDER, bottom: SIDE_BORDER, left: SIDE_BORDER, right: SIDE_BORDER };
  if (withInside) {
    b.insideH = SIDE_BORDER;
    b.insideV = SIDE_BORDER;
  }
  return b;
}

// Keep only axis-aligned segments (table rules), in top-down points.
function pushSeg(segs, x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (dx <= 0.8 && dy > 2) {
    segs.push({ vertical: true, x: (x1 + x2) / 2, y1: Math.min(y1, y2), y2: Math.max(y1, y2), len: dy });
  } else if (dy <= 0.8 && dx > 2) {
    segs.push({ horizontal: true, y: (y1 + y2) / 2, x1: Math.min(x1, x2), x2: Math.max(x1, x2), len: dx });
  }
}

// Walk one OPS.constructPath payload ([opCodes, coords]) under CTM, emitting
// axis-aligned segments. Curves are skipped (only their end point updates the
// pen) — table rules are straight.
function collectPathSegments(pathArgs, ctm, pageH, segs, OPS) {
  const ops = pathArgs[0] || [];
  const coords = pathArgs[1] || [];
  let ci = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const emitLineTo = (nx, ny) => {
    const [ax, ay] = applyMatrix(ctm, cx, cy);
    const [bx, by] = applyMatrix(ctm, nx, ny);
    pushSeg(segs, ax, pageH - ay, bx, pageH - by);
    cx = nx;
    cy = ny;
  };
  for (const op of ops) {
    if (op === OPS.moveTo) {
      cx = coords[ci++];
      cy = coords[ci++];
      sx = cx;
      sy = cy;
    } else if (op === OPS.lineTo) {
      emitLineTo(coords[ci++], coords[ci++]);
    } else if (op === OPS.curveTo) {
      ci += 4;
      cx = coords[ci++];
      cy = coords[ci++];
    } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
      ci += 2;
      cx = coords[ci++];
      cy = coords[ci++];
    } else if (op === OPS.rectangle) {
      const x = coords[ci++];
      const y = coords[ci++];
      const w = coords[ci++];
      const h = coords[ci++];
      const c = (px, py) => applyMatrix(ctm, px, py);
      const p00 = c(x, y);
      const p10 = c(x + w, y);
      const p11 = c(x + w, y + h);
      const p01 = c(x, y + h);
      pushSeg(segs, p00[0], pageH - p00[1], p10[0], pageH - p10[1]);
      pushSeg(segs, p10[0], pageH - p10[1], p11[0], pageH - p11[1]);
      pushSeg(segs, p11[0], pageH - p11[1], p01[0], pageH - p01[1]);
      pushSeg(segs, p01[0], pageH - p01[1], p00[0], pageH - p00[1]);
      cx = x;
      cy = y;
      sx = x;
      sy = y;
    } else if (op === OPS.closePath) {
      emitLineTo(sx, sy);
    }
  }
}

// Group ruling lines into table regions. Horizontal-rule y's cluster into row
// boundaries; a large vertical gap (>140pt) splits stacked tables into separate
// bands. For each band, the vertical rules overlapping it give the column
// boundaries. Needs ≥2 row boundaries and ≥2 column boundaries to qualify.
function detectTablesFromSegments(segs) {
  const Hs = segs.filter((s) => s.horizontal);
  const Vs = segs.filter((s) => s.vertical);
  if (Hs.length < 2 || Vs.length < 2) return [];
  const hy = clusterPositions(Hs.map((s) => s.y), 2.5);
  if (hy.length < 2) return [];
  const bands = [];
  let band = [hy[0]];
  const Y_TOL = 3.0;
  // tableBottomY tracks the table's TRUE bottom as last confirmed by an E-13
  // band-merge. It is set to nextTop when a merge fires (the connecting
  // verticals ended at nextTop, so that y IS the table's bottom) and reset to
  // null otherwise. The small-gap branch uses it to seal a band once we cross
  // past the confirmed bottom — see the seal block below.
  let tableBottomY = null;
  for (let i = 1; i < hy.length; i++) {
    if (hy[i] - hy[i - 1] > 140) {
      // E-13 (band-merge across split row-rectangles): a >140pt gap normally
      // starts a new band, but if ≥2 vertical rules CONNECT prev band's bottom
      // to the next h-rule cluster — i.e. v.y1 ≤ prevBottom (rule starts at or
      // above prev band's bottom) AND v.y2 ≈ nextTop (rule ends at the next
      // h-rule cluster) — the gap is the empty interior of ONE ruled box (the
      // Word-PDF case: a table where the header is its own stroked rectangle
      // and the data area is a second stroked rectangle sharing left/right/
      // inner column rules; the two rectangles abut at a sub-pt y boundary so
      // the verticals look continuous visually but are reported as separate
      // sub-segments). Catches both topologies in one rule: a literally
      // continuous full-height rule passes (y1 ≤ prevBottom, y2 ≈ nextTop)
      // AND the split-rectangle data sub-segment passes (y1 ≈ prevBottom +
      // sub-pt gap, y2 ≈ nextTop). The y2-≈-nextTop constraint automatically
      // excludes page-edge verticals (y2 = pageH never matches a band-internal
      // nextTop within Y_TOL), so no separate prevLeft/prevRight x-clamp is
      // needed — the rule is self-tight against the dominant false-merge risk.
      const prevBottom = band[band.length - 1];
      const nextTop = hy[i];
      const connectingVs = Vs.filter((v) =>
        v.y1 <= prevBottom + Y_TOL &&
        Math.abs(v.y2 - nextTop) <= Y_TOL
      );
      const connectingColXs = clusterPositions(connectingVs.map((v) => v.x), 2.5);
      if (connectingColXs.length >= 2) {
        band.push(hy[i]); // gap is interior of one table → keep merging
        // The connecting verticals' y2 IS the table's true bottom — record it
        // so the seal below knows when we leave this table. Multi-section tall
        // tables (multiple E-13 transitions, each with continuing verticals)
        // still merge correctly because tableBottomY updates on every merge.
        tableBottomY = nextTop;
      } else {
        bands.push(band);
        band = [hy[i]];
        tableBottomY = null;
      }
    } else if (tableBottomY !== null && hy[i] > tableBottomY + Y_TOL) {
      // E-13 seal — close the small-gap escape hatch. After E-13 merges in a
      // singleton at the table's true bottom, the original code's small-gap
      // branch would absorb the NEXT close h-rule into the same band even
      // though that rule belongs to an unrelated adjacent table. (Vrishin's
      // linguistic table swallowed the test-material table this way because
      // the linguistic box bottom at y=539.86 was followed by the test-
      // material's first rule at y=554.64 only 14.78pt below — well under the
      // 140pt threshold.) Once hy[i] is past the E-13-confirmed bottom by
      // more than Y_TOL, we're in a different table; seal the current band
      // and start fresh.
      bands.push(band);
      band = [hy[i]];
      tableBottomY = null;
    } else {
      band.push(hy[i]);
    }
  }
  bands.push(band);
  const tables = [];
  for (const b of bands) {
    if (b.length < 2) continue;
    const top = b[0];
    const bottom = b[b.length - 1];
    const vIn = Vs.filter((v) => v.y1 <= bottom - 1 && v.y2 >= top + 1);
    const vx = clusterPositions(vIn.map((v) => v.x), 2.5);
    if (vx.length < 2) continue;
    tables.push({ top, bottom, left: vx[0], right: vx[vx.length - 1], rowYs: b, colXs: vx });
  }
  return tables;
}

// ── table-detection refinement (Phase E wk1 calibration) ──────────────────────
const MIN_COL_PT = 12.5; // ≈250 DXA — narrower "columns" are gutter/edge rules, not real columns
const HEADER_BAND_PT = 120; // page-1 letterhead band (≈1.65"): suppress tables here → paragraphs

// Drop a boundary that would create a column narrower than MIN_COL_PT, merging
// the sliver into its neighbour (a too-narrow column is a gutter/edge artifact).
function mergeSliverColumns(colXs) {
  if (colXs.length <= 2) return colXs.slice();
  const out = [colXs[0]];
  for (let i = 1; i < colXs.length; i++) {
    if (colXs[i] - out[out.length - 1] < MIN_COL_PT) {
      if (i === colXs.length - 1) out[out.length - 1] = colXs[i]; // keep the true right edge
      // otherwise drop this boundary → the sliver merges into the left column
    } else {
      out.push(colXs[i]);
    }
  }
  return out;
}

// Refine raw table regions: merge sliver columns, then drop the things that are
// NOT real tables — single-column boxes (boxed headings/paragraphs) and the
// page-1 letterhead region (whose lines should flow back as centered/bold
// paragraphs via the normal paragraph path).
function refineTableDescs(descs, pageIndex) {
  const kept = [];
  for (const d of descs) {
    const colXs = mergeSliverColumns(d.colXs);
    if (colXs.length - 1 < 2) continue; // single content column → boxed paragraph, not a table
    if (pageIndex === 0 && d.top < HEADER_BAND_PT) continue; // document letterhead → paragraphs
    kept.push(Object.assign({}, d, { colXs, left: colXs[0], right: colXs[colXs.length - 1] }));
  }
  return kept;
}

function indexForBoundary(boundaries, v) {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (v >= boundaries[i] - 0.5 && v < boundaries[i + 1] + 0.5) return i;
  }
  return -1;
}

// Build a canonical table block from a region descriptor + the glyph lines that
// fall inside it. Glyphs are bucketed into cells by (row y-band, column x-band);
// each cell's glyphs are re-grouped into lines so a multi-line cell becomes
// multiple paragraphs. Borders are emitted as single (the rules were drawn).
function buildTableBlock(desc, regionLines) {
  const { rowYs, colXs } = desc;
  const nRows = rowYs.length - 1;
  const nCols = colXs.length - 1;
  const buckets = [];
  for (let r = 0; r < nRows; r++) {
    buckets.push([]);
    for (let c = 0; c < nCols; c++) buckets[r].push([]);
  }
  for (const ln of regionLines) {
    for (const g of ln.glyphs) {
      const r = indexForBoundary(rowYs, g.baseTop);
      const c = indexForBoundary(colXs, (g.xLeft + g.xRight) / 2);
      if (r >= 0 && c >= 0) buckets[r][c].push(g);
    }
  }
  const rows = [];
  for (let r = 0; r < nRows; r++) {
    const cells = [];
    for (let c = 0; c < nCols; c++) {
      const cellLines = groupGlyphsIntoLines(buckets[r][c]);
      const content = cellLines.map((cl) => ({ type: 'paragraph', runs: cl.runs, images: [] }));
      if (content.length === 0) content.push({ type: 'paragraph', runs: [], images: [] });
      cells.push({
        content,
        width: ptToDxa(colXs[c + 1] - colXs[c]),
        borders: fullBorders(false),
      });
    }
    rows.push({ cells });
  }
  const grid = [];
  for (let c = 0; c < nCols; c++) grid.push(ptToDxa(colXs[c + 1] - colXs[c]));
  return {
    type: 'table',
    grid,
    width: grid.reduce((a, b) => a + b, 0),
    borders: fullBorders(true),
    rows,
    _top: desc.top,
    _bottom: desc.bottom,
    _xLeft: desc.left,
    _xRight: desc.right,
  };
}

// ── images ─────────────────────────────────────────────────────────────────
// Image XObjects draw the unit square [0,1]² under the current CTM. Recover the
// EMU anchor (top-left, top-down) and extent from the CTM.
function imageAnchorFromCtm(ctm, pageH) {
  const w = Math.hypot(ctm[0], ctm[1]);
  const h = Math.hypot(ctm[2], ctm[3]);
  const left = ctm[4];
  const topDownTop = pageH - (ctm[5] + h);
  return { x: ptToEmu(left), y: ptToEmu(topDownTop), width: ptToEmu(w), height: ptToEmu(h) };
}

// Re-encode a pdfjs decoded bitmap ({data,width,height,kind}) to PNG bytes.
// Handles RGBA / RGB / 1-bpp grayscale; returns null for anything else (the
// anchor is still captured — the renderer simply skips byte-less media).
function encodePng(img) {
  if (!img || !img.data || !img.width || !img.height) return null;
  const { data, width, height, kind } = img;
  const png = new PNG({ width, height });
  const out = png.data; // RGBA, length width*height*4
  if (kind === IMAGE_KIND_RGBA_32BPP) {
    if (data.length < width * height * 4) return null;
    for (let i = 0; i < width * height * 4; i++) out[i] = data[i];
  } else if (kind === IMAGE_KIND_RGB_24BPP) {
    if (data.length < width * height * 3) return null;
    for (let p = 0, s = 0, d = 0; p < width * height; p++) {
      out[d++] = data[s++];
      out[d++] = data[s++];
      out[d++] = data[s++];
      out[d++] = 255;
    }
  } else if (kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const d = (y * width + x) * 4;
        out[d] = v;
        out[d + 1] = v;
        out[d + 2] = v;
        out[d + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return PNG.sync.write(png);
}

// ── pdfjs-driven page extraction ──────────────────────────────────────────────
async function extractPageGlyphs(page, pageH) {
  const tc = await page.getTextContent({ disableNormalization: false, includeMarkedContent: false });
  const styles = tc.styles || {};
  const glyphs = [];
  for (const it of tc.items) {
    if (it.str == null) continue;
    const tr = it.transform;
    const size = Math.hypot(tr[0], tr[1]) || Math.abs(tr[3]) || 0;
    if (size <= 0) continue;
    const xLeft = tr[4];
    const baseTop = pageH - tr[5]; // baseline distance from page top (y down)
    const style = styles[it.fontName];
    const meta = resolveFontMeta(page, it.fontName, style);
    // Glyph box from the font's OWN ascent/descent (pdfjs text-style metrics),
    // not a flat 0.8·em guess. The guess under-counted ascent by ~1.6pt, which
    // skewed the inferred top margin (1472 vs true 1440) and hence the image
    // anchor-Y normalization. See Finding E-3 / Issue-2 in phase-e-findings.md.
    const ascentFrac = style && typeof style.ascent === 'number' && style.ascent > 0 ? style.ascent : 0.8;
    const descentFrac = style && typeof style.descent === 'number' ? Math.abs(style.descent) : 0.2;
    glyphs.push({
      str: it.str,
      xLeft,
      xRight: xLeft + (it.width || 0),
      baseTop,
      top: baseTop - size * ascentFrac,
      bottom: baseTop + size * descentFrac,
      size,
      sizeHp: Math.max(1, Math.round(size * 2)), // half-points, as the .docx path stores
      font: meta.family,
      bold: meta.bold,
      italic: meta.italic,
    });
  }
  return glyphs;
}

async function extractPageGraphics(page, pageH, OPS) {
  const opList = await page.getOperatorList();
  const fns = opList.fnArray;
  const args = opList.argsArray;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const segs = [];
  const imgs = [];
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    if (fn === OPS.save) {
      stack.push(ctm.slice());
    } else if (fn === OPS.restore) {
      if (stack.length) ctm = stack.pop();
    } else if (fn === OPS.transform) {
      ctm = matMul(args[i], ctm);
    } else if (fn === OPS.constructPath) {
      collectPathSegments(args[i], ctm, pageH, segs, OPS);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
      const a = args[i];
      const objId = Array.isArray(a) ? a[0] : a;
      if (typeof objId === 'string') imgs.push({ objId, ctm: ctm.slice() });
    }
  }
  return { segs, imgs };
}

function getImageBytes(page, objId) {
  if (!objId || !page.objs || !page.objs.has(objId)) return null;
  const img = page.objs.get(objId);
  if (!img) return null;
  return encodePng(img);
}

// ── page setup + document stats ───────────────────────────────────────────────
function inferContentArea(glyphs, pageW, pageH) {
  let left = pageW;
  let right = 0;
  let top = pageH;
  let bottom = 0;
  for (const g of glyphs) {
    left = Math.min(left, g.xLeft);
    right = Math.max(right, g.xRight);
    top = Math.min(top, g.top);
    bottom = Math.max(bottom, g.bottom);
  }
  if (right <= left) {
    left = 0;
    right = pageW;
    top = 0;
    bottom = pageH;
  }
  return { left, right, top, bottom };
}
// Margins inferred from TEXT extents only (images such as a behindDoc logo can
// bleed past the text frame and must not skew the page margins).
function buildPageSetup(textGlyphs, pageW, pageH) {
  const area = inferContentArea(textGlyphs, pageW, pageH);
  return {
    width: ptToDxa(pageW),
    height: ptToDxa(pageH),
    orientation: pageW > pageH ? 'landscape' : 'portrait',
    margins: {
      top: Math.max(0, ptToDxa(area.top)),
      bottom: Math.max(0, ptToDxa(pageH - area.bottom)),
      left: Math.max(0, ptToDxa(area.left)),
      right: Math.max(0, ptToDxa(pageW - area.right)),
      header: 720,
      footer: 720,
    },
  };
}
function buildDefaultFont(glyphs) {
  const tally = new Map();
  for (const g of glyphs) {
    const weight = (g.str || '').replace(/\s/g, '').length || 0;
    if (!weight) continue;
    const key = `${g.font || ''}|${g.sizeHp}`;
    tally.set(key, (tally.get(key) || 0) + weight);
  }
  let bestKey = null;
  let best = -1;
  for (const [k, v] of tally) {
    if (v > best) {
      best = v;
      bestKey = k;
    }
  }
  if (!bestKey) return { family: null, size: null };
  const [family, sizeHp] = bestKey.split('|');
  return { family: family || null, size: Number(sizeHp) || null };
}

// Finalize a block: emit paragraph spacing.after from the gap to the next block,
// set _bbox (DXA, page-local, top-down) + _inferred, and strip the working keys.
function finalizeBlocks(structure) {
  for (let i = 0; i < structure.length; i++) {
    const b = structure[i];
    if (b.type === 'paragraph') {
      const next = structure[i + 1];
      if (next && b._bottom != null && next._top != null && next._top > b._bottom) {
        const gap = next._top - b._bottom;
        const extra = gap - (b._lineHeight || 0) * 0.3;
        if (extra > 2) b.spacing = { after: ptToDxa(extra) };
      }
    }
    const x = b._xLeft != null ? b._xLeft : 0;
    const y = b._top != null ? b._top : 0;
    const w = (b._xRight != null ? b._xRight : x) - x;
    const h = (b._bottom != null ? b._bottom : y) - y;
    b._bbox = { x: ptToDxa(x), y: ptToDxa(y), w: ptToDxa(w), h: ptToDxa(h) };
    b._inferred = true;
    delete b._top;
    delete b._bottom;
    delete b._xLeft;
    delete b._xRight;
    delete b._lineHeight;
    delete b._sortTop;
  }
}

// ── E-15: content-occupancy test for detected tables ────────────────────────
// A table is structurally defined by content occupancy, not by drawn rules
// alone. Axis-aligned vector rules get drawn for many reasons that aren't
// "this is a table" — brand-header decorations, page-edge accents, signature
// lines, decorative borders — producing phantom grids whose cells are mostly
// empty because no content was meant to occupy them. The occupancy test
// reverses the inferential direction: instead of "do drawn rules suggest a
// table?", ask "does content confirm a table?" Below threshold → reject the
// descriptor; regionLines flow into the existing linesToParagraphs path.
//
// THRESHOLD — PROVISIONAL. Calibrated against N=2 (reject Ikansh's 6%, keep
// Vrishin's 33% / 50%); revisit when corpus includes a real sparse-form
// clinical table (checklist with mostly-empty rows). Cost asymmetry:
// false-accept (shredded prose) >> false-reject (sparse form as paragraphs),
// so err toward keeping — 8% is deliberately well below the ~15-20% where a
// real sparse form would plausibly land.
const MIN_TABLE_OCCUPANCY = 0.08;

// A cell is empty iff none of its paragraph runs carry non-whitespace text.
function isCellEmpty(cell) {
  for (const cb of (cell && cell.content) || []) {
    if (cb.type !== 'paragraph') continue;
    for (const r of cb.runs || []) {
      if (r.text && String(r.text).trim() !== '') return false;
    }
  }
  return true;
}

// Whole-grid occupancy = (cells containing any text glyph) / (total cells).
// HOOK FOR PER-ROW OCCUPANCY: if a sparse-form document later defeats the
// whole-grid test by registering above MIN_TABLE_OCCUPANCY in aggregate while
// having most rows entirely empty, a per-row median pass would land here as
// a second signal. Not implemented — whole-grid covers the high-severity
// case (Ikansh-style phantom grids); per-row is a future refinement.
function computeTableOccupancy(tbl) {
  let nonEmpty = 0;
  let total = 0;
  for (const row of (tbl && tbl.rows) || []) {
    for (const cell of row.cells || []) {
      total++;
      if (!isCellEmpty(cell)) nonEmpty++;
    }
  }
  return total === 0 ? 1 : nonEmpty / total;
}

// ── top-level ────────────────────────────────────────────────────────────────
async function extractPDFGeometry(pdfBuffer) {
  const pdfjs = await loadPdfjs();
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const allGlyphs = [];
  const structure = [];
  const media = [];
  let firstW = 612;
  let firstH = 792;
  let yOffset = 0; // stacks pages so cross-page document order sorts correctly

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const pageW = vp.width;
    const pageH = vp.height;
    if (p === 1) {
      firstW = pageW;
      firstH = pageH;
    }

    // Warm the font registry first: getOperatorList resolves embedded fonts
    // into page.commonObjs, so glyph font-family resolution sees real embedded
    // names (e.g. Arial) instead of pdfjs's generic CSS fallback ("sans-serif").
    const { segs, imgs } = await extractPageGraphics(page, pageH, OPS);
    const glyphs = await extractPageGlyphs(page, pageH);
    for (const g of glyphs) allGlyphs.push(g);

    const lines = groupGlyphsIntoLines(glyphs);
    const tableDescs = refineTableDescs(detectTablesFromSegments(segs), p - 1);

    const used = new Set();
    const items = [];
    for (const d of tableDescs) {
      const regionLines = lines.filter((l) => l.baseTop >= d.top - 2 && l.baseTop <= d.bottom + 2);
      const tbl = buildTableBlock(d, regionLines);
      // E-15: reject if cell-content occupancy is below threshold (decorative
      // rules drew a phantom grid). regionLines stay UNMARKED in `used` so
      // they flow into linesToParagraphs via the freeLines path below — the
      // existing non-tabular fallback handles them with no new code path.
      if (computeTableOccupancy(tbl) < MIN_TABLE_OCCUPANCY) continue;
      regionLines.forEach((l) => used.add(l));
      tbl._sortTop = d.top + yOffset;
      items.push(tbl);
    }
    const freeLines = lines.filter((l) => !used.has(l));
    const area = inferContentArea(glyphs, pageW, pageH);
    const paras = linesToParagraphs(freeLines, pageW, area.left, pageW - area.right);
    for (const para of paras) {
      para._sortTop = para._top + yOffset;
      items.push(para);
    }

    for (const im of imgs) {
      const bytes = getImageBytes(page, im.objId);
      const relId = `pdfimg${media.length + 1}`;
      media.push({
        id: `image${media.length + 1}.png`,
        rel_id: relId,
        part: `page${p}`,
        ext: 'png',
        bytes: bytes || null,
        anchor: imageAnchorFromCtm(im.ctm, pageH),
        wrap_mode: 'behindDoc',
      });
      // E-6: attach the image to the closest paragraph on this page so the
      // renderer reproduces it. The renderer emits images only via a block's
      // images[] (resolved through mediaByRel[rel_id]); a PDF image left only in
      // geometry.media[] would never render. Floating/behindDoc placement is by
      // the media anchor, so the host paragraph just carries the rel_id ref (no
      // anchor on the ref → resolveMedia falls back to the normalized media anchor).
      const imgH = Math.hypot(im.ctm[2], im.ctm[3]);
      const imgTopPt = pageH - (im.ctm[5] + imgH);
      let host = null;
      let bestDist = Infinity;
      for (const para of paras) {
        const d = Math.abs((para._top != null ? para._top : 0) - imgTopPt);
        if (d < bestDist) { bestDist = d; host = para; }
      }
      if (host) host.images.push({ rel_id: relId, wrap_mode: 'behindDoc' });
    }

    for (const it of items) structure.push(it);
    yOffset += pageH + 1;
    page.cleanup();
  }

  structure.sort((a, b) => (a._sortTop || 0) - (b._sortTop || 0));
  finalizeBlocks(structure);
  await doc.destroy();

  const page_setup = buildPageSetup(allGlyphs, firstW, firstH);
  // Frame-normalization rule (docs/audit/phase-e-findings.md): PDF image anchors
  // are absolute-from-page-corner; .docx anchors are margin-relative. Translate
  // to the .docx convention HERE so downstream stays format-agnostic.
  const marginLeftEmu = Math.round((page_setup.margins.left || 0) * 635); // 1 DXA = 635 EMU
  const marginTopEmu = Math.round((page_setup.margins.top || 0) * 635);
  for (const m of media) {
    if (!m.anchor) continue;
    m.anchor.x -= marginLeftEmu;
    m.anchor.y -= marginTopEmu;
  }

  const tables = structure.filter((b) => b.type === 'table');
  return {
    source: 'pdf',
    page_setup,
    default_font: buildDefaultFont(allGlyphs),
    numbering_definitions: { abstract: {}, nums: {} },
    structure,
    media,
    counts: {
      tables: tables.length,
      images: media.length,
      main_table_columns: tables.length ? tables[0].grid.length : 0,
    },
  };
}

module.exports = {
  extractPDFGeometry,
  DXA_PER_PT,
  EMU_PER_PT,
  // exported for unit tests (pure helpers — no pdfjs / no real PDF needed)
  _internals: {
    matMul,
    applyMatrix,
    ptToDxa,
    ptToEmu,
    cleanFontFamily,
    fontIsBold,
    fontIsItalic,
    clusterPositions,
    buildLineRuns,
    groupGlyphsIntoLines,
    detectAlignment,
    indentLeftDxa,
    linesToParagraphs,
    pushSeg,
    collectPathSegments,
    detectTablesFromSegments,
    mergeSliverColumns,
    refineTableDescs,
    indexForBoundary,
    buildTableBlock,
    imageAnchorFromCtm,
    encodePng,
    inferContentArea,
    buildPageSetup,
    buildDefaultFont,
    finalizeBlocks,
    // E-15
    isCellEmpty,
    computeTableOccupancy,
    MIN_TABLE_OCCUPANCY,
  },
};
