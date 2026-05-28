# CLAUDE.md — Cue (Proxy)
This is the **proxy** repo (`cheGv/cue-ai-proxy`, `C:\dev\cue\proxy`) — the Node/Render service that fronts the Anthropic API and holds Cue's system prompts. **This is where Cue's clinical voice actually executes.**
This file is a ROUTER. Read it fully at the start of every session.
**Before anything else, load `_local/repo-and-path-topology` — path confusion has caused real regressions.**
---
## SESSION-OPEN RITUAL (do this first, every time)
```
pwd                      # confirm you're in C:\dev\cue\proxy
git remote -v            # confirm cheGv/cue-ai-proxy (NOT cue-flutter)
```
---
## THE SHARED LAWS LIVE IN THE FLUTTER REPO — READ THEM
The shared-core skills are canonical at `C:\projects\cue\.claude\skills\_shared\`. They govern proxy prompts as much as Flutter code. **Do NOT duplicate them here** (drift trap). Read from that path:
- **`language-discipline`** — governs every word the system prompts emit. PRIMARILY a prompt concern. Read before touching any clinical prompt.
- **`clinical-invariants`** — anti-hallucination, attestation, controlled vocabularies, multilingual fidelity.
- **`product-law`** + **`north-star`** — the why.
---
## HARD INVARIANTS (never violate)
1. **Language discipline (§13) governs all prompt output.** Forbidden-words scan + stance check every output template. (`_shared/language-discipline` in the Flutter repo)
2. **Anti-fabrication preamble** is the immutable, versioned, non-optional prefix on every clinical-generation prompt. (`_local/prompt-discipline`)
3. **The proxy is the PHI de-identification boundary** — strip identifiers before forwarding to Anthropic. (`_local/prompt-discipline`)
4. **Every prompt is versioned** (version constant + SHA256 hash, both logged per call). No inline prompts. (`_local/prompt-discipline`)
5. **Goal structure / coherence / conditions rules are mirrored with `language-discipline` in lockstep.** Change one, change both. (`_local/prompt-discipline`)
6. **The product is "Cue," never "Cue AI"** in any user-facing output. (`_shared/north-star`)
---
## SKILL ROUTING
| Task touches… | Load |
|---|---|
| Any system prompt, endpoint, `routes/`, `server.js` | `_local/prompt-discipline` |
| ANY clinical text the prompt emits | `_shared/language-discipline` (Flutter repo path) |
| Clinical vocab, attestation, anti-hallucination, multilingual | `_shared/clinical-invariants` (Flutter repo path) |
| Which repo / which file / before any commit/push | `_local/repo-and-path-topology` |
| The why behind any rule | `_shared/north-star`, `_shared/product-law` |
---
## ENVIRONMENT
- **This repo:** proxy, `C:\dev\cue\proxy`, `cheGv/cue-ai-proxy` → Render (auto-deploy ~1–2 min after push)
- **Flutter repo (separate):** `C:\projects\cue`, `cheGv/cue-flutter` → Netlify (holds the canonical shared skills)
- **Proxy URL:** `https://cue-ai-proxy.onrender.com`
- **Prod Supabase:** `cgnjbjbargkxtcnafxaa` · **Sandbox:** `uuqhusmgoiaxdvtgbmwh`
- Prompt review writeups: `/prompts/reviews/`
---
## WHEN UNSURE
Ask Guru. Mirror every clinical-voice change into `language-discipline`. Never inline or unversion a prompt. Never reintroduce `functions.invoke()` on the Flutter side.
