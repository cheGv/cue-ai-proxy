require('dotenv').config({ override: true });
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { WebSocketServer } = require('ws');
const { Deepgram } = require('@deepgram/sdk');
console.log('[boot] deepgram Deepgram type:', typeof Deepgram);

const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT              = process.env.PORT || 3001;

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

app.post('/generate-report', async (req, res) => {
  try {
    const { clientName, session, additionalContext, goals } = req.body;

    const name       = clientName || 'Client';
    const date       = session?.date         || 'Not specified';
    const goal       = session?.goal         || 'Not specified';
    const activity   = session?.activity     || 'Not specified';
    const attempts   = session?.totalTrials       || 0;
    const independent = session?.independentTrials || 0;
    const prompted   = session?.promptedTrials    || 0;
    const goalMet    = session?.goalMet      || 'Not specified';

    const totalTrials  = parseInt(attempts)   || 0;
    const indepTrials  = parseInt(independent) || 0;
    const promptTrials = parseInt(prompted)   || 0;
    const indepPct     = totalTrials > 0 ? Math.round((indepTrials  / totalTrials) * 100) : 0;
    const promptPct    = totalTrials > 0 ? Math.round((promptTrials / totalTrials) * 100) : 0;
    const affect     = session?.affect       || 'Not specified';
    const notes      = session?.notes        || 'None';
    const goalsText = goals && goals.length > 0
  ? `\n\nACTIVE THERAPY GOALS:\n${goals.map(g => 
      `- [${g.domain}] ${g.goal} (target: ${g.target})`
    ).join('\n')}`
  : '';

     const prompt = `You are Cue, a clinical AI assistant for RCI-certified Speech-Language Pathologists in India. Generate a professional two-page clinical report from the session data below.

═══════════════════════════════════════════
SECTION 1 — DOCUMENTATION INTEGRITY (NON-NEGOTIABLE)
═══════════════════════════════════════════
1. You did NOT observe this session. You have only the structured data provided.
2. NEVER fabricate, invent, or imagine specific utterances, quotes, or examples of what the client said. Example of what is FORBIDDEN: writing "Arjun said 'the boy is running because he wants the ball'" when no such quote was in the data.
3. NEVER generate hypothetical sentence examples attributed to the client. Do not write "he produced sentences like X" unless X was explicitly provided.
4. Describe performance ONLY in clinical abstractions supported by the data — e.g. "produced complex sentences with conjunctions on 6 of 10 trials" — NOT a fabricated example of such a sentence.
5. If specific utterance data is absent, write "Specific utterance data not recorded this session" rather than inventing examples to enrich the narrative.

═══════════════════════════════════════════
SECTION 2 — LINGUISTIC FIDELITY
═══════════════════════════════════════════
1. Preserve native language terms, transliterations, or code-switching (English-Telugu, English-Kannada, English-Hindi, etc.) EXACTLY as provided. Do not "correct", translate, or anglicize non-English clinical targets, utterances, or activity names.
2. LINGUISTIC NEUTRALITY: Do not apply English grammatical rules to observations of utterances in other languages. Evaluate phonological or syntactic performance strictly per the rules of the target language as provided.
3. If the session mentions a target language (e.g. "target language: Kannada"), frame all clinical interpretation within that language's structure, not English.

═══════════════════════════════════════════
SECTION 3 — STRUCTURE, TONE & PARENT SUMMARY
═══════════════════════════════════════════
1. CLINICAL REPORT (Page 1): Neutral, third-person professional tone. No direct quotes fabricated. Trial data and goal performance are the primary evidence.
2. PARENT SUMMARY (Page 2): Warm, jargon-free, strengths-based. You MAY use generic teaching examples (e.g. "using long sentences to connect ideas with 'because'") to help parents understand what was worked on, but you must NOT attribute specific words or quotes to the child that were not in the data.
3. LENGTH: Aim for a professional two-page structure. If session data is sparse, do NOT "fluff" the narrative to fill space. Produce a high-quality concise report instead, and append a "Clinical Note" at the end of Page 1 identifying specific data gaps (e.g. "Utterance-level data not captured; recommend narration for next session").
4. Use neurodiversity-affirming, strengths-based language throughout. Never pathologize..

CLIENT: ${name}
DATE: ${date}
GOAL: ${goal}
ACTIVITY: ${activity}
TOTAL TRIALS: ${attempts}
INDEPENDENT RESPONSES: ${independent}
PROMPTED RESPONSES: ${prompted}
GOAL MET: ${goalMet}
AFFECT/REGULATION: ${affect}
NEXT SESSION FOCUS: ${notes}${goalsText}

Generate the report in this exact format with these exact headers. Use plain text only — no asterisks, no hashtags, no markdown.

PAGE 1 — CLINICAL SESSION NOTE

Client Name: ${name}
Date of Service: ${date}
Service Type: Individual Speech-Language Therapy
Clinician: RCI-Certified Speech-Language Pathologist

SUBJECTIVE:
[Client's presentation, affect, regulation, and behavioral observations during the session. Include any caregiver-reported information if available.]

OBJECTIVE:
Target Goal: ${goal}
Activity: ${activity}
Trial Data:
- Total Trials: ${totalTrials}
- Independent Responses: ${indepTrials} (${indepPct}%)
- Prompted Responses: ${promptTrials} (${promptPct}%)
- Goal Met: ${goalMet}
Client Affect/Regulation: ${affect}

ASSESSMENT:
[Clinical interpretation of performance. Comment on skill acquisition, generalization potential, impact of regulation on learning, and progress toward goals.]

PLAN:
[Next session targets, therapy modifications, strategies to support regulation, frequency recommendations.]

Next Session Focus: ${notes}

---

PAGE 2 — PARENT COMMUNICATION SUMMARY

Dear Parent/Caregiver,

Here is a summary of today's session for ${name}:

WHAT WE WORKED ON TODAY:
[Explain the goal and activity in simple, jargon-free language a non-clinician parent can understand.]

HOW ${name.toUpperCase()} DID TODAY:
[Strengths-based, positive description of the child's performance. Mention specific achievements. Frame challenges constructively.]

TRY THIS AT HOME:
1. [Practical home activity related to today's goal — specific and doable in 5 minutes]
2. [Second home activity — playful and easy to implement]
3. [Third suggestion — can be incorporated into daily routine]

COMING UP NEXT SESSION:
[Brief, encouraging preview of what will be worked on next. Keep it positive and forward-looking.]

Remember: Every session builds on the last. Your involvement at home makes a significant difference in your child's progress.

---
Generated by Cue AI | RCI-Certified SLP Documentation`;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
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

    const deepgramClient = new Deepgram(process.env.DEEPGRAM_API_KEY);

    const dgLive = deepgramClient.transcription.live({
      model:           'nova-2',
      detect_language: true,
      punctuate:       true,
      smart_format:    true,
      interim_results: true,
    });

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
