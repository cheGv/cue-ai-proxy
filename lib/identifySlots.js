// lib/identifySlots.js
//
// Phase D week 3 — Cue Mirror content-slot bridge: LLM-aided slot identification.
//
// Given the deterministic geometry (extractGeometry output), identify which
// locations are per-client CONTENT SLOTS vs STRUCTURAL STATIC TEXT, label each
// slot's semantic role, and flag table rows that repeat per skill domain.
//
// No rendered page image is required (none is produced on this host — no
// LibreOffice). The structured geometry's own cell/paragraph text + layout is
// sufficient signal for the LLM. Pure-ish: takes geometry + { apiKey }, returns
// the slot map. Anthropic only — no DB, no Supabase. Errors are THROWN with the
// real message (never swallowed) so callers can surface them.

const SLOT_ID_MODEL = 'claude-opus-4-5';

const SLOT_ID_SYSTEM_PROMPT = `You are Cue's format slot identifier. You are given a deterministic structural outline of a clinician's report template (page blocks, in order; tables with rows and cells; the verbatim text currently in each location). The template was authored for ONE past client; identify which locations hold PER-CLIENT VARIABLE CONTENT (content slots) versus STRUCTURAL STATIC TEXT reused verbatim for every client (institution name, section headings, fixed column headers, fixed labels).

Templates come in two shapes — handle BOTH:
• TABLE-DRIVEN (e.g. a lesson-plan grid): most slots are table cells; body rows may repeat per skill domain.
• NARRATIVE (e.g. a pre-therapy assessment): most slots are PARAGRAPHS. Each "Label: value" line (e.g. "Birth weight: 3.4 kg", "Sucking – Achieved") is a content slot whose VALUE varies per client; Roman-numeral section headings ("I. Background Information:", "II. History:") are STATIC. Small embedded tables ("mini-tables", e.g. a Linguistic-skills grid) have content cells that are slots.

For every CONTENT SLOT, emit an entry with:
- slot_id: unique snake_case (e.g. "client_name", "provisional_diagnosis", "prenatal_history", "oro_facial_examination", "row_goals")
- location_type: "cell" | "paragraph" | "mini_table_cell"
- location: { "block": N } for a paragraph slot; { "block": N, "row": R, "cell": C } for a table cell OR mini-table cell (indices exactly as in the outline)
- semantic_label: the best-fitting role —
  client_name, age_gender, gender, registration_number, date, clinician_name, supervisor_name, provisional_diagnosis,
  background_information, presenting_complaint, prenatal_history, birth_history, neonatal_history, postnatal_history, developmental_milestones, motor_milestones, speech_language_milestones, family_history, educational_history,
  oro_facial_examination, vegetative_skills, prerequisite_skills, linguistic_skills, motor_assessment, social_pragmatic_skills, behavioral_assessment, observed_behavior, sensory_assessment, reinforcement, ot_consultation,
  serial_number, skill_domain, goal_statement, baseline, activity_descriptions, techniques, progress_report,
  summary, recommendations, other
- repeatable_per_skill_domain: true ONLY for a table BODY-row cell that repeats once per skill/goal domain; false otherwise (ALL narrative paragraph slots are false)
- notes: optional, <=12 words. For a "Label: value" slot, record the label prefix here (e.g. "Label prefix: Birth weight:").

For STRUCTURAL STATIC TEXT, emit a static_text entry: { "location": {...}, "text": "<verbatim>" } — reproduced unchanged by the renderer.

If a table's body rows repeat per skill domain, also emit:
- repeatable_table: { "block": N, "header_rows": [<fixed header row indices>], "template_row": R }. Otherwise null. (Narrative templates and fixed-size mini-tables have NO repeatable_table.)

Rules:
- A location is a content slot only if its value is clearly client-specific. Section headings, the institution name, and fixed labels are static_text.
- A "Label: value" paragraph or cell is a content slot (the VALUE varies); put the label in notes so the renderer keeps the label and swaps only the value.
- Be THOROUGH on narrative templates: every per-client value line is its own paragraph slot (there may be many dozens).
- Output ONLY a single JSON object. No prose, no markdown fences. Schema:
{ "slots": [ ... ], "static_text": [ ... ], "repeatable_table": { ... } | null }`;

// ── outline builder ──────────────────────────────────────────────────────────
function runText(runs) {
  return (runs || []).map((r) => (r && r.text != null ? String(r.text) : '')).join('');
}
function paragraphText(block) {
  return runText(block.runs).replace(/\s+/g, ' ').trim();
}
function cellText(cell) {
  const parts = [];
  for (const cb of cell.content || []) {
    if (cb.type === 'paragraph') parts.push(paragraphText(cb));
    else if (cb.type === 'table') parts.push('[nested table]');
  }
  return parts.join(' / ').replace(/\s+/g, ' ').trim();
}
function clip(s, n) {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function buildOutline(geometry) {
  const lines = [];
  const ps = geometry.page_setup || {};
  lines.push(`PAGE: ${ps.width}x${ps.height} ${ps.orientation}; default font ${(geometry.default_font || {}).family || '?'}`);
  const structure = geometry.structure || [];
  for (let i = 0; i < structure.length; i++) {
    const block = structure[i];
    if (block.type === 'paragraph') {
      const t = paragraphText(block);
      lines.push(`block ${i} [paragraph]: ${t === '' ? '(empty)' : '"' + clip(t, 160) + '"'}`);
    } else if (block.type === 'table') {
      const grid = block.grid || [];
      lines.push(`block ${i} [table]: ${grid.length} columns (widths ${JSON.stringify(grid)}), ${block.rows.length} rows`);
      for (let r = 0; r < block.rows.length; r++) {
        const cells = block.rows[r].cells || [];
        const cellStrs = cells.map((c, ci) => {
          const span = c.gridSpan && c.gridSpan > 1 ? `(span ${c.gridSpan})` : '';
          const vm = c.vMerge ? `(vmerge ${c.vMerge})` : '';
          return `cell ${ci}${span}${vm}: "${clip(cellText(c), 90)}"`;
        });
        lines.push(`  row ${r}: ${cellStrs.join(' | ')}`);
      }
    }
  }
  return lines.join('\n');
}

function firstTextBlock(data) {
  if (!data || !Array.isArray(data.content)) return '';
  const t = data.content.find((b) => b && b.type === 'text');
  return t ? t.text : '';
}
function stripFence(s) {
  return String(s).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

async function identifySlots(geometry, opts = {}) {
  const { apiKey, model = SLOT_ID_MODEL, fetchImpl = fetch } = opts;
  if (!apiKey) throw new Error('identifySlots: apiKey is required');
  if (!geometry || !Array.isArray(geometry.structure)) {
    throw new Error('identifySlots: geometry.structure is required');
  }

  const outline = buildOutline(geometry);
  const userText =
    'Identify the content slots and static text for this template. Output ONLY the JSON object.\n\nOUTLINE:\n' + outline;

  const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      system: [{ type: 'text', text: SLOT_ID_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText }],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`identifySlots anthropic ${resp.status}: ${(data && data.error && data.error.message) || 'unknown'}`);
  }
  const text = firstTextBlock(data);
  let map;
  try {
    map = JSON.parse(stripFence(text));
  } catch (e) {
    throw new Error(`identifySlots parse failed: ${e.message}; head: ${clip(text, 240)}`);
  }
  if (!map || !Array.isArray(map.slots)) {
    throw new Error('identifySlots: model output missing slots[] array');
  }
  return {
    engine: 'format-identify-slots',
    model,
    identified_at: new Date().toISOString(),
    slots: map.slots,
    static_text: Array.isArray(map.static_text) ? map.static_text : [],
    repeatable_table: map.repeatable_table || null,
    usage: { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 },
  };
}

module.exports = { identifySlots, SLOT_ID_MODEL, _internals: { buildOutline, firstTextBlock, stripFence } };
