// test/formatContentFill.test.js
//
// Phase D week 3 — content-slot bridge. Deterministic tests (no API key, no
// fixtures, always run):
//  • renderer content-fill: slot injection (label-append + body-replace),
//    repeatable-row expansion, static verbatim, page preserved.
//  • identifySlots: parses LLM output + surfaces errors (mocked fetch).

const { test } = require('node:test');
const assert = require('node:assert');
const { buildReportDocxV2 } = require('../lib/buildReportDocxV2');
const { extractGeometry } = require('../lib/extractGeometry');
const { identifySlots } = require('../lib/identifySlots');

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
    static_text: [],
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

test('F3b renderer — no slotMap ⇒ pure verbatim mirror (unchanged)', async () => {
  const geometry = syntheticGeometry();
  const buf = await buildReportDocxV2({ geometry });
  const out = await extractGeometry(buf);
  // verbatim: placeholders remain, body NOT expanded (still 3 rows)
  assert.strictEqual(firstTableRows(out), 3);
  assert.ok(allText(out).includes('skill placeholder'));
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
  assert.strictEqual(map.slots[0].slot_id, 'client_name');
  assert.strictEqual(map.repeatable_table.template_row, 1);
});

test('F1b identifySlots — non-200 surfaces the error (no silent swallow)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'model overloaded' } }) });
  await assert.rejects(
    () => identifySlots({ structure: [para('x')] }, { apiKey: 'test', fetchImpl: fakeFetch }),
    /500|model overloaded/,
  );
});
