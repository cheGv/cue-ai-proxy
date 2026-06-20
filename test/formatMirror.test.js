// test/formatMirror.test.js
//
// Phase D week 2 — Cue Mirror format-mirroring engine.
// E1 (snapshot invariants) + E2 (extract → render → re-extract round-trip).
//
// Fixtures (Vrishin LP + PT) are REAL clinical documents and are deliberately
// NOT committed (PII — the PT is a child's pre-therapy report). Provide them at
// runtime via MIRROR_FIXTURES_DIR (or drop them in test/fixtures/); tests SKIP
// cleanly when absent so the committed suite stays green and PII-free. Locally:
//   MIRROR_FIXTURES_DIR=C:/Users/<you>/Downloads node --test test/formatMirror.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractGeometry } = require('../lib/extractGeometry');
const { buildReportDocxV2 } = require('../lib/buildReportDocxV2');

const CANDIDATE_DIRS = [process.env.MIRROR_FIXTURES_DIR, path.join(__dirname, 'fixtures')].filter(Boolean);
function findFixture(names) {
  for (const dir of CANDIDATE_DIRS) for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const LP = findFixture(['vrishin_lp.docx', 'Vrishin  LP .docx', 'Vrishin__LP_.docx']);
const PT = findFixture(['vrishin_pt.docx', 'vrishin PT.docx']);

const pctDiff = (a, b) => (b === 0 ? (a === 0 ? 0 : 1) : Math.abs(a - b) / Math.abs(b));
const firstTable = (g) => (g.structure || []).find((s) => s.type === 'table');
function hasIPA(g, ch) {
  let f = false;
  const walk = (bl) => { for (const b of bl || []) {
    if (b.type === 'paragraph') { for (const r of b.runs) if (r.text && r.text.indexOf(ch) !== -1) f = true; }
    else if (b.type === 'table') { for (const row of b.rows) for (const c of row.cells) walk(c.content); } } };
  walk(g.structure); return f;
}

// ── E1: snapshot invariants ──────────────────────────────────────────────────
test('E1 LP — landscape, 2 tables, 0 images, 9-col main table', { skip: LP ? false : 'LP fixture absent (set MIRROR_FIXTURES_DIR)' }, async () => {
  const g = await extractGeometry(fs.readFileSync(LP));
  assert.strictEqual(g.page_setup.orientation, 'landscape');
  assert.strictEqual(g.counts.tables, 2);
  assert.strictEqual(g.counts.images, 0);
  assert.strictEqual(g.counts.main_table_columns, 9);
  assert.ok(hasIPA(g, 'ɛ'), 'IPA U+025B present in source');
});

test('E1 PT — portrait, at least one image', { skip: PT ? false : 'PT fixture absent (set MIRROR_FIXTURES_DIR)' }, async () => {
  const g = await extractGeometry(fs.readFileSync(PT));
  assert.strictEqual(g.page_setup.orientation, 'portrait');
  assert.ok(g.counts.images >= 1, `expected >=1 image, got ${g.counts.images}`);
});

// ── E2: extract → render → re-extract round-trip ─────────────────────────────
async function roundTrip(fixturePath) {
  const src = await extractGeometry(fs.readFileSync(fixturePath));
  // verbatim mode = pure mirror reproduction (content_fill is the default now).
  const buf = await buildReportDocxV2({ geometry: src, renderMode: 'verbatim' });
  const out = await extractGeometry(buf);
  return { src, out };
}

function assertGeometryMatches(src, out, opts = {}) {
  // page size exact
  assert.strictEqual(out.page_setup.width, src.page_setup.width, 'page width');
  assert.strictEqual(out.page_setup.height, src.page_setup.height, 'page height');
  // orientation
  assert.strictEqual(out.page_setup.orientation, src.page_setup.orientation, 'orientation');
  // margins within 5%
  for (const s of ['top', 'bottom', 'left', 'right']) {
    assert.ok(pctDiff(out.page_setup.margins[s], src.page_setup.margins[s]) <= 0.05, `margin ${s} within 5% (${out.page_setup.margins[s]} vs ${src.page_setup.margins[s]})`);
  }
  // table count
  assert.strictEqual(out.counts.tables, src.counts.tables, 'table count');
  // main table cols + widths within 5%
  const st = firstTable(src), ot = firstTable(out);
  assert.strictEqual(ot ? ot.grid.length : 0, st ? st.grid.length : 0, 'main table column count');
  if (st && ot) {
    for (let i = 0; i < st.grid.length; i++) {
      assert.ok(pctDiff(ot.grid[i], st.grid[i]) <= 0.05, `col ${i} width within 5% (${ot.grid[i]} vs ${st.grid[i]})`);
    }
  }
  // default font + image count
  assert.strictEqual(out.default_font.family, src.default_font.family, 'default font');
  assert.strictEqual(out.counts.images, src.counts.images, 'image count');
}

test('E2 LP — render reproduces source geometry; IPA preserved', { skip: LP ? false : 'LP fixture absent' }, async () => {
  const { src, out } = await roundTrip(LP);
  assertGeometryMatches(src, out);
  assert.ok(hasIPA(out, 'ɛ'), 'IPA U+025B preserved through render');
});

test('E2 PT — render reproduces source geometry; image anchor within 10%', { skip: PT ? false : 'PT fixture absent' }, async () => {
  const { src, out } = await roundTrip(PT);
  assertGeometryMatches(src, out);
  const sm = src.media[0], om = out.media[0];
  assert.ok(sm && om && sm.anchor && om.anchor, 'image + anchor present in both');
  assert.ok(pctDiff(om.anchor.x, sm.anchor.x) <= 0.10, `anchor x within 10% (${om.anchor.x} vs ${sm.anchor.x})`);
  assert.ok(pctDiff(om.anchor.y, sm.anchor.y) <= 0.10, `anchor y within 10% (${om.anchor.y} vs ${sm.anchor.y})`);
  assert.ok(pctDiff(om.anchor.width, sm.anchor.width) <= 0.10 && pctDiff(om.anchor.height, sm.anchor.height) <= 0.10, 'image w/h within 10%');
});

// Always-on smoke: the modules load and a trivial geometry renders to a docx.
test('smoke — minimal geometry renders to a non-empty .docx', async () => {
  const geometry = {
    page_setup: { width: 16839, height: 11907, orientation: 'landscape', margins: { top: 270, bottom: 180, left: 180, right: 99, header: 720, footer: 720 } },
    default_font: { family: 'Cambria', size: 24 },
    numbering_definitions: { abstract: {}, nums: {} },
    structure: [
      { type: 'paragraph', runs: [{ text: 'Mirror smoke ɛ', font: 'Cambria', size: 24 }], images: [] },
      { type: 'table', grid: [4000, 4000], rows: [{ cells: [{ content: [{ type: 'paragraph', runs: [{ text: 'A' }], images: [] }] }, { content: [{ type: 'paragraph', runs: [{ text: 'B' }], images: [] }] }] }] },
    ],
    media: [],
  };
  const buf = await buildReportDocxV2({ geometry, renderMode: 'verbatim' });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000, 'produced a docx buffer');
  const out = await extractGeometry(buf);
  assert.strictEqual(out.page_setup.orientation, 'landscape');
  assert.strictEqual(out.counts.tables, 1);
  assert.ok(hasIPA(out, 'ɛ'), 'IPA preserved in synthetic render');
});

// ── E-25: builder renders left tab stops + tab runs, and NEVER a table ─────────
test('E-25 builder — a tabStops paragraph renders <w:tabs> + <w:tab/> and adds NO <w:tbl>', async () => {
  const JSZip = require('jszip');
  const geometry = {
    page_setup: { width: 11906, height: 16838, orientation: 'portrait', margins: { top: 1440, bottom: 1440, left: 1140, right: 1140, header: 720, footer: 720 } },
    default_font: { family: 'Arial', size: 21 },
    numbering_definitions: { abstract: {}, nums: {} },
    structure: [
      {
        type: 'paragraph',
        runs: [{ text: 'Subtest' }, { tab: true }, { text: 'Raw Score' }, { tab: true }, { text: 'Percentile' }],
        images: [],
        tabStops: [{ type: 'left', position: 4400 }, { type: 'left', position: 6800 }],
      },
    ],
    media: [],
  };
  const buf = await buildReportDocxV2({ geometry, renderMode: 'verbatim' });
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:tabs>/);
  assert.match(xml, /<w:tab w:val="left" w:pos="4400"\/>/);
  assert.match(xml, /<w:tab w:val="left" w:pos="6800"\/>/);
  assert.strictEqual((xml.match(/<w:tab\//g) || []).length, 2, 'two tab elements between three cells');
  assert.strictEqual((xml.match(/<w:tbl>/g) || []).length, 0, 'tab alignment must NEVER emit a table');
});
