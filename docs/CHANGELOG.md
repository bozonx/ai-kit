# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
