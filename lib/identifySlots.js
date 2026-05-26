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

const SLOT_ID_SYSTEM_PROMPT = `You are Cue's format slot identifier. You are given a deterministic structural outline of a clinician's report template (page blocks; tables with rows and cells; the verbatim text currently in each location). The template was authored for one client; your job is to identify which locations hold PER-CLIENT VARIABLE CONTENT (content slots) versus STRUCTURAL STATIC TEXT that is reused verbatim for every client (column headers, fixed labels, institution name, etc.).

For every CONTENT SLOT, emit an entry with:
- slot_id: a unique snake_case id (e.g. "client_name", "pd", "row_goal", "row_activities")
- location: { "block": N } for a top-level paragraph, or { "block": N, "row": R, "cell": C } for a table cell (indices exactly as given in the outline)
- semantic_label: ONE of — client_name, age_gender, provisional_diagnosis, registration_number, date, clinician_name, serial_number, skill_domain, goal_statement, baseline, activity_descriptions, techniques, reinforcement, progress_report, recommendations, summary, other
- repeatable_per_skill_domain: true if this slot is one cell of a table BODY row that repeats once per skill/goal domain (e.g. each Skills/Goals/Activities/Progress row); false otherwise
- notes: optional, <=12 words

For STRUCTURAL STATIC TEXT, emit a static_text entry: { "location": {...}, "text": "<verbatim>" } — these are reproduced unchanged by the renderer.

If the template has a table whose body rows repeat per skill domain, also emit:
- repeatable_table: { "block": N, "header_rows": [<row indices that are fixed headers>], "template_row": R } where R is the single body row to clone per domain. If no repeatable table, set repeatable_table to null.

Rules:
- Be conservative: a location is a content slot only if its text is clearly client-specific (a name, an age, a goal, an activity description, a progress note) OR it is a body-row cell in a repeating table. Fixed column headers, the institution name, and reused labels are static_text.
- A label-and-value paragraph like "Name: Vrishin" is a content slot (the value varies); record the static label prefix in notes.
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
      max_tokens: 4096,
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
