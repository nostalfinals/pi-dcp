# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 - 2026-07-18

Initial experimental local/Git trial release.

### Added

- Two-field token or percentage threshold configuration.
- Request-local stable message aliases backed by Pi session entry IDs.
- Sequential, atomic model-authored range compression.
- Provider-safe outbound compression overlays without session-history mutation.
- Branch-local bounded state snapshots and restore behavior.
- Range overlap, supersession, and economic-benefit validation.
- `/dcp` inspection and branch-local decompression commands.
- Soft, strong, and long-iteration model nudges.
- Pi native-compaction reconciliation and ghost-block cleanup.
- Unit, provider-shape, and real Pi `SessionManager` integration coverage.

### Fixed

- Compact one-decimal `k` formatting for compression savings at 1,000 tokens and above.
- Model-emitted DCP markers are removed from finalized assistant output before persistence.
- DCP no longer injects metadata into assistant payloads. The following non-assistant message carries the preceding assistant alias, avoiding provider-visible assistant mutation while retaining range references.
- Strong-reminder false positives caused by serializing provider metadata instead of using Pi context usage.
- Compression savings no longer count JSON structure, provider accounting, or thinking signatures as prompt text; range estimates now use Pi's content-only token heuristic.
- Successful compression output now reports removed source tokens, added summary tokens, and net reduction separately.
