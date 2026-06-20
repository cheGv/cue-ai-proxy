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

// ── E-25: text-column alignment via tab stops (the text-side twin of E-24) ─────
// A borderless table (e.g. a score grid with no cell rules) carries its column
// structure ONLY in glyph x-positions: a Word→PDF export encodes the gutter
// between two columns as a single space glyph whose width spans the whole gap
// (so "Subtest<181pt space>Raw Score" is three positioned chunks, not a ruled
// grid). detectTablesFromSegments sees no rules and buildLineRuns collapses that
// wide gap to ONE literal space — the columns die, the row becomes run-on prose.
//
// E-25 recovers the alignment WITHOUT ever asserting a table: when several
// consecutive lines share the same column x-boundaries, each line is rendered as
// a paragraph with left TAB STOPS at those x's (cells joined by tabs). No
// <w:tbl> is ever emitted from this path — the only tables in any output still
// come from the vector detector. This is intentionally the conservative twin of
// the E-24 phantom-table guard: a coincidentally-aligned block of prose, a
// wrapped paragraph, or an indented/nested list must NOT become columns. A
// missed alignment is acceptable; a hallucinated column is not. The guards:
//   1. cell split needs a gap ≥ COLALIGN_GAP_EM × font size (a column gutter is
//      qualitatively wider than the widest word/marker space ~1.5em);
//   2. ≥ COLALIGN_MIN_ROWS consecutive, vertically-contiguous lines, each with
//      ≥2 cells;
//   3. ≥2 columns clustered to a tight tolerance, each populated in ≥75% of rows,
//      with low cross-row variance (max−min ≤ tol) — "the SAME column x's";
//   4. every cell must snap to a strong column (no off-grid split → not a grid);
//   5. list-marker reject: a column whose first cells are "1." / "-" / "a)" is a
//      numbered/bulleted list, not a table;
//   6. label:value reject: cells that read "Label: value" are a form/field block
//      (e.g. a demographics header), not a data grid.
const COLALIGN_GAP_EM = 2.0;        // inter-cell gap ≥ this × font size = a column gutter
const COLALIGN_GAP_MIN_PT = 16;     // absolute floor (small fonts must not over-split)
const COLALIGN_TOL_EM = 0.6;        // cross-row column-start clustering tolerance
const COLALIGN_TOL_MIN_PT = 4;      // absolute floor for that tolerance
const COLALIGN_MIN_ROWS = 3;        // need ≥3 consecutive rows to assert a column block
const COLALIGN_ROW_PITCH_EM = 2.6;  // consecutive rows: baseline pitch ceiling (a blank line breaks the block)
const COLALIGN_SUPPORT_FRAC = 0.75; // a column must carry a cell in ≥ this fraction of rows
const COLALIGN_MARKER_FRAC = 0.6;   // reject block if ≥ this fraction of rows' first cell is a list marker
const COLALIGN_FIELD_FRAC = 0.5;    // reject block if ≥ this fraction of cells read "Label: value"
// A cell whose ENTIRE text is a list marker: "1." "12)" "a." "iv)" or a bullet.
const COLALIGN_MARKER_RE = /^(\d{1,3}[.)]|[A-Za-z][.)]|[ivxlcdmIVXLCDM]{1,4}[.)]|[-*•·▪◦‣–—])$/;
// "Label: value" — a letter, then any non-colon text, then a colon, then content.
const COLALIGN_FIELD_RE = /[A-Za-z][^:]*:\s*\S/;

function lineFontSize(ln) {
  return ln.lineHeight || (ln.glyphs && ln.glyphs[0] && ln.glyphs[0].size) || 10;
}

// Split one line into cells at wide horizontal gaps. Whitespace-only glyph items
// are dropped — the gutter they encode is recovered as the positional gap between
// the non-whitespace items they separate, so both encodings (a wide space item
// AND a true positional gap) are handled uniformly. A line with no glyphs (the
// synthetic linesToParagraphs test shape) yields no cells → never a column.
function splitLineCells(ln) {
  const gs = ln.glyphs;
  if (!Array.isArray(gs) || gs.length === 0) return [];
  const nonWs = gs.filter((g) => g.str && String(g.str).trim() !== '').slice().sort((a, b) => a.xLeft - b.xLeft);
  if (nonWs.length === 0) return [];
  const thresh = Math.max(COLALIGN_GAP_EM * lineFontSize(ln), COLALIGN_GAP_MIN_PT);
  const cells = [];
  let cur = { startX: nonWs[0].xLeft, endX: nonWs[0].xRight, glyphs: [nonWs[0]] };
  for (let i = 1; i < nonWs.length; i++) {
    const g = nonWs[i];
    if (g.xLeft - cur.endX >= thresh) {
      cells.push(cur);
      cur = { startX: g.xLeft, endX: g.xRight, glyphs: [g] };
    } else {
      cur.endX = Math.max(cur.endX, g.xRight);
      cur.glyphs.push(g);
    }
  }
  cells.push(cur);
  for (const c of cells) c.text = buildLineRuns(c.glyphs).text;
  return cells;
}

// Decide whether a run of contiguous multi-cell rows is a real column block.
// `rows` = [{ line, cells }]. Returns { colXs, rows } (cells annotated with _col)
// or null. The annotated rows are the SAME objects the caller will emit.
function evaluateColumnRun(rows) {
  const nRows = rows.length;
  if (nRows < COLALIGN_MIN_ROWS) return null;
  const avgSize = rows.reduce((a, r) => a + lineFontSize(r.line), 0) / nRows;
  const tol = Math.max(COLALIGN_TOL_EM * avgSize, COLALIGN_TOL_MIN_PT);
  const allStarts = [];
  for (const r of rows) for (const c of r.cells) allStarts.push(c.startX);
  const cols = clusterPositions(allStarts, tol);
  if (cols.length < 2) return null;
  // Snap every cell to its nearest column. A cell farther than tol from every
  // cluster means this row does not fit the grid → not a table.
  const members = cols.map(() => []);
  const rowsAtCol = cols.map(() => new Set());
  for (let ri = 0; ri < nRows; ri++) {
    for (const c of rows[ri].cells) {
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < cols.length; k++) {
        const d = Math.abs(c.startX - cols[k]);
        if (d < bd) { bd = d; best = k; }
      }
      if (bd > tol) return null; // off-grid cell
      members[best].push(c.startX);
      rowsAtCol[best].add(ri);
      c._col = best;
    }
  }
  // Strong columns: carry a cell in ≥ SUPPORT_FRAC of rows, low cross-row variance.
  const minSup = Math.ceil(nRows * COLALIGN_SUPPORT_FRAC);
  const strongIdx = [];
  for (let k = 0; k < cols.length; k++) {
    if (rowsAtCol[k].size < minSup) continue;
    const m = members[k];
    if (Math.max(...m) - Math.min(...m) > tol) return null; // high variance → not aligned
    strongIdx.push(k);
  }
  if (strongIdx.length < 2) return null;
  // Every cell must belong to a STRONG column (a stray weak-column cell means the
  // rows do not share one consistent grid).
  const strongSet = new Set(strongIdx);
  for (const r of rows) for (const c of r.cells) if (!strongSet.has(c._col)) return null;
  // Re-index cells onto the dense strong-column axis (0..strongIdx.length-1).
  const denseOf = new Map();
  strongIdx.forEach((k, dense) => denseOf.set(k, dense));
  for (const r of rows) for (const c of r.cells) c._col = denseOf.get(c._col);
  // Anti-phantom #5: a list (numbered / bulleted) — first cell is a bare marker.
  const markerRows = rows.filter((r) => COLALIGN_MARKER_RE.test((r.cells[0].text || '').trim())).length;
  if (markerRows / nRows >= COLALIGN_MARKER_FRAC) return null;
  // Anti-phantom #6: a label:value form (e.g. demographics) — not a data grid.
  let fieldCells = 0;
  let totalCells = 0;
  for (const r of rows) for (const c of r.cells) { totalCells++; if (COLALIGN_FIELD_RE.test(c.text || '')) fieldCells++; }
  if (totalCells && fieldCells / totalCells >= COLALIGN_FIELD_FRAC) return null;
  const colXs = strongIdx.map((k) => members[k].reduce((a, b) => a + b, 0) / members[k].length);
  return { colXs, rows };
}

// Scan the (top→bottom) free lines for column blocks. Returns non-overlapping
// blocks { start, end, colXs, rows } (end exclusive, indices into `lines`),
// sorted by start. Greedy: grow a maximal run of contiguous multi-cell rows,
// evaluate it as a whole, then continue past it.
function detectColumnarBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const ci = splitLineCells(lines[i]);
    if (ci.length < 2) { i++; continue; }
    const rows = [{ line: lines[i], cells: ci }];
    let j = i + 1;
    while (j < lines.length) {
      const cj = splitLineCells(lines[j]);
      if (cj.length < 2) break;
      const pitch = lines[j].baseTop - lines[j - 1].baseTop;
      if (!(pitch > 0) || pitch > COLALIGN_ROW_PITCH_EM * lineFontSize(lines[j])) break;
      rows.push({ line: lines[j], cells: cj });
      j++;
    }
    const ev = rows.length >= COLALIGN_MIN_ROWS ? evaluateColumnRun(rows) : null;
    if (ev) blocks.push({ start: i, end: j, colXs: ev.colXs, rows: ev.rows });
    i = Math.max(j, i + 1);
  }
  return blocks;
}

// Turn one detected column block into one paragraph per row: left tab stops at
// the 2nd..Nth column x's (1st column = the paragraph's left edge), cells joined
// by tab runs. Tab x's are dxa relative to marginLeftPt — the same margin the
// existing indent path uses. NEVER a table.
function buildColumnarParagraphs(block, marginLeftPt) {
  const { colXs, rows } = block;
  const tabStops = [];
  for (let k = 1; k < colXs.length; k++) {
    tabStops.push({ type: 'left', position: Math.max(0, ptToDxa(colXs[k] - marginLeftPt)) });
  }
  const indentLeft = ptToDxa(colXs[0] - marginLeftPt);
  const out = [];
  for (const row of rows) {
    const cells = row.cells.slice().sort((a, b) => a._col - b._col);
    const runs = [];
    let prevCol = 0; // cursor starts at column 0 (the paragraph's indent)
    for (const cell of cells) {
      for (let t = prevCol; t < cell._col; t++) runs.push({ tab: true });
      for (const r of buildLineRuns(cell.glyphs).runs) runs.push(r);
      prevCol = cell._col;
    }
    const para = { type: 'paragraph', runs, images: [], tabStops };
    if (indentLeft > 6) para.indent = { left: indentLeft };
    para._top = row.line.top;
    para._bottom = row.line.bottom;
    para._xLeft = row.line.xLeft;
    para._xRight = row.line.xRight;
    para._lineHeight = row.line.lineHeight;
    out.push(para);
  }
  return out;
}

// Group free (non-table) lines into paragraph blocks. Default is one block per
// line (matches a field-per-line assessment template); a line folds into the
// previous block only when it reads as a soft-wrapped continuation: same left
// edge, tight vertical gap, and the previous line ran near the right margin.
function linesToParagraphs(lines, pageW, marginLeftPt, marginRightPt) {
  const blocks = [];
  // E-25: detect borderless column blocks first. Their rows are emitted as
  // tab-aligned paragraphs (atomic), and a block boundary resets the wrap-
  // continuation state so a column row never folds into adjacent prose.
  const columnar = detectColumnarBlocks(lines);
  let ci = 0;
  let cur = null;
  let curLast = null;
  let i = 0;
  while (i < lines.length) {
    if (ci < columnar.length && columnar[ci].start === i) {
      for (const para of buildColumnarParagraphs(columnar[ci], marginLeftPt)) blocks.push(para);
      i = columnar[ci].end;
      ci++;
      cur = null;
      curLast = null;
      continue;
    }
    const ln = lines[i];
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
      i++;
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
    i++;
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

// ── E-24: invisible-fill guard (ported from guard.py) ─────────────────────────
// A flat PDF gives every painted path an equal vote in table inference, but a
// path that does not actually RENDER carries no table-structure meaning. Two
// kinds of fill-only path render to nothing useful and must not vote:
//   1. a fill larger than half the page — a decorative full-bleed band, never a
//      rule or a cell;
//   2. a fill whose colour equals its own backdrop (the page, or the smallest
//      fill enclosing it) — an INVISIBLE fill. DOCX→PDF exporters stamp a white
//      rectangle behind every text line; stacked, those rectangles' edges
//      cluster into a phantom grid of "cells". Because each phantom cell sits
//      behind real text it is NOT empty, so the E-15 occupancy test (which runs
//      AFTER cells are built) cannot catch it — the only place to kill it is
//      here, at the path, before a single segment reaches
//      detectTablesFromSegments. This is E-24.
// Strokes and visibly-coloured fills always pass.
//
// pdfjs port: PyMuPDF's page.get_drawings() yields {type, rect, fill} dicts; the
// equivalent here is reconstructed in extractPageGraphics during the operator-
// list walk — `type` from the path's paint op (f / s / fs), `rect` from
// constructPath's minMax under the CTM (top-down points), `fill` from the
// normalized setFillRGBColor state (0–1 RGB). eligible() is then called as a
// filter on that path list, exactly as the spec describes filtering
// get_drawings() output before any table-structure detection runs.
const E24_MAX_RULE_FRAC = 0.5; // a fill-only path larger than this fraction of the page is a band
const E24_COLOR_TOL = 0.02; // RGB equality tolerance in 0–1 space (≈ 5/255)

// RGB-tuple equality with tolerance (guard.py _eq). A null/undefined operand
// never matches — an unknown fill (e.g. a Pattern colour) is therefore treated
// as visible, i.e. eligible.
function colorsEqual(a, b, tol = E24_COLOR_TOL) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!(Math.abs(a[i] - b[i]) <= tol)) return false;
  }
  return true;
}
function pathIsFillOnly(p) {
  return p.type === 'f';
}
function pathHasStroke(p) {
  return p.type === 's' || p.type === 'fs';
}

// Map a pdfjs paint op to the guard's path type. endPath (clip / no-op) and any
// unrecognized terminator map to 'n' — neither fill nor stroke — so eligible()
// passes the path through unchanged (preserving the pre-E-24 behaviour where a
// clip rectangle still contributed its segments).
function paintType(fn, OPS) {
  if (fn === OPS.fill || fn === OPS.eoFill) return 'f';
  if (fn === OPS.stroke || fn === OPS.closeStroke) return 's';
  if (fn === OPS.fillStroke || fn === OPS.eoFillStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) {
    return 'fs';
  }
  return 'n';
}

// Transform a constructPath minMax box [xMin,yMin,xMax,yMax] (user space) by the
// CTM and flip to top-down points, returning the guard's rect shape (the pdfjs
// analogue of PyMuPDF path["rect"]). Returns null for a non-finite box (a path
// that opened with a curve/closePath rather than a rect/move/line).
function rectFromMinMax(minMax, ctm, pageH) {
  if (!minMax) return null;
  const [xMin, yMin, xMax, yMax] = minMax;
  if (![xMin, yMin, xMax, yMax].every(Number.isFinite)) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [ux, uy] of [[xMin, yMin], [xMax, yMin], [xMax, yMax], [xMin, yMax]]) {
    const [dx, dy] = applyMatrix(ctm, ux, uy);
    const ty = pageH - dy; // top-down
    x0 = Math.min(x0, dx);
    x1 = Math.max(x1, dx);
    y0 = Math.min(y0, ty);
    y1 = Math.max(y1, ty);
  }
  return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

// Smallest enclosing OTHER fill = local backdrop; else the page background
// (guard.py _backdrop).
function backdropColor(path, allFills, pageBg) {
  const r = path.rect;
  let best = null;
  let bestArea = null;
  if (r) {
    for (const q of allFills) {
      if (q === path || !q.rect) continue;
      const qr = q.rect;
      if (qr.x0 <= r.x0 && qr.y0 <= r.y0 && qr.x1 >= r.x1 && qr.y1 >= r.y1) {
        const area = qr.width * qr.height;
        if (bestArea === null || area < bestArea) {
          best = q;
          bestArea = area;
        }
      }
    }
  }
  return best !== null ? best.fill : pageBg;
}

// Per-path eligibility for table inference — THE E-24 guard (guard.py eligible).
// Returns false (drop the path) iff it is a fill-only band larger than
// maxRuleFrac of the page, or a fill-only path that renders invisibly against
// its backdrop. Everything else (strokes, visible coloured fills) is eligible.
function eligible(path, allPaths, pageBg = [1, 1, 1], maxRuleFrac = E24_MAX_RULE_FRAC, pageArea = 595 * 842) {
  const r = path.rect;
  // 1) huge fills (decorative bands) are never rules/cells
  if (pathIsFillOnly(path) && r && r.width * r.height > maxRuleFrac * pageArea) return false;
  // 2) invisible fill (fill == local backdrop, no stroke) → ignore  [the E-24 guard]
  if (pathIsFillOnly(path)) {
    const fills = allPaths.filter(pathIsFillOnly);
    if (colorsEqual(path.fill, backdropColor(path, fills, pageBg))) return false;
  }
  // everything else (strokes, visible coloured fills) is eligible
  return true;
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

async function extractPageGraphics(page, pageH, pageW, OPS) {
  const opList = await page.getOperatorList();
  const fns = opList.fnArray;
  const args = opList.argsArray;
  let ctm = [1, 0, 0, 1, 0, 0];
  let fill = [0, 0, 0]; // GS default fill is black; null marks a pattern/unknown fill
  const stack = [];
  const paths = []; // painted vector paths {type, rect, fill, segs} — the E-24 input list
  const imgs = [];
  let pending = null; // a constructed path awaiting its paint op

  // Finalize the pending path under paint op `type`, capturing the fill colour
  // in effect at paint time. collectPathSegments uses the CTM recorded at
  // CONSTRUCTION time (pre-E-24 behaviour — the path's geometry froze there).
  const finalizePath = (type) => {
    if (!pending) return;
    const segs = [];
    collectPathSegments(pending.pathArgs, pending.ctm, pageH, segs, OPS);
    paths.push({
      type,
      rect: rectFromMinMax(pending.pathArgs[2], pending.ctm, pageH),
      fill: type === 'f' || type === 'fs' ? fill : null,
      segs,
    });
    pending = null;
  };

  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    if (fn === OPS.save) {
      stack.push({ ctm: ctm.slice(), fill });
    } else if (fn === OPS.restore) {
      if (stack.length) {
        const s = stack.pop();
        ctm = s.ctm;
        fill = s.fill;
      }
    } else if (fn === OPS.transform) {
      ctm = matMul(args[i], ctm);
    } else if (fn === OPS.setFillRGBColor) {
      const c = args[i] || [];
      fill = [(c[0] || 0) / 255, (c[1] || 0) / 255, (c[2] || 0) / 255]; // pdfjs normalizes all fill colours here, 0–255
    } else if (fn === OPS.setFillColorN) {
      fill = null; // pattern / shading fill — not a flat colour, so treat as visible
    } else if (fn === OPS.constructPath) {
      // Freeze the CTM at construction time; the paint op below decides the type.
      pending = { pathArgs: args[i], ctm: ctm.slice() };
    } else if (
      fn === OPS.fill || fn === OPS.eoFill ||
      fn === OPS.stroke || fn === OPS.closeStroke ||
      fn === OPS.fillStroke || fn === OPS.eoFillStroke ||
      fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke ||
      fn === OPS.endPath
    ) {
      finalizePath(paintType(fn, OPS));
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
      const a = args[i];
      const objId = Array.isArray(a) ? a[0] : a;
      if (typeof objId === 'string') imgs.push({ objId, ctm: ctm.slice() });
    }
  }

  // E-24: filter the reconstructed path list exactly as the spec filters
  // get_drawings() output — drop every path where eligible() is false — THEN
  // flatten the survivors' segments. detectTablesFromSegments downstream is
  // unchanged; it simply never sees the invisible per-line fills again.
  const pageBg = [1, 1, 1];
  const pageArea = (pageW || 595) * (pageH || 842);
  const segs = [];
  for (const p of paths) {
    if (eligible(p, paths, pageBg, E24_MAX_RULE_FRAC, pageArea)) {
      // E-24b: tag each segment with whether its source path paints visibly. A
      // clip / endPath path (type 'n') yields ruling geometry but no visible
      // mark; only visible rules (strokes, visible fills) may later vouch for a
      // table region. Additive flag — detectTablesFromSegments ignores it.
      const vis = p.type !== 'n';
      for (const s of p.segs) {
        s.vis = vis;
        segs.push(s);
      }
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

// ── E-24b: visible-rule gate for detected tables ─────────────────────────────
// E-24 (the invisible-fill guard above) drops fill-only paths that render
// invisibly. But this exporter also stamps per-line CLIP rectangles (pdfjs
// eoClip + endPath, path type 'n'): they paint NOTHING yet still emit ruling
// segments, and on a page built entirely of them (e.g. Ikansh p.3) they form a
// phantom grid with no invisible-fill for E-24 to catch and non-empty cells for
// E-15 to pass. The structural truth a real table always satisfies: it is drawn
// with at least one VISIBLE rule — a stroke or a visible fill. So after
// detection, require each table region to contain ≥1 visible-rule segment; a
// region ruled only by invisible clips is rejected (its regionLines flow back to
// linesToParagraphs, exactly like the E-15 rejection path).
//
// The signal is visible-rule BACKING, not clip-ness. Clips also co-occur INSIDE
// real tables (vrishin's genuine tables contain clip rectangles alongside their
// drawn black-fill rules), so dropping clips wholesale would delete real tables.
// Keying on "is there a visible rule here" keeps those and kills the pure-clip
// phantom. Segments carry `vis` (set at collection in extractPageGraphics).
const E24B_TOL = 3.0; // pt — region-membership slack, matches the rule-cluster tolerances

// Does an axis-aligned segment lie within a table descriptor's bounding region?
function segInTableRegion(s, d) {
  if (s.horizontal) {
    return s.y >= d.top - E24B_TOL && s.y <= d.bottom + E24B_TOL &&
      s.x2 >= d.left - E24B_TOL && s.x1 <= d.right + E24B_TOL;
  }
  return s.x >= d.left - E24B_TOL && s.x <= d.right + E24B_TOL &&
    s.y2 >= d.top - E24B_TOL && s.y1 <= d.bottom + E24B_TOL;
}

// A detected table region is real only if ≥1 VISIBLE-rule segment falls inside it.
function tableHasVisibleRule(d, segs) {
  for (const s of segs || []) {
    if (s.vis && segInTableRegion(s, d)) return true;
  }
  return false;
}

// ── Mirror P1: image placement (right container, not better coordinates) ──────
// A flat PDF positions every image by absolute coordinates; reproduced as
// floating anchors they DRIFT on reflow (logo gap at the top, footer band
// tinting mid-page text, signature landing on a paragraph). Fix by CONTAINER:
// classify each image by GEOMETRY + cross-page RECURRENCE and route it to the
// structurally correct place — generic, never hardcoded to one report.
//   recurring + near top + ~full width     → Word HEADER (repeats per page)
//   recurring + near bottom + ~full width   → Word FOOTER
//   otherwise (single page / non-band)       → INLINE in document order
// CONDITIONAL: if no band recurs, bandFound=false and the caller leaves every
// image on its pre-P1 floating host attachment — clean reports (no band) render
// exactly as before.
const IMG_POS_TOL = 6; // pt — page-local bbox match tolerance for recurrence

function imageBoxesMatch(a, b, tol = IMG_POS_TOL) {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
}

// Classify page-local image boxes {x,y,w,h,page,pageW,pageH} into placement
// roles. Returns { roles: ('header'|'footer'|'inline')[], bandFound }.
function classifyImagePlacement(boxes, numPages) {
  const groups = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    let g = groups.find((G) => imageBoxesMatch(G.box, b));
    if (!g) { g = { box: b, idxs: [], pages: new Set() }; groups.push(g); }
    g.idxs.push(i);
    g.pages.add(b.page);
  }
  const minRecur = Math.max(2, Math.ceil((numPages || 1) * 0.6)); // "most/all pages"
  const roles = new Array(boxes.length).fill('inline');
  let bandFound = false;
  for (const g of groups) {
    const b = g.box;
    const recurring = g.pages.size >= minRecur;
    const nearTop = b.y <= b.pageH * 0.12;
    const nearBottom = (b.y + b.h) >= b.pageH * 0.88;
    const fullWidth = b.w >= b.pageW * 0.6;
    let role = 'inline';
    if (recurring && fullWidth && nearTop) role = 'header';
    else if (recurring && fullWidth && nearBottom) role = 'footer';
    if (role !== 'inline') bandFound = true;
    for (const i of g.idxs) roles[i] = role;
  }
  return { roles, bandFound };
}

// Float an image on its nearest same-page paragraph (the pre-P1 behaviour, kept
// as the no-band fallback so clean reports render exactly as before).
function attachFloatingToHost(rec) {
  let host = null;
  let bestDist = Infinity;
  for (const para of rec.paras) {
    const d = Math.abs((para._top != null ? para._top : 0) - rec.imgTopPt);
    if (d < bestDist) { bestDist = d; host = para; }
  }
  if (host) host.images.push({ rel_id: rec.relId, wrap_mode: 'behindDoc' });
}

// Route every collected image to header / footer / inline. Mutates `structure`
// (pushes one inline left-aligned image paragraph per non-band image, ordered by
// its y via _sortTop) and returns the media to render in the section header /
// footer. No band detected → preserve the prior floating behaviour for all.
function placeImages(structure, media, imageRecords, numPages) {
  if (imageRecords.length === 0) return { headerMedia: [], footerMedia: [] };
  // pdfjs decodes only some instances of a cross-page-repeated image to bytes
  // (duplicates often resolve null). A bytes-less image can never render, so it
  // must not seed an empty header/footer or a blank inline paragraph.
  const hasBytes = (rec) => !!(media[rec.mediaIndex] && media[rec.mediaIndex].bytes);
  const { roles, bandFound } = classifyImagePlacement(imageRecords.map((r) => r.box), numPages);
  if (!bandFound) {
    for (const rec of imageRecords) attachFloatingToHost(rec);
    return { headerMedia: [], footerMedia: [] };
  }
  const headerMedia = [];
  const footerMedia = [];
  for (let i = 0; i < imageRecords.length; i++) {
    const rec = imageRecords[i];
    const role = roles[i];
    if (role === 'header') {
      if (headerMedia.length === 0 && hasBytes(rec)) headerMedia.push(media[rec.mediaIndex]); // first renderable; Word repeats it
    } else if (role === 'footer') {
      if (footerMedia.length === 0 && hasBytes(rec)) footerMedia.push(media[rec.mediaIndex]);
    } else if (hasBytes(rec)) {
      // inline in document order — its own left-aligned paragraph at the image's y
      structure.push({
        type: 'paragraph',
        runs: [],
        images: [{ rel_id: rec.relId, wrap_mode: 'inline' }],
        _sortTop: rec.sortTop,
        _top: rec.imgTopPt,
        _bottom: rec.imgTopPt + rec.box.h,
        _xLeft: rec.box.x,
        _xRight: rec.box.x + rec.box.w,
        _lineHeight: rec.box.h,
      });
    }
  }
  return { headerMedia, footerMedia };
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
  const imageRecords = []; // Mirror P1 — collected across pages, placed after the loop
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
    const { segs, imgs } = await extractPageGraphics(page, pageH, pageW, OPS);
    const glyphs = await extractPageGlyphs(page, pageH);
    for (const g of glyphs) allGlyphs.push(g);

    const lines = groupGlyphsIntoLines(glyphs);
    const tableDescs = refineTableDescs(detectTablesFromSegments(segs), p - 1);

    const used = new Set();
    const items = [];
    for (const d of tableDescs) {
      // E-24b: reject a region with no visible rule (a phantom grid drawn only
      // from invisible clip rectangles — e.g. Ikansh p.3). regionLines stay
      // UNMARKED in `used`, so they flow to linesToParagraphs via freeLines below.
      if (!tableHasVisibleRule(d, segs)) continue;
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

    // E-6 / Mirror P1: collect each image with its page-local geometry. The
    // renderer emits images only via a block's images[] (resolved through
    // mediaByRel[rel_id]) or the section header/footer, so a PDF image must be
    // routed to one of those. Recurrence is a cross-page signal, so the actual
    // routing (header/footer/inline, or the pre-P1 floating host attachment when
    // no band recurs) is deferred to placeImages() once all pages are seen.
    for (const im of imgs) {
      const bytes = getImageBytes(page, im.objId);
      const relId = `pdfimg${media.length + 1}`;
      const mediaIndex = media.length;
      media.push({
        id: `image${media.length + 1}.png`,
        rel_id: relId,
        part: `page${p}`,
        ext: 'png',
        bytes: bytes || null,
        anchor: imageAnchorFromCtm(im.ctm, pageH),
        wrap_mode: 'behindDoc',
      });
      const imgW = Math.hypot(im.ctm[0], im.ctm[1]);
      const imgH = Math.hypot(im.ctm[2], im.ctm[3]);
      const imgLeft = im.ctm[4];
      const imgTopPt = pageH - (im.ctm[5] + imgH);
      imageRecords.push({
        relId,
        mediaIndex,
        imgTopPt,
        sortTop: imgTopPt + yOffset,
        paras, // this page's paragraph blocks — host candidates for the no-band fallback
        box: { x: imgLeft, y: imgTopPt, w: imgW, h: imgH, page: p, pageW, pageH },
      });
    }

    for (const it of items) structure.push(it);
    yOffset += pageH + 1;
    page.cleanup();
  }

  // Mirror P1 — route images to header / footer / inline (or leave floating when
  // no band recurs). Runs before the sort so inline image paragraphs order in.
  const { headerMedia, footerMedia } = placeImages(structure, media, imageRecords, doc.numPages);

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
    header_media: headerMedia, // Mirror P1 — empty unless a recurring top band was found
    footer_media: footerMedia, // Mirror P1 — empty unless a recurring bottom band was found
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
    // E-25 (text-column alignment via tab stops — the text-side twin of E-24)
    splitLineCells,
    evaluateColumnRun,
    detectColumnarBlocks,
    buildColumnarParagraphs,
    COLALIGN_GAP_EM,
    COLALIGN_MIN_ROWS,
    COLALIGN_SUPPORT_FRAC,
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
    // E-24 (invisible-fill guard — ported from guard.py)
    colorsEqual,
    pathIsFillOnly,
    pathHasStroke,
    paintType,
    rectFromMinMax,
    backdropColor,
    eligible,
    E24_MAX_RULE_FRAC,
    E24_COLOR_TOL,
    // E-24b (visible-rule gate)
    segInTableRegion,
    tableHasVisibleRule,
    E24B_TOL,
    // Mirror P1 (image placement)
    imageBoxesMatch,
    classifyImagePlacement,
    IMG_POS_TOL,
  },
};
