# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Validate PCM16 sample alignment, sample rates, and RIFF size limits before creating WAV files.

## [0.5.0] - 2026-09-23

### Added

- The built-in `deepl` machine-translation adapter, including Free API endpoint
  support through a catalog `baseUrl`.
- `runTranslationPipeline`, a provider-neutral deterministic quality gate with
  at most one paid repair pass. A source language detected by the first pass is
  used by its checks when the caller did not specify one.
- `empty_output`, reported when a provider returns no translation for non-empty
  source text.

### Changed

- Google Cloud Translation and DeepL reject empty translations as
  `invalid_output` instead of returning an apparently successful result.
- `chunkText` now strictly observes its documented maximum at a boundary that
  falls exactly at the limit.

## [0.4.0] - 2026-09-21

The package runs outside Node: in a browser and in a Tauri webview, as well as
on a server.

### Changed — breaking

- **`Catalog.fromFile` moved to `@bozonx/ai-kit/node` as `readCatalogFile`.**
  It was the one reason the main entry point imported `node:fs`. `fromYaml` and
  `fromObject` stay where they were.
- **Every accounting object carries `priced`** — `CallAccounting` (and so the
  stream's `usage` part), `EmbedAccounting`, `SttAccounting`, `MtAccounting`,
  `UsageEvent` and `CandidateQuote`. It is `true` for every call in a catalog
  that requires prices, which is the default.
- **`SocketSession.close(payload)` leaves the closing to the server.** With a
  payload — a provider's end-of-stream message — it sends it and waits for the
  server to flush and close, cutting it off after five seconds. It used to
  close at once, which only worked because `ws` keeps delivering frames on a
  closing socket; the platform `WebSocket` drops them.

### Added

- **`Transport` port** (`fetch`, `openSocket`) and `transport` on
  `createAiKit`. Every HTTP request — the AI SDK providers, speech, translation
  — goes through `fetch`; live speech through `openSocket`. Defaults:
  `platformFetch` and `platformSocket`, both exported. Adapter factories
  (`ProviderFactory`, `SttProviderFactory`, `TranslationProviderFactory`)
  receive the transport, optionally, so custom adapters can use it too.
- **`@bozonx/ai-kit/node`** with `readCatalogFile` and `wsSocketOpener`.
- **`openai-compatible` provider** for chat and embeddings (Ollama, LM Studio,
  vLLM, proxies) and for speech (`/audio/transcriptions`). Requires `baseUrl`;
  sends no `Authorization` header for an empty key. `openAiCompatibleSttAdapter`
  builds presets; Groq is now one.
- **`deepseek` provider** through `@ai-sdk/deepseek`.
- **`requirePricing` in the catalog**, `true` by default. Set to `false`, a
  model may have no price block; its calls record `costMicros: 0`,
  `priceVersion: 'unpriced'` (`UNPRICED`) and `priced: false`, and a budget
  never excludes it. `Catalog#requiresPricing` reports the setting.
- `test/invariants.spec.ts` walks the import graph of every entry point except
  `/node` and fails on `node:*`, `ws` or Node globals.

### Changed

- The platform `WebSocket` replaces `ws` as the default live-session socket.
  Node 22+, Deno and Bun send headers through it; a browser gets an
  `invalid_request` naming `transport.openSocket` instead of a retried outage.
- The client cache hashes keys with Web Crypto instead of `node:crypto`.
- `@ai-sdk/deepseek` and `@ai-sdk/openai-compatible` are new optional peer
  dependencies.

## [0.3.0] - 2026-09-20

The release that makes the package usable by a second product. Three of the
four headline changes are breaking, and all three were the same defect: things that
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
- **The main entry point is the kit, and the loops under it are no longer
  public.** `runGenerate`, `runStream`, `runTranscribe`, `runTranscribeStream`,
  `runTranslate`, `ExecutionDeps`, `SttExecutionDeps`, `MtExecutionDeps`,
  `ProviderRegistry`, `SttProviderRegistry` and `MtProviderRegistry` are gone
  from the exports. The only consumer that assembled them by hand did so to
  pass a customer's key per call, which `keys` on the request now does.
  Speech and translation extras moved to their own entry points:
  `@bozonx/ai-kit/stt` (adapters, `renderSubtitles`, `segmentWords`,
  `assertSttCapabilities`, the adapter interfaces) and
  `@bozonx/ai-kit/translate` (`googleCloudTranslationProvider`, glossary,
  quality detectors, the adapter interfaces).

### Changed (boundary review, before publication)

- **Sinks are best effort.** A `UsageSink` or `TraceSink` that throws no longer
  fails a call that has already been answered and paid for; a failed usage
  write is reported as a `<name>.usage-failed` span. All four kinds of call
  record through one path (`execute/record.ts`) instead of four copies.
- **A call that ends without an answer is recorded.** Every candidate failed,
  the budget ran out or the caller aborted: the `UsageSink` and
  `TraceSink.generation` hear about it at zero cost, with its status, the
  attempts it took and the error. Before, such a call reached neither.
- **The `usage` part of a stream is the full `CallAccounting`** — provider,
  model, `routeId`, `routedBy`, attempts and latency as well as tokens and
  cost — and the speech stream's `usage` part is the full `SttAccounting`.
  Consumers were rebuilding both from the `model` part and guessing at the
  attempts. `CallAccounting` now lives in `ports.ts`, `SttAccounting` in
  `stt/types.ts`; both are still exported from where they were.
- **A stream stopped after reasoning or tool calls alone is billed.** The
  estimate for a cancelled stream counted only answer text, so a stream that
  had only reasoned was recorded with no output. Any visible part now counts,
  and a failure after one is a `stream_interrupted`.
- **`mode` is optional** on every policy (`CandidatePolicy`, now shared by
  text, speech, translation and embeddings): left out, a policy is `manual`
  exactly when `requestedModel` names something. `isManual` is exported.
- **`signals` are optional on a language-model request** (`RequestPolicy`), and
  so is each field: the size of the request and its images are read off the
  messages when the caller does not say.
- **`kit.planTranslation` and `kit.planTranscription`** do for speech and
  translation what `kit.plan` does for text: one selection, quoted, handed back
  as `plan` so the call tries exactly what the caller reserved for.
  `CallPlan` extends the new `CandidatePlan`.

### Added (boundary review, before publication)

- `encodeSse` and `SseDecoder` in `@bozonx/ai-kit/stream`: both halves of the
  SSE wire for stream parts, handling split events, CRLF and comments. The
  `./stream` entry point is now `dist/stream/index.js` and also re-exports
  `CallAccounting`, `RoutedBy`, `TokenUsage` and `AiErrorKind` as types.
- `PhraseChunker` in `@bozonx/ai-kit/stt`: live PCM cut into phrases on a
  pause or at a ceiling, each with its offset in the session, for dictation
  over a batch model.

### Changed — breaking (added before publication)

- **The built-in Cloud Translation adapter is `google-translate`, not
  `google`.** That id is Gemini's, and a `KeyProvider` is asked for a key by
  provider id: under one name the two products shared a credential they do not
  share. A consumer registering the adapter under its own id no longer has to.
- **`zod` is a peer dependency.** A schema passed to `generate` is typed
  against the package's `zod`; two copies meant two incompatible `ZodType`s.
- Structured output uses `generateText` with `Output.object` instead of the
  deprecated `generateObject`. Behaviour is unchanged; a schema violation is
  still `invalid_output`.
- `compactHistory` returns `summary: null` when nothing has been dropped.

### Added (before publication)

- **Tools.** `tools`, `toolChoice` and `maxSteps` on `generate` and `stream`;
  tools make `needsTools` true. `GenerateResult` gains `toolCalls`, `steps` and
  `responseMessages`. A stream with several steps sums every step's usage.
  `tool` and `jsonSchema` are re-exported, with the `ToolSet` and `ToolChoice`
  types.
- **`providerOptions`** on every language-model request, passed through as is.
- **Embeddings.** Model kind `embedding` (priced through `pricing`, with
  `contextSize` as the per-input limit and descriptive `dimensions`),
  `kit.embed`, built-in adapters for `google`, `openai` and `openrouter`,
  `embeddingProviders` for others. `quoteCandidates` takes `embeddingTokens`.
- **`signalsFor`** — `estimatedInputTokens` and `hasImages` from a request's
  own messages, multi-part content included.
- **`isProviderFault`** — which failure kinds a route's health should count.
- **`compactHistory`** — the chat history window with a rolling summary, from
  the consumer, generic over the message shape, with `unsummarized`.
- **`splitParallelText`** in `/translate` — source and translation cut into
  corresponding pairs at paragraphs, lines or sentences, never through a word.
- `demotedRoutes` on the speech and translation policy inputs.
- **`kit.plan(request)`** — candidates, quotes and a capped output allowance from
  one selection; `plan` on the request makes the call use it.
- Each attempt's `maxOutputTokens` is capped at its own model's limit.
- Failed attempts of speech, translation and embedding calls are named
  `transcribe`, `translate` and `embed` in traces, not `generate`.

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
- **`keys` on every request**: credentials for that call only, applied over
  the `KeyProvider` — how a customer's own key is used without a kit per
  customer.
- **`AttemptObserver`** (`attempts` in `AiKitOptions`) hears about every
  candidate that failed, with its `routeId`, including the ones a fallback
  covered for. `AllCandidatesFailedError.failures` and the `attempt-failed`
  trace span carry `routeId` too. Before this a consumer's route health could
  only see the route that answered, so a route failing before the first token
  was never counted against.
- **`quoteCandidates`**: every candidate the policy would try, with its
  worst-case cost in tokens, seconds or characters — the upper bound a hold
  before the call has to cover.
- **`Catalog#toData()`**, the validated data back as valid input.
- **`callStatusFor(kind)`**: the usage status an error kind is recorded under.
- **`chunkText`**: long text cut between words to fit a request limit.
- **Audio helpers** in `@bozonx/ai-kit/stt`: `estimateAudioSeconds`,
  `pcm16Rms`, `SilenceDetector`, `pcm16ToWav`.
- `kindFromStatus` is exported and shared with the speech adapters, which had
  their own copy — one of them knew that 404 and 422 mean a bad request and the
  other did not.

### Fixed

- **A stream the consumer stopped reading is cancelled and recorded.**
  `runStream` had no `finally`: breaking out of the loop left the provider
  generating until the time budget ran out, and the `UsageSink` and
  `TraceSink` never heard about the call. It is now aborted, and recorded as
  `aborted` with what it had produced.
- **Provider clients are cached by a hash of the whole key**, not its last
  eight characters, in a bounded least-recently-used cache. With per-call keys
  two customers whose keys shared a suffix would have been served one client
  built with one of their keys, and every key was an entry that never left.

### Packaging

- `README.md` moved to the package root, so it ships with the package; it
  used to live in `docs/` and the npm page had none.
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
