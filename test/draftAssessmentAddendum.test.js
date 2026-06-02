// test/draftAssessmentAddendum.test.js
//
// Deterministic gate for Step 4 (assessment addendum). Proves:
//   * therapy / session-report path (assessmentMode=false) -> system blocks are
//     returned UNCHANGED (same reference + contents) — byte-identical to before;
//   * assessment mode -> the addendum is appended as the LAST system block;
//   * assessment + slot-fill STACK cleanly: [base, slot, assessment];
//   * the helper never mutates its input;
//   * the addendum text carries the safety-critical instructions
//     (incl. the new "client_meta" source_type for demographic identity);
//   * version + SHA256 are present and the SHA matches the text.
// No network, no LLM, no server boot.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  FORMAT_DRAFT_ASSESSMENT_ADDENDUM,
  FORMAT_DRAFT_ASSESSMENT_ADDENDUM_VERSION,
  FORMAT_DRAFT_ASSESSMENT_ADDENDUM_SHA256,
  appendAssessmentAddendum,
} = require('../lib/draftAssessmentAddendum');

// Stand-ins mirroring server.js's blocks (text content is irrelevant here).
const base = () => [{ type: 'text', text: 'BASE_PROMPT', cache_control: { type: 'ephemeral' } }];
const baseSlot = () => [
  { type: 'text', text: 'BASE_PROMPT', cache_control: { type: 'ephemeral' } },
  { type: 'text', text: 'SLOT_ADDENDUM', cache_control: { type: 'ephemeral' } },
];

test('therapy path (assessmentMode=false): system blocks UNCHANGED', () => {
  const blocks = base();
  const out = appendAssessmentAddendum(blocks, false);
  assert.strictEqual(out, blocks, 'same array reference returned — nothing appended');
  assert.deepStrictEqual(out, base(), 'therapy system blocks are byte-identical');
  assert.strictEqual(out.length, 1);
});

test('therapy + slot-fill (assessmentMode=false): slot blocks UNCHANGED', () => {
  const blocks = baseSlot();
  const out = appendAssessmentAddendum(blocks, false);
  assert.strictEqual(out, blocks);
  assert.deepStrictEqual(out, baseSlot());
  assert.strictEqual(out.length, 2);
});

test('assessment mode: addendum appended as the last block', () => {
  const out = appendAssessmentAddendum(base(), true);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].text, 'BASE_PROMPT', 'base prompt stays first, unchanged');
  assert.strictEqual(out[1].text, FORMAT_DRAFT_ASSESSMENT_ADDENDUM, 'assessment addendum is appended');
  assert.deepStrictEqual(out[1].cache_control, { type: 'ephemeral' }, 'cache_control mirrors the slot block');
});

test('assessment + slot-fill STACK cleanly: [base, slot, assessment]', () => {
  const out = appendAssessmentAddendum(baseSlot(), true);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].text, 'BASE_PROMPT');
  assert.strictEqual(out[1].text, 'SLOT_ADDENDUM');
  assert.strictEqual(out[2].text, FORMAT_DRAFT_ASSESSMENT_ADDENDUM);
});

test('helper does not mutate its input array', () => {
  const blocks = base();
  appendAssessmentAddendum(blocks, true);
  assert.strictEqual(blocks.length, 1, 'input array untouched');
});

test('addendum text carries the safety-critical instructions', () => {
  const t = FORMAT_DRAFT_ASSESSMENT_ADDENDUM;
  assert.match(t, /"assessment"/, 'instructs source_type "assessment"');
  assert.match(t, /source_id/, 'requires source_id on every claim');
  assert.match(t, /ONLY clinical sources/, 'findings/measures are the only sources');
  assert.match(t, /Reaffirming Rule 1/, 'reaffirms (does not replace) the anti-fabrication rule');
  assert.match(t, /blank/, 'empty section stays blank');
  assert.match(t, /do NOT invent/i, 'never invent / N\\/A / filler');
  assert.match(t, /"client_meta"/, 'instructs the new client_meta source_type for demographic identity');
});

test('version + SHA256 present and SHA matches the exact text', () => {
  assert.match(FORMAT_DRAFT_ASSESSMENT_ADDENDUM_VERSION, /^assessment-addendum-v/);
  assert.match(FORMAT_DRAFT_ASSESSMENT_ADDENDUM_SHA256, /^[0-9a-f]{64}$/);
  const recomputed = crypto.createHash('sha256').update(FORMAT_DRAFT_ASSESSMENT_ADDENDUM, 'utf8').digest('hex');
  assert.strictEqual(FORMAT_DRAFT_ASSESSMENT_ADDENDUM_SHA256, recomputed);
});
