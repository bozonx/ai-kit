# @bozonx/ai-kit

The part of an AI feature that is the same in every product.

Not a model router, and no longer a microservice: a library you call in-process.
It holds a priced model catalog, the rules for choosing a model and retrying a
call, the vocabulary a streamed answer is made of, error classification, and the
ports through which a host supplies keys, shared state and observability.

It deliberately holds nothing about tenants, users, projects, permissions,
storage or money. If a component needs one of those words, it belongs to the
application, not here — and a test fails when it creeps in.

> **Status: 0.3.0.** The package includes the catalog with multi-provider
> routes, model-selection policy, provider registries, generation and streaming
> execution with retries, prompt assembly, cost accounting, ports, error
> taxonomy, speech-to-text — batch and live — over AssemblyAI, Deepgram and
> Groq, subtitle rendering, and machine translation over a dedicated engine
> with a binding glossary and deterministic quality detectors. It is ready for
> use with a consumer-owned model catalog.

## Install

```bash
pnpm add @bozonx/ai-kit
```

During development, consume it through a workspace link so that changes are
visible without publishing.

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
import { Catalog, calculateCost } from '@bozonx/ai-kit';

// Throws on a bad price, an unknown model in a task class, a duplicate name.
// Loudly, at startup — a catalog that is wrong is a bill that is wrong.
const catalog = Catalog.fromFile('./models.yaml');

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
`KeyProvider`, `UsageSink`, `TraceSink`, `Clock`. All are optional except keys —
a library that cannot be called until five interfaces are implemented gets
worked around instead of used.

## Streaming

`StreamPart` is one vocabulary for both ends of the connection —
`model`, `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `sources`,
`usage`, `error`, `finish`. The consumer's frontend imports the type rather than
describing it a second time, because two hand-written copies of a wire format
drift the first time a field is added.

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

`renderSubtitles` turns stored segments into SRT or WebVTT, cutting long cues on
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

Two pieces of the surrounding machinery are here too, because both are the same
in every product that translates and both are quietly wrong when rewritten from
memory:

- **`glossary.ts`** — a binding glossary, applied three times and differently
  each time: only the terms that occur in the text go into the prompt, a
  "do not translate" term is put back by replacement rather than asked for
  again, and a violated glossary is found deterministically.
- **`quality.ts`** — deterministic detectors that run on every translation:
  passages left in the source language, lost links and placeholders, a
  structure that no longer matches, looping, truncation, an unexpected writing
  system. No model takes part, which is what makes them free to run and
  explainable to whoever is shown the result.

## Installing only what you use

The provider SDKs and `ws` are optional peer dependencies, loaded the first time
a route asks for one. A product that only calls OpenAI installs
`@ai-sdk/openai` and nothing else; one that transcribes files but never dictates
needs no `ws`. A missing package produces a sentence naming what to install
rather than a module-resolution stack trace.

`@bozonx/ai-kit/stream` is a second entry point holding only the stream-part
types, so a browser can share the wire vocabulary without resolving the Node
entry point.

## Development

```bash
pnpm install
pnpm check   # lint, typecheck, format, tests
pnpm build
```

## Licence

MIT.
