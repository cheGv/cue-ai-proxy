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
- slot_id: a short readable snake_case label — ADVISORY ONLY. Cue recomputes the real slot_id deterministically from (semantic_label, document position); do not agonize over uniqueness or naming. (e.g. "client_name", "provisional_diagnosis")
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
- DECLARED SECTION HEADERS ARE AUTHORITATIVE FOR ROLE. When a section is introduced by a declared heading — a Roman-numeral heading ("I. Background Information:", "II. History:", "III. Assessment Information:", "IV. Summary:", "V. Recommendations:") or an equivalent named heading — the semantic_label of that section's content slot(s) MUST derive from the heading's stated role (content under "I. Background Information:" is background_information; under "II. History:" the relevant *_history role; etc.). NEVER override a declared heading's role by reinterpreting the content beneath it (e.g. do NOT relabel a "Background Information" section as presenting_complaint because its bullets read like complaints). Content-based interpretation is permitted ONLY when there is no declared heading, or the heading is genuinely generic ("Other", "Notes", "Remarks").
- DECLARED HEADING TEXT NEVER VANISHES (extends the rule above; does not weaken it). A paragraph block whose text is ONLY a declared section heading — Roman-numeral ("I. ...", "II. ..."), Arabic-numbered ("1. ...", "2. ..."), or lettered ("a) ...", "(b) ...") — with NO per-client value on the same line is static_text, NOT a content slot. The heading text renders verbatim every time. If a heading and a per-client value share one block (e.g. "I. Background Information: : The child was brought to AIISH..."), that block is a content slot per the "Label: value" rule below, with notes "Label prefix: <full heading text including the numeral/letter>" — the label-prefix mechanism preserves the heading even when the drafter returns an empty value. EITHER WAY, the heading still acts as the AUTHORITATIVE ROLE SIGNAL for the section's content slots (the rule above is unchanged) — what changes here is that the heading TEXT itself is never blanked.
- DEMOGRAPHIC BOUNDARY: fields appearing BEFORE the first declared section heading (Roman-numeral, numbered, or otherwise) are demographic header information. Label them with a specific demographic role (client_name, registration_number, date, clinician_name, age_gender, supervisor_name, or similar) or "other" — NEVER with a clinical-section role (background_information, presenting_complaint, any *_history, or any assessment role).
- LABEL-LIST BOUNDARY: a colon-terminated text fragment that carries NO inline value and is followed by entries belonging to a different role is a STATIC label introducing those entries — emit it as static_text, NOT a slot. (e.g. "Test material administered:" followed by a list of test materials → "Test material administered:" is static_text; the materials below are the slots.)
- EMPTY LOCATIONS ARE NEITHER SLOT NOR STATIC. Do NOT emit any entry (slot OR static_text) for an empty cell, a gutter/spacer column, or a blank row. Emit entries ONLY for locations that actually contain text.
- BORDERLINE LABELS: when a line could fit more than one role, choose the role of its governing section heading (per the authoritative-header rule). Distinguish sensory_assessment (sensory-specific findings — vision, hearing, tactile, sensory processing) from observed_behavior (general behavioural observation) by the section the line sits under.
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

// ── deterministic canonicalization (Finding E-8) ──────────────────────────────
// The LLM emits semantic_label + location; the slot_id (the substrate-fill join
// key) is NOT trusted from the LLM — it is recomputed here as a pure function of
// (semantic_label, document position). Empty-text locations are dropped, and
// everything is sorted into document order, so the stored map is byte-stable
// across runs regardless of the LLM's free-form naming/ordering nondeterminism.
function textAtLocation(geometry, loc) {
  if (!loc || loc.block == null) return '';
  const block = (geometry.structure || [])[loc.block];
  if (!block) return null; // unresolvable — keep (cannot verify emptiness)
  if (loc.row != null && loc.cell != null) {
    if (block.type !== 'table') return '';
    const row = (block.rows || [])[loc.row];
    const cell = row && (row.cells || [])[loc.cell];
    return cell ? cellText(cell) : '';
  }
  return block.type === 'paragraph' ? paragraphText(block) : '';
}
function locTriple(loc) {
  return [
    loc && loc.block != null ? loc.block : 1e9,
    loc && loc.row != null ? loc.row : -1,
    loc && loc.cell != null ? loc.cell : -1,
    loc && loc.field_idx != null ? loc.field_idx : -1,
  ];
}
function byDocOrder(a, b) {
  const A = locTriple(a.location || {});
  const B = locTriple(b.location || {});
  return A[0] - B[0] || A[1] - B[1] || A[2] - B[2] || A[3] - B[3];
}
function canonicalSlotId(label, loc) {
  const base = label || 'slot';
  const l = loc || {};
  if (l.row != null && l.cell != null) return `${base}_${l.block}_${l.row}_${l.cell}`;
  // E-14: paragraph slot with field_idx — disambiguates multi-field demographic
  // lines packing several "Label: value" pairs into one paragraph.
  if (l.field_idx != null) return `${base}_${l.block != null ? l.block : 'x'}_f${l.field_idx}`;
  return `${base}_${l.block != null ? l.block : 'x'}`;
}
function canonicalizeSlotMap(map, geometry) {
  const slots = [];
  const used = new Map();
  for (const s of map.slots || []) {
    if (textAtLocation(geometry, s.location || {}) === '') continue; // resolvable + empty → drop
    let id = canonicalSlotId(s.semantic_label, s.location);
    if (used.has(id)) { const n = used.get(id) + 1; used.set(id, n); id = `${id}_${n}`; } else used.set(id, 1);
    slots.push(Object.assign({}, s, { slot_id: id }));
  }
  slots.sort(byDocOrder);
  const staticText = (map.static_text || []).filter((st) => String(st.text == null ? '' : st.text).replace(/\s+/g, ' ').trim() !== '');
  staticText.sort(byDocOrder);
  return { slots, static_text: staticText, repeatable_table: map.repeatable_table || null };
}

// ── E-14: post-LLM multi-field paragraph decomposition ──────────────────────
// A demographic header line that packs multiple "Label: value" fields into one
// paragraph (e.g. "Case Name: ... Date of report: ... Age/Gender: ...") is
// identified by the LLM as ONE slot — under-decomposed, with all but one
// field's worth of data effectively lost at render time (Finding E-14).
// Detection is purely geometric: the paragraph's runs[] match the alternating
// pattern (bold-label-ending-in-colon, regular-value) with N ≥ 2 pairs. When
// matched, all LLM-emitted slots at that paragraph block are DISCARDED and
// replaced with N field_idx-keyed slots — one per (label, value) pair.
//
// Each new slot's semantic_label is derived from the bold-label text via a
// small lookup table of common demographic headers. Unmatched labels fall back
// to the LLM's original semantic_label for that block (or 'other' if the LLM
// emitted nothing at that block).
//
// Principle (E-8): the LLM owns semantics for SINGLE-field paragraphs (it
// picks the best label for "Provisional diagnosis:" etc.); the deterministic
// decomposer owns identity for MULTI-field paragraphs (the geometric pattern
// is unambiguous; the lookup table covers common labels; uncommon labels
// inherit the LLM's best guess rather than dropping data).

// Lookup is case-insensitive against the bold-label text with leading bullets,
// trailing colons, and surrounding whitespace stripped.
const LABEL_TO_SEMANTIC = {
  // names
  'name': 'client_name',
  'case name': 'client_name',
  'client name': 'client_name',
  'patient name': 'client_name',
  // dates
  'date': 'date',
  'date of report': 'date',
  'report date': 'date',
  'date of assessment': 'date_of_assessment',
  'assessment date': 'date_of_assessment',
  // demographics
  'age': 'age_gender',
  'age/gender': 'age_gender',
  'age / gender': 'age_gender',
  'gender': 'age_gender',
  'sex': 'age_gender',
  // clinicians
  'clinician': 'clinician_name',
  'clinician name': 'clinician_name',
  'slp': 'clinician_name',
  'speech-language pathologist': 'clinician_name',
  'supervisor': 'supervisor_name',
  // identifiers
  'registration number': 'registration_number',
  'registration no': 'registration_number',
  'regn no': 'registration_number',
  'reg no': 'registration_number',
  'file no': 'registration_number',
  'id': 'registration_number',
  // language
  'language used': 'other',
  'language': 'other',
  // diagnoses
  'provisional diagnosis': 'provisional_diagnosis',
  'diagnosis': 'provisional_diagnosis',
};

function lookupSemanticLabel(rawLabelText) {
  const key = String(rawLabelText || '')
    .replace(/^[\s•*▪⮚⮜▶◆●○\-]+/, '')   // strip leading bullets/punctuation
    .replace(/:\s*$/, '')                  // strip trailing colon (and trailing space)
    .trim()
    .toLowerCase();
  return LABEL_TO_SEMANTIC[key] || null;
}

// Detect whether a paragraph's runs[] match the multi-field demographic
// pattern: alternating (bold-label-ending-in-colon, regular-value) pairs with
// N ≥ 2 pairs. Returns the pair list on match, null otherwise. A single
// (label, value) pair is NOT multi-field (existing single-slot path handles
// it). A paragraph with an odd number of runs, a non-bold "label" run, a
// bold "label" without a trailing colon, or a bold "value" run is NOT
// multi-field.
function detectMultiFieldRuns(runs) {
  if (!Array.isArray(runs) || runs.length < 4) return null;
  if (runs.length % 2 !== 0) return null;
  const pairs = [];
  for (let i = 0; i < runs.length; i += 2) {
    const labelRun = runs[i];
    const valueRun = runs[i + 1];
    if (!labelRun || !valueRun) return null;
    if (!labelRun.bold) return null;
    const labelText = String(labelRun.text || '');
    if (!/:\s*$/.test(labelText)) return null;
    if (valueRun.bold) return null; // value-runs are regular-weight
    pairs.push({ labelRun, valueRun, labelText: labelText.trim() });
  }
  return pairs.length >= 2 ? pairs : null;
}

// For every multi-field paragraph in the geometry, discard the LLM's slot(s)
// at that block and emit N field_idx-keyed slots — one per (label, value)
// pair, in source-run order. Slots at table cells (with row+cell set) and
// single-field paragraphs are passed through untouched. Returns a new map.
function decomposeMultiFieldParagraphs(map, geometry) {
  const structure = (geometry && geometry.structure) || [];
  // Group LLM-emitted paragraph slots by block — only paragraph slots are
  // candidates (a slot with row+cell is a table cell, unaffected).
  const llmByBlock = new Map();
  for (const s of (map && map.slots) || []) {
    const L = s.location || {};
    if (L.row != null || L.cell != null || L.block == null) continue;
    if (!llmByBlock.has(L.block)) llmByBlock.set(L.block, []);
    llmByBlock.get(L.block).push(s);
  }
  // Detect multi-field blocks. We inspect EVERY paragraph block in the
  // geometry, not just the ones the LLM emitted slots for — because a strict
  // (bold-colon, regular)+ paragraph IS demographic field-packing regardless
  // of whether the LLM correctly identified it as content.
  const multiField = new Map(); // block_idx -> pairs[]
  for (let bi = 0; bi < structure.length; bi++) {
    const block = structure[bi];
    if (!block || block.type !== 'paragraph') continue;
    const pairs = detectMultiFieldRuns(block.runs);
    if (pairs) multiField.set(bi, pairs);
  }
  if (multiField.size === 0) return map; // nothing to decompose

  // Build new slot list: drop LLM paragraph slots at multi-field blocks,
  // emit one field_idx slot per pair.
  const out = [];
  for (const s of (map.slots || [])) {
    const L = s.location || {};
    if (L.block != null && multiField.has(L.block) && L.row == null && L.cell == null) continue;
    out.push(s);
  }
  for (const [bi, pairs] of multiField) {
    const llmSlots = llmByBlock.get(bi) || [];
    const fallbackLabel = (llmSlots[0] && llmSlots[0].semantic_label) || 'other';
    pairs.forEach((p, idx) => {
      const looked = lookupSemanticLabel(p.labelRun.text);
      const label = looked || fallbackLabel;
      out.push({
        semantic_label: label,
        location: { block: bi, field_idx: idx },
        repeatable_per_skill_domain: false,
        notes: `Label prefix: ${p.labelText}`,
      });
    });
  }
  return Object.assign({}, map, { slots: out });
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
      // temperature 0: slot identity must be stable across runs — non-determinism
      // in clinical-template roles is unacceptable (Finding E-7). Was previously
      // unset (API default 1.0).
      temperature: 0,
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
  // E-14: deterministic decomposition of multi-field paragraphs (e.g. demographic
  // header lines packing "Case Name: ... Date of report: ..."). Detected
  // geometrically from runs[]; LLM slots at those blocks are replaced with
  // field_idx-keyed slots. No-op for templates without multi-field paragraphs.
  const decomposed = decomposeMultiFieldParagraphs(map, geometry);
  // Decouple the substrate-fill join key from the LLM (Finding E-8): recompute
  // slot_id deterministically, drop empty locations, sort into document order.
  const canonical = canonicalizeSlotMap(decomposed, geometry);
  return {
    engine: 'format-identify-slots',
    model,
    identified_at: new Date().toISOString(),
    slots: canonical.slots,
    static_text: canonical.static_text,
    repeatable_table: canonical.repeatable_table,
    usage: { input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 },
  };
}

module.exports = {
  identifySlots,
  SLOT_ID_MODEL,
  _internals: {
    buildOutline,
    firstTextBlock,
    stripFence,
    canonicalizeSlotMap,
    textAtLocation,
    canonicalSlotId,
    locTriple,
    // E-14
    detectMultiFieldRuns,
    decomposeMultiFieldParagraphs,
    lookupSemanticLabel,
    LABEL_TO_SEMANTIC,
  },
};
