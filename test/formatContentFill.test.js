// test/formatContentFill.test.js
//
// Phase D week 3 — content-slot bridge. Deterministic tests (no API key, no
// fixtures, always run):
//  • renderer content-fill: slot injection (label-append + body-replace),
//    repeatable-row expansion, static verbatim, page preserved.
//  • identifySlots: parses LLM output + surfaces errors (mocked fetch).

const { test } = require('node:test');
const assert = require('node:assert');
const { buildReportDocxV2, _internals: { fitMediaToWidth } } = require('../lib/buildReportDocxV2');
const { extractGeometry } = require('../lib/extractGeometry');
const { identifySlots } = require('../lib/identifySlots');

// Mirror P1 — band image width-fit (scale down to printable width, keep aspect).
test('P1 fitMediaToWidth: over-wide band scales to fit, aspect preserved, no upscale', () => {
  const PT = 12700; // EMU per pt
  const band = { anchor: { x: 0, y: 0, width: 600 * PT, height: 150 * PT }, bytes: Buffer.from([1]) };
  const fit = fitMediaToWidth(band, 480 * PT); // 600pt → 480pt (scale 0.8)
  assert.equal(fit.anchor.width, Math.round(600 * PT * (480 / 600)), 'width scaled to max');
  assert.ok(Math.abs(fit.anchor.width / fit.anchor.height - 4) < 0.01, 'aspect ratio (4:1) preserved');
  assert.equal(fit.wrap_mode, 'inline', 'band renders inline, never floating');
  // an already-fitting band is returned unchanged in size (never upscaled)
  const small = fitMediaToWidth({ anchor: { width: 300 * PT, height: 100 * PT } }, 480 * PT);
  assert.equal(small.anchor.width, 300 * PT);
  assert.equal(small.anchor.height, 100 * PT);
});

function allText(g) {
  const out = [];
  const walk = (bl) => { for (const b of bl || []) {
    if (b.type === 'paragraph') out.push((b.runs || []).map((r) => r.text || '').join(''));
    else if (b.type === 'table') for (const row of b.rows) for (const c of row.cells) walk(c.content);
  } };
  walk(g.structure); return out.join('\n');
}
const firstTableRows = (g) => { const t = (g.structure || []).find((s) => s.type === 'table'); return t ? t.rows.length : 0; };
const para = (text) => ({ type: 'paragraph', runs: [{ text }], images: [] });

// A minimal LP-shaped geometry: a title paragraph + a 3-col table with a client
// info row, a column-header row, and a repeatable body skeleton row.
function syntheticGeometry() {
  return {
    page_setup: { width: 16839, height: 11907, orientation: 'landscape', margins: { top: 270, bottom: 180, left: 180, right: 99, header: 720, footer: 720 } },
    default_font: { family: 'Cambria', size: 24 },
    numbering_definitions: { abstract: {}, nums: {} },
    media: [],
    structure: [
      para('LESSON PLAN FORM'),
      { type: 'table', grid: [2000, 3000, 4000], rows: [
        { cells: [{ content: [para('NAME:')] }, { content: [para('AGE:')] }, { content: [para('PD:')] }] },
        { cells: [{ content: [para('S.N')] }, { content: [para('SKILLS')] }, { content: [para('GOALS')] }] },
        { cells: [{ content: [para('1')] }, { content: [para('skill placeholder')] }, { content: [para('goal placeholder')] }] },
      ] },
    ],
  };
}
function syntheticSlotMap() {
  return {
    slots: [
      { slot_id: 'client_name', location: { block: 1, row: 0, cell: 0 }, semantic_label: 'client_name', repeatable_per_skill_domain: false, notes: 'Label prefix: NAME:' },
      { slot_id: 'age', location: { block: 1, row: 0, cell: 1 }, semantic_label: 'age_gender', repeatable_per_skill_domain: false, notes: 'Label prefix: AGE:' },
      { slot_id: 'pd', location: { block: 1, row: 0, cell: 2 }, semantic_label: 'provisional_diagnosis', repeatable_per_skill_domain: false, notes: 'Label prefix: PD:' },
      { slot_id: 'row_sn', location: { block: 1, row: 2, cell: 0 }, semantic_label: 'serial_number', repeatable_per_skill_domain: true, notes: '' },
      { slot_id: 'row_skills', location: { block: 1, row: 2, cell: 1 }, semantic_label: 'skill_domain', repeatable_per_skill_domain: true, notes: '' },
      { slot_id: 'row_goals', location: { block: 1, row: 2, cell: 2 }, semantic_label: 'goal_statement', repeatable_per_skill_domain: true, notes: '' },
    ],
    static_text: [
      { location: { block: 0 }, text: 'LESSON PLAN FORM' },
      { location: { block: 1, row: 1, cell: 0 }, text: 'S.N' },
      { location: { block: 1, row: 1, cell: 1 }, text: 'SKILLS' },
      { location: { block: 1, row: 1, cell: 2 }, text: 'GOALS' },
    ],
    repeatable_table: { block: 1, header_rows: [0, 1], template_row: 2 },
  };
}

test('F3 renderer — content-fill injects slots, expands repeatable rows, preserves structure', async () => {
  const geometry = syntheticGeometry();
  const slotMap = syntheticSlotMap();
  const contentMap = {
    client_name: 'Ratnadeep', age: '30 years', pd: 'B/L vocal cord paralysis',
    row_sn: ['1', '2'],
    row_skills: ['SOVT /m/ phonation', 'VFE'],
    row_goals: ['sustained /m/ at 3 seconds', 'four VFE exercises twice daily'],
  };
  const buf = await buildReportDocxV2({ geometry, slotMap, contentMap });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
  const out = await extractGeometry(buf);
  const txt = allText(out);

  // page preserved
  assert.strictEqual(out.page_setup.orientation, 'landscape');
  assert.strictEqual(out.page_setup.width, 16839);
  assert.strictEqual(out.page_setup.height, 11907);
  // label-append header slots: "NAME: Ratnadeep", not duplicated
  assert.ok(txt.includes('NAME: Ratnadeep'), 'client_name appended after label');
  assert.ok(txt.includes('AGE: 30 years'));
  assert.ok(txt.includes('PD: B/L vocal cord paralysis'));
  assert.ok(!/NAME:\s*NAME:/.test(txt), 'label not duplicated');
  // repeatable body expanded 1 → 2 rows (src 3 → out 4)
  assert.strictEqual(firstTableRows(out), 4, 'body row expanded to 2 domains');
  // body content injected; IPA preserved; placeholder replaced
  assert.ok(txt.includes('SOVT /m/ phonation') && txt.includes('VFE'));
  assert.ok(txt.includes('/m/'), 'IPA preserved');
  assert.ok(!txt.includes('skill placeholder'), 'template placeholder replaced');
  // static text preserved verbatim
  assert.ok(txt.includes('LESSON PLAN FORM') && txt.includes('S.N') && txt.includes('SKILLS'));
});

test('F3b renderer — verbatim mode ⇒ pure mirror (placeholders kept, no expansion)', async () => {
  const geometry = syntheticGeometry();
  const buf = await buildReportDocxV2({ geometry, renderMode: 'verbatim' });
  const out = await extractGeometry(buf);
  // verbatim: placeholders remain, body NOT expanded (still 3 rows)
  assert.strictEqual(firstTableRows(out), 3);
  assert.ok(allText(out).includes('skill placeholder'));
});

// ── F-leak: the render-mode safety boundary (synthetic, always runs) ──────────
function leakGeometry() {
  return {
    page_setup: { width: 11909, height: 16834, orientation: 'portrait', margins: { top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720 } },
    default_font: { family: 'Times New Roman', size: 24 },
    numbering_definitions: { abstract: {}, nums: {} },
    media: [],
    structure: [
      para('PRE THERAPY ASSESSMENT'),               // 0 static heading
      para('Case Name: OldClient'),                  // 1 slot client_name (replace)
      para('Birth weight: 3.4 kg'),                  // 2 slot birth_weight (empty → label only)
      para('II. History:'),                          // 3 static heading
      para('Prenatal History: No significant hx'),   // 4 slot prenatal (empty → label only)
      para('Stray prior-client note never classified'), // 5 UNCLASSIFIED → blank in content_fill
    ],
  };
}
const leakSlotMap = {
  slots: [
    { slot_id: 'client_name', location_type: 'paragraph', location: { block: 1 }, semantic_label: 'client_name', repeatable_per_skill_domain: false, notes: 'Label prefix: Case Name:' },
    { slot_id: 'birth_weight', location_type: 'paragraph', location: { block: 2 }, semantic_label: 'birth_history', repeatable_per_skill_domain: false, notes: 'Label prefix: Birth weight:' },
    { slot_id: 'prenatal_history', location_type: 'paragraph', location: { block: 4 }, semantic_label: 'prenatal_history', repeatable_per_skill_domain: false, notes: 'Label prefix: Prenatal History:' },
  ],
  static_text: [
    { location: { block: 0 }, text: 'PRE THERAPY ASSESSMENT' },
    { location: { block: 3 }, text: 'II. History:' },
  ],
  repeatable_table: null,
};

test('F-leak-1 content_fill — prior client clinical data NEVER leaks', async () => {
  const contentMap = { client_name: 'NewKid', birth_weight: '', prenatal_history: '' };
  const out = await extractGeometry(await buildReportDocxV2({ geometry: leakGeometry(), slotMap: leakSlotMap, contentMap, renderMode: 'content_fill' }));
  const txt = allText(out);
  // new client present; labels kept; static headings kept
  assert.ok(txt.includes('NewKid'), 'new client name filled');
  assert.ok(txt.includes('Case Name:') && txt.includes('Birth weight:') && txt.includes('Prenatal History:'), 'labels kept for empty slots');
  assert.ok(txt.includes('PRE THERAPY ASSESSMENT') && txt.includes('II. History:'), 'static scaffolding kept');
  // NONE of the prior client's clinical content survives
  for (const leak of ['OldClient', '3.4 kg', 'No significant hx', 'Stray prior-client note']) {
    assert.ok(!txt.includes(leak), `must NOT leak: "${leak}"`);
  }
});

test('F-leak-2 verbatim — prior client content reproduced exactly (mirror path)', async () => {
  const out = await extractGeometry(await buildReportDocxV2({ geometry: leakGeometry(), renderMode: 'verbatim' }));
  const txt = allText(out);
  for (const keep of ['OldClient', '3.4 kg', 'No significant hx', 'Stray prior-client note', 'PRE THERAPY ASSESSMENT']) {
    assert.ok(txt.includes(keep), `verbatim must reproduce: "${keep}"`);
  }
});

// E-14: multi-field paragraph rendering. A demographic line packs N (label, value)
// pairs in one paragraph block via alternating bold/regular runs; the slot map
// decomposes that block into N field_idx-bearing slots. The renderer must
// preserve every label verbatim and replace every value with its slot's content.
function multiFieldGeometry() {
  return {
    page_setup: { width: 11909, height: 16834, orientation: 'portrait', margins: { top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720 } },
    default_font: { family: 'Times New Roman', size: 24 },
    numbering_definitions: { abstract: {}, nums: {} },
    media: [],
    structure: [
      // b0 — 3-field demographic line: "Name: ___  Age: ___  Date: ___"
      {
        type: 'paragraph',
        runs: [
          { text: 'Name: ',     font: 'Times New Roman', size: 24, bold: true },
          { text: 'OldName',    font: 'Times New Roman', size: 24 },
          { text: ' Age: ',     font: 'Times New Roman', size: 24, bold: true },
          { text: 'OldAge',     font: 'Times New Roman', size: 24 },
          { text: ' Date: ',    font: 'Times New Roman', size: 24, bold: true },
          { text: 'OldDate',    font: 'Times New Roman', size: 24 },
        ],
        images: [],
      },
    ],
  };
}

test('F4 renderer — multi-field paragraph injects each (label, value) pair via field_idx slots (E-14)', async () => {
  const geometry = multiFieldGeometry();
  const slotMap = {
    slots: [
      { slot_id: 'client_name', location: { block: 0, field_idx: 0 }, semantic_label: 'client_name', repeatable_per_skill_domain: false, notes: 'Label prefix: Name:' },
      { slot_id: 'age_gender',  location: { block: 0, field_idx: 1 }, semantic_label: 'age_gender',  repeatable_per_skill_domain: false, notes: 'Label prefix: Age:' },
      { slot_id: 'date',        location: { block: 0, field_idx: 2 }, semantic_label: 'date',        repeatable_per_skill_domain: false, notes: 'Label prefix: Date:' },
    ],
    static_text: [],
    repeatable_table: null,
  };
  const contentMap = { client_name: 'Asha', age_gender: '4y / Female', date: '19-04-2022' };
  const buf = await buildReportDocxV2({ geometry, slotMap, contentMap });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
  const out = await extractGeometry(buf);
  const txt = allText(out);
  // Labels preserved verbatim (structural scaffolding)
  assert.ok(txt.includes('Name:'), 'Name: label preserved');
  assert.ok(txt.includes('Age:'),  'Age: label preserved');
  assert.ok(txt.includes('Date:'), 'Date: label preserved');
  // Values injected from contentMap
  assert.ok(txt.includes('Asha'),       'client_name value injected');
  assert.ok(txt.includes('4y / Female'),'age_gender value injected');
  assert.ok(txt.includes('19-04-2022'), 'date value injected');
  // Source values replaced (content_fill safety: no prior-client leak)
  assert.ok(!txt.includes('OldName'),  'source name value replaced');
  assert.ok(!txt.includes('OldAge'),   'source age value replaced');
  assert.ok(!txt.includes('OldDate'),  'source date value replaced');
});

test('F4b renderer — mixed map with field_idx slots AND legacy single-block slots both render correctly (E-14 backward-compat)', async () => {
  // Same first paragraph (multi-field) plus a second paragraph using the legacy
  // single-slot-per-block contract (no field_idx). Both must render together.
  const geometry = {
    page_setup: { width: 11909, height: 16834, orientation: 'portrait', margins: { top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720 } },
    default_font: { family: 'Times New Roman', size: 24 },
    numbering_definitions: { abstract: {}, nums: {} },
    media: [],
    structure: [
      // b0 — multi-field demographic line
      {
        type: 'paragraph',
        runs: [
          { text: 'Name: ',    font: 'Times New Roman', size: 24, bold: true },
          { text: 'OldName',   font: 'Times New Roman', size: 24 },
          { text: ' Age: ',    font: 'Times New Roman', size: 24, bold: true },
          { text: 'OldAge',    font: 'Times New Roman', size: 24 },
        ],
        images: [],
      },
      // b1 — legacy single-slot paragraph (no field_idx)
      {
        type: 'paragraph',
        runs: [{ text: 'Diagnosis: OldDiagnosis', font: 'Times New Roman', size: 24 }],
        images: [],
      },
    ],
  };
  const slotMap = {
    slots: [
      // field_idx slots for b0
      { slot_id: 'client_name', location: { block: 0, field_idx: 0 }, semantic_label: 'client_name', repeatable_per_skill_domain: false, notes: 'Label prefix: Name:' },
      { slot_id: 'age_gender',  location: { block: 0, field_idx: 1 }, semantic_label: 'age_gender',  repeatable_per_skill_domain: false, notes: 'Label prefix: Age:' },
      // legacy slot for b1 (no field_idx — single-slot path)
      { slot_id: 'diagnosis',   location: { block: 1 },                semantic_label: 'provisional_diagnosis', repeatable_per_skill_domain: false, notes: 'Label prefix: Diagnosis:' },
    ],
    static_text: [],
    repeatable_table: null,
  };
  const contentMap = { client_name: 'Asha', age_gender: '4y', diagnosis: 'B/L vocal cord paralysis' };
  const out = await extractGeometry(await buildReportDocxV2({ geometry, slotMap, contentMap }));
  const txt = allText(out);
  // Multi-field b0 renders correctly
  assert.ok(txt.includes('Name:') && txt.includes('Asha'),  'b0 Name field');
  assert.ok(txt.includes('Age:')  && txt.includes('4y'),    'b0 Age field');
  // Legacy single-slot b1 renders correctly via the unchanged single-slot path
  assert.ok(txt.includes('Diagnosis:') && txt.includes('B/L vocal cord paralysis'), 'b1 legacy diagnosis');
  // No source values leak
  assert.ok(!txt.includes('OldName')      && !txt.includes('OldAge'),       'b0 source values dropped');
  assert.ok(!txt.includes('OldDiagnosis'),                                  'b1 source value dropped');
});

test('F4c renderer — multi-field paragraph with a missing slot in contentMap blanks the value (content_fill safety)', async () => {
  const geometry = multiFieldGeometry();
  const slotMap = {
    slots: [
      { slot_id: 'client_name', location: { block: 0, field_idx: 0 }, semantic_label: 'client_name', repeatable_per_skill_domain: false, notes: 'Label prefix: Name:' },
      { slot_id: 'age_gender',  location: { block: 0, field_idx: 1 }, semantic_label: 'age_gender',  repeatable_per_skill_domain: false, notes: 'Label prefix: Age:' },
      { slot_id: 'date',        location: { block: 0, field_idx: 2 }, semantic_label: 'date',        repeatable_per_skill_domain: false, notes: 'Label prefix: Date:' },
    ],
    static_text: [],
    repeatable_table: null,
  };
  // contentMap missing 'date' and 'age_gender' entirely → those values blank
  const contentMap = { client_name: 'Asha' };
  const out = await extractGeometry(await buildReportDocxV2({ geometry, slotMap, contentMap }));
  const txt = allText(out);
  // Labels still present (structural scaffolding)
  assert.ok(txt.includes('Name:') && txt.includes('Age:') && txt.includes('Date:'), 'all labels preserved');
  // Filled value present
  assert.ok(txt.includes('Asha'), 'client_name value injected');
  // Source values for missing-slot fields NOT leaked (safety boundary)
  assert.ok(!txt.includes('OldName') && !txt.includes('OldAge') && !txt.includes('OldDate'), 'no source values leak when slot missing');
});

test('F1 identifySlots — parses LLM output into a slot map', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        slots: [{ slot_id: 'client_name', location: { block: 0 }, semantic_label: 'client_name', repeatable_per_skill_domain: false }],
        static_text: [{ location: { block: 1 }, text: 'HEADER' }],
        repeatable_table: { block: 2, header_rows: [0], template_row: 1 },
      }) }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  });
  const map = await identifySlots(
    { page_setup: { width: 1, height: 1, orientation: 'portrait' }, structure: [para('x')] },
    { apiKey: 'test', fetchImpl: fakeFetch },
  );
  assert.strictEqual(map.engine, 'format-identify-slots');
  assert.strictEqual(map.slots.length, 1);
  // slot_id is recomputed deterministically from (semantic_label, position) —
  // NOT the LLM's free-form value (Finding E-8). block 0 → "client_name_0".
  assert.strictEqual(map.slots[0].slot_id, 'client_name_0');
  assert.strictEqual(map.slots[0].semantic_label, 'client_name');
  assert.strictEqual(map.repeatable_table.template_row, 1);
});

test('F1b identifySlots — non-200 surfaces the error (no silent swallow)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'model overloaded' } }) });
  await assert.rejects(
    () => identifySlots({ structure: [para('x')] }, { apiKey: 'test', fetchImpl: fakeFetch }),
    /500|model overloaded/,
  );
});

// ── E-14 producer-side multi-field paragraph decomposition tests ──────────────
// These exercise the decomposition pass in ISOLATION (no LLM, no API key) so
// the deterministic logic is verified before being spent on real templates.
const { _internals } = require('../lib/identifySlots');
const {
  detectMultiFieldRuns,
  decomposeMultiFieldParagraphs,
  lookupSemanticLabel,
  canonicalSlotId: canonicalSlotIdInternal,
} = _internals;

test('F5 producer — detectMultiFieldRuns matches (bold-endswith-colon)(regular)+ with N≥2 pairs (E-14)', () => {
  // 3 (label, value) pairs — matches
  const pairs = detectMultiFieldRuns([
    { text: 'Case Name: ',       bold: true },
    { text: 'Vrishin V T' },
    { text: ' Date of report: ', bold: true },
    { text: '19-04-2022' },
    { text: ' Age/Gender: ',     bold: true },
    { text: '4y / M' },
  ]);
  assert.ok(pairs, 'multi-field detected');
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].labelText, 'Case Name:');
  assert.equal(pairs[1].labelText, 'Date of report:');
  assert.equal(pairs[2].labelText, 'Age/Gender:');
});

test('F5b producer — detectMultiFieldRuns REJECTS single-field paragraphs (N=1 pair → not multi)', () => {
  // 1 pair only — single-field paragraph, NOT multi-field
  assert.equal(detectMultiFieldRuns([
    { text: 'Supervisor: ', bold: true },
    { text: 'Deepa Anand' },
  ]), null);
});

test('F5c producer — detectMultiFieldRuns REJECTS non-matching patterns', () => {
  // narrative paragraph — no bold runs at all
  assert.equal(detectMultiFieldRuns([
    { text: 'A narrative paragraph without label/value packing.' },
  ]), null);
  // bold runs but no trailing colon — not field labels
  assert.equal(detectMultiFieldRuns([
    { text: 'Bold heading',   bold: true },
    { text: 'some value' },
    { text: 'Another heading',bold: true },
    { text: 'another value' },
  ]), null);
  // odd run count — incomplete pair
  assert.equal(detectMultiFieldRuns([
    { text: 'Name: ', bold: true },
    { text: 'Asha' },
    { text: ' Age: ', bold: true },
  ]), null);
  // two bold "labels" in a row (no regular value between) — wrong pattern
  assert.equal(detectMultiFieldRuns([
    { text: 'Name: ',  bold: true },
    { text: ' Age: ',  bold: true },
    { text: ' Date: ', bold: true },
    { text: 'value' },
  ]), null);
});

test('F5d producer — lookupSemanticLabel resolves common headers, returns null for unknowns', () => {
  // Case-insensitive, colon-stripped, whitespace-trimmed
  assert.equal(lookupSemanticLabel('Case Name:'), 'client_name');
  assert.equal(lookupSemanticLabel('case name'), 'client_name');
  assert.equal(lookupSemanticLabel('Date of report:'), 'date');
  assert.equal(lookupSemanticLabel('Age/Gender:'), 'age_gender');
  assert.equal(lookupSemanticLabel('Registration Number: '), 'registration_number');
  assert.equal(lookupSemanticLabel('Clinician'), 'clinician_name');
  assert.equal(lookupSemanticLabel('Supervisor:'), 'supervisor_name');
  assert.equal(lookupSemanticLabel('Provisional diagnosis:'), 'provisional_diagnosis');
  // unknown labels return null (caller falls back to LLM's original label)
  assert.equal(lookupSemanticLabel('Custom Header:'), null);
  assert.equal(lookupSemanticLabel('Foo bar baz'), null);
});

test('F5e producer — decomposeMultiFieldParagraphs replaces LLM single slot with N field_idx slots (E-14 core)', () => {
  // LLM emitted ONE slot at block 3 (under-decomposed). Block 3 actually has
  // 3 field pairs — decomposer emits 3 field_idx slots with correct labels.
  const geometry = {
    structure: [
      { type: 'paragraph', runs: [{ text: 'Header', bold: true }], images: [] },                   // b0
      { type: 'paragraph', runs: [{ text: 'Intro' }], images: [] },                                 // b1
      { type: 'paragraph', runs: [{ text: 'Intro 2' }], images: [] },                               // b2
      {                                                                                             // b3 — multi-field
        type: 'paragraph',
        runs: [
          { text: 'Case Name: ',       bold: true, font: 'Times', size: 24 },
          { text: 'OldName',                            font: 'Times', size: 24 },
          { text: ' Date of report: ', bold: true, font: 'Times', size: 24 },
          { text: 'OldDate',                            font: 'Times', size: 24 },
          { text: ' Age/Gender: ',     bold: true, font: 'Times', size: 24 },
          { text: 'OldAge',                             font: 'Times', size: 24 },
        ],
        images: [],
      },
    ],
  };
  const mapIn = {
    slots: [
      // LLM under-decomposed: only one slot for b3, labeled client_name
      { location: { block: 3 }, semantic_label: 'client_name', notes: 'LLM original note' },
    ],
  };
  const mapOut = decomposeMultiFieldParagraphs(mapIn, geometry);
  assert.equal(mapOut.slots.length, 3, '3 field_idx slots emitted');
  // Each new slot has a distinct field_idx in source-run order
  const byIdx = (n) => mapOut.slots.find((s) => (s.location || {}).field_idx === n);
  assert.ok(byIdx(0) && byIdx(1) && byIdx(2), 'field_idx 0, 1, 2 all present');
  // Labels derived from lookup (no inheritance from LLM's "client_name")
  assert.equal(byIdx(0).semantic_label, 'client_name');       // "Case Name:" → client_name
  assert.equal(byIdx(1).semantic_label, 'date');              // "Date of report:" → date
  assert.equal(byIdx(2).semantic_label, 'age_gender');        // "Age/Gender:" → age_gender
  // Notes carry the verbatim bold-label text
  assert.equal(byIdx(0).notes, 'Label prefix: Case Name:');
  assert.equal(byIdx(1).notes, 'Label prefix: Date of report:');
  assert.equal(byIdx(2).notes, 'Label prefix: Age/Gender:');
  // All locations at block 3
  for (const s of mapOut.slots) assert.equal(s.location.block, 3);
});

test('F5f producer — decomposeMultiFieldParagraphs LEAVES single-field paragraphs unchanged', () => {
  // Block 0 is single-field (1 pair) — should NOT decompose
  const geometry = {
    structure: [
      {
        type: 'paragraph',
        runs: [
          { text: 'Supervisor: ', bold: true },
          { text: 'Deepa Anand' },
        ],
        images: [],
      },
    ],
  };
  const mapIn = {
    slots: [{ location: { block: 0 }, semantic_label: 'supervisor_name', notes: 'Label prefix: Supervisor:' }],
  };
  const mapOut = decomposeMultiFieldParagraphs(mapIn, geometry);
  assert.equal(mapOut.slots.length, 1);
  assert.equal(mapOut.slots[0].semantic_label, 'supervisor_name');
  assert.equal(mapOut.slots[0].location.block, 0);
  assert.equal(mapOut.slots[0].location.field_idx, undefined, 'no field_idx added');
});

test('F5g producer — decomposeMultiFieldParagraphs LEAVES non-matching paragraphs untouched (narrative text)', () => {
  // Block 0 is a narrative paragraph (no bold labels at all) — should NOT decompose
  const geometry = {
    structure: [
      {
        type: 'paragraph',
        runs: [{ text: 'A narrative paragraph that the child has good attention.' }],
        images: [],
      },
    ],
  };
  const mapIn = {
    slots: [{ location: { block: 0 }, semantic_label: 'background_information', notes: '' }],
  };
  const mapOut = decomposeMultiFieldParagraphs(mapIn, geometry);
  assert.equal(mapOut.slots.length, 1);
  assert.equal(mapOut.slots[0].semantic_label, 'background_information');
  assert.equal(mapOut.slots[0].location.block, 0);
  assert.equal(mapOut.slots[0].location.field_idx, undefined, 'no field_idx added');
});

test('F5h producer — decomposeMultiFieldParagraphs preserves other paragraph slots AND table-cell slots in a mixed map', () => {
  const geometry = {
    structure: [
      // b0 multi-field (2 pairs)
      {
        type: 'paragraph',
        runs: [
          { text: 'Name: ', bold: true }, { text: 'Asha' },
          { text: ' Date: ', bold: true }, { text: '19-04-2022' },
        ],
        images: [],
      },
      // b1 single-field paragraph
      { type: 'paragraph', runs: [{ text: 'Diagnosis: SLD' }], images: [] },
      // b2 a table block (cell slots must pass through untouched)
      {
        type: 'table',
        grid: [1000, 1000],
        rows: [{ cells: [
          { content: [{ type: 'paragraph', runs: [{ text: 'TestA' }] }] },
          { content: [{ type: 'paragraph', runs: [{ text: 'TestB' }] }] },
        ] }],
      },
    ],
  };
  const mapIn = {
    slots: [
      // b0 LLM single slot — should decompose to 2
      { location: { block: 0 }, semantic_label: 'client_name', notes: 'LLM note' },
      // b1 paragraph slot — single-field, stays
      { location: { block: 1 }, semantic_label: 'provisional_diagnosis', notes: 'LLM' },
      // b2 table cells — never touched
      { location: { block: 2, row: 0, cell: 0 }, semantic_label: 'other', notes: 'Test A' },
      { location: { block: 2, row: 0, cell: 1 }, semantic_label: 'other', notes: 'Test B' },
    ],
  };
  const mapOut = decomposeMultiFieldParagraphs(mapIn, geometry);
  assert.equal(mapOut.slots.length, 5, '2 field_idx + 1 b1 + 2 table cells = 5');
  // b0 decomposed into 2 field_idx slots (Name → client_name, Date → date)
  const b0 = mapOut.slots.filter((s) => (s.location || {}).block === 0);
  assert.equal(b0.length, 2);
  assert.ok(b0.find((s) => s.location.field_idx === 0 && s.semantic_label === 'client_name'));
  assert.ok(b0.find((s) => s.location.field_idx === 1 && s.semantic_label === 'date'));
  // b1 single slot preserved (no field_idx added)
  const b1 = mapOut.slots.filter((s) => (s.location || {}).block === 1);
  assert.equal(b1.length, 1);
  assert.equal(b1[0].location.field_idx, undefined);
  assert.equal(b1[0].semantic_label, 'provisional_diagnosis');
  // Table cells preserved verbatim
  const b2 = mapOut.slots.filter((s) => (s.location || {}).block === 2);
  assert.equal(b2.length, 2);
});

test('F5i producer — decomposeMultiFieldParagraphs falls back to LLM label when lookup misses', () => {
  // Unknown bold label "Custom Header:" → not in lookup → inherits LLM's
  // original semantic_label rather than dropping the field.
  const geometry = {
    structure: [
      {
        type: 'paragraph',
        runs: [
          { text: 'Custom Header: ', bold: true }, { text: 'value1' },
          { text: ' Other Custom: ', bold: true }, { text: 'value2' },
        ],
        images: [],
      },
    ],
  };
  const mapIn = {
    slots: [{ location: { block: 0 }, semantic_label: 'background_information', notes: '' }],
  };
  const mapOut = decomposeMultiFieldParagraphs(mapIn, geometry);
  assert.equal(mapOut.slots.length, 2);
  // Both decomposed slots inherit the LLM's original semantic_label (no lookup match)
  for (const s of mapOut.slots) assert.equal(s.semantic_label, 'background_information');
  // But notes still carry the bold-label text
  assert.equal(mapOut.slots.find((s) => s.location.field_idx === 0).notes, 'Label prefix: Custom Header:');
  assert.equal(mapOut.slots.find((s) => s.location.field_idx === 1).notes, 'Label prefix: Other Custom:');
});

test('F5j producer — canonicalSlotId includes _f${field_idx} for paragraph slots with field_idx (schema extension)', () => {
  // Legacy paragraph (no field_idx): unchanged
  assert.equal(canonicalSlotIdInternal('client_name', { block: 3 }), 'client_name_3');
  // Legacy cell: unchanged
  assert.equal(canonicalSlotIdInternal('linguistic_skills', { block: 60, row: 1, cell: 0 }), 'linguistic_skills_60_1_0');
  // E-14 paragraph with field_idx — the new shape
  assert.equal(canonicalSlotIdInternal('date', { block: 3, field_idx: 1 }), 'date_3_f1');
  assert.equal(canonicalSlotIdInternal('client_name', { block: 3, field_idx: 0 }), 'client_name_3_f0');
  assert.equal(canonicalSlotIdInternal('age_gender', { block: 3, field_idx: 2 }), 'age_gender_3_f2');
});
