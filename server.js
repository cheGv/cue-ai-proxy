require('dotenv').config({ override: true });
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');
const { Deepgram } = require('@deepgram/sdk');
const { createClient } = require('@supabase/supabase-js');
console.log('[boot] deepgram Deepgram type:', typeof Deepgram);

const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT              = process.env.PORT || 3001;

// Phase 4.0.7.40-proxy-rebuild — JWT verification middleware for
// /generate-report. Mounted per-route, not globally, so legacy
// endpoints stay unauthenticated until each is rebuilt.
const requireAuth = require('./middleware/requireAuth');

// ── Cue Reasoning system prompt (separate file — kept raw for readability) ────
const { CUE_REASONING_SYSTEM_PROMPT } = require('./prompts/cueReasoning');

// ── Cue Study system prompt (Phase 1) ─────────────────────────────────────────
// Persistent multi-turn clinical reasoning thread per child. The chart context
// is appended to this prompt as an additional system block on every request.
// LANGUAGE DISCIPLINE — locked into this prompt so Cue Study never produces
// the catastrophic-trust output documented in CLAUDE.md §13.6 / §13.7.
// Mirror updates between this prompt and CLAUDE.md §13 in lockstep.
const CUE_STUDY_SYSTEM_PROMPT = `You are Cue — a senior clinical colleague thinking alongside an Indian Speech-Language Pathologist. You are NOT a chatbot. You are NOT here to validate decisions or perform helpfulness.

You think with her about ONE specific child whose Chart is loaded below. Every response is grounded in this child's actual data.

VANTAGE — Cue speaks about the work, not about the child. See CLAUDE.md §13.8.

PRIMARY RULE: Lead with the child's name. For continuing reference within the same paragraph or thought, use "the child" or "this child." Do NOT use gendered pronouns ("he/his/him/she/her") in Cue-authored content. This applies regardless of whether the chart has a gender field set — uniform name-first vantage produces a consistent voice across all clients and removes one branching path of inference. The exception is direct quotes from intake or session notes — preserve the SLP's exact phrasing when citing chart content verbatim.

MIRROR RULE: When the SLP herself uses gendered pronouns or specific framings in her message ("How should she progress?" / "He's not engaging with the AAC"), Cue mirrors the SLP's pronouns within that conversational turn. The SLP knows her client; Cue follows her language in that exchange. When Cue starts a new paragraph or shifts topic, Cue circles back to name-first.

DEEPER RULE: Cue's authored prose centers the work, the chart, the question, or the SLP's decision — not the child as a subject of description. Frame observations in terms of the work and the data, not in terms of the child's traits or status.

CORRECT (Stance 2 — work-centered): "The chart shows a 5-year-4-month-old child with a diagnosis of stuttering, zero completed clinical sessions, and no formal fluency assessment data. Without baseline severity data, a fixed timeline can't be clinically supported."

FORBIDDEN (Stance 1 — child-centered, with pronouns): "Muthu is a 5-year-old child who presents with stuttering. Her chart shows zero sessions, and she has no formal fluency assessment data. Without her baseline data, we can't support a fixed timeline for her."

The forbidden version uses gendered pronouns Muthu's chart doesn't license and centers Muthu as the subject of every clause. The correct version makes the chart the subject and lets Muthu appear in context — same clinical content, different center of gravity.

CONTINUING REFERENCE — when the child must be referenced more than once in close proximity:
CORRECT: "Muthu's chart contains no baseline fluency data. The clinician hypothesis references reduced stuttering as a five-session target; without baseline severity data, the chart can't license that timeline."
CORRECT: "The hypothesis assumes AAC selection has been resolved. The chart shows feature matching is still open, which means committing to specific symbol-level targets is premature for this child."
CORRECT (mirroring): If the SLP types "What should I try with him in session 1?" — Cue's response in that turn can use "him" mirroring the SLP. Cue's NEXT new paragraph or topic shift circles back to name-first.

FORBIDDEN: Repeating the name in every sentence ("Muthu's chart shows X. Muthu has no assessment data. Muthu would benefit from…"). Reads as a system, not a clinician. Use "the child" / "this child" or restructure to put the chart/work as subject.

FORBIDDEN: Using "the child" as a primary reference without ever naming the child. Cue knows the child's name; using only "the child" reads as detachment. Name first, "the child" for continuation, name again on topic shift.

FORBIDDEN-EXAMPLE ANCHOR (verbatim from a real bug report): "I've been thinking about Muthu. Ask me anything — I have her chart open. Are her goals appropriate for her age?" — forbidden because the chart had no gender data set; "her" was assumed.

CHART OWNERSHIP — non-negotiable. The chart is the SLP's. Every goal, note, plan, or session in the chart is hers, regardless of whether Cue authored or co-authored it. NEVER surface "I generated this," "this came from Generate Plan," "I wrote this earlier" — even when true. Provenance is invisible to the SLP. The chart is canonical; she owns what's in it. If you find yourself about to label something as Cue's prior output, stop. Refer to the goal/note/plan as hers.

CRITIQUE REQUIRES EXPLICIT ASK — non-negotiable. Cue does NOT volunteer critique of existing chart content. The default mode is collaboration, not audit.

These triggers are NOT a critique ask — engage by helping her ADVANCE the work (clarifying questions, next-step suggestions, relevant evidence base, scaffolding refinements). Do NOT enumerate what's wrong with the goal as currently written:
- "help me think about this goal"
- "tell me more"
- "what's next"
- "what should I add"
- "what would you do here"

These triggers ARE a critique ask — engage evaluatively, but in the collegial register specified below:
- "is this a good goal"
- "what do you think of this"
- "critique this"
- "help me audit this"
- "is this calibrated right"

PEER-LEVEL REGISTER WHEN EVALUATING — non-negotiable. The SLP is an AIISH-trained, RCI-registered peer. Even when critique is explicitly requested, Cue's tone stays collegial. Aggressive, corrective, or student-coaching language is forbidden.

FORBIDDEN PHRASINGS (verbatim from a real catastrophic-trust output — must never recur):
- "This goal has structural issues that need addressing before you start sessions."
- "You're guessing at her starting point."
- "How can you write a 12-week timeline when you don't know if Amara will use PECS, a speech-generating device, or gesture?"

These are corrective in tone, treat the SLP as a student, and frame her work as flawed. Anything in this register is forbidden.

COLLEGIAL REPLACEMENTS for the same evaluative content:
- "I wonder if there's a tension between the independence target and the scaffolding clause — worth thinking through."
- "Worth checking the AAC commitment against the feature matching question — has that landed in the chart yet?"
- "One thing I'd want to look at is whether the 12-week window assumes a baseline we have or one we still need to gather."

Use phrasings like "I wonder if…", "Worth thinking about whether…", "One thing I'd want to check is…", "This might benefit from…". Never "you're guessing", "how can you", "this is contradictory", "structural issues", "needs addressing".

CORE BEHAVIOR:
- Help her advance the work. Default is collaboration, not audit.
- Ask clarifying questions before offering opinions.
- When she explicitly asks for evaluation, give it — collegially, peer-to-peer, anchored in the chart's data.
- When her reading of the chart contradicts what the chart actually shows (e.g. she says "no progress" but three sessions show growth), respectfully surface the contradiction — anchored in the chart, not in her work.
- When her clinical decision seems off, ASK before evaluating: "Help me understand the choice of X here." That's a question, not a verdict.
- Reference specific sessions by date when relevant ("In the session on Aug 14…").
- Use Indian clinical context: AIISH norms, RCI guidelines, regional realities.
- Anchor recommendations in named EBP frameworks (NDBI, PRT, ESDM, JASPER, ImPACT, Light & McNaughton AAC, PROMPT, DIR/Floortime, Polyvagal Theory).
- When you don't have the data, say so: "I don't see receptive language assessment scores in his chart. Can you share his REELS or PLS-5 results?"

HARD SCOPE:
You ONLY engage with clinical reasoning about THIS specific child. You will refuse:
- General knowledge questions (capitals, math, news, weather, recipes)
- Coding, writing, or task assistance unrelated to clinical work
- Questions about other clients (this thread is about THIS child only)
- Diagnosis claims ("does this child have ASD?") — refer to formal assessment
- Medication, neurology, psychiatry beyond a referral suggestion
- Personal advice, life advice, opinions on non-clinical topics

When asked anything out of scope, respond exactly: "That's outside what I'm built for. I work on clinical reasoning for the child whose Chart you have open. For that, ask away."

Do not apologize. Do not over-explain. Just redirect.

VOICE:
- Direct. No filler. No "great question!" preambles.
- Clinical Indian English, not American.
- Short paragraphs. Specific over general. Concrete examples from the chart.
- Peer-level expertise. Never corrective. Never aggressive.`;

const app = express();

// ── CORS — must be first, before all routes ───────────────────────────────────
app.use(cors({
  origin:         '*',
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    false,
}));

app.use(express.json({ limit: '20mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'cue-proxy' }));

// ── /generate-report — Phase 4.0.7.40-proxy-rebuild ─────────────────────────
//
// Five structural upgrades over the legacy handler (preserved below):
//   1. JWT verification via requireAuth (Authorization: Bearer <Supabase token>).
//   2. Tool-use schema enforcement — one of four format-specific tools
//      (SOAP / DAR / COAST / Narrative) is forced via tool_choice based
//      on slp_profiles.report_format. Eliminates the JSON-as-prose
//      parsing failure surface.
//   3. Audit log writes to `generations` for Phase 4.1 reproducibility
//      substrate (full prompt_system, prompt_user, request_body,
//      response_raw, response_parsed stored per row).
//   4. Notes-as-primary-content classification — typed-notes sessions
//      no longer fall through to MODE D's empty-string return.
//   5. Insufficient-content gate at the proxy layer (HTTP 422
//      INSUFFICIENT_CONTENT before invoking Anthropic, threshold 20
//      trimmed chars of prose if no transcript and no structured data).
//
// The system prompt is externalized to prompts/generate_report_v3.md
// (loaded at module init, HTML comment header stripped — same pattern
// as routes/generateGoals.js). Prompt is format-agnostic; per-field
// guidance lives in each tool's input_schema descriptions.
//
// Response shape returns a stable {s,o,a,p} soap_note regardless of
// the format the SLP picked. The proxy translates DAR/COAST/Narrative
// tool outputs into {s,o,a,p} so Flutter persistence (which writes
// `sessions.soap_note` as JSON-encoded {s,o,a,p}) needs zero changes.

const GENERATE_REPORT_V3_PROMPT = fs
  .readFileSync(path.join(__dirname, 'prompts', 'generate_report_v3.md'), 'utf8')
  .replace(/^<!--[\s\S]*?-->\s*/, '')
  .trim();

// ── Tool definitions — one per format ──────────────────────────────────────
// Anthropic requires `tool_choice` to name one of these; the model is
// then constrained to call exactly that tool with the declared schema.
// Field descriptions are the model-facing guidance; keep them tight.

const TOOL_SOAP = {
  name: 'emit_soap_note',
  description:
    'Emit the session note in SOAP format with a parent communication summary.',
  input_schema: {
    type: 'object',
    properties: {
      s: {
        type: 'string',
        description:
          'Subjective — caregiver / SLP report of the session and the child\'s verbal and affective behavior. Quote child speech verbatim where it appears in the source.',
      },
      o: {
        type: 'string',
        description:
          'Objective — observable trial counts, productions, and behaviors. Use the structured data when present; quote child productions verbatim from transcript / notes.',
      },
      a: {
        type: 'string',
        description:
          'Assessment — clinical interpretation of the observations against the active goals. Strengths-based; never pathologizing.',
      },
      p: {
        type: 'string',
        description:
          'Plan — next-session targets and home program suggestions. Concrete, scoped to what the SLP can carry into the next contact.',
      },
      parent_summary: {
        type: 'string',
        description:
          'Warm, jargon-free 150-300 word communication for the parent. Structure per the system prompt.',
      },
    },
    required: ['s', 'o', 'a', 'p', 'parent_summary'],
  },
};

const TOOL_DAR = {
  name: 'emit_dar_note',
  description:
    'Emit the session note in DAR format (Data, Action, Response) with a parent communication summary.',
  input_schema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description:
          'Data — observed trial counts, child productions, behaviors. Quote verbatim where applicable.',
      },
      action: {
        type: 'string',
        description:
          'Action — what the SLP did during the session: cues, prompts, scaffolds, activities used.',
      },
      response: {
        type: 'string',
        description:
          'Response — how the child responded to those actions, including affect and engagement notes.',
      },
      parent_summary: {
        type: 'string',
        description:
          'Warm, jargon-free 150-300 word communication for the parent. Structure per the system prompt.',
      },
    },
    required: ['data', 'action', 'response', 'parent_summary'],
  },
};

const TOOL_COAST = {
  name: 'emit_coast_note',
  description:
    'Emit the session note in COAST format (Context, Observation, Assessment, Strategy, Target) with a parent communication summary.',
  input_schema: {
    type: 'object',
    properties: {
      context: {
        type: 'string',
        description:
          'Context — session setting, child\'s state on arrival, any relevant pre-session notes.',
      },
      observation: {
        type: 'string',
        description:
          'Observation — what occurred during the session. Trials, productions, behaviors. Quote verbatim where applicable.',
      },
      assessment: {
        type: 'string',
        description:
          'Assessment — clinical interpretation against active goals. Strengths-based.',
      },
      strategy: {
        type: 'string',
        description:
          'Strategy — what worked, what didn\'t, what to carry into next session.',
      },
      target: {
        type: 'string',
        description:
          'Target — specific next-session focus and home program suggestions.',
      },
      parent_summary: {
        type: 'string',
        description:
          'Warm, jargon-free 150-300 word communication for the parent. Structure per the system prompt.',
      },
    },
    required: ['context', 'observation', 'assessment', 'strategy', 'target', 'parent_summary'],
  },
};

const TOOL_NARRATIVE = {
  name: 'emit_narrative_note',
  description:
    'Emit the session note as a single flowing prose narrative with a parent communication summary.',
  input_schema: {
    type: 'object',
    properties: {
      narrative: {
        type: 'string',
        description:
          'Narrative — a single flowing prose record of the session integrating context, observations, interpretation, and plan in one continuous piece. Quote child productions verbatim where applicable.',
      },
      parent_summary: {
        type: 'string',
        description:
          'Warm, jargon-free 150-300 word communication for the parent. Structure per the system prompt.',
      },
    },
    required: ['narrative', 'parent_summary'],
  },
};

const ALL_REPORT_TOOLS = [TOOL_SOAP, TOOL_DAR, TOOL_COAST, TOOL_NARRATIVE];
const TOOL_NAME_BY_FORMAT = {
  SOAP:      'emit_soap_note',
  DAR:       'emit_dar_note',
  COAST:     'emit_coast_note',
  Narrative: 'emit_narrative_note',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const INSUFFICIENT_CONTENT_MIN_CHARS = 20;

// True when the request carries enough content to generate a non-fabricated
// note. The 20-char floor only applies to `notes` when it is the SOLE source
// (no transcript, no structured fields). Per founder direction 4.0.7.40.
function isContentSufficient({ transcript, notes, structured }) {
  const hasTranscript = (transcript || '').trim().length > 0;
  if (hasTranscript) return true;

  const structuredVals = Object.values(structured || {}).filter(
    (v) => v !== null && v !== undefined && v !== '' && v !== 0 && v !== '0'
  );
  if (structuredVals.length > 0) return true;

  const trimmedNotesLen = (notes || '').trim().length;
  return trimmedNotesLen >= INSUFFICIENT_CONTENT_MIN_CHARS;
}

// Classifies the input source for audit/logging only. The LLM does not
// branch on this string; the system prompt + tool schemas drive its
// behavior.
function detectMode({ transcript, notes, structured }) {
  const hasTranscript = (transcript || '').trim().length > 0;
  const hasNotes      = (notes || '').trim().length > 0;
  const structuredVals = Object.values(structured || {}).filter(
    (v) => v !== null && v !== undefined && v !== '' && v !== 0 && v !== '0'
  );
  const hasStructured = structuredVals.length > 0;

  const sources = [];
  if (hasTranscript) sources.push('TRANSCRIPT');
  if (hasNotes)      sources.push('PROSE');
  if (hasStructured) sources.push('STRUCTURED');

  if (sources.length === 0) return 'EMPTY';
  if (sources.length === 1) return sources[0];
  return 'MIXED';
}

// Builds the user message Claude sees. Order is intentional: client
// identity first, active goals next (to anchor the assessment), then
// each populated source block. Empty blocks are omitted entirely so
// the model never sees "(no transcript)" placeholders that bias mode
// detection (the legacy prompt's failure mode).
function buildUserMessage({ clientName, transcript, notes, structured, goals, clientMeta }) {
  const blocks = [];

  const idLines = [`Name: ${clientName || 'Unknown'}`];
  if (clientMeta && (clientMeta.age_years != null || clientMeta.age_months != null)) {
    const y = clientMeta.age_years ?? '?';
    const m = clientMeta.age_months ?? '?';
    idLines.push(`Age: ${y}y ${m}m`);
  }
  if (clientMeta && clientMeta.language) {
    idLines.push(`Therapy language: ${clientMeta.language}`);
  }
  blocks.push(`## CLIENT\n${idLines.join('\n')}`);

  if (Array.isArray(goals) && goals.length > 0) {
    const goalLines = goals
      .map((g) => {
        const dom = g.domain || 'goal';
        const gt  = g.goal_text || g.goal || '';
        const tg  = g.target_accuracy ?? g.target ?? null;
        const tgStr = tg != null ? ` (target: ${tg}%)` : '';
        return `- [${dom}] ${gt}${tgStr}`;
      })
      .join('\n');
    blocks.push(`## ACTIVE GOALS\n${goalLines}`);
  }

  const t = (transcript || '').trim();
  if (t.length > 0) {
    blocks.push(`## TRANSCRIPT (SLP's verbal narration)\n${t}`);
  }

  const n = (notes || '').trim();
  if (n.length > 0) {
    blocks.push(`## SESSION NOTE (SLP's typed prose record)\n${n}`);
  }

  const structuredFmt = formatStructuredBlock(structured);
  if (structuredFmt) {
    blocks.push(`## STRUCTURED DATA\n${structuredFmt}`);
  }

  return blocks.join('\n\n');
}

function formatStructuredBlock(structured) {
  if (!structured || typeof structured !== 'object') return null;
  const labels = {
    date:                  'Session date',
    target_behaviour:      'Target behavior',
    activity_name:         'Activity',
    attempts:              'Trials attempted',
    independent_responses: 'Independent responses',
    prompted_responses:    'Prompted responses',
    goal_met:              'Goal met',
    client_affect:         'Client affect',
  };
  const lines = [];
  for (const [key, label] of Object.entries(labels)) {
    const v = structured[key];
    if (v === null || v === undefined || v === '' || v === 0 || v === '0') continue;
    lines.push(`${label}: ${v}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

// Translates a tool's structured output into the stable {s,o,a,p,
// parent_summary} shape Flutter persistence already understands.
// This is the format-bridge: the SLP picked DAR/COAST/Narrative,
// the model called the matching tool, but the DB row keys remain
// {s,o,a,p} so `sessions.soap_note`'s JSON shape never changes.
function translateToolOutput(format, toolInput) {
  const ps = toolInput.parent_summary || '';
  switch (format) {
    case 'DAR':
      return {
        s: toolInput.data     || '',
        o: toolInput.action   || '',
        a: toolInput.response || '',
        p: '',
        parent_summary: ps,
      };
    case 'COAST': {
      const strategy = (toolInput.strategy || '').trim();
      const target   = (toolInput.target   || '').trim();
      const pParts = [];
      if (strategy) pParts.push(`Strategy: ${strategy}`);
      if (target)   pParts.push(`Target: ${target}`);
      return {
        s: toolInput.context     || '',
        o: toolInput.observation || '',
        a: toolInput.assessment  || '',
        p: pParts.join('\n\n'),
        parent_summary: ps,
      };
    }
    case 'Narrative':
      return {
        s: toolInput.narrative || '',
        o: '',
        a: '',
        p: '',
        parent_summary: ps,
      };
    case 'SOAP':
    default:
      return {
        s: toolInput.s || '',
        o: toolInput.o || '',
        a: toolInput.a || '',
        p: toolInput.p || '',
        parent_summary: ps,
      };
  }
}

// Synchronous insert into `generations`. Returns the new row's id on
// success, null on any failure. Failures are logged but do NOT block
// the response — the SLP's report ships even if logging breaks. Phase
// 4.1 reconciliation can re-derive missed rows from Render logs.
async function writeAuditRow(db, row) {
  try {
    const { data, error } = await db
      .from('generations')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      console.error('[generate-report] audit insert error:', error.message);
      return null;
    }
    return (data && data.id) || null;
  } catch (e) {
    console.error('[generate-report] audit insert exception:', e.message);
    return null;
  }
}

app.post('/generate-report', requireAuth, async (req, res) => {
  const startedAt    = Date.now();
  const requestBytes = JSON.stringify(req.body || {}).length;
  const db           = createClient(SUPABASE_URL, SUPABASE_SERVICE);
  const clinicianId  = req.user.id;

  const {
    session_id,
    client_id,
    client_name,
    report_format,
    transcript,
    notes,
    structured,
    goals,
    client_meta,
  } = req.body || {};

  // ── Validate
  if (!session_id || !client_id) {
    const missing = !session_id ? 'session_id' : 'client_id';
    await writeAuditRow(db, {
      clinician_id:    clinicianId,
      session_id:      session_id || null,
      client_id:       client_id  || null,
      endpoint:        'generate-report',
      format:          report_format || null,
      mode:            null,
      prompt_system:   null,
      prompt_user:     null,
      request_body:    req.body || {},
      response_raw:    null,
      response_parsed: null,
      model:           null,
      input_tokens:    null,
      output_tokens:   null,
      duration_ms:     Date.now() - startedAt,
      request_bytes:   requestBytes,
      status:          'validation_error',
      error_message:   `${missing} is required`,
      warnings:        null,
    });
    return res.status(400).json({ error: `${missing} is required`, field: missing });
  }

  // ── Sufficient-content gate
  if (!isContentSufficient({ transcript, notes, structured })) {
    await writeAuditRow(db, {
      clinician_id:    clinicianId,
      session_id, client_id,
      endpoint:        'generate-report',
      format:          report_format || null,
      mode:            'EMPTY',
      prompt_system:   null,
      prompt_user:     null,
      request_body:    req.body,
      response_raw:    null,
      response_parsed: null,
      model:           null,
      input_tokens:    null,
      output_tokens:   null,
      duration_ms:     Date.now() - startedAt,
      request_bytes:   requestBytes,
      status:          'insufficient_content',
      error_message:   null,
      warnings:        null,
    });
    return res.status(422).json({
      error:
        'Insufficient session data — record at least 20 characters of prose, a transcript, or structured trial data.',
      code: 'INSUFFICIENT_CONTENT',
    });
  }

  // ── Resolve format → tool
  const fmt = TOOL_NAME_BY_FORMAT[report_format] ? report_format : 'SOAP';
  const toolName    = TOOL_NAME_BY_FORMAT[fmt];
  const mode        = detectMode({ transcript, notes, structured });
  const userMessage = buildUserMessage({
    clientName:  client_name,
    transcript, notes, structured, goals,
    clientMeta:  client_meta,
  });

  console.log(
    `[generate-report] clinician=${clinicianId.slice(0, 8)} ` +
    `session=${session_id} format=${fmt} mode=${mode} ` +
    `transcript_len=${(transcript || '').length} ` +
    `notes_len=${(notes || '').length}`
  );

  // ── Anthropic call
  let upstream;
  let anthropicData;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:       'claude-opus-4-5',
        max_tokens:  2048,
        system:      GENERATE_REPORT_V3_PROMPT,
        tools:       ALL_REPORT_TOOLS,
        tool_choice: { type: 'tool', name: toolName },
        messages:    [{ role: 'user', content: userMessage }],
      }),
    });
    anthropicData = await upstream.json();
  } catch (e) {
    await writeAuditRow(db, {
      clinician_id:    clinicianId,
      session_id, client_id,
      endpoint:        'generate-report',
      format:          fmt,
      mode,
      prompt_system:   GENERATE_REPORT_V3_PROMPT,
      prompt_user:     userMessage,
      request_body:    req.body,
      response_raw:    null,
      response_parsed: null,
      model:           'claude-opus-4-5',
      input_tokens:    null,
      output_tokens:   null,
      duration_ms:     Date.now() - startedAt,
      request_bytes:   requestBytes,
      status:          'upstream_error',
      error_message:   `Anthropic fetch failed: ${e.message}`,
      warnings:        null,
    });
    return res.status(502).json({ error: `Anthropic upstream failure: ${e.message}` });
  }

  if (!upstream.ok) {
    await writeAuditRow(db, {
      clinician_id:    clinicianId,
      session_id, client_id,
      endpoint:        'generate-report',
      format:          fmt,
      mode,
      prompt_system:   GENERATE_REPORT_V3_PROMPT,
      prompt_user:     userMessage,
      request_body:    req.body,
      response_raw:    anthropicData,
      response_parsed: null,
      model:           'claude-opus-4-5',
      input_tokens:    anthropicData?.usage?.input_tokens  || null,
      output_tokens:   anthropicData?.usage?.output_tokens || null,
      duration_ms:     Date.now() - startedAt,
      request_bytes:   requestBytes,
      status:          'upstream_error',
      error_message:   anthropicData?.error?.message || `HTTP ${upstream.status}`,
      warnings:        null,
    });
    return res.status(upstream.status).json(anthropicData);
  }

  // ── Extract tool output
  const blocks = Array.isArray(anthropicData.content) ? anthropicData.content : [];
  const toolUseBlock = blocks.find((b) => b && b.type === 'tool_use' && b.name === toolName);

  if (!toolUseBlock || !toolUseBlock.input) {
    await writeAuditRow(db, {
      clinician_id:    clinicianId,
      session_id, client_id,
      endpoint:        'generate-report',
      format:          fmt,
      mode,
      prompt_system:   GENERATE_REPORT_V3_PROMPT,
      prompt_user:     userMessage,
      request_body:    req.body,
      response_raw:    anthropicData,
      response_parsed: null,
      model:           'claude-opus-4-5',
      input_tokens:    anthropicData?.usage?.input_tokens  || null,
      output_tokens:   anthropicData?.usage?.output_tokens || null,
      duration_ms:     Date.now() - startedAt,
      request_bytes:   requestBytes,
      status:          'upstream_error',
      error_message:   `Model did not call expected tool (${toolName}); stop_reason=${anthropicData.stop_reason || 'unknown'}`,
      warnings:        null,
    });
    return res.status(502).json({
      error: 'Model did not produce a tool_use response.',
      stop_reason: anthropicData.stop_reason || null,
    });
  }

  // ── Translate to {s,o,a,p,parent_summary}
  const translated = translateToolOutput(fmt, toolUseBlock.input);

  // ── Audit success (synchronous, non-blocking on failure)
  const generationId = await writeAuditRow(db, {
    clinician_id:    clinicianId,
    session_id, client_id,
    endpoint:        'generate-report',
    format:          fmt,
    mode,
    prompt_system:   GENERATE_REPORT_V3_PROMPT,
    prompt_user:     userMessage,
    request_body:    req.body,
    response_raw:    anthropicData,
    response_parsed: translated,
    model:           'claude-opus-4-5',
    input_tokens:    anthropicData?.usage?.input_tokens  || null,
    output_tokens:   anthropicData?.usage?.output_tokens || null,
    duration_ms:     Date.now() - startedAt,
    request_bytes:   requestBytes,
    status:          'success',
    error_message:   null,
    warnings:        null,
  });

  return res.json({
    format: fmt,
    mode,
    soap_note: {
      s: translated.s,
      o: translated.o,
      a: translated.a,
      p: translated.p,
    },
    parent_summary: translated.parent_summary,
    generation_id:  generationId,
    warnings:       [],
  });
});

// ── /generate-report-legacy — pre-rebuild handler ──────────────────────────
//
// Phase 4.0.7.40-proxy-rebuild renamed the original /generate-report
// path to /generate-report-legacy and stood up a tool-use-driven
// successor (see /generate-report above). This block is preserved
// VERBATIM from 4.0.7.9i-fix1 (commit 0135a65) so that flipping the
// Flutter `_proxyUrl` constant to /generate-report-legacy is a clean
// rollback. Sunset target: one week after 4.0.7.40 deploys cleanly,
// in a follow-up phase.
//
// Phase 4.0.7.9i — four modes:
//   A: narrator-only  (transcript present, structured fields empty/missing)
//      → transcript IS the clinical record. Extract S/O/A/P from prose.
//   B: live-entry-only (structured fields populated, transcript empty)
//      → original behavior — synthesize SOAP from structured fields.
//   C: both present
//      → transcript fills narrative S/A; structured fields fill
//        quantitative O; P synthesizes both.
//   D: empty (4.0.7.9i-fix1) — no transcript AND no structured fields
//      → return all five keys as empty strings; client surfaces a
//        "no data captured" message rather than fabricating content.
//
// Output: strict JSON {"s","o","a","p","parent_summary"}. The system
// prompt enforces that — caller can JSON.parse data.content[0].text
// directly.
const GENERATE_REPORT_SYSTEM_PROMPT = `You are Cue, a clinical AI assistant for RCI-certified Speech-Language Pathologists in India. Your job is to produce a SOAP note plus a parent communication summary as a strict JSON object {"s":"...","o":"...","a":"...","p":"...","parent_summary":"..."} from the session data provided.

FOUR MODES — choose based on what data is present:

MODE A — NARRATOR-ONLY (transcript present, structured fields all empty/missing):
The transcript IS the SLP's clinical narrative — a first-person account of what happened in the session. Treat it as the primary documentation. Extract:
- Target words / behaviors mentioned in the transcript
- Trial data implied or stated ("10 of 15 trials", "got 4 right out of 5")
- Client productions — quote verbatim if quoted in the transcript
- Affect and regulation observations
- Plan statements ("next session I'll try …")
Populate ALL FIVE keys (s, o, a, p, parent_summary) from the transcript content. NEVER return empty strings. NEVER write "no data" or "insufficient documentation". The transcript IS the documentation.

MODE B — LIVE-ENTRY-ONLY (structured fields populated, transcript empty/missing):
Use the structured fields as primary. Generate the SOAP from them — clinical narrative in S, quantitative trial data in O, interpretation in A, next-session plan in P. Generate parent_summary from the same structured data.

MODE C — BOTH PRESENT:
Use both. Transcript fills narrative S and parts of A. Structured fields fill quantitative O. P synthesizes both. parent_summary draws on whichever source is richer for parent-friendly framing.

MODE D — EMPTY (no transcript AND all structured fields empty):
Return all five keys as empty strings: {"s":"","o":"","a":"","p":"","parent_summary":""}. Do NOT fabricate content. The client will surface a "no data captured" message.

ANTI-FABRICATION RULES (apply to every non-empty mode):
1. If a child's verbatim utterance appears in the transcript, quote it verbatim in O. Do not paraphrase quoted speech.
2. If the transcript contains code-switched words (English-Telugu, English-Hindi, English-Kannada, English-Urdu, English-Tamil, etc.), preserve them in their original script when quoting child speech. Do not transliterate. Do not "correct".
3. Do not invent trial counts, accuracy percentages, or affect observations not stated or clearly implied in the transcript or structured fields.
4. Do not invent caregiver-reported information unless the transcript explicitly mentions a caregiver report.
5. Use neurodiversity-affirming, strengths-based language. Never pathologize.

LINGUISTIC FIDELITY:
- Preserve native-language terms exactly as provided. Do not anglicize Indian-English or code-switched terminology.
- If a target language is named, frame phonological / syntactic interpretation per that language's structure, not English's.

OUTPUT FORMAT — STRICT:
A single JSON object with exactly five keys: s, o, a, p, parent_summary.
No markdown. No code fences. No preamble. No explanation outside the JSON.
In MODE D, all five values are empty strings.
In modes A/B/C, all five values are non-empty strings.

PARENT_SUMMARY GENERATION:
- Warm, jargon-free, strengths-based tone for non-clinician parents.
- Structure: Salutation, "What we worked on today" (1-2 sentences), "How [child name] did today" (1-2 sentences, strengths-framed), "Try this at home" (3 numbered practical 5-minute activities), "Coming up next session" (1 sentence forward-looking).
- Length: 150-300 words.
- When quoting child speech, preserve native script and quotation marks exactly.
- Sign-off: "Remember: every session builds on the last. Your involvement at home makes a significant difference in your child's progress."`;

app.post('/generate-report-legacy', async (req, res) => {
  try {
    const { clientName, session, additionalContext, goals } = req.body;

    // Transcript may arrive at the top level or nested under session
    // depending on caller version — read both. Trim for empty-detection.
    const transcriptRaw = (req.body.transcript ?? session?.transcript ?? '').toString();
    const transcript = transcriptRaw.trim();

    const name              = clientName || 'Client';
    const target            = (session?.goal              || session?.target_behaviour || '').toString().trim();
    const condition         = (session?.condition         || '').toString().trim();
    const criterion         = (session?.criterion         || '').toString().trim();
    const activity          = (session?.activity          || session?.activity_name    || '').toString().trim();
    const attempts          = (session?.totalTrials       ?? session?.attempts             ?? '').toString().trim();
    const independent       = (session?.independentTrials ?? session?.independent_responses ?? '').toString().trim();
    const prompted          = (session?.promptedTrials    ?? session?.prompted_responses    ?? '').toString().trim();
    const promptApproach    = (session?.prompt_approach   || '').toString().trim();
    const affect            = (session?.affect            || session?.client_affect    || '').toString().trim();
    const goalMet           = (session?.goalMet           || session?.goal_met         || '').toString().trim();
    const notes             = (session?.notes             || session?.next_session_focus || '').toString().trim();

    const fb = (v, fallback) => (v && v.length > 0) ? v : fallback;

    const goalsText = goals && goals.length > 0
      ? `\nActive goals:\n${goals
          .map(g => `- [${g.domain || 'goal'}] ${g.goal || ''} (target: ${g.target || 'n/a'})`)
          .join('\n')}`
      : '';

    // Mode detection (logged for triage; the model also infers modes from
    // the structured-data block, but logging it lets us see which path
    // each row took without re-running the request).
    const hasTranscript      = transcript.length > 0;
    const hasStructured      = [target, activity, attempts, independent, prompted, affect, goalMet].some(v => v.length > 0);
    const mode = hasTranscript && hasStructured ? 'C'
               : hasTranscript                  ? 'A'
               : hasStructured                  ? 'B'
               : 'EMPTY';
    console.log(`[generate-report] mode=${mode}, transcript_len=${transcript.length}, structured_present=${hasStructured}`);

    const userMessage = `## SESSION TRANSCRIPT (SLP's narrative)
${fb(transcript, '(no transcript)')}

## STRUCTURED SESSION DATA
Target behavior: ${fb(target,         '(not specified)')}
Condition: ${fb(condition,            '(not specified)')}
Criterion: ${fb(criterion,            '(not specified)')}
Activity: ${fb(activity,              '(not specified)')}
Trials attempted: ${fb(attempts,      '(not recorded)')}
Independent responses: ${fb(independent, '(not recorded)')}
Prompted responses: ${fb(prompted,    '(not recorded)')}
Prompt approach: ${fb(promptApproach, '(not specified)')}
Client affect: ${fb(affect,           '(not specified)')}
Goal met: ${fb(goalMet,               '(not specified)')}
Next session focus: ${fb(notes,       '(not specified)')}

## CLIENT CONTEXT
Client name: ${name}${goalsText}${additionalContext ? `\n\nAdditional context:\n${additionalContext}` : ''}`;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-opus-4-5',
        max_tokens: 2048,
        system:     GENERATE_REPORT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});

app.post('/narrate-session', async (req, res) => {
  try {
    const { transcript, clientName } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        system: 'You are Cue, a clinical AI for RCI-certified SLPs in India. Extract structured session data from a clinician\'s verbal narration and respond ONLY with valid JSON — no markdown, no code fences, no preamble, no explanation.',
        messages: [{
          role: 'user',
          content: `Extract session data from this narration and return a single JSON object with EXACTLY these keys:
- date (string, YYYY-MM-DD format; today is ${today} — use today if the narration does not mention a date)
- target_behaviour (string)
- activity_name (string)
- attempts (integer)
- independent_responses (integer)
- prompted_responses (integer)
- goal_met (string: "yes" or "not_yet")
- client_affect (string: exactly one of "Regulated", "Dysregulated", or "Mixed")
- next_session_focus (string)

Client name: ${clientName || 'Not specified'}
Narration: ${transcript}

Respond with the JSON object only. No other text.`
        }],
      }),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Narrate error:', err);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});
app.post('/pre-session-brief', async (req, res) => {
  try {
    const { model, system, user_message, thinking } = req.body;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    // Extended thinking requires the interleaved-thinking beta header
    if (thinking) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    const bodyObj = {
      model: model || 'claude-opus-4-5',
      // When thinking is enabled max_tokens must exceed budget_tokens
      max_tokens: thinking
        ? Math.max(4096, (thinking.budget_tokens || 0) + 1024)
        : 1024,
      system: system,
      messages: [{ role: 'user', content: user_message }],
    };
    if (thinking) bodyObj.thinking = thinking;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Pre-session brief error:', err);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});

// ── /extract — file-aware clinical data extraction ────────────────────────────
// Accepts PDF, image/*, or DOCX (via mammoth). Builds the appropriate
// Anthropic content block type and returns { result: "..." }.
app.post('/extract', async (req, res) => {
  try {
    const { model, system, user_message, file_base64, file_type } = req.body;

    // Guard: if a file_type is declared, base64 payload must be present and non-empty.
    // Without this check an empty data field reaches Anthropic and causes a 422 that
    // logs nowhere (it is caught by !upstream.ok, not the catch block).
    if (file_type && (!file_base64 || file_base64.trim() === '')) {
      console.error('[/extract] file_type set but file_base64 is empty/missing — rejecting before Anthropic call. file_type:', file_type);
      return res.status(400).json({ error: 'file_base64 is required when file_type is provided' });
    }

    // file_base64 + file_type are optional — omit both for text-only (voice) extraction
    const contentBlocks = [];

    if (!file_type) {
      // Text-only (voice / brain dump) — no file block needed
    } else if (file_type === 'application/pdf') {
      // Native PDF document block — Claude reads it directly
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: file_base64 },
      });
    } else if (file_type.startsWith('image/')) {
      // Image block
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: file_type, data: file_base64 },
      });
    } else if (file_type.includes('wordprocessingml') || file_type.includes('docx')) {
      // DOCX: extract plain text with mammoth, then send as text block
      try {
        const mammoth = require('mammoth');
        const buf = Buffer.from(file_base64, 'base64');
        const extracted = await mammoth.extractRawText({ buffer: buf });
        contentBlocks.push({
          type: 'text',
          text: `Document content:\n\n${extracted.value}`,
        });
      } catch (_) {
        // mammoth unavailable or parse failure — tell the model what arrived
        contentBlocks.push({
          type: 'text',
          text: '[A Word document was uploaded but could not be parsed. Extract what you can from context.]',
        });
      }
    } else {
      contentBlocks.push({ type: 'text', text: `[File of type ${file_type} provided]` });
    }

    // Append the instruction as the final text block
    contentBlocks.push({ type: 'text', text: user_message });

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    // PDF support requires the beta header on current API versions
    if (file_type === 'application/pdf') {
      headers['anthropic-beta'] = 'pdfs-2024-09-25';
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'claude-opus-4-5',
        max_tokens: 2048,
        system: system,
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('[/extract] Anthropic API error — status:', upstream.status,
        '| type:', data?.error?.type,
        '| message:', data?.error?.message,
        '| file_type:', file_type,
        '| base64_length:', file_base64 ? file_base64.length : 0);
      return res.status(500).json({ error: data?.error?.message || 'Anthropic API error' });
    }

    const resultText = data?.content?.[0]?.text ?? '';
    res.json({ result: resultText });

  } catch (err) {
    console.error('Extract error — message:', err.message);
    console.error('Extract error — stack:', err.stack);
    console.error('Extract error — full:', err);
    res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

// ── /cue-study — persistent multi-turn clinical thread (Phase 1) ──────────────
// Body: { messages: [{role: 'user'|'assistant', content: string}], chart_context: string }
// Returns: full Anthropic non-streaming response (the client extracts content[0].text).
app.post('/cue-study', async (req, res) => {
  try {
    const { messages, chart_context } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    if (typeof chart_context !== 'string' || chart_context.trim() === '') {
      return res.status(400).json({ error: 'chart_context (string) is required' });
    }

    const systemMessage = `${CUE_STUDY_SYSTEM_PROMPT}\n\n${chart_context}`;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system:     systemMessage,
        messages:   messages.map((m) => ({
          role:    m.role,
          content: m.content,
        })),
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('[/cue-study] Anthropic API error — status:', upstream.status,
        '| type:',    data?.error?.type,
        '| message:', data?.error?.message);
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Anthropic API error',
      });
    }
    res.json(data);
  } catch (err) {
    console.error('[/cue-study] error — message:', err.message);
    console.error('[/cue-study] error — stack:',   err.stack);
    res.status(500).json({ error: 'Cue Study request failed' });
  }
});

// ── /cue-reasoning — Ask Cue · {client_name} chat surface ─────────────────────
// Body: { client_id, message, conversation_history }
//   conversation_history: [{role: 'user'|'assistant', content: string}, ...]
// Auth: Authorization: Bearer <supabase-jwt> — `req.user.id` (set by
//   requireAuth) is the clinician_id used for both the ownership check
//   and the slp_profiles.response_style lookup. The Flutter client must
//   NOT send slp_id in the body; identity comes from the JWT.
// Returns: full Anthropic non-streaming response (the client extracts content[0].text).
//
// The prompt placeholders {client_name}, {age}, {diagnosis},
// {user_style_preference}, {session_context} are filled here via plain
// string replacement against CUE_REASONING_SYSTEM_PROMPT. The clients
// lookup is a single combined ownership-and-fetch query — if the
// authenticated SLP does not own client_id, the route 403s before any
// defaults are applied and before the Anthropic call is made.
//
// TODO(flutter-client): the Flutter client must send
// { client_id, message, conversation_history } to this endpoint with
// the Supabase auth JWT on the Authorization header.

// Cue Reasoning — Today-screen / session-flow clinical AI surface
// Request contract: see NEXT_STEPS.md §2.1 for canonical payload shape, status codes, and Flutter integration notes.
// Distinct from the reasoning_threads goal-authoring system (Phase 4.0.7.20) which persists multi-turn threads.
app.post('/cue-reasoning', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};

    // ── Request-size guard ────────────────────────────────────────────────────
    // Global express.json limit is 20mb (server.js top). Cap this route at
    // 32 KB — comfortably fits a 20-turn conversation_history, tight enough
    // to flag abuse before any DB or Anthropic round-trip.
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodyBytes > 32768) {
      console.warn('[/cue-reasoning] payload too large — bytes:', bodyBytes,
        '| slp_id:', req.user.id);
      return res.status(413).json({
        error: 'Payload Too Large — /cue-reasoning body is capped at 32 KB',
      });
    }

    // ── Reject stray slp_id from stale clients ───────────────────────────────
    // slp_id is derived server-side from req.user.id; clients sending it in
    // the body are running outdated code. Fail fast, identify in logs.
    if (Object.prototype.hasOwnProperty.call(body, 'slp_id')) {
      console.warn('[/cue-reasoning] stale client sent slp_id — body.slp_id:',
        body.slp_id, '| req.user.id:', req.user.id,
        '| user-agent:', req.headers['user-agent']);
      return res.status(400).json({
        error: 'slp_id is no longer accepted in request body; it is derived from the authenticated session. Update your client to remove this field.',
      });
    }

    const {
      client_id,
      message,
      conversation_history,
    } = body;

    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'message (string) is required' });
    }
    if (!client_id) {
      return res.status(400).json({ error: 'client_id is required' });
    }

    const slpId = req.user.id;
    const db    = createClient(SUPABASE_URL, SUPABASE_SERVICE);

    // ── Ownership-and-fetch: one query, two outcomes ─────────────────────────
    // Row returned → authenticated SLP owns this client; use the data.
    // No row     → 403 before any defaulting and before the Anthropic call.
    const { data: clientRow, error: clientErr } = await db
      .from('clients')
      .select('name, age, diagnosis')
      .eq('id', client_id)
      .eq('clinician_id', slpId)
      .maybeSingle();

    if (clientErr) {
      console.error('[/cue-reasoning] client lookup error — client_id:', client_id,
        '| slp_id:', slpId, '| error:', clientErr.message);
      return res.status(500).json({ error: 'Client lookup failed' });
    }
    if (!clientRow) {
      console.warn('[/cue-reasoning] ownership check failed — client_id:', client_id,
        '| slp_id:', slpId);
      return res.status(403).json({ error: 'Client not found or access denied' });
    }

    const clientName = clientRow.name      || 'this client';
    const clientAge  = clientRow.age != null ? String(clientRow.age) : 'unknown';
    const diagnosis  = clientRow.diagnosis || 'unknown';

    // ── Resolve SLP style preference ─────────────────────────────────────────
    // slp_profiles.response_style is a forthcoming column — fall back to
    // 'balanced' if the column doesn't exist yet or the row is missing.
    // See NEXT_STEPS.md for the migration to add this column.
    let stylePreference = 'balanced';
    const { data: slpRow, error: slpErr } = await db
      .from('slp_profiles')
      .select('response_style')
      .eq('clinician_id', slpId)
      .maybeSingle();
    if (slpErr) {
      // Most likely cause: column doesn't exist yet. Keep default.
      console.warn('[/cue-reasoning] slp_profiles.response_style lookup failed — slp_id:',
        slpId, '| error:', slpErr.message);
    } else if (slpRow && slpRow.response_style) {
      stylePreference = slpRow.response_style;
    }

    // TODO: wire session-notes RAG when retrieval pipeline is built
    const sessionContext = '';

    // ── Build the final system prompt via plain string replacement ───────────
    const systemMessage = CUE_REASONING_SYSTEM_PROMPT
      .replaceAll('{client_name}',           clientName)
      .replaceAll('{age}',                   clientAge)
      .replaceAll('{diagnosis}',             diagnosis)
      .replaceAll('{user_style_preference}', stylePreference)
      .replaceAll('{session_context}',       sessionContext);

    // ── Build messages array: prior history (if any) + current turn ──────────
    const history = Array.isArray(conversation_history) ? conversation_history : [];
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system:     systemMessage,
        messages,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('[/cue-reasoning] Anthropic API error — status:', upstream.status,
        '| type:',    data?.error?.type,
        '| message:', data?.error?.message);
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Anthropic API error',
      });
    }
    res.json(data);
  } catch (err) {
    console.error('[/cue-reasoning] error — message:', err.message);
    console.error('[/cue-reasoning] error — stack:',   err.stack);
    res.status(500).json({ error: 'Cue Reasoning request failed' });
  }
});

// ── /generate-brief — Phase 2 one-sentence companion thought ──────────────────
// Body: { chart_context: string }
// Returns: { thought: string, highlight: string }  — the Flutter chart wraps
// `highlight` in amber inside the rendered `thought`. Keeps prompt + JSON
// extraction here so the Flutter side stays thin.
// LANGUAGE DISCIPLINE — locked into this prompt so every brief Cue ever
// generates writes to the same rule. Mirrors lib/theme/.. comment blocks
// and CLAUDE.md §13. Do not soften, do not strip, do not add deficit
// framings. Update both this prompt and CLAUDE.md §13 in lockstep.
const CUE_BRIEF_SYSTEM_PROMPT = `You are Cue, a clinical companion. Generate ONE sentence (max 35 words) that names the most important clinical observation about this child today, based on their chart. The sentence must:
- Reference a specific recent observation from the chart
- Identify a pattern, opening, or piece of work worth noticing
- Use plain language, not clinical jargon
- End with the implication, not the analysis
- Be written in Indian clinical English

VANTAGE — Cue speaks about the work, not about the child. See CLAUDE.md §13.8.

PRIMARY RULE: Lead with the child's name. For continuing reference within the same thought, use "the child" or "this child." Do NOT use gendered pronouns ("he/his/him/she/her") in Cue-authored content. This applies regardless of whether the chart has a gender field set — uniform name-first vantage produces a consistent voice across all clients and removes one branching path of inference. The exception is direct quotes from intake or session notes — preserve the SLP's exact phrasing when citing chart content verbatim.

DEEPER RULE: Cue's authored prose centers the work, the chart, the question, or the SLP's decision — not the child as a subject of description.

CORRECT (Stance 2 — work-centered): "The chart shows zero completed sessions and no formal fluency assessment — without baseline severity data, the 12-week timeline can't be clinically supported."

FORBIDDEN (Stance 1 — child-centered, with pronouns): "Muthu is a 5-year-old who presents with stuttering. Her chart shows zero sessions, and she has no formal fluency assessment data."

FORBIDDEN-EXAMPLE ANCHOR (verbatim from a real bug report): "I've been thinking about Muthu. Ask me anything — I have her chart open." — forbidden because the chart had no gender data set; "her" was assumed.

NO MANUFACTURED URGENCY — see CLAUDE.md §13.10. Cue describes what is on the chart. Cue does NOT generate anxiety, urgency, or pressure about the SLP's pace, scheduling, or progress. The SLP knows her schedule, her caseload, her clinic's session length, and her practice cadence — Cue does not.

FORBIDDEN patterns:
- "Already under pressure" / "Behind schedule" / "Falling behind" / "Compressed timeline" / "Tight window" / "Running late" / "Time is running out" — when applied to the SLP's session cadence, plan execution, or assessment completion.
- "Only N sessions remaining" / "N days left" — when stated as a concern rather than a neutral observation requested by the SLP.
- "Two days in and…" / "X weeks in and…" / any temporal framing that implies the SLP should have done more by now.
- "The timeline assumes…" or "the plan requires…" used to surface a gap between plan and execution as a problem.

ALLOWED framings:
- Pure factual observations: "Chart created two days ago. One session of the four-contact plan completed."
- Neutral data surfacing when the SLP explicitly asks: if she types "am I on track" or "how is the cadence looking," Cue can respond with the numbers + her own framing — but she must ask first.
- Clinical observations about the child or the chart's data: "Sensory profile shows X. Worth thinking through Y." These are about chart content, not about the SLP's pace.

DEEPER RULE: Cue's brief surfaces what is on the chart. Cue does not surface what is NOT on the chart as a deficit, a gap, or a pressure point. The absence of completed sessions in a 2-day-old chart is not a clinical observation; it is calendar arithmetic. Don't elevate it.

FORBIDDEN-EXAMPLE ANCHOR (verbatim from the bug report): "Srujana's comprehensive fluency baseline goal launched two days ago — but zero sessions completed means the 4-contact timeline is already under pressure." Forbidden because it manufactures concern about session cadence the SLP did not ask Cue to evaluate.

CORRECT REWRITE for the same chart state: "Srujana's chart shows a fluency baseline plan with four planned contacts. Caregiver intake and observational session are next on the protocol." Pure observation. The SLP determines the pace.

LANGUAGE DISCIPLINE — non-negotiable. Cue presumes competence and surfaces observations. Cue NEVER characterizes the child, the family, or the goal as deficient. Cue NEVER speculates about why the chart is empty, sparse, or any particular shape — Cue does not know.

FORBIDDEN words and phrases when describing children, goals, or families:
stuck, overdue, behind, no progress, plateau, struggling, failing, regressing, slow learner, low-functioning, non-progressing, falling behind, lagging, despite, intervention timing, developmental trajectory, critical window, critical period, missed opportunity, falling further, gap widening, behind peers, age-appropriate, age-typical. The phrase "developmental delay" is forbidden as a Cue-authored verdict; quoting the diagnosis field verbatim if it already says so is fine.

DO NOT contrast the child against a developmental norm. DO NOT use "despite". DO NOT reference age as a clinical concern. DO NOT speculate about parental engagement, household circumstance, or anything Cue cannot read directly off the chart.

REQUIRED reframings:
- Long-active goal → "Active for N sessions — review when you have a moment." (the goal owns the duration; the SLP owns the review)
- Pending documentation → "Note pending from {date}." (the SLP owns the pending work, not the child)
- Absence / duration → state the number; let the SLP interpret. ("14 days since last session" not "Parent disengaged.")

EMPTY-CHART HANDLING:
If the chart context shows zero sessions AND zero active goals, the Flutter client is supposed to short-circuit and surface a template — this prompt should not be reached. If you ARE reached with an empty chart anyway, respond with:
{"thought": "{firstName}'s story starts here.", "highlight": "story starts here"}
substituting the child's first name. Do not analyse, do not interpret, do not reference age. Use the name; never use a gendered pronoun.

Output format: a JSON object {"thought": "<the sentence>", "highlight": "<the 2-5 word phrase to highlight in amber>"}.

Example (good): {"thought": "Ranadir activated three symbols unprompted on Tuesday — but that session is undocumented and tomorrow plan still assumes maximum support.", "highlight": "three symbols unprompted"}

Example (good, long-active goal): {"thought": "AAC linguistic goal active for 17 sessions — review when you have a moment.", "highlight": "active for 17 sessions"}

Example (FORBIDDEN — never produce): {"thought": "Amara's chart shows zero sessions despite being six years old with autism — intervention timing could significantly impact her developmental trajectory.", "highlight": "intervention timing"} — this uses 'despite', references age as concern, speculates about trajectory. Do not write briefs in this register.

Output the JSON object only. No markdown, no code fences, no commentary.`;

app.post('/generate-brief', async (req, res) => {
  try {
    const { chart_context } = req.body || {};
    if (typeof chart_context !== 'string' || chart_context.trim() === '') {
      return res.status(400).json({ error: 'chart_context (string) is required' });
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 400,
        system:     CUE_BRIEF_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: chart_context }],
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('[/generate-brief] Anthropic error — status:', upstream.status,
        '| message:', data?.error?.message);
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Anthropic API error',
      });
    }

    // Extract assistant text and parse JSON, stripping any code-fence wrappers.
    let raw = (data?.content?.[0]?.text ?? '').trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('[/generate-brief] non-JSON model output:', raw);
      return res.status(502).json({
        error:   'Brief generator returned non-JSON',
        thought: raw,           // fall back to plain text so the UI still has something
        highlight: '',
      });
    }

    res.json({
      thought:   (parsed.thought   ?? '').toString(),
      highlight: (parsed.highlight ?? '').toString(),
    });
  } catch (err) {
    console.error('[/generate-brief] error — message:', err.message);
    console.error('[/generate-brief] error — stack:',   err.stack);
    res.status(500).json({ error: 'Brief generation failed' });
  }
});

const generateGoals = require('./routes/generateGoals');
app.use('/api', generateGoals);

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
// Create the HTTP server from the Express app first, then attach the WebSocket
// server to it directly (no manual upgrade handler needed).
const http   = require('http');
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/transcribe') {
    console.log('[transcribe] client connected');

    // 4.0.7.9f-part1: per-session keyword boosting. The client
    // serializes its keyword set as JSON in the `keywords` query
    // parameter; we parse, sanitize, clamp the weight to Deepgram's
    // accepted range, format as "term:weight", and cap at 200 entries.
    const keywordsParam = url.searchParams.get('keywords');
    let keywordList = [];
    if (keywordsParam) {
      try {
        const decoded = JSON.parse(decodeURIComponent(keywordsParam));
        keywordList = decoded
          .filter(kw => kw && kw.term && typeof kw.term === 'string')
          .map(kw => {
            const cleanTerm = kw.term
              .replace(/[():,;]/g, '')
              .replace(/\s+/g, ' ')
              .trim();
            const weight = Math.max(0.5, Math.min(2, Number(kw.weight) || 1.5));
            return cleanTerm ? `${cleanTerm}:${weight.toFixed(1)}` : null;
          })
          .filter(Boolean)
          .slice(0, 200);
      } catch (e) {
        console.error('[transcribe] failed to parse keywords:', e.message);
        keywordList = [];
      }
    }
    console.log(`[transcribe] received ${keywordList.length} keywords for session`);

    // 4.0.7.9g: per-SLP language mode. Defaults to 'multi'
    // (code-switching) if absent, but typical Indian-English
    // SLPs set 'en-IN' to lock all output to Latin script.
    const ALLOWED_LANGUAGES = new Set([
      'multi', 'en', 'en-IN',
      'te', 'hi', 'kn', 'ta', 'ml', 'bn', 'mr', 'gu', 'pa', 'ur'
    ]);
    const languageParam = url.searchParams.get('language_mode');
    const language = (languageParam && ALLOWED_LANGUAGES.has(languageParam))
      ? languageParam
      : 'multi';
    console.log(`[transcribe] language_mode=${language} (param=${languageParam})`);

    const deepgramClient = new Deepgram(process.env.DEEPGRAM_API_KEY);

    const dgLive = deepgramClient.transcription.live({
      model:           'nova-3',
      // 4.0.7.9g: language is now per-SLP, sourced from
      // slp_profiles.transcription_language_mode and passed by
      // the client via query string. Default 'multi' for code-
      // switching; 'en-IN' for Indian-English-only with Latin
      // script enforcement; specific Indic codes for monolingual
      // SLPs.
      language:        language,
      ...(keywordList.length > 0 ? { keywords: keywordList } : {}),
      punctuate:       true,
      smart_format:    true,
      interim_results: true,
    });
    console.log(`[transcribe] dgLive ready, language=${language}, keywords=${keywordList.length}`);

    dgLive.addListener('open', () => {
      console.log('[transcribe] Deepgram connected');

      ws.on('message', (data) => {
        dgLive.send(data);
      });
    });

    dgLive.addListener('transcriptReceived', (transcription) => {
      console.log('[transcribe] raw:', transcription.substring(0, 200));
      const data = JSON.parse(transcription);
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;

      console.log('[transcribe] sending:', transcript);
      ws.send(JSON.stringify({
        type:       'transcript',
        text:       transcript,
        is_final:   data.is_final,
        confidence: data.channel?.alternatives?.[0]?.confidence ?? 0,
        language:   data.channel?.alternatives?.[0]?.language ?? 'unknown',
      }));
    });

    dgLive.addListener('error', (err) => {
      console.error('[transcribe] DG error:', err);
      ws.send(JSON.stringify({
        type:    'error',
        message: err.message ?? 'Transcription error',
      }));
    });

    ws.on('close', () => {
      console.log('[transcribe] client disconnected');
      try { dgLive.finish(); } catch (_) {}
    });

  } else {
    ws.close(1008, 'Unknown path');
  }
});

server.listen(PORT, () => {
  console.log(`Cue proxy listening on port ${PORT}`);
});
