# @bozonx/ai-kit

The part of an AI feature that is the same in every product.

Not a model router, and no longer a microservice: a library you call in-process.
It holds a priced model catalog, the rules for choosing a model and retrying a
call, the vocabulary a streamed answer is made of, error classification, and the
ports through which a host supplies keys and observability.

It deliberately holds nothing about tenants, users, projects, permissions,
storage or money. If a component needs one of those words, it belongs to the
application, not here — and a test fails when it creeps in.

> **Status: 0.4.0.** The package includes the catalog with multi-provider
> routes, model-selection policy, provider registries, generation and streaming
> execution with retries, prompt assembly, cost accounting, ports, error
> taxonomy, speech-to-text — batch and live — over AssemblyAI, Deepgram, Groq
> and any OpenAI-compatible server, subtitle rendering, and machine translation
> over a dedicated engine with a binding glossary and deterministic quality
> detectors. It runs on a server, in a browser and in a Tauri webview.
>
> **Upgrading from 0.3:** `Catalog.fromFile` is now `readCatalogFile` from
> `@bozonx/ai-kit/node`, and every accounting object and `UsageEvent` carries
> `priced`. See `docs/CHANGELOG.md`.

## Install

```bash
pnpm add @bozonx/ai-kit
```

During development, consume it through a workspace link so that changes are
visible without publishing.

## Entry points

| Import | What is in it |
|---|---|
| `@bozonx/ai-kit` | `createAiKit` and everything needed to call it: the catalog, pricing, policy, errors, ports, prompt assembly, tools, chat history compaction, request and result types |
| `@bozonx/ai-kit/stt` | Speech extras: provider adapters, subtitles, word segmentation, audio helpers (`estimateAudioSeconds`, `SilenceDetector`, `PhraseChunker`, `pcm16ToWav`) |
| `@bozonx/ai-kit/translate` | Translation extras: the Cloud Translation adapter, parallel text splitting, the binding glossary, the quality detectors |
| `@bozonx/ai-kit/stream` | The stream-part types and the SSE codec (`encodeSse`, `SseDecoder`) |
| `@bozonx/ai-kit/node` | What needs Node: `readCatalogFile` and `wsSocketOpener` |

Every entry point except `/node` loads without Node: the network goes through
the `Transport` port, hashing through Web Crypto, and a test walks the import
graph of each one to keep it that way. See [Running outside Node](#running-outside-node).

The kit is the way to call a model. The loops underneath it — retry, fallback,
pricing — are not exported on their own: a consumer that needs something the
kit does not offer should get it added to the kit rather than reassemble the
kit's internals by hand.

## The catalog

The catalog is the main entity, not a lookup table. It says what a model costs,
what it can do, and which tasks it is a candidate for — so changing the model
behind a product feature is an edit to a YAML file, not a release.

```yaml
models:
  - name: gemini-2.5-flash
    provider: google
    model: gemini-2.5-flash
    tier: standard # economy | standard | premium
    contextSize: 1048576
    maxOutputTokens: 65536
    modalities:
      input: [text, image, audio, pdf]
      output: [text]
    capabilities:
      tools: true
      structuredOutput: true
      promptCaching: true
    pricing:
      version: '2026-08'
      # Per million tokens, in micro-units of the currency: 1_000_000 = 1 USD.
      inputPerMTok: 300000
      outputPerMTok: 2500000
      cachedInputPerMTok: 75000

taskClasses:
  summarize: [gemini-2.5-flash, gpt-4.1-mini]
  chat_agentic: [gemini-2.5-pro, claude-sonnet-4.5]
```

**Task class names are yours.** The library ships no list of them: `summarize`
and `chat_agentic` above are this example's words, and a product about support
tickets writes `triage` and `suggest_reply` instead. What the library works out
for itself is whether a class is served by language models, speech models or a
translation engine — it reads that off the models nominated for it, and refuses
a catalog whose class mixes two kinds.

```ts
import { calculateCost } from '@bozonx/ai-kit';
import { readCatalogFile } from '@bozonx/ai-kit/node';

// Throws on a bad price, an unknown model in a task class, a duplicate name.
// Loudly, at startup — a catalog that is wrong is a bill that is wrong.
// Outside Node: `Catalog.fromYaml(text)` or `Catalog.fromObject(data)`.
const catalog = readCatalogFile('./models.yaml');

const model = catalog.require('gemini-2.5-flash');
const cost = calculateCost(model, {
  inputTokens: 12_000,
  cachedInputTokens: 8_000,
  outputTokens: 900,
  reasoningTokens: 0,
});
// cost.totalMicros, cost.priceVersion — hand these to your own accounting.
```

`pricing.version` exists so that history stays recomputable after a provider
changes prices. Record it with every call; without it a re-pricing turns the
past into numbers nobody can defend.

Every model needs its price block — `pricing`, `sttPricing` or `mtPricing` —
unless the catalog sets `requirePricing: false`. That is for a catalog nobody
is billed through: a desktop app on the user's own key, a local model. An
unpriced call is then recorded with `costMicros: 0`, `priceVersion: 'unpriced'`
and `priced: false`, and a quote carries `priced: false` too — a bare zero is
what a free call looks like, and a billing product must be able to tell the two
apart. Leave it on in anything that charges money.

`tier` is the boundary a fallback may not cross. A premium model quietly
replaced by a free one is not a degraded answer, it is a different product.

## Routes: the same model somewhere else

A model definition carries one provider, and that provider is its first route.
`routes:` adds backups — the same model at another provider, at another price,
tried in `priority` order:

```yaml
  - name: claude-sonnet-4.5
    provider: openrouter
    model: anthropic/claude-sonnet-4.5
    pricing: { version: '2026-08', inputPerMTok: 3000000, outputPerMTok: 15000000 }
    routes:
      - id: sonnet-direct # your own id, echoed back in the accounting
        provider: anthropic
        model: claude-sonnet-4-5
        priority: 10
        pricing: { version: '2026-08-direct', inputPerMTok: 3000000, outputPerMTok: 15000000 }
        capabilities: { structuredOutput: true } # only what this route changes
```

Every route of a model is tried before the next model is considered, which is
what makes "we try another route, never another model" true for somebody who
pinned a model by name. The call is priced at the route that actually answered,
and `routeId` travels through `CallAccounting`, the `model` stream part and the
usage event — so a consumer with its own health automation can report a route
as unhealthy through `demotedRoutes`, which moves it to the back of the list
and never removes it.

## Ports

Everything the library needs from the outside arrives through `src/ports.ts`:
`KeyProvider`, `UsageSink`, `TraceSink`, `AttemptObserver`, `Clock`,
`Transport`. All are
optional except keys — a library that cannot be called until five interfaces
are implemented gets worked around instead of used.

`UsageSink` is optional in practice too. Every result — and the `usage` part of
a stream — carries the full accounting, so a consumer that has to attach a
tenant to each row can record from the result and leave the sink empty.
`isProviderFault(kind)` says which failures a route's health should count.

Sinks are called best effort. A `UsageSink` that throws does not fail the call
it was recording — the provider has answered and been paid by then — and is
reported as a `<name>.usage-failed` span on the `TraceSink` instead. A call
that ends without an answer (every candidate failed, the time budget ran out,
the caller aborted) is still recorded, at zero cost, with its status and the
number of attempts it took.

`AttemptObserver` hears about every candidate that failed, by `routeId`,
including the ones a fallback then covered for. The result of a call only
names the route that answered, so this is what a consumer's route health
automation feeds on. `AllCandidatesFailedError.failures` carries the same
`routeId` for the case where nothing answered.

### A customer's own key

Every request takes `keys`: credentials for that call only, by provider id,
applied over the `KeyProvider`. There is no need to build a kit per customer.

```ts
await kit.transcribe({
  policy: { mode: 'auto', taskClass: 'transcription' },
  source: { url },
  keys: { deepgram: customerKey },
});
```

Clients are cached per provider, endpoint, model and a hash of the whole key,
with a bounded least-recently-used cache, so per-call keys neither leak memory
nor share a client between two customers.

## Choosing a model

Every call takes a `policy`. Only `taskClass` is required:

```ts
{ taskClass: 'chat' }                               // the catalog's order
{ taskClass: 'chat', requestedModel: 'gpt-5-mini' } // pinned; mode is implied
{ taskClass: 'chat', demotedRoutes: unhealthyIds }  // failing routes go last
```

`mode` may still be given explicitly; left out, a policy is `manual` exactly
when `requestedModel` names something. `demotedRoutes` applies to a pinned
model too — its failing route is tried after its healthy ones.

For a language-model call the `signals` are optional as well: the size of the
request and whether it carries images are read off `system` and `messages`
(the same `signalsFor` a consumer can call itself), and what the request asks
for — a schema, tools, streaming, an output allowance — is added on top.

## Quoting before a call

A consumer that reserves budget has to hold enough for the dearest candidate
in the fallback chain, not only the first. `quoteCandidates` lists every
candidate `selectCandidates` would try with its worst-case cost — tokens for a
language model, seconds for speech, characters for an engine — and leaves the
choice of maximum to the caller, whose markup may depend on the price:

```ts
const quotes = quoteCandidates(policy, kit.catalog, { characters: 12_000 });
const hold = Math.max(0, ...quotes.map(quote => quote.costMicros));
```

For a language-model call, `kit.plan(request)` does the selection once and
returns the candidates, their quotes and the output allowance capped at the
first candidate's limit. Hand it back as `plan` on the same request, and the
call tries exactly the candidates the hold was sized for:

```ts
const plan = kit.plan(request);
await reserve(Math.max(0, ...plan.quotes.map(quote => quote.costMicros)));
const result = await kit.generate({ ...request, plan, maxOutputTokens: plan.maxOutputTokens });
```

Each attempt is sent at most the output its own model can produce, so a
fallback to a model with a smaller limit is not refused for a number chosen for
another one.

Speech and translation plan the same way. `kit.planTranslation(request)`
quotes every engine exactly, from the characters in hand;
`kit.planTranscription(request, { audioSeconds, realtime })` quotes every speech
model for the audio expected. Both return `{ candidates, quotes }`, and both
requests accept it back as `plan`.

## Streaming

`StreamPart` is one vocabulary for both ends of the connection —
`model`, `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `sources`,
`usage`, `error`, `finish`. The consumer's frontend imports the type rather than
describing it a second time, because two hand-written copies of a wire format
drift the first time a field is added.

`usage` arrives once, after the answer and before `finish` or `error`. A
consumer may stop reading at any point: the provider request is then cancelled
and the call is still recorded through the `UsageSink`, as `aborted`, with
whatever it produced — the answer, reasoning and tool calls alike.
`callStatusFor(kind)` maps an `error` part's kind to the status to record it
under.

The `usage` part is the full `CallAccounting` that `generate` returns: model,
route, `routedBy`, tokens, cost, price version, attempts and latency.

Over HTTP the parts travel as server-sent events, and both halves of that are
in `@bozonx/ai-kit/stream`, with no Node or AI SDK imports:

```ts
// Server: write each part wherever the framework lets you write.
response.write(encodeSse(part));
response.write(encodeSse({ id }, 'saved')); // a named event

// Browser: feed decoded text, get complete events back.
const decoder = new SseDecoder();
for (const { event, data } of decoder.push(textDecoder.decode(chunk, { stream: true }))) {
  // event === 'message' for a part
}
```

## Tools and provider options

`generate` and `stream` take `tools` (defined with the re-exported `tool`),
`toolChoice` and `maxSteps`. Tools make `needsTools` true, so only candidates
whose route can call tools are tried. With `maxSteps` above 1 the SDK runs the
loop — tool call, tool result, next step — and every step is paid for:

```ts
import { tool } from '@bozonx/ai-kit';

const result = await kit.generate({
  policy: { mode: 'auto', taskClass: 'chat_agentic', signals: { estimatedInputTokens: 800 } },
  messages,
  maxSteps: 4,
  tools: {
    search: tool({
      description: 'Search the web',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => search(query),
    }),
  },
});
// result.toolCalls, result.steps, result.responseMessages (append for the next turn)
```

Nothing is retried after the first visible part, and a tool call is visible:
a tool with side effects never runs twice because of a retry.

`providerOptions` passes settings for one provider through untouched — a
thinking budget, a cache breakpoint — keyed by provider id, so a fallback to
another provider ignores what was not meant for it.

`signalsFor({ system, messages })` derives `estimatedInputTokens` and
`hasImages` from the request itself, multi-part messages included.

## Embeddings

The fourth kind of model. `kit.embed` returns one vector per value and bills
the input tokens the provider counted:

```ts
const result = await kit.embed({
  policy: { mode: 'manual', taskClass: 'search_index', requestedModel: 'gemini-embedding-001' },
  values: chunks,
});
// result.embeddings, result.dimensions, result.tokens, result.costMicros
```

Pin the model when the vectors go into an existing index: vectors of two
different models are not comparable, and only another route of the same model
is a safe fallback.

## Chat history

`compactHistory` keeps the newest messages that fit a token budget and a
message count, counts a rolling summary against the same budget, and reports
which dropped messages the summary does not cover yet (`unsummarized`,
`summaryStale`) — so the caller knows when a rebuild is worth a model call.

## Speech

Transcription is the catalog's second kind of model, not a second catalog:

```ts
const result = await kit.transcribe({
  policy: { mode: 'auto', taskClass: 'transcription' },
  options: { language: 'en', wordTimings: true },
  source: { url: presignedUrl },
});

for await (const part of kit.transcribeStream({
  policy: { mode: 'auto', taskClass: 'dictation' },
  options: { language: 'en' },
  audio: pcm16Frames,
})) {
  // 'model' | 'partial' | 'final' | 'usage' | 'error' | 'finish'
}
```

Three things about it are worth knowing before the first invoice:

- **Speech is priced by the hour of audio**, in `sttPricing`, and a model may
  have that block or `pricing` but never both. Seconds are rounded up to whole
  seconds before anything is multiplied, because that is how providers bill.
- **A live session is billed for the time it is open**, not for the words that
  came out of it. Silence costs the same as talking, which is why a dictation
  session that nobody is speaking into has to be closed rather than left idle.
- **`partial` may be rewritten in full; `final` never changes.** Text shown as
  settled and then altered reads as a bug to whoever is watching it appear.

A speech model can never be routed a language task, or the other way round: the
catalog refuses to load when a task class nominates models of two kinds.

Without a realtime provider, dictation is a series of short batch calls.
`PhraseChunker` (from `@bozonx/ai-kit/stt`) cuts live PCM into phrases on a
pause, or at a ceiling when nobody pauses, and tells each phrase where it
starts in the session so its segments land on one timeline:

```ts
const chunker = new PhraseChunker({ maxSeconds: 30, silenceMs: 1_200 });
for await (const chunk of microphone) {
  const phrase = chunker.push(chunk.data);
  if (phrase) await send(pcm16ToWav(phrase.pcm, 16_000), phrase.offsetMs);
}
const last = chunker.flush();
```

`renderSubtitles` (from `@bozonx/ai-kit/stt`) turns stored segments into SRT or WebVTT, cutting long cues on
a real pause when word timings are there and proportionally when they are not.
`segmentWords` is its other half: providers return one flat word list for a
whole recording and segments separately, and this puts the two together.

## Translation

The catalog's third kind of model is a dedicated translation engine, billed by
the character:

```ts
const result = await kit.translate({
  policy: { mode: 'auto', taskClass: 'translate_fast' },
  texts: ['Hello there'],
  targetLanguage: 'ru',
  format: 'text',
});
// result.translations, result.characters, result.costMicros, result.priceVersion
```

Unlike a language model, the price is exact before the call: the characters are
counted from the text in hand, so a quote shown to a customer and the amount
finally charged can be the same number.

The built-in Cloud Translation adapter is registered as `google-translate`,
not `google`: that id is Gemini's, and a `KeyProvider` is asked for a key by
provider id — the two products take different credentials.

Three pieces of the surrounding machinery live in `@bozonx/ai-kit/translate`,
because they are the same in every product that translates and quietly wrong
when rewritten from memory. `chunkText` (main entry) cuts long text between
words to fit a request limit.

- **`splitParallelText`** — a source and its translation cut into pairs that
  still correspond, for a repair pass over a long text: at paragraphs when both
  sides have the same number, then lines, then sentences, and only then
  proportionally — on a boundary, never through a word.
- **`glossary.ts`** — a binding glossary, applied three times and differently
  each time: only the terms that occur in the text go into the prompt, a
  "do not translate" term whose spelling only changed by case is restored
  deterministically, and any other violated term is reported for repair. A
  caller that needs an absolute byte-for-byte guarantee should protect those
  terms before sending text to a machine-translation engine.
- **`quality.ts`** — deterministic detectors that run on every translation:
  an empty result, passages left in the source language, lost links and
  placeholders, a structure that no longer matches, looping, truncation, an
  unexpected writing system. No model takes part, which is what makes them free
  to run and explainable to whoever is shown the result.
- **`runTranslationPipeline`** — one first pass, deterministic checks and at
  most one optional repair pass. When the first pass detects its source
  language, the pipeline uses it for same-language checks unless the caller
  supplied a source language explicitly.

`chunkText` limits each returned string; it does not split one provider call
into several requests. Consumers must batch or send the chunks separately when
the provider limits the total request body or number of strings.

## Running outside Node

`transport` on `createAiKit` is how the kit reaches the network. Either half may
be given alone; the defaults are the platform's `fetch` and `WebSocket`.

```ts
import { fetch } from '@tauri-apps/plugin-http';

const kit = createAiKit({
  catalog: Catalog.fromObject(catalogData),
  keys: { get: provider => keychain.get(provider) },
  transport: { fetch },
});
```

- **`fetch`** carries every HTTP request — language models through the AI SDK,
  speech, translation. In a Tauri app, the HTTP plugin's `fetch` gets past the
  CORS rules a webview would otherwise apply to provider APIs.
- **`openSocket`** opens live speech sessions. Every speech provider
  authenticates one with a request header, which Node, Deno and Bun can send
  through the platform `WebSocket` and a browser cannot. In a browser, pass an
  opener that can (a Tauri WebSocket plugin, or a proxy of your own); without
  one, a live session fails with `invalid_request` rather than being retried as
  an outage. `wsSocketOpener` from `@bozonx/ai-kit/node` is the `ws`-based
  opener, for a Node host that prefers it.
- **Keys in a browser are the user's keys.** A `KeyProvider` in a desktop app
  reads the user's own key from the OS keychain; a key your company pays for
  has no place in a web page, and nothing here makes that safe.
- Anthropic refuses browser-origin requests unless told otherwise; through a
  Tauri HTTP plugin the request is not browser-origin and nothing extra is
  needed.
- Web Crypto's `subtle` exists only in a secure context (HTTPS, `localhost`, a
  Tauri webview), and the client cache hashes keys with it.

### OpenAI-compatible servers and DeepSeek

`openai-compatible` is a built-in provider for any server that speaks OpenAI's
API — Ollama, LM Studio, vLLM, a company proxy — for chat, embeddings and, in
the speech registry, `/audio/transcriptions`. It has no default endpoint, so
the catalog sets `baseUrl`, and it sends no `Authorization` header when the
`KeyProvider` returns an empty key. `deepseek` is built in as well.

```yaml
requirePricing: false
models:
  - name: local-llama
    provider: openai-compatible
    model: llama3.1
    baseUrl: http://localhost:11434/v1
    tier: standard
    contextSize: 131072
    maxOutputTokens: 4096
```

## Installing only what you use

`zod` is a peer dependency, so the schemas you pass and the ones the package
validates with are the same copy. The provider SDKs (`@ai-sdk/google`,
`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/deepseek`,
`@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`) and `ws` are
optional peer dependencies, loaded the first time a route asks for one. A
product that only calls OpenAI installs `@ai-sdk/openai` and nothing else; `ws`
is needed only by `wsSocketOpener`. A missing package produces a sentence
naming what to install rather than a module-resolution stack trace.

`@bozonx/ai-kit/stream` holds only the stream-part types and the SSE codec, for
a page that renders a stream the server produced.

## Development

```bash
pnpm install
pnpm check   # lint, typecheck, format, tests
pnpm build
```

## Licence

MIT.
