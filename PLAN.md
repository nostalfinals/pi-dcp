# Minimal Agentic DCP for Pi — Implementation Plan

## 1. Goal

Build a small, reliable Dynamic Context Pruning extension for Pi that reproduces the core agentic range-compression behavior of OpenCode-DCP:

1. Monitor effective context usage.
2. Nudge the active model before context quality degrades.
3. Let the model choose a closed, contiguous conversation range and write its own high-fidelity summary.
4. Replace that range only in outbound model context; never rewrite or delete Pi's JSONL session history.
5. Persist compression state with Pi's session tree semantics.
6. Allow active compressions to be decompressed while their raw source entries are still available.
7. Coexist safely with Pi's native compaction and remove stale compression records after native compaction.

The first version exposes only two user-facing settings:

```json
{
  "minCompressContext": 50000,
  "maxCompressContext": 100000
}
```

Both settings also accept percentages:

```json
{
  "minCompressContext": "25%",
  "maxCompressContext": "50%"
}
```

This is a clean implementation against Pi's extension API. It may reproduce public OpenCode-DCP behavior and concepts, but it must not copy source code from the AGPL project unless this project intentionally adopts AGPL-compatible licensing.

## 2. Non-goals for v1

The first release will not implement:

- Deduplication of repeated tool calls.
- Purging inputs from failed tool calls.
- Individual-message compression mode.
- Custom prompt overrides.
- Per-model threshold overrides.
- Automatic update checks.
- Subagent-specific behavior.
- Protected file glob configuration.
- A complex full-screen TUI.
- Replacement of Pi's native compaction summarizer.

Pi native auto-compaction remains enabled as a final overflow and consolidation fallback.

## 3. Design Principles

### 3.1 Session history is immutable

DCP changes only the message array returned by Pi's `context` event. Original messages and session entries remain untouched in the append-only JSONL session.

### 3.2 State follows the Pi session tree

DCP state must not live only in a global sidecar keyed by session ID. Every state mutation is persisted as a Pi custom entry on the current branch. Restoring state means finding the latest DCP state entry on the active branch.

This guarantees:

- A compression created on branch A does not leak into branch B.
- Forking after a compression inherits it naturally.
- Navigating to a point before a compression naturally disables it.
- `/resume` and `/reload` restore the correct branch-local state.

### 3.3 Stable IDs are Pi session entry IDs

Persistent compression boundaries use Pi `SessionEntry.id` values, never array indices or timestamps. Short message references shown to the model are aliases for stable entry IDs in the current context snapshot.

### 3.4 Fail open

If DCP cannot map messages, validate a range, restore state, or safely preserve provider message invariants, it sends the original context unchanged and emits a diagnostic warning. Context optimization must never make the agent unusable.

### 3.5 Native compaction owns final consolidation

Once Pi native compaction consumes the raw entries covered by a DCP block, that block is retired and removed from active DCP state. No ghost blocks are retained.

## 4. Proposed Project Structure

```text
.
├── index.ts
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── lib/
│   ├── config.ts
│   ├── types.ts
│   ├── state.ts
│   ├── persistence.ts
│   ├── message-map.ts
│   ├── range.ts
│   ├── pruning.ts
│   ├── nudges.ts
│   ├── prompts.ts
│   ├── compaction-sync.ts
│   ├── tools/
│   │   └── compress.ts
│   └── commands/
│       ├── index.ts
│       ├── context.ts
│       └── decompress.ts
└── test/
    ├── config.test.ts
    ├── message-map.test.ts
    ├── range.test.ts
    ├── pruning.test.ts
    ├── persistence.test.ts
    ├── branching.test.ts
    └── native-compaction.test.ts
```

The structure may be collapsed if the implementation remains small, but state, range validation, and outbound context transformation should stay independently testable.

## 5. Core Data Model

```ts
type ContextLimit = number | `${number}%`;

interface DcpConfig {
  minCompressContext: ContextLimit;
  maxCompressContext: ContextLimit;
}

interface CompressionBlock {
  id: string;                    // b1, b2, ...
  startEntryId: string;
  endEntryId: string;
  summary: string;
  topic?: string;
  createdAt: number;
  creatorToolCallId?: string;
}

interface DcpStateSnapshot {
  version: 1;
  nextBlockNumber: number;
  activeBlocks: CompressionBlock[];
}
```

Only active blocks are retained in the latest snapshot. Decompressed, superseded, and native-compacted blocks are removed rather than accumulated indefinitely. `nextBlockNumber` remains monotonic so block IDs are never reused on the same branch lineage.

Custom state entries use one namespaced type, for example:

```text
pi-dcp-state
```

They do not participate in LLM context.

## 6. Compression Semantics

### 6.1 Model-visible references

Before each model request, DCP derives the active, compaction-aware entry sequence from:

```ts
ctx.sessionManager.buildContextEntries()
```

Each context-producing entry is mapped through Pi's exported session-entry conversion behavior. DCP then assigns short request-local aliases such as:

```text
m001 -> 7f3c9a12
m002 -> 0ab32d81
```

The model receives compact, idempotent annotations such as:

```text
<dcp-message id="m017">...</dcp-message>
```

The compression tool resolves aliases against the exact snapshot from which the tool call was generated, then persists only the underlying stable Pi entry IDs.

Requirements:

- Repeated `context` passes must not accumulate annotations.
- Text, images, thinking blocks, custom messages, compaction summaries, and branch summaries must remain structurally valid.
- If exact entry/message alignment cannot be established, range compression is disabled for that request and the original messages pass through.

### 6.2 Compress tool

The v1 tool accepts one or more contiguous ranges atomically:

```ts
compress({
  ranges: [
    {
      startId: "m012",
      endId: "m037",
      summary: "High-fidelity technical summary...",
      topic: "Optional short label"
    }
  ]
})
```

The model is responsible for the summary. The extension does not make a second LLM call.

Every submitted range is validated before any state mutation. If one range is invalid, the whole call is rejected with concise valid-boundary guidance.

### 6.3 Valid range rules

A valid range must:

- Resolve both endpoints in the current active branch/context snapshot.
- Have start before or equal to end.
- Exclude the current `compress` invocation and in-flight work.
- Exclude the most recent active work segment when it cannot yet be summarized safely.
- Stay within one active branch.
- Preserve complete assistant tool-call/result groups.
- Not partially overlap an existing block.
- Contain enough raw content to save more tokens than the replacement summary and metadata.

The validator normalizes boundaries to safe message groups. It must never leave an orphaned tool call or tool result.

### 6.4 Applying a block

For each active block during a `context` event:

1. Resolve its stable entry boundaries against the active context-entry sequence.
2. Remove the normalized raw message range from the outbound copy.
3. Insert one synthetic summary message at the range anchor:

```text
[Compressed conversation section: b3 — Initial repository investigation]

<summary>
...
</summary>
```

4. Keep all original session entries untouched.

Synthetic summary messages must use a provider-compatible Pi message shape and must not break role ordering or tool-call/result pairing.

### 6.5 Avoiding duplicate summaries

The original `compress` assistant tool call contains the summary in its arguments. Once the block is persisted, future outbound contexts should replace the historical `summary` argument with a compact reference such as:

```text
[stored in DCP block b3]
```

The authoritative model-visible copy is the synthetic summary at the compressed range anchor. The tool call/result pair remains valid, but the full summary is not sent twice.

### 6.6 Overlap and recompression

Rules for new ranges against existing blocks:

- No overlap: accept normally.
- New range fully contains one or more existing blocks: accept and supersede the contained blocks.
- Existing block fully contains the new range: reject unless the operation is an explicit replacement of that block.
- Partial overlap: reject and return valid non-overlapping boundaries.

When a new range contains existing blocks, the model generated its new summary from the old synthetic summaries already present in context. The new block replaces the contained blocks in the latest state snapshot so active state remains bounded.

## 7. Configuration

### 7.1 Locations

Use Pi conventions:

1. Global: `~/.pi/agent/dcp.json`
2. Project override: `<cwd>/.pi/dcp.json`

Project config is honored only for trusted projects. The project file overrides matching global fields.

### 7.2 Defaults

```json
{
  "minCompressContext": 50000,
  "maxCompressContext": 100000
}
```

### 7.3 Validation

- Numeric limits must be positive finite integers.
- Percentage strings must be greater than `0%` and at most `100%`.
- Percentages resolve against the active model's context window.
- Resolved minimum must be lower than resolved maximum.
- If model context-window metadata is unavailable, percentage limits cannot trigger nudges, but the `compress` tool and manual commands remain usable.
- Invalid configuration produces one warning and falls back to defaults.

## 8. Nudge Policy

Nudges are ephemeral outbound context additions and are never persisted to the session.

Fixed v1 policy:

- Below minimum: no threshold nudge.
- At or above minimum but below maximum: soft compression reminder.
- At or above maximum: strong compression reminder.
- Soft reminders are throttled to roughly every five eligible outbound context builds.
- Long autonomous tool chains receive an iteration reminder after approximately fifteen model/tool steps since the last user message.
- Strong reminders may repeat while above maximum, but should not be duplicated within one request.
- Manual user prompts and active work are never automatically compressed; the model still decides whether a safe closed range exists.

The nudge must explicitly instruct the model to:

- Compress completed or stale work only.
- Preserve decisions, constraints, file paths, errors, validation state, and next steps.
- Avoid recent or in-flight work.
- Prefer one meaningful batch over many tiny compressions to reduce prompt-cache churn.

Nudges should be added from the per-request `context` path rather than relying only on `before_agent_start`, because Pi may perform many LLM/tool turns inside one agent run.

## 9. Persistence and Branching

### 9.1 State writes

After every state mutation, append a complete bounded snapshot:

```ts
pi.appendEntry("pi-dcp-state", snapshot);
```

Mutations include:

- Successful `compress`.
- `/dcp decompress`.
- Superseding contained blocks.
- Native compaction cleanup.

### 9.2 State restore

On `session_start` and after relevant session/tree lifecycle changes:

1. Read the current active branch.
2. Find the latest valid `pi-dcp-state` custom entry on that branch.
3. Validate and restore it.
4. Reconcile restored blocks against the current compaction-aware active entries.
5. Drop stale or malformed blocks and append a repaired snapshot if necessary.

Never restore the latest DCP entry from the entire JSONL file without checking branch ancestry.

### 9.3 Tree behavior acceptance cases

- Compress on branch A, switch to sibling branch B created before the compression: block must not apply.
- Fork after compression: block must apply in the child lineage.
- Navigate to before compression: raw messages must return.
- Navigate forward to a branch containing the compression state: block must return.
- Decompress on one branch: sibling branches must retain their own state.

## 10. Decompression

Commands:

```text
/dcp
/dcp context
/dcp decompress
/dcp decompress b3
```

Behavior:

- `/dcp decompress` lists only active, currently restorable blocks.
- `/dcp decompress b3` removes `b3` from the latest state snapshot.
- The next outbound context includes the original raw messages again.
- Superseded or native-compacted blocks are not listed.
- If a block is no longer restorable, report that Pi native compaction already consolidated its source rather than claiming success.

Recompression is not required for v1. The model can create a new compression if needed.

## 11. Pi Native Compaction Integration

### 11.1 Event handling

Listen to:

```ts
session_compact
```

Use:

```ts
event.compactionEntry.firstKeptEntryId
```

plus the active branch ordering to determine which DCP source entries were consumed by Pi.

### 11.2 Cleanup rules

- Block fully before the native retained boundary: remove it.
- Block crossing the retained boundary: retire it conservatively; do not apply a full-range summary to a partial surviving range.
- Block fully inside the retained tail: keep it.
- After cleanup, append a new bounded DCP state snapshot.
- Reconcile again on session restore in case Pi exited between compaction and extension cleanup.

### 11.3 Expected result

After native compaction:

- No active block references only missing entries.
- `/dcp context` does not show ghost blocks.
- `/dcp decompress` never claims to restore native-compacted source messages.
- Context-pipeline work remains proportional to currently active blocks, not lifetime compression count.
- Pi's native summary becomes the authoritative consolidation for the consumed region.

## 12. Prompt Cache Considerations

A compression changes the prompt prefix at the first replaced message, so the first request after compression will lose cache from that point onward. Subsequent requests can cache the new shorter prefix.

The implementation should therefore:

- Encourage semantic phase-level compression rather than tiny frequent changes.
- Reject compressions whose summary is not materially smaller than the raw range.
- Batch multiple disjoint closed ranges into one atomic tool call when useful.
- Keep block placement and summary text stable after creation.
- Perform no automatic range rewrites without an explicit model `compress` call.

No cache-saving claim should be made without provider-specific measurements.

## 13. Phased Implementation

### Phase 0 — Project scaffold and API spike

Deliverables:

- Minimal Pi package metadata.
- TypeScript config and test runner.
- Empty extension loading successfully through `pi -e .`.
- Small spike proving:
  - `context` can return cloned messages.
  - Active `SessionEntry` objects can be aligned with outbound messages.
  - Custom state entries persist and remain branch-local.
  - `session_compact` provides enough information for cleanup.

Exit criteria:

- Typecheck and unit tests run from a clean install.
- No implementation dependency on private Pi internals when a public export exists.
- Any unavoidable mapping limitation is documented before proceeding.

### Phase 1 — Configuration and state persistence ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Reproducible TypeScript package scaffold with declared Pi peer/development dependencies.
- Global and project `dcp.json` loading with project overrides.
- Positive token-count and percentage parsing, defaults, validation, and model-window resolution.
- Versioned, strictly validated, defensively cloned DCP state snapshots.
- Branch-local persistence through `pi.appendEntry("pi-dcp-state", snapshot)`.
- Active-branch restore on `session_start` and `session_tree`.
- Invalid/future state rejection with fallback to the latest valid snapshot.
- Unit tests plus real Pi `SessionManager` branch-isolation tests.
- Clean typecheck, test suite, and `pi -e .` extension-load smoke test.

Deliverables:

- Global/project config loading.
- Token and percentage limit resolution.
- Config validation and defaults.
- Versioned `DcpStateSnapshot` parser.
- Append/restore latest state on the active branch.

Tests:

- Numeric and percentage settings.
- Invalid values and min/max inversion.
- Empty, malformed, and future-version state entries.
- Latest snapshot on current branch wins.
- Sibling branch state does not leak.

Exit criteria:

- State survives `/reload` and `/resume` in a real Pi smoke test.
- Tree navigation restores branch-correct state.

### Phase 2 — Message mapping and safe range normalization ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Exact alignment of outbound messages with Pi's active, native-compaction-aware session entries.
- Deterministic request-local aliases backed by stable Pi entry IDs.
- Non-mutating, provider-safe annotations for user, assistant, tool-result, image, custom, branch-summary, compaction-summary, and bash-execution messages.
- Idempotent annotation stripping/reapplication across repeated context passes.
- Fail-open behavior for message count, ordering, or structural mismatches.
- Safe closed-range resolution with stale/missing/reversed alias diagnostics.
- Atomic normalization of sequential and parallel assistant tool-call/result batches.
- Rejection of orphaned, incomplete, duplicate, or interleaved tool protocols.
- Provider-neutral raw token estimates that exclude DCP annotation overhead.
- Unit and real Pi `SessionManager` compaction-context fixtures.

Deliverables:

- Stable entry-to-message mapping.
- Request-local short aliases.
- Idempotent model-visible annotations.
- Range validation and tool-group normalization.
- Raw token-size estimation for candidate ranges.

Tests:

- User, assistant, image, thinking, custom, branch-summary, and compaction entries.
- Sequential and parallel tool calls.
- No orphan tool call/results after normalized removal.
- Repeated context passes do not duplicate annotations.
- Invalid, reversed, missing, stale, or cross-branch IDs fail safely.

Exit criteria:

- Mapping failures pass original context through unchanged.
- Provider-compatible message invariants hold in fixture tests.

### Phase 3 — Compress tool and outbound pruning ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Sequential `compress` tool with one atomic multi-range call schema.
- Exact request-snapshot and active-branch freshness checks before execution.
- All-before-mutation validation for aliases, ordering, tool groups, active work, range overlap, and context-size benefit.
- Monotonic block allocation and append-first atomic state commits.
- Pure outbound overlays that replace source ranges with one synthetic DCP summary each.
- Historical `compress` summary-argument scrubbing without mutating session messages.
- Whole-current-segment protection, including in-flight tool loops.
- Fail-open overlay behavior for stale or inconsistent persisted boundaries.
- Real Pi `SessionManager` tests proving branch rejection, persistent snapshots, repeated fresh-context pruning, and intact source JSONL entries.
- Canonical sequential and parallel tool-protocol verification suitable for Pi's Anthropic/OpenAI provider adapters.

Deliverables:

- Sequential `compress` tool.
- Atomic multi-range validation.
- Compression state snapshots.
- Synthetic summary insertion.
- Historical compress-argument summary scrubbing.
- Context-size benefit check.

Tests:

- One range and multiple disjoint ranges.
- Summary appears exactly once.
- Raw session objects are never mutated.
- The original JSONL/session branch remains intact.
- Recent/in-flight work cannot be compressed.
- Compression applies on every fresh context rebuild, not only the first.

Exit criteria:

- A real Pi session can compress an old investigation range and continue successfully with Anthropic- and OpenAI-style tool protocols.

### Phase 4 — Overlap, supersession, and decompress ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Full-containment recompression that supersedes all contained active blocks.
- Benefit estimation against the effective outbound section, including existing synthetic summaries.
- Rejection of contained and partial overlaps with safe neighboring-boundary guidance.
- Monotonic block numbering with latest snapshots containing active blocks only.
- `/dcp`, `/dcp context`, `/dcp decompress`, and `/dcp decompress <block-id>` behavior.
- Restorability checks against Pi's current compaction-aware context entries.
- Conservative native-compaction diagnostics instead of false decompression success.
- Branch-local decompression through append-first complete state snapshots.
- Original-message restoration on the next outbound context build without session mutation.
- Tests for nested recompression, bounded state, stale blocks, command behavior, and sibling-branch isolation.

Deliverables:

- Full-containment supersession.
- Partial-overlap rejection.
- `/dcp context` and `/dcp decompress` commands.
- Bounded active-state snapshots.

Tests:

- Nested recompression supersedes old blocks.
- Partial overlap returns actionable error details.
- Decompress restores raw messages.
- Decompress on one branch does not affect siblings.
- No inactive/superseded record accumulation in latest state.

Exit criteria:

- Every listed active block is effective and restorable.

### Phase 5 — Nudge system ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Effective outbound token estimation after active compression overlays.
- Numeric and per-model percentage threshold resolution on every mapped context build.
- Below-minimum silence, throttled soft reminders, and repeatable per-request strong reminders.
- Branch-resettable iteration tracking keyed by unique session leaf, with reminders after fifteen model/tool continuations.
- One combined nudge when context pressure and iteration pressure coincide.
- Deterministic provider-compatible ephemeral messages with no session persistence.
- Idempotent per-request decisions, exact no-nudge array preservation, and append-stable aliases beyond `m999` for prompt-cache stability.
- Explicit guidance for semantic batching, preserved technical details, and recent/in-flight work protection.
- Fail-open behavior that avoids nudge injection when mapping or overlay protocol validation fails.
- Tests across threshold bands, model windows, long tool loops, repeated passes, and session immutability.
- Live `deepseek/deepseek-v4-flash` Pi smoke test: the model autonomously called `compress`, created `b1`, consumed its synthetic summary on the next turn, and left the original JSONL source intact.

Deliverables:

- Min/max threshold evaluation.
- Soft, strong, and iteration nudges.
- Per-request throttling.
- Ephemeral injection with no session persistence.

Tests:

- Below-min, between-threshold, and above-max behavior.
- Percentage thresholds across model windows.
- Long same-run tool loops trigger iteration nudges.
- No duplicate nudge within one request.
- Prompt cache remains stable on requests where no compression or nudge change occurs.

Exit criteria:

- The model discovers and uses `compress` without a manual slash command in a long smoke-test session.

### Phase 6 — Native compaction integration ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Pure native-compaction reconciliation against Pi's canonical `buildContextEntries()` sequence.
- Immediate cleanup on `session_compact` and repair on `session_start`/`session_tree`.
- Conservative retirement of fully consumed, boundary-crossing, and invalid-order blocks.
- Preservation of complete retained-tail blocks and monotonic `nextBlockNumber`.
- Append-first complete snapshot persistence with no in-memory advance on cleanup failure.
- Immediate ghost removal from `/dcp` inspection/decompression state.
- Resume/reload repair for sessions interrupted between Pi compaction and DCP cleanup.
- Repeated real DCP preparation plus Pi `SessionManager` compaction-cycle integration coverage with bounded active state.

Deliverables:

- `session_compact` reconciliation.
- Restore-time stale-state repair.
- Ghost-block cleanup.
- Correct command/UI status after native compaction.

Tests:

- Fully consumed block is removed.
- Boundary-crossing block is retired.
- Retained-tail block remains valid.
- Repeated native compactions do not grow active state.
- Decompress never falsely succeeds after native compaction.
- Cleanup works after resume/reload.

Exit criteria:

- Long integration test with repeated DCP and Pi native compactions shows bounded active state and no silent stale records.

### Phase 7 — Packaging, documentation, and trial release ✅

**Status:** Completed on 2026-07-18.

Implemented:

- Source-first private `0.1.0` local/Git experimental Pi package metadata.
- MIT license with copyright assigned to nostalfinals.
- README covering installation, two-field configuration, automatic behavior, commands, cache trade-offs, recovery, native compaction, and known limitations.
- Explicit independent-implementation attribution for OpenCode-DCP behavioral research with no AGPL source dependency or inclusion.
- Changelog for the initial trial release.
- GitHub Actions verification on Node.js 20, 22, and 24, including a Node 24 Pi extension-load smoke test.
- `verify` script plus package-content validation excluding tests and planning artifacts.
- Clean-install verification with 66 passing tests and no undeclared runtime imports.
- Successful local installation through `pi install /home/nostalfinals/Projects/pi-dcp`, `pi list` verification, and installed-package smoke load.

Deliverables:

- README with installation, two-field configuration, behavior, cache trade-offs, and recovery instructions.
- License and attribution decision documented.
- CI for supported Node and Pi versions.
- npm/git Pi package metadata.
- Changelog and initial experimental release.

Exit criteria:

- Clean clone can install, typecheck, test, and load in Pi.
- No undeclared runtime or typecheck dependencies.
- Known limitations are documented.

## 14. Verification Strategy

### 14.1 Unit tests

Pure tests cover config resolution, state snapshots, message mapping, boundary normalization, overlap rules, pruning, and compaction reconciliation.

### 14.2 SessionManager integration tests

Use real Pi session entries and `SessionManager` where practical. Do not rely only on hand-shaped message mocks for tree, compaction, and branch behavior.

### 14.3 Provider-shape fixtures

Validate at least:

- Anthropic-style assistant tool call followed by tool results.
- OpenAI-style tool-call/result pairing as normalized by Pi.
- Parallel tool-call batches.
- Images and non-text content.
- Existing Pi compaction and branch-summary messages.

### 14.4 Manual smoke scenarios

1. Long repository investigation, compress, continue implementation.
2. Compress on branch A, switch to branch B.
3. Decompress before native compaction.
4. DCP compress, then Pi `/compact`, then inspect active blocks.
5. Repeated DCP/native compaction cycle.
6. Reload and resume after each state mutation.
7. Switch between models with different context windows and percentage thresholds.

### 14.5 Invariants checked in every relevant test

- Session-owned messages are never mutated.
- Tool calls and results remain valid pairs.
- Active blocks belong to the active branch.
- Every active block affects at least one live source entry.
- Every listed block is restorable.
- Latest state size is bounded by active blocks.
- A pipeline failure returns original context.

## 15. Risks and Mitigations

### Model chooses poor ranges or summaries

Mitigation: early nudges, strict range validation, recent-work protection, benefit checks, and decompress before native compaction.

### Long-context retrieval degrades before compression

Mitigation: default thresholds begin well before the model's context limit and encourage compression at semantic boundaries.

### Prompt cache churn

Mitigation: throttle nudges, batch ranges, reject tiny savings, and never perform automatic range rewrites.

### Pi message mapping changes across versions

Mitigation: rely on exported session APIs, isolate mapping logic, fail open, and pin integration tests to supported Pi versions.

### Native compaction races with DCP state

Mitigation: reconcile on `session_compact` and again on `session_start`.

### Branch state leakage

Mitigation: store snapshots inside the Pi session tree and restore only from the active branch.

## 16. Definition of Done for v1

The v1 trial is complete when:

- A model can discover and call `compress` without user intervention.
- A validated closed message range is replaced by one summary in all subsequent outbound contexts.
- `/dcp decompress <block>` restores the original range before native compaction.
- `/tree`, `/fork`, `/resume`, and `/reload` preserve correct branch-local behavior.
- Pi native compaction retires consumed blocks with no ghost records.
- Only `minCompressContext` and `maxCompressContext` are user-configurable.
- Deduplication and purge-errors remain out of scope.
- Unit and real SessionManager integration tests cover the critical invariants.
- The package installs and runs from a clean checkout with no undeclared dependencies.
