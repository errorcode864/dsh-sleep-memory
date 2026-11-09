---
id: sleep-memory.readme-legacy
title: 历史英文说明
type: history
status: archived
updated: 2026-11-09
source_of_truth: history
---

# 历史英文说明

> 以下为 `0.1.0` 阶段的英文历史说明，保留用于追溯，不作为当前接口契约。
> 当前 `0.2.0` 的变更、配置、原文追溯与备份能力以 [中文说明](README.md)
> 和 [使用指南](docs/guides/reliability.md) 为准。

[English](./README.en.md) | [简体中文](./README.md)

Cross-session persistent memory for DeepSeek Harness agents: storage (`memory_write`), retrieval (`memory_recall`), sleep-time consolidation (`memory_sleep`, consolidation plus forgetting), and store management (`memory_manage`: list, forget, stats). Recall results are also injected into context before every turn automatically (the model never has to call a tool); user messages with significant emotion are scored by an LLM and settle into salient emotion memories on their own. A sidebar GUI panel (「记忆银行」) browses the store, plots the salient emotion space, lists dream edges, and triggers sleep cycles. The design maps Google Research *Sleep-time Compute* (arXiv:2606.03979) and the Ebbinghaus forgetting curve.

## Install

The package is a zero-dependency DSH plugin bundle (`name: dsh-sleep-memory`) consumed by the plugin manager. Recommended install: in DSH, open 「插件 → 添加插件 → 安装第三方插件」 and paste the git URL:

```
git+https://github.com/errorcode864/dsh-sleep-memory.git
```

- **Local development** (source = install): link the checkout into a profile as `node_modules/dsh-sleep-memory` (junction or `file:` dependency) and add `dsh-sleep-memory` to the profile `package.json` `bundles`. `index.js` changes hot-reload through a plugin disable/enable toggle; `client.js` changes take effect on page refresh.

## Status: M10-C

| Milestone | Scope | Status |
| --- | --- | --- |
| M1 | Storage domain + write/recall tools + BM25 retrieval + salient emotion memory + memorialized presentation | ✅ |
| M2 | Sleep consolidation: NREM clustering → deep layer; archive demotion; Ebbinghaus decay; hard forgetting; REM associate edges | ✅ |
| M3 | Association graph + spreading-activation recall | ✅ |
| M4 | Dual-branch auto-injection (implicit recall + LLM valence×arousal scoring) | ✅ |
| M5 | Web tool cards / plugin icon / bilingual README | ✅ |
| M6 | Store management tool (`memory_manage`: list / forget / stats) + management cards | ✅ |
| M7 | Salient emotion injection wording (✦[显著·激励] / ⚠️[显著·警示] tags with a fixed legend header) | ✅ |
| M8 | Semantic expansion recall (LLM query rewriting × hybrid BM25 on the injection path) | ✅ |
| M9 | Memory bank GUI panel (browse / emotion space / dream edges / sleep trigger) | ✅ |
| M10 | Time-window recall (`memory_recall` `since`/`until` filtering on `createdAt`) | ✅ |
| M10-B | Package rename to `dsh-sleep-memory` + publish readiness + docs | ✅ |
| M10-C | Bundle-detail-page config section (`plugins.bundle.config` slot, persisted via the host `configEditor`) | ✅ This release |

## Memory layers

| Layer | Semantics | Producer |
| --- | --- | --- |
| `surface` | Surface memories, decay quickly | `memory_write` |
| `salient` | Salient emotion memories (valence −1~+1 × arousal 0~1), never decay; negative ⚠️ caution / positive ✦ encouragement | `memory_write` (must pass the salience threshold) |
| `deep` | Deep gists produced by sleep consolidation (gist + `consolidates` edges pointing at members) | `memory_sleep` |
| `archive` | Aged standalone gists (layer demotion + gist, still recallable) | `memory_sleep` |

## Presentation is embellishment (iron rule)

`memory_recall` defaults to `fidelity: "recall"`: recent memories come back mostly verbatim, while distant ones are truncated by current strength into an impression gist with `drift` metadata (fadedness + note). **The underlying raw record is never rewritten** (archive gists live in a separate `gist` field); `fidelity: "raw"` always returns the original text. Surface memories superseded by deep consolidation (`supersededBy`) stop being recalled by default; the deep gist takes over, and deep hits carry a `linkedMemories` member count.

## Sleep consolidation (memory_sleep)

One sleep pass walks a snapshot of current records through four phases and returns a per-item report:

1. **Decay (Ebbinghaus)**: every non-salient memory is recomputed as `strength × 2^(−idleDays / (halfLife × (1 + importance)))`; salient is exempt.
2. **Consolidation (NREM)**: low-strength surface memories above the similarity threshold form a cluster → one deep gist record is generated, members are marked `supersededBy` and each gets a `gist`; unclustered singles whose strength has bottomed out demote to `archive`.
3. **Forgetting**: archived records whose strength reached the floor and have been idle beyond `deleteArchiveAfterDays` days are **hard-deleted** from storage (the only irreversible operation; the report lists each id/content preview/idle days). Records that have not bottomed out or are not idle long enough are kept (double guard).
4. **Dreaming (REM)**: bidirectional `dream-associate` edges are added between surviving non-salient records by word-vector similarity (consumed by `memory_recall` spreading activation).

Usage: the model can call `memory_sleep` at any time (`dryRun: true` computes without writing — read the report first, then run for real); a scheduled run also fires every `sleepIntervalMinutes` minutes by default (`0` disables the timer). Only one sleep runs at a time; concurrent calls return `busy`.

Known semantic boundaries:

- The timer is process-local: a desktop restart resets the countdown and missed cycles are not replayed; after a long idle period, call `memory_sleep` manually once.
- All decisions are based on the snapshot taken at cycle start; concurrent writes during the cycle are overwritten by the sleep result (any hit reinforcement lost that way is rebuilt on the next recall).
- Deep consolidation is bounded by `maxRecords`: when the store is full the phase is skipped for that cycle (report `capacityLimited: true`) rather than evicting existing memories.

## Spreading-activation recall

Beyond BM25 direct hits, `memory_recall` spreads activation outward along the `dream-associate` edges created during REM: querying A can bring up B that dreamed itself associated with A. Edges are stored one-directionally (attached to the source record) but traversal is bidirectional (out-edges + in-edges), so a hit on either side brings up the other.

- **Activation score** = direct-hit score × edge weight × `spreadDecay^hops` × neighbor's current strength; below `spreadMinActivation` it is dropped, beyond `spreadDepth` hops traversal stops.
- **`via` marker**: associated hits carry `via: { from, relation, hops }` (`from` is the previous record id, pointing one link up the chain on multi-hop paths); they sort after all direct hits by activation score descending. Direct hits never carry `via`, and a record appears only once (an already-directly-hit neighbor is not repeated as an association).
- **No reinforcement**: associated hits do not write back `accessCount`/`strength` — being awakened by association is not being actually recalled; only direct hits reinforce as usual.
- **Filter parity**: `supersededBy` records do not spread; the `layers` argument constrains direct hits and spread neighbors alike; associations beyond the `recallBudget` are bounded separately by `spreadMaxNeighbors`.

## Time-window recall (M10)

`memory_recall` accepts optional `since`/`until` epoch-millisecond bounds on the record `createdAt`: both endpoints inclusive, applied as a hard pre-filter before BM25 scoring, and carried into spreading activation so association neighbors outside the window are excluded too. Omitted bounds are unbounded; the injection path takes no time filter and is unchanged. Invalid values (negative, non-integer, or `since > until`) are rejected with `invalid_args`.

## Dual-branch auto-injection

Besides `memory_recall`, the plugin attaches two side channels at the first step of every turn with no tool call required:

**Branch 1: implicit recall injection.** A listener on the `agent/pre-step` waterfall extracts a query from the step's last user message and runs the exact same pipeline as the tool (BM25 + salience boost + spreading activation), takes direct hits scoring at least `injectMinScore` (up to `injectBudget`, each truncated to `injectMaxCharsPerHit` chars), and inserts them as one user message tagged `source.kind: "sleep-memory"` right after the triggering message. The injected text (Chinese, fixed once shipped) opens with "[sleep-memory 记忆库自动唤起]", declares that it is not the user speaking, and adds one fixed ✦/⚠️ marker legend so the model cannot mistake memories for user statements or misread a salient memory's polarity:

```
[sleep-memory 记忆库自动唤起] 以下是你的持久记忆库中与用户当前消息相关的记忆，仅供参考（这不是用户说的话）。✦ 为激励线索（指向值得重复的选择），⚠️ 为警示线索（相似情境再现时优先回顾教训）：
- [表层] memory body...
- ✦[显著·激励] 用户消息带显著积极情绪（激励线索，valence=0.80, arousal=0.80）：...
- ⚠️[显著·警示] 用户消息带显著消极情绪（警示线索，valence=-0.90, arousal=0.70）：...
- [表层] associated body...（由联想边带出）
```

- **Reinforcement matches tool recall**: directly hit memories injected this way write back `accessCount`/`strength` as usual; associated hits do not reinforce.
- **Idempotence and pass-through**: non-enter decisions, non-first steps, missing user messages, or a message that already carries a sleep-memory source return the decision unchanged and never inject twice; if injection itself fails the original decision is returned and the conversation is never blocked.
- **Log consistency**: the injected message is a real user message persisted with the session log, satisfying "model-visible ⟺ logged".

**Branch 2: LLM emotion scoring.** On the same event, the plugin fire-and-forget calls the optional `llm` service to score the user message by valence (−1~+1) × arousal (0~1); messages passing the salience threshold (shared with `memory_write`: `salienceValenceThreshold`/`salienceArousalThreshold`) settle automatically into a salient memory tagged `auto-salient`, with the body prefixed "警示线索" (caution cue, valence < 0) or "激励线索" (incentive cue, valence ≥ 0) plus the valence/arousal values so the polarity is readable from the content itself. Scoring never modifies existing `memory_write` records and never awaits its result — any failure (no `llm` service, timeout, unparseable output, non-stop finish, store at capacity) is silently abandoned, never blocking or polluting the current turn. Each message is scored at most once.

## Semantic expansion recall (M8)

With `semanticRecallEnabled` (default off), the injection path first asks the current route's model to rewrite the user message into retrieval terms (synonyms, near expressions, related entities, English equivalents — one per line, capped by `semanticMaxTerms`), then scores the same candidate set once more with BM25 over those terms, added to the original score by weight: `score = BM25(query) + semanticRecallWeight × BM25(expanded terms)`. The rewrite lets memories that phrase the same thing differently still hit (e.g. "波塞冬号" expanding to "海神").

The expansion call follows the same calling convention as emotion scoring (block-array messages, streamed accumulation, timeout abort); any failure — no `llm` service, invalid route, timeout, non-stop finish, unparseable output — silently falls back to pure BM25 and never blocks injection. Expanded terms flow only through the injection path; the `memory_recall` tool path leaves query organization to the model and is not expanded. When on, each injected turn adds one lightweight LLM call (`semanticRecallTimeoutMs` defaults to 3 seconds, shorter than the scoring timeout to protect injection latency).

## Web tool cards

All four tools project rich `generic` Web cards. The call card carries a title plus an input preview; the result card is derived only from replayable JSON that `output.presentationMeta` persists as `result.meta`, and presenters are pure functions of args plus result, so live streaming and log replay render identically. Unknown or malformed metadata falls back to the bare generic card.

- `memory_write`: the success card names the layer and kind plus the record id; rejections (invalid args, unmet salience threshold, store at capacity) show the code and message.
- `memory_recall`: hit lines with layer, drift marker, score, and association annotations, plus a footer counting association-brought hits; zero hits get an actionable hint.
- `memory_sleep`: a report card with record before/after counts, per-phase counts (consolidated / archived / decayed / deleted / REM edges), the capacity flag, and a dry-run note.
- `memory_manage`: `list` shows total/offset/limit plus one line per record (layer, importance, content preview); `forget` states the deleted count including the superseded cascade; `stats` shows per-layer counts, capacity, superseded count, edge count, and oldest/newest record ids.

## Plugin icon and localization

`icon.svg` (a crescent moon over a constellation on an indigo night) ships through the manifest `icon` field; `locale/en.json` and `locale/zh.json` provide the plugin title and description shown in the plugin manager.

## Memory bank GUI panel (M9)

The plugin ships a client module (`./client`) that registers a「记忆银行」entry in the sidebar, backed by a Node-side Remote service `sleepMemoryApi` (`ctx.reflect.provide`) with four declared methods: `stats`, `list` (layer filter + substring search + offset pagination), `edges`, and `runSleep` (`dryRun` supported). Read methods never write; `runSleep` is the only write and reuses the same `runSleepCycle` as the tool. Failures return structured errors with `sleep-memory/<code>` codes (`bad-layer`/`bad-limit`/`bad-offset`/`bad-request`).

The panel has three tabs:

- **浏览 (browse)**: a stats card (total, per-layer counts, capacity, superseded count, edge count, oldest/newest record) plus a record list with layer filter, debounced substring search, and incremental "load more" pagination; each row shows layer, kind, importance, tags, and a wire-truncated content preview (2000 chars).
- **情绪空间 (scatter)**: an SVG scatter of salient memories in valence (−1~+1) × arousal (0~1) space; points split into encouragement ✦ (valence ≥ 0) and caution ⚠️ (valence < 0) halves, with hover tooltips.
- **联想边 (edges)**: REM `dream-associate` edges grouped by relation (`dream-associate` / `consolidates`), each line naming both endpoints and their layers.

Header actions「立即睡眠」(run sleep now) and「预演」(dry run) call `runSleep` and show the SleepReport badges (consolidated / archived / decayed / deleted / edges). All copy is locale-owned (embedded zh/en dictionaries registered under the plugin's locale namespace), styling uses only `--dsw-*` tokens, and the module cleans up fully on disposal (HMR-safe).

## Plugin configuration section (M10-C)

The client module registers the `plugins.bundle.config` slot (key = the package name `dsh-sleep-memory`), so the plugin's bundle detail page on the Plugins page renders an inline configuration section between the description and the package rows:

| Field | Control | Range |
| --- | --- | --- |
| `injectEnabled` | checkbox | on/off |
| `recallBudget` | number input | 1–50 |
| `injectBudget` | number input | 0–10 |
| `sleepIntervalMinutes` | number input | 0–10080 (0 disables the timer) |

- Values load through the plugin's `getConfig` bridge method: each field carries its current value, schema default, `overridden` flag, type, and (for integers) the min/max range.
- A field counts as overridden when its key exists in the profile config overlay (presence, not value comparison); each overridden field gets a reset affordance that removes the key so the plugin falls back to its default.
- Saves call `setConfig`, which validates first, then persists through the host `configEditor` (`edit(entry, change)` on the `sleep-memory` row): the editor re-validates against the plugin's `Config` schema, writes the profile overlay, and triggers a Loader reconcile, so changes take effect immediately. Identical values are skipped as no-ops; `{ key: null }` resets.
- Failures render an inline error line under the section; when the config editor or the plugin row is unavailable the section reports the load error instead of controls.

## Configuration

M1 (write and recall):

| Field | Default | Meaning |
| --- | --- | --- |
| `recallBudget` | 5 | Max records per recall |
| `maxContentChars` | 8000 | Max characters per memory body |
| `maxTags` / `maxKeywords` | 8 / 12 | Max tag and keyword counts |
| `salienceRecallBoost` | 0.5 | Retrieval boost factor for salient emotion memories |
| `strengthRecallGain` | 0.1 | Strength gain per hit |
| `salienceValenceThreshold` | 0.6 | Required \|valence\| to write a salient memory |
| `salienceArousalThreshold` | 0.7 | Required arousal to write a salient memory |
| `maxRecords` | 20000 | Record cap (writes are rejected when full, not silently evicted) |

M2 (sleep consolidation):

| Field | Default | Meaning |
| --- | --- | --- |
| `sleepIntervalMinutes` | 360 | Scheduled sleep interval in minutes, 0 disables |
| `decayHalfLifeDays` | 14 | Base decay half-life in days, scaled by importance |
| `consolidateStrengthLine` | 0.55 | Strength line for surface memories to join consolidation |
| `consolidateMinSimilarity` | 0.45 | Word-vector cosine similarity required to cluster |
| `archiveStrengthFloor` | 0.35 | Strength floor for demotion/deletion decisions |
| `deleteArchiveAfterDays` | 90 | Idle days before an archived record is hard-deleted |
| `dreamEdgesPerRecord` | 2 | Max new association edges per record |
| `dreamMaxCandidates` | 300 | Max records considered in the REM phase |
| `deepSummaryMaxChars` | 1200 | Max characters per deep gist body |

M3 (spreading-activation recall):

| Field | Default | Meaning |
| --- | --- | --- |
| `spreadDepth` | 1 | Max spread hops (0 disables spreading) |
| `spreadDecay` | 0.5 | Per-hop activation decay factor |
| `spreadMaxNeighbors` | 3 | Max associated hits per recall |
| `spreadMinActivation` | 0.05 | Minimum activation score for an associated hit |

M4 (dual-branch auto-injection):

| Field | Default | Meaning |
| --- | --- | --- |
| `injectEnabled` | true | When false the injection branch is fully off (tool recall unaffected) |
| `injectBudget` | 3 | Max direct hits per injection, 0 disables injection |
| `injectMinScore` | 0.5 | Minimum retrieval score for an injected hit |
| `injectMaxCharsPerHit` | 400 | Body truncation length per injected memory |
| `salientScoringEnabled` | true | When false the emotion-scoring branch is off |
| `salientScoringTimeoutMs` | 30000 | Timeout per scoring call in milliseconds |

M6 (store management):

| Field | Default | Meaning |
| --- | --- | --- |
| `manageListMaxItems` | 50 | Default page size for `memory_manage` `list` results (each request bounded to 1–500) |
| `manageListPreviewChars` | 120 | Content preview length per record in `list` results |

M8 (semantic expansion recall):

| Field | Default | Meaning |
| --- | --- | --- |
| `semanticRecallEnabled` | false | When on, the injection recall first rewrites the query into retrieval terms with an LLM (hybrid BM25) |
| `semanticRecallWeight` | 0.5 | Weight factor for the expanded-term BM25 score (0–1, added to the original score) |
| `semanticRecallTimeoutMs` | 3000 | Expansion call timeout in milliseconds (latency-sensitive injection path, shorter than the scoring timeout) |
| `semanticMaxTerms` | 8 | Cap on expanded retrieval terms participating in hybrid recall (1–20) |

Configuration errors throw at plugin load time (fail loud).

## Local verification

```sh
node smoke.mjs   # a mocked ctx drives 73 behavior scenarios (M1 write/recall + M2 four-phase sleep + M3 spread recall + M4 injection/scoring + M5 card projection + M6 manage tool + M8 semantic expansion recall + M9 GUI Remote service + M10 time-window recall)
```

## Known limitations

- Retrieval is in-memory BM25 over the whole table, good to tens of thousands of records; larger scale (externalized token index, etc.) will be evaluated later.
- Emotion on `memory_write` still comes from the calling model's self-assessment; injection-time LLM scoring goes through the declared `llm` service (the same property-access style as built-in model consumers), and a missing service or failed call silently skips that branch (no salient memory is produced) without affecting anything else.
- Auto-injection appends one user message per turn to the context, spending token budget; bound it with `injectBudget`/`injectMaxCharsPerHit`, or set `injectEnabled: false` to return to pure tool recall.
- Spreading only travels `dream-associate` edges; `consolidates` edges (deep → members) do not participate. High-frequency stop words in BM25 (like "的") can cause weak direct hits — that is M1 retrieval semantics.
- The GUI panel is read-only except for triggering sleep (`runSleep`, with dry-run); record edits go through `memory_manage`/`memory_write`. Record content is wire-truncated at 2000 chars per row (full text stays retrievable via `memory_recall`), and the panel is a single-file local client module without its own unit tests — behavior is covered by the M9 service scenes in `smoke.mjs` and must be visually confirmed in the browser.

## License

[MIT](./LICENSE) © errorcode864
