# pi-dcp

Experimental, branch-aware agentic Dynamic Context Pruning for [Pi](https://github.com/earendil-works/pi-mono).

`pi-dcp` lets the active model replace completed ranges of conversation history with its own high-fidelity summaries. Compression changes only the outbound context sent to the model: Pi's append-only session JSONL remains intact.

> **Trial status:** `0.1.0` is intended for local and Git-based evaluation. Keep Pi's native compaction enabled as the final overflow and consolidation fallback.

## What it does

- Adds compact request-local IDs such as `m001` to model-visible messages.
- Registers a sequential `compress` tool that the model can call without a slash command.
- Validates closed ranges, active work, branch freshness, overlap, savings, and complete tool-call/result groups.
- Replaces active ranges with synthetic summaries only in outbound model context.
- Persists bounded state inside the active Pi session branch.
- Supports decompression while Pi still retains the complete raw source range.
- Retires stale blocks after Pi native compaction, avoiding ghost summaries and records.
- Nudges the model at configurable effective-context thresholds and during long tool loops.

It does **not** delete messages, rewrite session JSONL, replace Pi's native summarizer, deduplicate tool calls, or purge failed-tool arguments.

## Requirements

- Node.js 20 or newer.
- `@earendil-works/pi-coding-agent` 0.80.10 is the tested Pi version.

## Install from this checkout

First validate the checkout:

```bash
cd /home/nostalfinals/Projects/pi-dcp
npm ci
npm run verify
```

Install it globally into Pi using the local directory:

```bash
pi install /home/nostalfinals/Projects/pi-dcp
```

Confirm that Pi recorded the package:

```bash
pi list
```

Restart Pi, or run `/reload` in an existing interactive Pi session. The extension then works automatically in every session.

To install it only for the current project:

```bash
pi install -l /home/nostalfinals/Projects/pi-dcp
```

To try it for one run without installing:

```bash
pi -e /home/nostalfinals/Projects/pi-dcp
```

Pi packages execute with full system access. Review extension source before installing packages from an untrusted location.

## Git installation

After this repository has a remote, Pi can install it directly from a Git URL:

```bash
pi install git:github.com/OWNER/REPOSITORY
```

A tag or commit can be pinned with `@REF`:

```bash
pi install git:github.com/OWNER/REPOSITORY@v0.1.0
```

This trial is intentionally not published to npm because the unscoped `pi-dcp` package name is already used by another project.

## Configuration

Three public settings are supported. Put them in either:

- Global: `~/.pi/agent/dcp.json`
- Project: `<project>/.pi/dcp.json`

Project settings override global settings.

Token-count example:

```json
{
  "minCompressContext": 50000,
  "maxCompressContext": 100000,
  "debugMarkerTrace": false
}
```

Percentage example:

```json
{
  "minCompressContext": "25%",
  "maxCompressContext": "80%"
}
```

Percentages are resolved against the active model's context window. The minimum must resolve below the maximum. Defaults are 50,000 and 100,000 tokens.

`debugMarkerTrace` defaults to `false`. When enabled, DCP writes grep-friendly JSON records to stderr for outbound context markers, streaming assistant marker events, and finalized-message sanitization. Records contain marker counts and short marker-adjacent excerpts, never complete conversation messages. Redirect stderr when reproducing a marker leak:

```bash
pi 2>/tmp/pi-dcp-marker-debug.log
```

A `message_update` or `message_end.before-sanitize` record proves that a marker entered model-generated assistant output. If only `context.outbound` records appear while the UI flashes a marker, the request overlay/TUI path is the likely source.

Threshold behavior:

- Below minimum: no threshold reminder.
- At or above minimum: throttled soft reminder.
- At or above maximum: strong reminder for each distinct eligible request.
- About fifteen model/tool continuations after one user message: iteration reminder.

A reminder never compresses automatically. The model still selects completed semantic ranges and writes each summary.

## Use

No startup command is required. Continue using Pi normally. When context pressure rises, the model sees DCP guidance and may call the registered `compress` tool with visible `mNNN` boundaries.

The model-visible aliases are temporary. DCP resolves them against the exact request snapshot and persists only stable Pi session entry IDs.

### Commands

#### `/dcp`

Shows active, currently restorable compression blocks. It is equivalent to `/dcp context`.

#### `/dcp context`

Shows active blocks, topics, abbreviated stable source boundaries, and decompression guidance.

```text
/dcp context
```

#### `/dcp decompress`

Lists active blocks that can still be restored.

```text
/dcp decompress
```

#### `/dcp decompress <block-id>`

Retires one active block and returns its original messages on the next context build.

```text
/dcp decompress b3
```

Decompression is branch-local. It cannot restore a range after Pi native compaction has consolidated part or all of its effective source.

Pi's own command remains available and enabled:

```text
/compact [optional focus instructions]
```

After native compaction, DCP automatically removes fully consumed and boundary-crossing blocks while retaining blocks whose complete source remains in Pi's retained tail.

## Branch and session behavior

DCP stores complete `pi-dcp-state` snapshots as Pi custom entries on the active branch:

- A sibling branch created before a compression does not inherit it.
- A child lineage created after a compression inherits it naturally.
- `/tree`, `/fork`, `/resume`, and `/reload` restore branch-local state.
- Block numbers remain monotonic and are not reused on the same lineage.
- Original source messages remain in the session JSONL.

## Prompt-cache and context trade-offs

DCP assigns every context message a deterministic request-local alias and injects a compact marker into the request overlay. Assistant markers are placed after signed thinking and before assistant text/tool calls. A system instruction marks them as read-only metadata, and finalized model output is sanitized before persistence if the model imitates a marker. Pi may still briefly render request-overlay or partially streamed markers in runtime views; this trial behavior is intentionally being evaluated. Existing aliases stay stable as append-only context grows, so normal requests add only a suffix.

Creating, superseding, or decompressing a block changes the prompt at that range's anchor and therefore loses cache from that point for the first changed request. Pi native compaction also changes the conversation prefix. Later requests can cache the new stable prefix.

DCP reduces churn by:

- encouraging phase-level semantic batches;
- throttling soft reminders;
- rejecting summaries that are not smaller than the effective replaced range;
- committing multiple submitted ranges atomically;
- avoiding automatic summary rewrites.

No provider-independent cache savings are guaranteed.

## Recovery and troubleshooting

### A summary is poor or no longer wanted

Run the following before Pi native compaction consumes its source:

```text
/dcp decompress b1
```

### A block cannot be decompressed

Pi native compaction has likely consolidated all or part of its source. The Pi native summary is then authoritative. DCP conservatively refuses to claim that the original effective range was restored.

### DCP reports a mapping or overlay warning

DCP fails open: it sends the uncompressed outbound conversation for that request rather than risking malformed provider history. Original session data is unaffected.

### Disable or remove the extension

Use `pi config` to disable package resources, or remove the local package registration:

```bash
pi remove /home/nostalfinals/Projects/pi-dcp
```

Removing the extension does not delete Pi sessions or their original messages. Existing `pi-dcp-state` custom entries remain harmless non-context metadata.

## Known limitations

- Summary quality depends on the active model.
- Only contiguous range compression is implemented.
- Compression requires exact entry/message alignment; unknown Pi message shapes fail open.
- A DCP block crossing a Pi native-compaction boundary is retired rather than partially rewritten.
- Decompression is unavailable after native compaction consumes any part of the source range.
- Marker and tool-schema overhead can outweigh tiny compressions; uneconomic ranges are rejected.
- The implementation is tested against Pi 0.80.10; future Pi message or session API changes may require updates.

## Development

```bash
npm ci
npm run check
npm test
npm run verify
```

Load the checkout directly:

```bash
pi -e .
```

## License and attribution

Copyright © 2026 nostalfinals. Licensed under the [MIT License](LICENSE).

This project is an independent implementation for Pi. Its behavioral design research considered the public behavior, concepts, and known issues of [OpenCode-DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), which is distributed under AGPL-3.0. No OpenCode-DCP source code is included, copied, translated, or linked as a dependency here. This implementation targets Pi's extension and session APIs and uses its own code, state model, and tests.
