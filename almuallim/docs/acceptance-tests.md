# Acceptance tests

**Auto** = runs in CI/locally via the named command. **Manual** = needs live credentials/hardware; steps given; result column stays ⬜/🟡 until a human records an actual run (date + tester) — nothing here is claimed passed without evidence.

Commands: `npm test` (unit) · `npm run test:db` (real PostgreSQL+pgvector; start with `scripts/test-db-cluster.sh start`) · `npm run typecheck` · `npm run build`.

## A. Security & privacy
| ID | Requirement | Verification | Status |
|---|---|---|---|
| A1 | A student cannot read another student's sessions, events, responses, mastery | Auto `test:db` rls.test.ts "student data isolation" | ✅ |
| A2 | A teacher sees only students in their own classes | Auto `test:db` | ✅ |
| A3 | Users cannot escalate role or self-register as privileged | Auto `test:db` "profiles & roles" | ✅ |
| A4 | Students cannot read raw pages/chunks; search returns ≤12 chunks and only from READY versions | Auto `test:db` "textbook access control" | ✅ |
| A5 | Students cannot write scores; AI estimate and teacher validation are stored separately; teacher stamp enforced | Auto `test:db` "AI estimate vs teacher validation" | ✅ |
| A6 | Audit log append-only, admin-readable only | Auto `test:db` | ✅ |
| A7 | Queue/rate-limit functions not callable by end users | Auto `test:db` | ✅ |
| A8 | No secret reaches the client bundle | Manual: `grep -r "SERVICE_ROLE\|OPENAI_API_KEY" .next/static` returns nothing; Auto test planned in M7 | ⬜ |
| A9 | Student can export and delete their data; deletion audited | Auto (M6) | ⬜ |
| A10 | Rate limits and budget ceilings reject excess requests with 429 before provider calls | Auto (M6) | ⬜ |

## B. Ingestion
| ID | Requirement | Verification | Status |
|---|---|---|---|
| B1 | Enqueue idempotent; concurrent workers never double-claim; lease expiry resumes; backoff; terminal failure surfaces error | Auto `test:db` queue.test.ts | ✅ |
| B2 | PDF → per-page text/page numbers on a generated Arabic PDF | Auto `tests/unit/extract.test.ts` | ✅ |
| B3 | Lesson boundaries detected from outline and from headings; fallback to whole-document | Auto `tests/unit/lessons.test.ts` | ✅ |
| B4 | Chunks never cross lesson boundaries, keep page ranges, stable hashes | Auto `tests/unit/chunk.test.ts` | ✅ |
| B5 | Re-running a job leaves identical rows (idempotent); resumes after provider outage; checksum mismatch & scanned PDFs fail non-retryably; lease loss abandons job | Auto `test:db` ingestion.test.ts | ✅ |
| B6 | Real textbook PDF ingested end to end with embeddings | Manual 🟡 (needs OpenAI key + licensed PDF) | ⬜ |

## C. Retrieval, tutoring
| ID | Requirement | Verification | Status |
|---|---|---|---|
| C1 | Arabic normalisation (diacritics, alef/ya/ta marbuta, digits, presentation forms, visual-order repair) | Auto `tests/unit/normalize.test.ts` | ✅ |
| C2 | Hybrid search returns lexical and semantic hits fused | Auto `test:db` (synthetic vectors) | ✅ |
| C3 | Grounding capped by retrieval confidence; ungrounded/partial answers carry a visible notice (thresholds uncalibrated) | Auto `tests/unit/retrieval.test.ts`, `tutor-answer.test.ts`, `tutor-engine.test.ts` | ✅ (logic) · 🟡 calibration on real book |
| C4 | Quotes not found in the cited chunk are rejected | Auto `tutor-answer.test.ts`, `tutor-engine.test.ts` | ✅ |
| C5 | Practice/assessment/socratic: answer-leak guard (one corrective retry, then safe fallback). Relies on the model's self-declared flag — defence in depth, not proof | Auto `tutor-engine.test.ts` | ✅ (mechanism) · 🟡 real-model behaviour |
| C6 | Tool inputs Zod-validated; foreign sessions rejected; rate-limit/budget before provider call; transcript opt-out honoured | Auto `chat-route.test.ts`, `admin-routes.test.ts` | ✅ |

## D. Camera / page matching
| ID | Requirement | Verification | Status |
|---|---|---|---|
| D1 | Permission states: denied/no-device/in-use/insecure/unsupported with actionable Arabic messages; rear camera requested; constraint fallback | Auto `camera-vision.test.ts`, `camera-ui.test.tsx` | ✅ |
| D2 | Stability detector fires only on steady, sharp, lit frames; re-arms only after movement | Auto `camera-vision.test.ts` (synthetic frames; thresholds uncalibrated) | ✅ (logic) |
| D3 | `decideMatch` → confident / ambiguous / none with margin & printed-page-number logic; end-to-end against real `match_pages` on the ingested PDF; image never stored; confirmation always required | Auto `page-match.test.ts`, `vision-routes.test.ts`, `test:db` | ✅ |
| D4 | Live camera on a physical page matches correct page | Manual 🟡 (device + OpenAI key + ingested book) | ⬜ |

## E. Voice
| ID | Requirement | Verification | Status |
|---|---|---|---|
| E1 | FSM: start/stop, mute, barge-in, tool calls, reconnect with backoff/offline wait, idle & max-duration limits, mic released on every terminal path, mic-denied/missing/busy/insecure, provider errors | Auto `voice-client.test.ts`, `webrtc-transport.test.ts`, `voice-ui.test.tsx` | ✅ (logic) |
| E2 | Token endpoint: auth, ownership, rate limit, daily voice budget, abandoned-segment accounting; returns only the short-lived secret; session body contains tools + page context | Auto `voice-routes.test.ts` (mocked provider HTTP) | ✅ (against mock) · 🟡 real provider |
| E3 | Confirmed page is pushed into the live session (system item + response.create) without reconnect; mode switches likewise | Auto `voice-client.test.ts`, `voice-ui.test.tsx` | ✅ (logic) |
| E4 | Real spoken Arabic conversation, barge-in works, transcript saved | Manual 🟡 (OpenAI key, microphone, desktop Chrome + iOS Safari + Android Chrome) | ⬜ |

## F. Teacher dashboard & UI
| ID | Requirement | Verification | Status |
|---|---|---|---|
| F1 | Dashboard shows AI estimate and teacher-validated values with distinct labels | Auto (M5) | ⬜ |
| F2 | RTL layout, keyboard navigation, contrast, reduced motion | Manual + axe check (M7) | ⬜ |
| F3 | `npm run build`, `typecheck` pass | Auto | ✅ (M0) |
| F4 | Deployed to Vercel and reachable | Manual — not attempted (Vercel MCP failed to connect in this session; no credentials) | ⬜ |
