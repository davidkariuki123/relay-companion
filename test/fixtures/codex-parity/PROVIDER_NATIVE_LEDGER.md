# Provider-native Work parity gate

This is a deliberately strict, evidence-only release gate. It does not define
Claude Code or Cowork by translating their legacy transcript `records` into
Codex-shaped items. Each provider must first preserve its own raw identities,
ordering, role boundaries and terminal semantics; only then may the shared Work
presentation reducer render demonstrably common UI primitives.

## Evidence provenance

- Claude compaction/DAG source:
  `~/.claude/projects/-Users-david-src-therapa/5714b7be-cb48-4dff-9f73-0b79313629c7.jsonl`,
  SHA-256 `d002de8829bdf6957307d3a9758b95a79360ea8be191eda1704d5f5545c6b0c7`.
  In particular, the `system/compact_boundary` row followed by the synthetic
  `user` row with `isCompactSummary` and `isVisibleInTranscriptOnly` proves that
  `role=user` alone is not a human-turn boundary.
- Claude retry/error source:
  `~/.claude/projects/-Users-david-src-relay/e0edad13-fa15-4b97-b488-41c2173362f2.jsonl`,
  SHA-256 `8d77abbfcccac85b124c69d254174af8a2764c45fb664517fd733ecd8b990482`.
  Its `system/api_error` rows retain retry attempt, delay and maximum-retry
  state that the legacy normalizer discards.
- Claude native image source:
  `~/.claude/projects/-Users-david-src-relay/03287122-8c90-4d9c-a249-d5f82f9d103e.jsonl`,
  SHA-256 `2657b55699223688271882a5e927abad14d54f81148afa138431223aa52b0737`.
  Real human rows include image-only content blocks shaped exactly as
  `{type:"image",source:{type:"base64",media_type,data}}`. Text is therefore
  not a valid prerequisite for a Claude human-turn boundary, while embedded
  bytes must not enter canonical Work state.
- Cowork audit: GET-only inspection of all 18 locally visible Claude Desktop
  Cowork sessions (954 events) on 2026-08-15. The corpus contained human and
  tool-result `user` events, `sequence_num`, `event_id`, `control_request`,
  `control_response`, `active_goal`, `tool_progress`, `post_turn_summary`,
  `mcp_auth_required`, `rate_limit_event` and `result.user_message_uuid`.
  All 18 session resources still reported `status=active` after historical
  completion and all were disconnected; 13 were `review_ready` and five were
  `blocked`. Therefore neither `active` nor `disconnected` is a terminal truth.
- The checked-in JSON files are sanitized, structure-preserving golden cases;
  private prompts, credentials and protocol headers are replaced with canary
  text. Fixture hashes at authoring time:
  - Claude: `2eaf272468a3be44181de1c5a829f22855e95781780e988853f04e1f700add6f`
  - Claude attachments: `b6525a31481a5b05505dd9354f624537d2af855d4b063b2216090547b9000f33`
  - Cowork: `a13a85900d9b5dec2c466e8df9232f308bcf81efee2a8473ba92c8e5daf0da16`
- Installed Claude Desktop UI audit on 2026-08-15:
  - `Daily morning briefing` displayed native `Awaiting answer`, a persistent
    four-step question card, an independently usable composer, a stopped-cloud
    retry surface, a credits/rate notice, and its permission-mode notice.
  - `Relay Cowork single envelope proof`
    (`cse_012Lh3tA1pwRAhgH2HU3t9sF`) displayed seven native visible messages:
    one assistant result followed by three genuine user/assistant follow-ups.
    The hidden runtime seed did not appear and the composer remained available.
  These are Cowork-native states; they are not inferred from Codex labels.
- A fresh source-level Cowork GET audit could not be repeated on 2026-08-15:
  the configured worker token returned `OAuth access token has been revoked`.
  The prior 954-event corpus and current installed native UI remain the only
  evidence used here. This gate does not claim unobserved Cowork token deltas,
  attachment payload shapes, or background/subagent payload families.

## Requirement-to-test ledger

| Gate | Provider boundary being proved | Failure layer |
|---|---|---|
| N00 | Separate raw Claude and Cowork adapters exist; neither funnels through `inspectAiSession`, `coworkEventsToRecords`, or generic legacy records | adapter |
| N01 | Claude UUID/parent UUID DAG (even without a convenience sidechain flag), real-human detection, tool ID/result linkage, commentary/final boundary, API retry, compaction, background subagent, safe native detail, delta reconciliation and privacy | adapter/model |
| N02 | `stop_reason=tool_use` prose cannot become final; exhausted retries and tool errors remain terminal errors | adapter/model |
| N03 | `AskUserQuestion` plus stop-hook prevention is one unresolved blocking request, not generic activity | adapter/model |
| N04 | A 252-record native Claude turn retains its initiating human, reconciles overlap by stable identity, and does not truncate the turn boundary | adapter/bounds |
| N04b | Overlapping live Claude stream pages reconcile partial deltas by native identity before persisted authoritative rows arrive | adapter/streaming |
| N05 | Detached active Claude work fails honestly while an owned resumable live session remains active | provider lifecycle |
| N05b | Canonical bridge retains `provider=claude`, hydrates once, and reduces exact pushed rows incrementally rather than rereading/replaying the full transcript on every token | bridge/provider lifecycle |
| N05c | Exact real-shape Claude image-only and text-plus-image human rows preserve their native turn boundaries and safe attachment metadata without allowing base64 bytes into canonical state | adapter/security |
| N05d | An incrementally arriving image-bearing human row settles the preceding live turn, promotes its native end-turn answer to final, and starts a new turn without replay duplication | adapter/streaming |
| N06 | Cowork numeric sequence ordering, event-ID dedupe, authoritative client-human vs worker synthetic/tool-result distinction, startup/protocol suppression, safe native command detail, tool progress, active goal, strict summary-selected final, older-result association, and one reconciled native blocker | adapter/model |
| N07 | Cowork control response retains and resolves the original request in its chronological position (persistent, nonblocking); each `post_turn_summary.summarizes_uuid` selects exactly one final and result text is not duplicated | adapter/model |
| N08 | Native blocked summary and MCP authentication remain actionable despite active/review-ready/result metadata; allowed overage and historical disconnect are not crashes | adapter/provider lifecycle |
| N09 | Cowork error result wins over optimistic assistant prose and stale active/review-ready resource fields | adapter/model |
| N09b | Native `control_cancel_request` retains and resolves the matching blocker in place (persistent, nonblocking) rather than erasing history or leaving endless input UI | adapter/model |
| N10 | Attachment authorization and reading use the same opened object; symlink/file swaps and post-check growth cannot escape the root or cause an unbounded read | broker/security |
| N11 | Root authorization is anchored to the opened directory hierarchy; swapping an ancestor directory to an out-of-root symlink cannot redirect the read | broker/security |
| N12 | Restoring a swapped ancestor after opening an outside descriptor cannot make that descriptor pass later pathname checks; canonical digest/identity or an anchored open is required | broker/security |

## How to run

Point the test at the candidate repository or worktree. A release candidate is
green only when all provider-specific gates pass without weakening the fixture
expectations:

```sh
RELAY_PARITY_SOURCE_ROOT=/path/to/candidate \
  node --test packages/companion/test/provider-native-parity-redteam.test.mjs
```

Historical failing baseline:
`ba42f3ed9065568d5e410c8033d015b8bbf515cd` (`Extend Work feeds to Claude and Cowork`).
Result: **0 pass / 16 fail**. N00–N09b failed because that candidate exposed
only the generic legacy-record funnel; N10–N12 independently demonstrated the
attachment TOCTOU and unbounded-read defects.

Independent installed-version baseline under this audit:
`53e05d1494bcda686f304c20410704534a048e35`, published as dev
`relay-companion@0.1.199`. Existing N00–N09b and N10–N12 passed. New N05c
failed because image-only humans were not recognized and all Claude image
attachments disappeared. New N05d then exposed a live multi-turn defect: a new
human boundary reset reconciliation before the preceding end-turn answer could
transition from commentary to final. Both gates pass after the narrow adapter
fix; the focused provider/reducer/broker suite is **68 pass / 0 fail**.
