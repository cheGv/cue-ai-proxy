// test/extractPDFGeometry.test.js
//
// Phase E week 1 — PDF-digital geometry extractor. Deterministic unit tests of
// the PURE inference helpers (no pdfjs, no real PDF, no API key — always run).
// The full end-to-end parse of a real Word-exported PDF is exercised in the
// Part C ingestion test against vrishin PT.pdf.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { _internals, extractPDFGeometry } = require('../lib/extractPDFGeometry');

const {
  matMul, applyMatrix, ptToDxa, ptToEmu,
  cleanFontFamily, fontIsBold, fontIsItalic, clusterPositions,
  buildLineRuns, groupGlyphsIntoLines, detectAlignment, indentLeftDxa,
  linesToParagraphs,
  splitLineCells, evaluateColumnRun, detectColumnarBlocks, buildColumnarParagraphs,
  pushSeg, collectPathSegments, detectTablesFromSegments,
  mergeSliverColumns, refineTableDescs,
  indexForBoundary, buildTableBlock, imageAnchorFromCtm, encodePng,
  inferContentArea, buildPageSetup, buildDefaultFont, finalizeBlocks,
  isCellEmpty, computeTableOccupancy, MIN_TABLE_OCCUPANCY,
  colorsEqual, pathIsFillOnly, pathHasStroke, paintType, rectFromMinMax,
  backdropColor, eligible, E24_MAX_RULE_FRAC,
  segInTableRegion, tableHasVisibleRule,
  imageBoxesMatch, classifyImagePlacement,
} = _internals;

// A synthetic glyph in the extractor's internal shape (top-down points).
function glyph(str, xLeft, width, baseTop, size, opts = {}) {
  return {
    str,
    xLeft,
    xRight: xLeft + width,
    baseTop,
    top: baseTop - size * 0.8,
    bottom: baseTop + size * 0.2,
    size,
    sizeHp: Math.max(1, Math.round(size * 2)),
    font: opts.font || 'Arial',
    bold: !!opts.bold,
    italic: !!opts.italic,
  };
}

// ── units ─────────────────────────────────────────────────────────────────────
test('unit conversion: points → DXA (×20) and EMU (×12700)', () => {
  assert.equal(ptToDxa(72), 1440); // 1 inch
  assert.equal(ptToEmu(72), 914400); // 1 inch
  assert.equal(ptToDxa(0), 0);
  assert.equal(ptToEmu(11), 139700);
});

// ── matrices ────────────────────────────────────────────────────────────────
test('applyMatrix: identity, translate, scale', () => {
  assert.deepEqual(applyMatrix([1, 0, 0, 1, 0, 0], 3, 4), [3, 4]);
  assert.deepEqual(applyMatrix([1, 0, 0, 1, 10, 20], 3, 4), [13, 24]);
  assert.deepEqual(applyMatrix([2, 0, 0, 3, 0, 0], 3, 4), [6, 12]);
});

test('matMul: applies m1 first then m2 (scale then translate)', () => {
  const scale = [2, 0, 0, 2, 0, 0];
  const translate = [1, 0, 0, 1, 5, 5];
  const combined = matMul(scale, translate); // scale a point, then translate
  assert.deepEqual(applyMatrix(combined, 1, 1), [7, 7]); // (1,1)→(2,2)→(7,7)
});

// ── fonts ─────────────────────────────────────────────────────────────────────
test('cleanFontFamily strips subset tag + style suffix', () => {
  assert.equal(cleanFontFamily('ABCDEE+Arial-BoldMT'), 'Arial');
  assert.equal(cleanFontFamily('BCDFGH+Calibri'), 'Calibri');
  assert.equal(cleanFontFamily('ArialMT'), 'Arial');
  assert.equal(cleanFontFamily('TimesNewRomanPS-ItalicMT'), 'Times New Roman'); // PS→friendly (E-3)
  assert.equal(cleanFontFamily('TimesNewRomanPSMT'), 'Times New Roman');
  assert.equal(cleanFontFamily(''), null);
});

test('font flag detection from PostScript names', () => {
  assert.equal(fontIsBold('ABCDEE+Arial-BoldMT'), true);
  assert.equal(fontIsBold('Arial-Black'), true);
  assert.equal(fontIsBold('Arial', { fontWeight: 700 }), true);
  assert.equal(fontIsBold('ArialMT'), false);
  assert.equal(fontIsItalic('Times-Italic'), true);
  assert.equal(fontIsItalic('Calibri-Oblique'), true);
  assert.equal(fontIsItalic('ArialMT'), false);
});

// ── clustering ────────────────────────────────────────────────────────────────
test('clusterPositions merges near values, returns means', () => {
  const c = clusterPositions([100, 100.5, 101, 300, 301, 700], 2.5);
  assert.equal(c.length, 3);
  assert.ok(Math.abs(c[0] - 100.5) < 0.6);
  assert.ok(Math.abs(c[1] - 300.5) < 0.6);
  assert.equal(c[2], 700);
});

// ── glyph → line → runs ─────────────────────────────────────────────────────
test('buildLineRuns: split runs on style change, insert space across a gap', () => {
  // "Name:" (bold) then a wide gap then "Asha" (regular)
  const line = buildLineRuns([
    glyph('Name:', 72, 30, 100, 11, { bold: true }),
    glyph('Asha', 140, 25, 100, 11), // gap 140-102=38 ≫ 0.25*11
  ]);
  assert.equal(line.runs.length, 2);
  assert.equal(line.runs[0].bold, true);
  assert.equal(line.runs[0].size, 22); // 11pt → 22 half-points
  assert.equal(line.text, 'Name: Asha');
  assert.equal(line.runs[1].bold, undefined);
});

test('groupGlyphsIntoLines: two baselines → two lines, kept top→bottom', () => {
  const lines = groupGlyphsIntoLines([
    glyph('second', 72, 40, 130, 11),
    glyph('first', 72, 40, 100, 11),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'first');
  assert.equal(lines[1].text, 'second');
  assert.ok(Array.isArray(lines[0].glyphs)); // glyphs retained for table splitting
});

// ── alignment + indent ──────────────────────────────────────────────────────
test('detectAlignment: centered title vs left body', () => {
  const pageW = 595; // A4 pt
  const center = { xLeft: 240, xRight: 355 }; // midpoint ≈ 297 ≈ pageW/2
  assert.equal(detectAlignment(center, pageW, 72, 72), 'center');
  const left = { xLeft: 72, xRight: 200 };
  assert.equal(detectAlignment(left, pageW, 72, 72), undefined);
});

test('indentLeftDxa: ignores sub-6pt jitter, converts real indent', () => {
  assert.equal(indentLeftDxa({ xLeft: 75 }, 72), 0); // 3pt → ignore
  assert.equal(indentLeftDxa({ xLeft: 108 }, 72), 720); // 36pt → 720 DXA
});

// ── paragraph grouping ──────────────────────────────────────────────────────
test('linesToParagraphs: one block per short line (field-per-line template)', () => {
  const mk = (text, baseTop) => Object.assign(
    { baseTop }, buildLineRuns([glyph(text, 72, 60, baseTop, 11)]),
  );
  const blocks = linesToParagraphs([mk('Birth weight: 3.4 kg', 100), mk('Sucking: Achieved', 120)], 595, 72, 72);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
});

test('linesToParagraphs: wrapped continuation folds into one block', () => {
  // A near-full-width first line, then a tight same-indent second line.
  const full = Object.assign({ baseTop: 100 }, buildLineRuns([glyph('x'.repeat(80), 72, 450, 100, 11)]));
  const cont = Object.assign({ baseTop: 113 }, buildLineRuns([glyph('continues here', 72, 70, 113, 11)]));
  const blocks = linesToParagraphs([full, cont], 595, 72, 72);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].runs.length >= 2);
});

// ── E-25: text-column alignment (tab stops, never a table) ────────────────────
// Build real line objects (with .glyphs) the way the pipeline does — synthetic
// shape-equivalents of the fixture rows, same style as the E-15 synthTable shapes.
function gridLines(rows, opts = {}) {
  const size = opts.size || 11;
  const pitch = opts.pitch || 18;
  const glyphs = [];
  rows.forEach((cells, ri) => {
    const baseTop = 100 + ri * pitch;
    for (const c of cells) glyphs.push(glyph(c.t, c.x, c.t.length * 5.5, baseTop, size));
  });
  return groupGlyphsIntoLines(glyphs);
}

test('E-25 splitLineCells: a wide-gap score row → 3 cells; prose & narrow-marker list → 1 cell', () => {
  const [scoreLine] = gridLines([[{ x: 72, t: 'Subtest' }, { x: 290, t: 'Raw' }, { x: 410, t: '9th' }]]);
  assert.equal(splitLineCells(scoreLine).length, 3);
  const [proseLine] = gridLines([[{ x: 72, t: 'This is ordinary prose with normal word spacing' }]]);
  assert.equal(splitLineCells(proseLine).length, 1);
  // a list marker sits ~1 char from its text (narrow) → stays one cell
  const [listLine] = groupGlyphsIntoLines([glyph('1.', 72, 8, 100, 11), glyph('Expand vocabulary', 84, 90, 100, 11)]);
  assert.equal(splitLineCells(listLine).length, 1);
});

test('E-25 detectColumnarBlocks: a borderless score grid (4 rows × 3 aligned cols) → one block', () => {
  const lines = gridLines([
    [{ x: 72, t: 'Subtest' }, { x: 290, t: 'Raw Score' }, { x: 410, t: 'Percentile' }],
    [{ x: 72, t: 'Auditory comprehension' }, { x: 290, t: '18' }, { x: 410, t: '9th' }],
    [{ x: 72, t: 'Expressive communication' }, { x: 290, t: '14' }, { x: 410, t: '5th' }],
    [{ x: 72, t: 'Total language' }, { x: 290, t: '16' }, { x: 410, t: '6th' }],
  ]);
  const blocks = detectColumnarBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].colXs.length, 3);
  assert.equal(blocks[0].rows.length, 4);
});

test('E-25 evaluateColumnRun: 3 aligned rows pass, returns the column means', () => {
  const lines = gridLines([
    [{ x: 72, t: 'Aa' }, { x: 290, t: 'Bb' }],
    [{ x: 72, t: 'Cc' }, { x: 290, t: 'Dd' }],
    [{ x: 72, t: 'Ee' }, { x: 290, t: 'Ff' }],
  ]);
  const ev = evaluateColumnRun(lines.map((ln) => ({ line: ln, cells: splitLineCells(ln) })));
  assert.ok(ev);
  assert.equal(ev.colXs.length, 2);
  assert.ok(Math.abs(ev.colXs[0] - 72) < 1 && Math.abs(ev.colXs[1] - 290) < 1);
});

test('E-25 anti-phantom: a label:value demographics block is NOT columnized', () => {
  const lines = gridLines([
    [{ x: 72, t: 'Name of child: Asha' }, { x: 320, t: 'Date of Assessment: 02.06' }],
    [{ x: 72, t: 'Date of Birth: 14.09.2021' }, { x: 320, t: 'Age/Gender: 4Y/M' }],
    [{ x: 72, t: 'Clinician: Riya Sharma' }, { x: 320, t: 'Languages: English' }],
  ]);
  assert.equal(detectColumnarBlocks(lines).length, 0); // label:value form, not a data grid
});

test('E-25 anti-phantom: a numbered list (forced into two cells) is rejected by the marker rule', () => {
  // even when a wide gap splits marker from text, a list must not become columns
  const lines = gridLines([
    [{ x: 72, t: '1.' }, { x: 290, t: 'Continue weekly therapy' }],
    [{ x: 72, t: '2.' }, { x: 290, t: 'Introduce AAC core board' }],
    [{ x: 72, t: '3.' }, { x: 290, t: 'Parent coaching at home' }],
  ]);
  assert.equal(detectColumnarBlocks(lines).length, 0);
});

test('E-25 anti-phantom: fewer than 3 consecutive rows is never a column block', () => {
  const lines = gridLines([
    [{ x: 72, t: 'Subtest' }, { x: 290, t: 'Score' }],
    [{ x: 72, t: 'Naming' }, { x: 290, t: '12' }],
  ]);
  assert.equal(detectColumnarBlocks(lines).length, 0);
});

test('E-25 anti-phantom: misaligned columns (high cross-row variance) are rejected', () => {
  // col-2 wanders (290 / 312 / 334): no shared boundary in ≥75% of rows → not a grid
  const lines = gridLines([
    [{ x: 72, t: 'Alpha' }, { x: 290, t: 'one' }],
    [{ x: 72, t: 'Bravo' }, { x: 312, t: 'two' }],
    [{ x: 72, t: 'Charlie' }, { x: 334, t: 'three' }],
  ]);
  assert.equal(detectColumnarBlocks(lines).length, 0);
});

test('E-25 linesToParagraphs: a score grid becomes tab-aligned paragraphs (tab runs + left tab stops, NO table)', () => {
  const lines = gridLines([
    [{ x: 72, t: 'Subtest' }, { x: 290, t: 'Raw Score' }, { x: 410, t: 'Percentile' }],
    [{ x: 72, t: 'Auditory comprehension' }, { x: 290, t: '18' }, { x: 410, t: '9th' }],
    [{ x: 72, t: 'Expressive communication' }, { x: 290, t: '14' }, { x: 410, t: '5th' }],
  ]);
  const blocks = linesToParagraphs(lines, 595, 72, 72); // marginLeft = 72 (= col 1)
  assert.equal(blocks.length, 3);
  assert.equal(blocks.every((b) => b.type === 'paragraph'), true); // never a table
  for (const b of blocks) {
    assert.ok(Array.isArray(b.tabStops) && b.tabStops.length === 2, 'two tab stops for three columns');
    assert.deepEqual(b.tabStops.map((t) => t.position), [ptToDxa(290 - 72), ptToDxa(410 - 72)]);
    assert.equal(b.tabStops.every((t) => t.type === 'left'), true);
    assert.equal(b.runs.filter((r) => r.tab).length, 2, 'two tab runs between three cells');
  }
  const headerText = blocks[0].runs.map((r) => (r.tab ? '\t' : r.text)).join('');
  assert.equal(headerText, 'Subtest\tRaw Score\tPercentile');
});

test('E-25 buildColumnarParagraphs: indented first column → indent.left; tab stops measured from margin', () => {
  const lines = gridLines([
    [{ x: 120, t: 'Alpha' }, { x: 300, t: 'one' }],
    [{ x: 120, t: 'Bravo' }, { x: 300, t: 'two' }],
    [{ x: 120, t: 'Charlie' }, { x: 300, t: 'three' }],
  ]);
  const [block] = detectColumnarBlocks(lines);
  assert.ok(block);
  const paras = buildColumnarParagraphs(block, 72); // margin 72; col 1 at 120 → 48pt indent
  assert.equal(paras.length, 3);
  assert.deepEqual(paras[0].indent, { left: ptToDxa(120 - 72) });
  assert.deepEqual(paras[0].tabStops.map((t) => t.position), [ptToDxa(300 - 72)]);
  assert.equal(paras[0].runs.filter((r) => r.tab).length, 1);
});

// ── segments ──────────────────────────────────────────────────────────────────
test('pushSeg classifies axis-aligned segments, drops diagonals', () => {
  const segs = [];
  pushSeg(segs, 10, 50, 200, 50); // horizontal
  pushSeg(segs, 10, 50, 10, 300); // vertical
  pushSeg(segs, 10, 50, 200, 300); // diagonal → dropped
  assert.equal(segs.length, 2);
  assert.equal(segs[0].horizontal, true);
  assert.equal(segs[1].vertical, true);
});

test('collectPathSegments: a rectangle becomes 4 edges under CTM', () => {
  const OPS = { moveTo: 1, lineTo: 2, curveTo: 3, curveTo2: 4, curveTo3: 5, rectangle: 6, closePath: 7 };
  const segs = [];
  // rectangle at (100,600) w=200 h=20 in PDF coords; identity CTM; page H=792
  collectPathSegments([[OPS.rectangle], [100, 600, 200, 20]], [1, 0, 0, 1, 0, 0], 792, segs, OPS);
  const H = segs.filter((s) => s.horizontal);
  const V = segs.filter((s) => s.vertical);
  assert.equal(H.length, 2);
  assert.equal(V.length, 2);
});

// ── table detection ─────────────────────────────────────────────────────────
test('detectTablesFromSegments: a 2×2 grid yields 3 row + 3 col boundaries', () => {
  const segs = [];
  // 3 horizontal rules at y = 100,130,160 spanning x 72..272
  for (const y of [100, 130, 160]) segs.push({ horizontal: true, y, x1: 72, x2: 272, len: 200 });
  // 3 vertical rules at x = 72,172,272 spanning y 100..160
  for (const x of [72, 172, 272]) segs.push({ vertical: true, x, y1: 100, y2: 160, len: 60 });
  const tables = detectTablesFromSegments(segs);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowYs.length, 3); // 2 rows
  assert.equal(tables[0].colXs.length, 3); // 2 cols
});

test('detectTablesFromSegments: stacked tables >140pt apart split into two', () => {
  const segs = [];
  for (const y of [100, 130]) segs.push({ horizontal: true, y, x1: 72, x2: 272, len: 200 });
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 100, y2: 130, len: 30 });
  for (const y of [400, 430]) segs.push({ horizontal: true, y, x1: 72, x2: 472, len: 400 });
  for (const x of [72, 472]) segs.push({ vertical: true, x, y1: 400, y2: 430, len: 30 });
  const tables = detectTablesFromSegments(segs);
  assert.equal(tables.length, 2);
});

// E-13: a >140pt horizontal-rule gap with ≥2 vertical rules connecting prev
// band's bottom to the next h-rule cluster is the empty interior of ONE table
// (header rect + data rect sharing column rules), not a band split.
test('detectTablesFromSegments: continuing vertical rules across the gap merge bands into one table (E-13)', () => {
  const segs = [];
  // header band: h-rules at y=100, 130 (small header row)
  for (const y of [100, 130]) segs.push({ horizontal: true, y, x1: 72, x2: 272, len: 200 });
  // box-bottom singleton h-rule at y=430 — gap 130→430 is 300pt, exceeds 140pt threshold
  segs.push({ horizontal: true, y: 430, x1: 72, x2: 272, len: 200 });
  // continuous left + right verticals span y=100..430 (across the gap)
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 100, y2: 430, len: 330 });
  const tables = detectTablesFromSegments(segs);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowYs.length, 3); // header top, header bottom, box bottom
  assert.equal(tables[0].colXs.length, 2);
});

// E-13 threshold guard: a SINGLE connecting vertical rule is below the ≥2
// threshold (could be a stray divider, not a table connection). Bands stay split.
test('detectTablesFromSegments: a single connecting vertical rule does NOT merge bands (E-13 threshold)', () => {
  const segs = [];
  for (const y of [100, 130]) segs.push({ horizontal: true, y, x1: 72, x2: 272, len: 200 });
  segs.push({ horizontal: true, y: 430, x1: 72, x2: 272, len: 200 });
  // band-local header verticals (y1=100, y2=130) — do not connect to next h-cluster
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 100, y2: 130, len: 30 });
  // ONLY ONE connecting vertical at x=170 spans the gap — below threshold
  segs.push({ vertical: true, x: 170, y1: 100, y2: 430, len: 330 });
  const tables = detectTablesFromSegments(segs);
  // no merge → header band survives as a 1-row table; box-bottom singleton dropped (length=1)
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowYs.length, 2); // header band only
});

// E-13 SEAL guard: when an E-13 merge correctly extends the linguistic-style
// band down to a singleton box-bottom, the next close h-rule (within the
// 140pt small-gap branch) must NOT be absorbed into the same band — it belongs
// to the next, physically-adjacent table. Vrishin failure mode: linguistic box
// bottom at y=400 followed by test-material rule at y=420 (gap 20pt) was being
// glued into the linguistic table, swallowing the next 11 rows.
test('detectTablesFromSegments: small-gap rules past an E-13-confirmed bottom seal the band (E-13 seal)', () => {
  const segs = [];
  // table A — header h-rules at y=100, 130 + box-bottom singleton at y=400
  for (const y of [100, 130]) segs.push({ horizontal: true, y, x1: 72, x2: 272, len: 200 });
  segs.push({ horizontal: true, y: 400, x1: 72, x2: 272, len: 200 });
  // table A header rect verticals
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 100, y2: 130, len: 30 });
  // table A data rect verticals (y1≈prev band bottom, y2≈next h-cluster) — fire E-13
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 130, y2: 400, len: 270 });
  // table B starts immediately below (small gap from 400 to 420) — UNRELATED table
  for (const y of [420, 450, 480]) segs.push({ horizontal: true, y, x1: 50, x2: 300, len: 250 });
  // table B verticals at different x positions (not part of table A's column set)
  for (const x of [50, 300]) segs.push({ vertical: true, x, y1: 420, y2: 480, len: 60 });
  const tables = detectTablesFromSegments(segs);
  // Expected: 2 tables. Table A merged via E-13 (3 rules: 100, 130, 400).
  // Table B is its own band (3 rules: 420, 450, 480) — NOT absorbed.
  assert.equal(tables.length, 2);
  assert.equal(tables[0].rowYs.length, 3); // table A: header + data row
  assert.equal(tables[1].rowYs.length, 3); // table B: 2 data rows
});

// E-13 multi-section guard: a tall ruled table with MULTIPLE E-13 transitions
// (header → mid-data row → bottom-data row, each section its own stroked
// rectangle with verticals matching the section's top + bottom) must stay ONE
// table. tableBottomY must UPDATE on each successive E-13 merge — the seal must
// not fire prematurely while E-13 keeps confirming further-down extensions.
test('detectTablesFromSegments: tall multi-section table with successive E-13 transitions stays one table (E-13 no premature seal)', () => {
  const segs = [];
  // h-rules at every section boundary: 100 (header top), 130 (header bottom),
  // 400 (mid-data bottom), 700 (bottom-data bottom). Gaps: 30, 270, 300 — the
  // two ≥140pt gaps trigger E-13 checks, both of which must merge.
  for (const y of [100, 130, 400, 700]) segs.push({ horizontal: true, y, x1: 72, x2: 272, len: 200 });
  // Header rect's left+right verticals (y=100..130)
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 100, y2: 130, len: 30 });
  // Mid-data rect's verticals (y=130..400) — connect prev band's bottom (130)
  // to next h-rule (400)
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 130, y2: 400, len: 270 });
  // Bottom-data rect's verticals (y=400..700) — connect new prev bottom (400)
  // to next h-rule (700)
  for (const x of [72, 272]) segs.push({ vertical: true, x, y1: 400, y2: 700, len: 300 });
  const tables = detectTablesFromSegments(segs);
  // Expected: ONE table with 4 row boundaries → 3 rows (header + 2 data rows).
  // If the seal fired prematurely after the first E-13 merge, we'd see 2+ tables.
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowYs.length, 4);
  assert.equal(tables[0].colXs.length, 2);
});

test('indexForBoundary maps a value to its band', () => {
  const b = [100, 130, 160];
  assert.equal(indexForBoundary(b, 115), 0);
  assert.equal(indexForBoundary(b, 145), 1);
  assert.equal(indexForBoundary(b, 999), -1);
});

test('buildTableBlock: glyphs bucket into the right cells', () => {
  const desc = { top: 100, bottom: 160, left: 72, right: 272, rowYs: [100, 130, 160], colXs: [72, 172, 272] };
  // four cells: (NAME:|AGE:) over (Asha|6y)
  const lines = groupGlyphsIntoLines([
    glyph('NAME:', 80, 40, 118, 11),
    glyph('AGE:', 180, 35, 118, 11),
    glyph('Asha', 80, 30, 148, 11),
    glyph('6y', 180, 20, 148, 11),
  ]);
  const tbl = buildTableBlock(desc, lines);
  assert.equal(tbl.type, 'table');
  assert.equal(tbl.grid.length, 2);
  assert.equal(tbl.rows.length, 2);
  const cellText = (r, c) => tbl.rows[r].cells[c].content.map((p) => (p.runs || []).map((x) => x.text).join('')).join('');
  assert.equal(cellText(0, 0), 'NAME:');
  assert.equal(cellText(0, 1), 'AGE:');
  assert.equal(cellText(1, 0), 'Asha');
  assert.equal(cellText(1, 1), '6y');
  assert.ok(tbl.borders.insideH); // drawn rules → single borders
});

// ── table-detection refinement (calibration) ─────────────────────────────────
test('mergeSliverColumns: drops a too-narrow trailing column, keeps real ones', () => {
  assert.deepEqual(mergeSliverColumns([0, 509, 586, 595]), [0, 509, 595]); // 9pt sliver → right edge
  assert.deepEqual(mergeSliverColumns([0, 100, 200]), [0, 100, 200]); // all real → unchanged
  assert.deepEqual(mergeSliverColumns([0, 5, 100, 200]), [0, 100, 200]); // leading 5pt sliver merged
});

test('refineTableDescs: drops single-column boxes and the page-1 header band', () => {
  const oneCol = { top: 300, colXs: [0, 200], rowYs: [300, 320] };
  const headerBand = { top: 10, colXs: [0, 100, 200, 300], rowYs: [10, 40] };
  const body = { top: 300, colXs: [0, 100, 200, 300], rowYs: [300, 340] };
  // page 0: single-col dropped, header-band dropped, body kept
  const keptP0 = refineTableDescs([oneCol, headerBand, body], 0);
  assert.equal(keptP0.length, 1);
  assert.equal(keptP0[0].colXs.length, 4); // body table survives with its columns
  // page 1: header-band rule does NOT apply (only page 0)
  const keptP1 = refineTableDescs([headerBand], 1);
  assert.equal(keptP1.length, 1);
});

// ── E-15: content-occupancy test for detected tables ────────────────────────
// A grid built from rules is a table only if a meaningful fraction of its
// cells contain text glyphs. Empty grids are decorative artifacts. The
// occupancy test happens AFTER buildTableBlock (which is the easy
// post-bucketing inspection point); below threshold → descriptor discarded,
// regionLines flow to linesToParagraphs.

// Tiny helper to synthesize a table block with selective cell content.
function synthTable(rows, cols, fillFn) {
  return {
    type: 'table',
    grid: Array.from({ length: cols }, () => 1000),
    rows: Array.from({ length: rows }, (_, r) => ({
      cells: Array.from({ length: cols }, (_, c) => {
        const t = fillFn(r, c);
        return {
          content: [{ type: 'paragraph', runs: t ? [{ text: t }] : [], images: [] }],
          width: 1000,
        };
      }),
    })),
  };
}

test('E-15 isCellEmpty: detects empty runs vs whitespace vs real text', () => {
  assert.equal(isCellEmpty({ content: [{ type: 'paragraph', runs: [] }] }), true);
  assert.equal(isCellEmpty({ content: [{ type: 'paragraph', runs: [{ text: '' }] }] }), true);
  assert.equal(isCellEmpty({ content: [{ type: 'paragraph', runs: [{ text: '   ' }] }] }), true);
  assert.equal(isCellEmpty({ content: [{ type: 'paragraph', runs: [{ text: 'x' }] }] }), false);
  assert.equal(isCellEmpty({}), true); // missing content
});

test('E-15 computeTableOccupancy: ratio across all cells', () => {
  // All-filled 3×3 → 1.0
  assert.equal(computeTableOccupancy(synthTable(3, 3, () => 'x')), 1);
  // All-empty 3×3 → 0
  assert.equal(computeTableOccupancy(synthTable(3, 3, () => null)), 0);
  // 1 of 9 filled → ~0.111
  const t = synthTable(3, 3, (r, c) => (r === 0 && c === 0) ? 'x' : null);
  const occ = computeTableOccupancy(t);
  assert.ok(Math.abs(occ - 1 / 9) < 1e-9, `occ=${occ}`);
});

test('E-15 phantom-grid rejection: 37×13 grid with ~30 filled (Ikansh b3 shape) → BELOW threshold', () => {
  // Ikansh's worst false table was 37 rows × 13 cols (481 cells) with ~30
  // cells filled (~6.2% occupancy). Threshold is 0.08, so this must reject.
  // Distribute 30 fills evenly so the test is shape-equivalent, not data-equivalent.
  let placed = 0;
  const tbl = synthTable(37, 13, () => {
    if (placed < 30) { placed++; return 'x'; }
    return null;
  });
  const occ = computeTableOccupancy(tbl);
  assert.ok(occ < MIN_TABLE_OCCUPANCY,
    `occupancy=${(occ * 100).toFixed(2)}% should be below threshold ${MIN_TABLE_OCCUPANCY * 100}%`);
});

test('E-15 real-table acceptance: 10×3 grid with 10 filled (Vrishin test-material shape) → ABOVE threshold', () => {
  // Vrishin test-material is 10 rows × 3 cols (30 cells) with ~10 filled
  // in the middle column (~33% occupancy). Must be kept.
  const tbl = synthTable(10, 3, (r, c) => c === 1 ? `row ${r}` : null);
  const occ = computeTableOccupancy(tbl);
  assert.ok(occ >= MIN_TABLE_OCCUPANCY,
    `occupancy=${(occ * 100).toFixed(2)}% should be above threshold ${MIN_TABLE_OCCUPANCY * 100}%`);
});

test('E-15 real-table acceptance: 2×2 header+data (Vrishin linguistic shape) → ABOVE threshold', () => {
  // Vrishin linguistic table (post-E-13): 2 rows × 4 cols with content in
  // cells (header row: c1, c2; data row: c1, c2) → 4/8 = 50% occupancy.
  const tbl = synthTable(2, 4, (r, c) => (c === 1 || c === 2) ? 'x' : null);
  const occ = computeTableOccupancy(tbl);
  assert.ok(occ >= MIN_TABLE_OCCUPANCY,
    `occupancy=${(occ * 100).toFixed(2)}% should be above threshold ${MIN_TABLE_OCCUPANCY * 100}%`);
});

test('E-15 boundary: empty descriptor (no rows) defaults to occupancy=1 (no spurious reject)', () => {
  // A zero-cell descriptor shouldn't be rejected by the occupancy test —
  // refineTableDescs already drops nonsensical descriptors upstream.
  assert.equal(computeTableOccupancy({ rows: [] }), 1);
  assert.equal(computeTableOccupancy({}), 1);
});

// ── image anchor + encode ─────────────────────────────────────────────────────
test('imageAnchorFromCtm: scale+translate → EMU anchor (top-down)', () => {
  // image 100pt wide, 50pt tall, drawn with bottom-left at (200,700) on a 792pt page
  const anchor = imageAnchorFromCtm([100, 0, 0, 50, 200, 700], 792);
  assert.equal(anchor.width, ptToEmu(100));
  assert.equal(anchor.height, ptToEmu(50));
  assert.equal(anchor.x, ptToEmu(200));
  assert.equal(anchor.y, ptToEmu(792 - 750)); // top-down top = 792 - (700+50)
});

test('encodePng: RGB bitmap re-encodes to a valid PNG buffer', () => {
  // 2×1 RGB: red, green
  const data = Uint8Array.from([255, 0, 0, 0, 255, 0]);
  const buf = encodePng({ data, width: 2, height: 1, kind: 2 });
  assert.ok(Buffer.isBuffer(buf));
  // PNG signature
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(encodePng({ data: null, width: 0, height: 0, kind: 2 }), null);
});

// ── page setup + stats ────────────────────────────────────────────────────────
test('buildPageSetup: A4 portrait, margins from text extents only', () => {
  const glyphs = [glyph('top-left', 72, 80, 80, 11), glyph('bottom', 72, 80, 760, 11)];
  const ps = buildPageSetup(glyphs, 595, 842); // A4 pt
  assert.equal(ps.orientation, 'portrait');
  assert.equal(ps.width, ptToDxa(595));
  assert.ok(ps.margins.left > 0 && ps.margins.top > 0);
});

test('buildDefaultFont: returns the modal family + size (by glyph weight)', () => {
  const df = buildDefaultFont([
    glyph('aaaaaa', 0, 10, 0, 11),
    glyph('bbbbbb', 0, 10, 20, 11),
    glyph('X', 0, 10, 40, 18, { font: 'Heading' }),
  ]);
  assert.equal(df.family, 'Arial');
  assert.equal(df.size, 22);
});

test('inferContentArea: bounding box over glyphs', () => {
  const a = inferContentArea([glyph('a', 72, 50, 100, 11), glyph('b', 200, 50, 300, 11)], 595, 842);
  assert.equal(a.left, 72);
  assert.equal(a.right, 250);
});

// ── finalize ──────────────────────────────────────────────────────────────────
test('finalizeBlocks: adds _bbox + _inferred, spacing.after, strips temps', () => {
  const structure = [
    { type: 'paragraph', runs: [{ text: 'A' }], images: [], _top: 100, _bottom: 111, _xLeft: 72, _xRight: 120, _lineHeight: 11, _sortTop: 100 },
    { type: 'paragraph', runs: [{ text: 'B' }], images: [], _top: 160, _bottom: 171, _xLeft: 72, _xRight: 120, _lineHeight: 11, _sortTop: 160 },
  ];
  finalizeBlocks(structure);
  assert.equal(structure[0]._inferred, true);
  assert.ok(structure[0]._bbox && typeof structure[0]._bbox.x === 'number');
  assert.ok(structure[0].spacing && structure[0].spacing.after > 0); // gap 160-111 ≫ leading
  assert.equal(structure[0]._top, undefined); // temp stripped
  assert.equal(structure[1].spacing, undefined); // last block: no next → no spacing
});

// ── export surface ────────────────────────────────────────────────────────────
test('extractPDFGeometry is exported as an async function', () => {
  assert.equal(typeof extractPDFGeometry, 'function');
  assert.equal(extractPDFGeometry.constructor.name, 'AsyncFunction');
});

// ── E-24: invisible-fill guard (ported from guard.py) ─────────────────────────
// E-15 catches phantom grids whose CELLS are empty. E-24 catches the other kind:
// the DOCX→PDF exporter stamps a white rectangle behind every text line, so the
// phantom cells are NOT empty (text sits in them) and survive E-15. The guard
// kills them at the path, before any segment reaches detectTablesFromSegments.
// Same methodology as the E-15 tests: synthetic, shape-equivalent inputs through
// the pure helpers (no pdfjs, no real PDF needed).

// A fake OPS enum (only the paint ops paintType reads) for the type-mapping test.
const E24_OPS = {
  fill: 22, eoFill: 23, stroke: 20, closeStroke: 21,
  fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27,
  endPath: 28,
};

// Build a rectangular path in the exact shape extractPageGraphics produces:
// {type, rect (top-down pts), fill (0–1 RGB or null), segs (axis-aligned edges)}.
// Segments are emitted via the real pushSeg so the table-detection contrast is
// driven only by the guard, not by a hand-rolled segment shape.
function rectPath(type, x0, y0, x1, y1, fill) {
  const segs = [];
  pushSeg(segs, x0, y0, x1, y0); // top
  pushSeg(segs, x0, y1, x1, y1); // bottom
  pushSeg(segs, x0, y0, x0, y1); // left
  pushSeg(segs, x1, y0, x1, y1); // right
  return { type, rect: { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 }, fill: fill || null, segs };
}

// The post-walk half of extractPageGraphics: filter paths through eligible(),
// then flatten the survivors' segments — exactly what now feeds table detection.
function eligibleSegs(paths, pageBg = [1, 1, 1], pageArea = 595 * 842) {
  const segs = [];
  for (const p of paths) {
    if (eligible(p, paths, pageBg, E24_MAX_RULE_FRAC, pageArea)) {
      for (const s of p.segs) segs.push(s);
    }
  }
  return segs;
}

test('E-24 colorsEqual: tolerant white match, rejects off-white and null', () => {
  assert.equal(colorsEqual([1, 1, 1], [1, 1, 1]), true);
  assert.equal(colorsEqual([1, 1, 1], [0.99, 1, 1]), true); // within 0.02 tol
  assert.equal(colorsEqual([1, 1, 1], [0.9, 0.9, 0.9]), false); // light grey ≠ white
  assert.equal(colorsEqual(null, [1, 1, 1]), false); // unknown fill never matches
  assert.equal(colorsEqual([1, 1, 1], null), false);
});

test('E-24 type predicates: fill-only vs has-stroke', () => {
  assert.equal(pathIsFillOnly({ type: 'f' }), true);
  assert.equal(pathIsFillOnly({ type: 'fs' }), false);
  assert.equal(pathIsFillOnly({ type: 's' }), false);
  assert.equal(pathHasStroke({ type: 's' }), true);
  assert.equal(pathHasStroke({ type: 'fs' }), true);
  assert.equal(pathHasStroke({ type: 'f' }), false);
});

test('E-24 paintType maps pdfjs paint ops to f / s / fs / n', () => {
  assert.equal(paintType(E24_OPS.fill, E24_OPS), 'f');
  assert.equal(paintType(E24_OPS.eoFill, E24_OPS), 'f');
  assert.equal(paintType(E24_OPS.stroke, E24_OPS), 's');
  assert.equal(paintType(E24_OPS.closeStroke, E24_OPS), 's');
  assert.equal(paintType(E24_OPS.fillStroke, E24_OPS), 'fs');
  assert.equal(paintType(E24_OPS.closeEOFillStroke, E24_OPS), 'fs');
  assert.equal(paintType(E24_OPS.endPath, E24_OPS), 'n'); // clip / no-op → passes through
});

test('E-24 rectFromMinMax: minMax → top-down rect under CTM; non-finite → null', () => {
  // identity CTM, page H=792: PDF box [100,600]..[300,620] flips to top-down y.
  const r = rectFromMinMax([100, 600, 300, 620], [1, 0, 0, 1, 0, 0], 792);
  assert.equal(r.x0, 100);
  assert.equal(r.x1, 300);
  assert.equal(r.y0, 792 - 620);
  assert.equal(r.y1, 792 - 600);
  assert.equal(r.width, 200);
  assert.equal(r.height, 20);
  // a path that opened with a curve carries a non-finite minMax → null rect
  assert.equal(rectFromMinMax([Infinity, Infinity, -Infinity, -Infinity], [1, 0, 0, 1, 0, 0], 792), null);
});

test('E-24 backdropColor: smallest enclosing fill, else page background', () => {
  const big = rectPath('f', 0, 0, 500, 700, [0, 0, 1]);       // blue, encloses all
  const mid = rectPath('f', 50, 50, 300, 300, [0, 1, 0]);     // green, encloses small
  const small = rectPath('f', 100, 100, 200, 150, [1, 1, 1]); // white, inside both
  const fills = [big, mid, small];
  // small's backdrop is the SMALLEST enclosing OTHER fill → green, not blue
  assert.deepEqual(backdropColor(small, fills, [1, 1, 1]), [0, 1, 0]);
  // big encloses nothing else → backdrop is the page background
  assert.deepEqual(backdropColor(big, fills, [1, 1, 1]), [1, 1, 1]);
});

test('E-24 eligible: drops invisible white-on-white fill, keeps visible + stroked', () => {
  const whiteOnPage = rectPath('f', 100, 100, 200, 130, [1, 1, 1]);
  const colouredFill = rectPath('f', 100, 200, 200, 230, [0.2, 0.4, 0.8]);
  const strokeRule = rectPath('s', 100, 300, 200, 330, null);
  const all = [whiteOnPage, colouredFill, strokeRule];
  assert.equal(eligible(whiteOnPage, all), false); // invisible → dropped (E-24)
  assert.equal(eligible(colouredFill, all), true);  // visible colour → kept
  assert.equal(eligible(strokeRule, all), true);    // stroke → always kept
});

test('E-24 eligible: a fill bigger than half the page is a decorative band → dropped', () => {
  const pageArea = 595 * 842;
  const band = rectPath('f', 0, 0, 595, 600, [0.95, 0.95, 0.95]); // > 50% page, visible grey
  assert.equal(eligible(band, [band], [1, 1, 1], 0.5, pageArea), false);
  const rule = rectPath('f', 0, 0, 200, 20, [0.95, 0.95, 0.95]); // same grey, modest size
  assert.equal(eligible(rule, [rule], [1, 1, 1], 0.5, pageArea), true);
});

test('E-24 eligible: white fill on a COLOURED backdrop is visible → kept', () => {
  const card = rectPath('f', 50, 50, 400, 400, [0.1, 0.2, 0.5]);    // navy card
  const whiteBox = rectPath('f', 100, 100, 300, 130, [1, 1, 1]);    // white box on navy
  assert.equal(eligible(whiteBox, [card, whiteBox]), true); // backdrop navy ≠ white → visible
  // and a fill matching its coloured backdrop IS invisible → dropped
  const sameOnCard = rectPath('f', 100, 100, 300, 130, [0.1, 0.2, 0.5]);
  assert.equal(eligible(sameOnCard, [card, sameOnCard]), false);
});

// The 3-col × 4-row layout of white per-line fills that defeated E-15 on Ikansh.
function phantomWhiteGrid() {
  const cols = [72, 172, 272, 372]; // 3 columns, 100pt each (≥ MIN_COL_PT)
  const rows = [100, 130, 160, 190, 220]; // 4 rows, 30pt each
  const paths = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) {
      paths.push(rectPath('f', cols[c], rows[r], cols[c + 1], rows[r + 1], [1, 1, 1]));
    }
  }
  return paths;
}

test('E-24 Inside Out (Ikansh): white per-line fills ARE misread as a table WITHOUT the guard', () => {
  // Control — the pre-E-24 behaviour: every path's segments reach detection.
  const rawSegs = phantomWhiteGrid().flatMap((p) => p.segs);
  const tables = detectTablesFromSegments(rawSegs);
  assert.equal(tables.length, 1, 'unguarded white-fill grid is misread as a table');
  assert.ok(tables[0].rowYs.length >= 3 && tables[0].colXs.length >= 3);
});

test('E-24 Inside Out (Ikansh): the guard drops every invisible fill → phantom table is gone', () => {
  const segs = eligibleSegs(phantomWhiteGrid()); // filter → flatten (what extractPageGraphics now feeds)
  assert.equal(segs.length, 0, 'all white-on-white fills dropped → zero segments survive');
  assert.deepEqual(detectTablesFromSegments(segs), [], 'no phantom table inferred');
});

test('E-24 Vrushali (clean text report): no fill-only invisible paths → guard is a no-op', () => {
  assert.deepEqual(eligibleSegs([]), []); // no vector content at all → no-op
  // a report whose only vector marks are visible stroked rules (header/footer
  // underlines): the guard must touch nothing — same segment count in and out.
  const strokes = [rectPath('s', 72, 80, 520, 82, null), rectPath('s', 72, 740, 520, 742, null)];
  const rawCount = strokes.flatMap((p) => p.segs).length;
  assert.equal(eligibleSegs(strokes).length, rawCount, 'no stroke dropped (no-op)');
  assert.deepEqual(detectTablesFromSegments(eligibleSegs(strokes)), [], 'two underlines are not a table');
});

test('E-24 real bordered table: stroked rules are all eligible → table still inferred', () => {
  // Same geometry as the phantom grid, but drawn as STROKES rather than fills.
  const cols = [72, 172, 272, 372];
  const rows = [100, 130, 160, 190, 220];
  const paths = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) {
      paths.push(rectPath('s', cols[c], rows[r], cols[c + 1], rows[r + 1], null));
    }
  }
  const segs = eligibleSegs(paths);
  assert.equal(segs.length, paths.flatMap((p) => p.segs).length, 'no stroked rule dropped');
  const tables = detectTablesFromSegments(segs);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].colXs.length, 4); // 3 columns survive
  assert.equal(tables[0].rowYs.length, 5); // 4 rows survive
});

test('E-24 real table with white cell fills: fills drop, stroked rules keep the table', () => {
  // The hardest case: a genuine bordered table whose cells ALSO carry white
  // background fills. The fills are invisible (dropped); the stroked rules that
  // actually define the table survive, so the table is still inferred.
  const cols = [72, 172, 272, 372];
  const rows = [100, 130, 160, 190, 220];
  const paths = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) {
      paths.push(rectPath('f', cols[c], rows[r], cols[c + 1], rows[r + 1], [1, 1, 1])); // white cell bg
      paths.push(rectPath('s', cols[c], rows[r], cols[c + 1], rows[r + 1], null));       // stroked border
    }
  }
  const segs = eligibleSegs(paths);
  const strokeSegCount = paths.filter((p) => p.type === 's').flatMap((p) => p.segs).length;
  assert.equal(segs.length, strokeSegCount, 'only stroked rules survive; white cell fills dropped');
  const tables = detectTablesFromSegments(segs);
  assert.equal(tables.length, 1, 'the real table is still inferred from its rules');
  assert.equal(tables[0].colXs.length, 4);
});

// ── E-24b: visible-rule gate ──────────────────────────────────────────────────
// E-24 drops invisible FILLS; E-24b rejects a detected table region backed by NO
// visible rule — the per-line CLIP rectangles that paint nothing yet still rule a
// grid (Ikansh p.3, which defeats E-24 (no fill) and E-15 (cells non-empty)). The
// signal is visible-rule BACKING, not clip-ness: clips also live inside real
// tables, so a visible stroke/fill anywhere in the region vouches for it.

// tag a segment list with a visibility flag (mirrors extractPageGraphics).
function tagVis(segs, vis) { for (const s of segs) s.vis = vis; return segs; }
// the 4 edges of a rectangle as segments (top-down pts), via the real pushSeg.
function rectSegs(x0, y0, x1, y1) {
  const s = [];
  pushSeg(s, x0, y0, x1, y0);
  pushSeg(s, x0, y1, x1, y1);
  pushSeg(s, x0, y0, x0, y1);
  pushSeg(s, x1, y0, x1, y1);
  return s;
}

test('E-24b segInTableRegion: horizontal + vertical membership with tolerance', () => {
  const d = { top: 100, bottom: 220, left: 72, right: 372 };
  assert.equal(segInTableRegion({ horizontal: true, y: 130, x1: 72, x2: 372 }, d), true);
  assert.equal(segInTableRegion({ horizontal: true, y: 400, x1: 72, x2: 372 }, d), false); // below
  assert.equal(segInTableRegion({ horizontal: true, y: 130, x1: 500, x2: 560 }, d), false); // no x-overlap
  assert.equal(segInTableRegion({ vertical: true, x: 172, y1: 100, y2: 220 }, d), true);
  assert.equal(segInTableRegion({ vertical: true, x: 500, y1: 100, y2: 220 }, d), false); // right of region
});

test('E-24b tableHasVisibleRule: ≥1 visible seg in region passes; all-invisible fails', () => {
  const d = { top: 100, bottom: 220, left: 72, right: 372 };
  const clip = tagVis([{ horizontal: true, y: 130, x1: 72, x2: 372 }], false); // invisible clip rule
  const stroke = tagVis([{ horizontal: true, y: 130, x1: 72, x2: 372 }], true); // visible rule
  assert.equal(tableHasVisibleRule(d, clip), false); // pure clip → no visible backing
  assert.equal(tableHasVisibleRule(d, [...clip, ...stroke]), true); // one visible rule vouches
  const farStroke = tagVis([{ horizontal: true, y: 600, x1: 72, x2: 372 }], true);
  assert.equal(tableHasVisibleRule(d, [...clip, ...farStroke]), false); // visible but outside region
});

test('E-24b Ikansh p.3 shape: clip-only grid IS detected but has NO visible rule → rejected', () => {
  // 3×4 grid of CLIP rectangles (vis=false) — defeats E-24 (no fill) and E-15
  // (cells non-empty), exactly the page-3 phantom.
  const cols = [72, 172, 272, 372];
  const rows = [100, 130, 160, 190, 220];
  const segs = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) segs.push(...tagVis(rectSegs(cols[c], rows[r], cols[c + 1], rows[r + 1]), false));
  }
  const descs = refineTableDescs(detectTablesFromSegments(segs), 1); // page idx 1 (not the header band)
  assert.equal(descs.length, 1, 'clip grid IS detected as a table by geometry alone');
  assert.equal(descs.every((d) => !tableHasVisibleRule(d, segs)), true, 'phantom rejected: zero visible rules');
});

test('E-24b real table: a clip grid WITH ≥1 visible rule in-region survives the gate', () => {
  // vrishin-shape: clips supply grid geometry, but a real drawn rule also exists
  // in the region → the gate keeps it (clip-ness alone is NOT the signal).
  const cols = [72, 172, 272, 372];
  const rows = [100, 130, 160, 190, 220];
  const segs = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) segs.push(...tagVis(rectSegs(cols[c], rows[r], cols[c + 1], rows[r + 1]), false));
  }
  segs.push(...tagVis([{ horizontal: true, y: 100, x1: 72, x2: 372, len: 300 }], true)); // one genuine drawn rule
  const descs = refineTableDescs(detectTablesFromSegments(segs), 1);
  assert.equal(descs.length, 1);
  assert.equal(descs.some((d) => tableHasVisibleRule(d, segs)), true, 'visible rule vouches → table kept');
});

// ── Mirror P1: image-placement classification ────────────────────────────────
// Classify source images by GEOMETRY + cross-page RECURRENCE into header /
// footer / inline. Validated against the real Ikansh bboxes (the user's
// reference) — shape-equivalent, no PDF needed. Guardrail: no recurring band →
// bandFound=false → caller leaves images floating (clean reports unchanged).

test('P1 imageBoxesMatch: tolerant bbox equality for recurrence', () => {
  const a = { x: 0, y: 0, w: 613, h: 152 };
  assert.equal(imageBoxesMatch(a, { x: 2, y: 1, w: 611, h: 153 }), true); // within 6pt
  assert.equal(imageBoxesMatch(a, { x: 20, y: 0, w: 613, h: 152 }), false); // x off by 20
});

test('P1 classifyImagePlacement: Ikansh shape → header / footer / inline', () => {
  const PW = 595, PH = 842;
  const logo = (page) => ({ x: 0, y: 0, w: 613, h: 152, page, pageW: PW, pageH: PH });   // (0,0,613,152) all pages
  const foot = (page) => ({ x: 0, y: 805, w: 608, h: 37, page, pageW: PW, pageH: PH });   // (0,805,608,842) all pages
  const sig = { x: 49, y: 579, w: 121, h: 74, page: 3, pageW: PW, pageH: PH };             // page 3 only
  const boxes = [logo(1), foot(1), logo(2), foot(2), logo(3), foot(3), sig];
  const { roles, bandFound } = classifyImagePlacement(boxes, 3);
  assert.equal(bandFound, true);
  assert.deepEqual(roles, ['header', 'footer', 'header', 'footer', 'header', 'footer', 'inline']);
});

test('P1 classifyImagePlacement: NO recurring band → all inline, bandFound=false (guardrail)', () => {
  const PW = 595, PH = 842;
  const boxes = [
    { x: 100, y: 300, w: 200, h: 120, page: 1, pageW: PW, pageH: PH }, // mid-page figure, one page
    { x: 0, y: 0, w: 600, h: 140, page: 1, pageW: PW, pageH: PH },     // top band but ONE page → not recurring
  ];
  const { roles, bandFound } = classifyImagePlacement(boxes, 3);
  assert.equal(bandFound, false);
  assert.deepEqual(roles, ['inline', 'inline']);
});

test('P1 classifyImagePlacement: recurring but NOT full-width (small logo) → not a band', () => {
  const PW = 595, PH = 842;
  const small = (page) => ({ x: 40, y: 30, w: 150, h: 60, page, pageW: PW, pageH: PH }); // ~25% width
  const { roles, bandFound } = classifyImagePlacement([small(1), small(2), small(3)], 3);
  assert.equal(bandFound, false);
  assert.deepEqual(roles, ['inline', 'inline', 'inline']);
});

// ── E-24 end-to-end against REAL PDFs (fixture-gated, PII-safe) ────────────────
// The shape-equivalent tests above prove the guard's logic; these prove it on the
// actual exporter output the task names. Like formatMirror's fixtures, the real
// clinical PDFs are PII (children's reports) and are deliberately NOT committed —
// provide them via MIRROR_FIXTURES_DIR (or drop them in test/fixtures/) and these
// run; otherwise they SKIP cleanly so the committed suite stays green and PII-free.
//   MIRROR_FIXTURES_DIR=C:/Users/<you>/Downloads node --test test/extractPDFGeometry.test.js
const PDF_DIRS = [process.env.MIRROR_FIXTURES_DIR, path.join(__dirname, 'fixtures')].filter(Boolean);
function findPdf(names) {
  for (const dir of PDF_DIRS) for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
// Candidate filenames per fixture — exact names first, fallback spellings after.
const IKANSH_PDF = findPdf(['Ikansh Shetty  SALT Progress Report.pdf', 'ikansh.pdf', 'Ikansh.pdf', 'Inside Out Ikansh.pdf']);
const AADYA_PDF = findPdf(['Speech and language Assessment  report - Aadya.pdf', 'aadya.pdf', 'Aadya.pdf', 'vrushali.pdf', 'Vrushali.pdf']);
const VRISHIN_PT_PDF = findPdf(['vrishin PT.pdf', 'vrishin_pt.pdf', 'Vrishin PT.pdf']);

// THE headline: Inside Out (Ikansh) is a narrative report whose only "table" was
// the phantom grid from invisible white per-line fills. With E-24 it must extract
// with ZERO tables. (If this copy genuinely contains a real table, narrow this to
// assert the wide phantom grid specifically is absent.)
test('E-24 e2e — Inside Out (Ikansh): real PDF extracts with NO phantom table',
  { skip: IKANSH_PDF ? false : 'Ikansh PDF absent (set MIRROR_FIXTURES_DIR)' }, async () => {
    const g = await extractPDFGeometry(fs.readFileSync(IKANSH_PDF));
    assert.strictEqual(g.counts.tables, 0, `expected 0 tables after E-24, got ${g.counts.tables}`);
    assert.ok((g.structure || []).some((b) => b.type === 'paragraph'), 'content still extracts as paragraphs');
  });

// Regression — a clean text report (Aadya) is a no-op: still zero tables, still
// extracts its content. (The rigorous guard-on vs guard-off geometry equality is
// proven separately by scripts/_e24_diag.js against the committed pre-E-24 build.)
test('E-24 e2e — Aadya (clean text report): real PDF stays table-free',
  { skip: AADYA_PDF ? false : 'Aadya PDF absent (set MIRROR_FIXTURES_DIR)' }, async () => {
    const g = await extractPDFGeometry(fs.readFileSync(AADYA_PDF));
    assert.strictEqual(g.counts.tables, 0, `clean report should have 0 tables, got ${g.counts.tables}`);
    assert.ok((g.structure || []).length > 0, 'content still extracts');
  });

// Extra case — vrishin PT is NOT a confirmed bordered-table report; neither of us
// has verified it contains a real table. So this test only asserts the extractor
// runs cleanly and reports the structure; ZERO tables is an acceptable outcome
// (it may simply have no table). scripts/_e24_diag.js prints the detected counts.
test('E-24 e2e — vrishin PT (extra case): extractor runs and produces structure',
  { skip: VRISHIN_PT_PDF ? false : 'vrishin PT PDF absent (set MIRROR_FIXTURES_DIR)' }, async () => {
    const g = await extractPDFGeometry(fs.readFileSync(VRISHIN_PT_PDF));
    assert.ok(Array.isArray(g.structure), 'extraction produced a structure array');
    assert.ok(g.counts && typeof g.counts.tables === 'number', 'counts.tables is reported');
  });
