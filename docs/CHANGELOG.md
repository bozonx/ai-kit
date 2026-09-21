# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-09-20

The release that makes the package usable by a second product. Three of the
four changes are breaking, and all three were the same defect: things that
belong to a consumer had been written into the library.

### Changed — breaking

- **Task classes are the consumer's own words.** `TASK_CLASSES` was a closed
  list of sixteen strings, and the list held `generate_post`, `alt_text`,
  `bulk_plan` and `subtitles` — one product's vocabulary inside a library that
  claims to know nothing about anybody's domain. A second product could fork
  the package or call its ticket triage `rewrite`. `TaskClass` is now `string`,
  and the invariant the list used to carry is read off the data instead:
  `Catalog.kindOf()` works out whether a class is served by `llm`, `stt` or
  `mt` models from the models nominated for it, and the schema refuses a class
  that mixes two kinds. `kindOfTaskClass` and `STT_TASK_CLASSES` are gone;
  `test/invariants.spec.ts` fails if the vocabulary grows back.
- **A candidate is a route, not a model.** `ModelCandidate` carries
  `route: ResolvedRoute`, and `attemptCandidates` hands whole candidates to
  `prepare`/`run`. The consumer that needed "same model, another provider" had
  been building one catalog per route depth and retrying the whole call against
  each — a fallback mechanism on top of the fallback mechanism, because the
  library resolved exactly one provider per model.
- **`StateStore` and `MemoryStateStore` are removed.** Nothing in the package
  read them and no consumer implemented one: a port declared for users who had
  not arrived yet, with a `compareAndSet` nobody called. It comes back with the
  circuit breaker that needs it.
- `UsageEvent` gains `characters` (alongside `audioSeconds`) and an optional
  `routeId`. `calculateCost`, `estimateCost` and `calculateSttCost` take a
  price-carrying object rather than a whole `ModelDefinition`, so a route and a
  model are priced by the same arithmetic.
- `ProviderFactory` may return a promise and receives `baseUrl`, which the
  language-model registry previously accepted in the schema and ignored.

### Added

- **Routes.** A model definition is its own first route; `routes:` adds backups
  at other providers, each with its own `priority`, price, endpoint, narrowed
  `capabilities` and consumer-supplied `id`. Every route of a model is tried
  before the next model is considered, the call is priced at the route that
  answered, and `routeId` travels through `CallAccounting`, the `model` stream
  part and the usage event. `PolicyInput.demotedRoutes` lets a consumer's
  health automation move a route to the back of the list — never out of it.
- **Machine translation**, the catalog's third kind of model: `kind: mt`,
  `mtPricing` (per million characters), `mtCapabilities`, `runTranslate`,
  `kit.translate`, `MtProviderRegistry` and a Google Cloud Translation v2
  adapter. Priced exactly before the call, because the characters are in hand.
- **A binding glossary** (`glossary.ts`) and **deterministic translation
  quality detectors** (`quality.ts`): passages left in the source language,
  lost links and placeholders, structure drift, looping, truncation, an
  unexpected writing system, a violated glossary. No model takes part in the
  detection.
- **Subtitles**: `renderSubtitles` (SRT and WebVTT, cutting long cues on a real
  pause where word timings allow) and `segmentWords`, which pairs a provider's
  flat word list with its segments.
- `anthropic` as a fourth built-in language-model adapter.
- `kindFromStatus` is exported and shared with the speech adapters, which had
  their own copy — one of them knew that 404 and 422 mean a bad request and the
  other did not.

### Packaging

- The provider SDKs and `ws` are **optional peer dependencies**, loaded on
  first use. A missing one produces a sentence naming what to install. A
  product that calls only OpenAI no longer installs Google's SDK.
- `@bozonx/ai-kit/stream` is a second entry point with the stream-part types
  alone, so a browser can share the wire vocabulary without the Node entry.
- `sideEffects: false`.

### Tests

- Coverage of the provider adapters went from 5% to 87%: the HTTP adapters
  against recorded provider answers, the live ones against a real WebSocket
  server. Overall 62% → 86%, 90 tests → 174.

## [0.2.0] - 2026-08-31

### Added

- Speech-to-text as a second domain of the same package: `kit.transcribe` for a
  finished recording and `kit.transcribeStream` for live dictation, with the
  `TranscriptPart` vocabulary (`model`, `partial`, `final`, `usage`, `error`,
  `finish`) shared by both ends of the connection.
- Provider adapters for AssemblyAI (batch and live), Deepgram (batch and live)
  and Groq (batch), behind the `SttProvider` port and `SttProviderRegistry`.
- Catalog support for speech: `kind`, `sttPricing`, `sttCapabilities`,
  `languages` and an optional `baseUrl`, with validation that refuses a model
  carrying both price blocks, a realtime model without a realtime price, and a
  diarizing model without its surcharge.
- The task classes `dictation`, `transcription` and `subtitles`. A task class is
  served by exactly one kind of model, and the catalog refuses to load when one
  nominates the other.
- `calculateSttCost` and `estimateSttCost`, priced per hour of audio with
  seconds rounded up the way providers round them.
- Language filtering in the policy: a model that declares `languages` is dropped
  for a language it does not claim, rather than returning plausible nonsense.
- `assertSttCapabilities`, which refuses an option the chosen model cannot
  honour instead of silently dropping it.

### Changed

- `UsageEvent` gained a required `audioSeconds`, zero for language calls.
- `contextSize`, `maxOutputTokens` and `pricing` are optional on a catalog entry
  and required for models of kind `llm`, which is checked on load.
- The retry and fallback loop moved to `src/execute/attempt.ts` and is now
  shared by text and speech. A provider whose client cannot be built — a missing
  key, for instance — is now that candidate's failure rather than the whole
  call's, so the next candidate gets its turn.

## [0.1.0] - 2026-08-28

### Added

- A reusable TypeScript library published as `@bozonx/ai-kit`.
- A validated, consumer-owned model catalog with pricing and capability data.
- Model-selection policies, provider registry adapters, retrying generation and
  streaming execution, cost accounting, and prompt assembly for untrusted data.
- Ports for keys, state, usage, traces, and time, plus `MemoryStateStore`.
- Public stream-part and error vocabularies.
- Tests that enforce the package boundary: no framework or ORM imports,
  environment reads, logging, or product-domain terms in `src/`.

### Changed

- Replaced the former HTTP microservice with an in-process library. The legacy
  service remains available through the `legacy-service` Git tag.

[0.2.0]: https://github.com/bozonx/ai-kit/releases/tag/v0.2.0
[0.1.0]: https://github.com/bozonx/ai-kit/releases/tag/v0.1.0
