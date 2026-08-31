# @bozonx/ai-kit

The part of an AI feature that is the same in every product.

Not a model router, and no longer a microservice: a library you call in-process.
It holds a priced model catalog, the rules for choosing a model and retrying a
call, the vocabulary a streamed answer is made of, error classification, and the
ports through which a host supplies keys, shared state and observability.

It deliberately holds nothing about tenants, users, projects, permissions,
storage or money. If a component needs one of those words, it belongs to the
application, not here — and a test fails when it creeps in.

> **Status: 0.2.0.** The package includes the catalog, model-selection policy,
> provider registry, generation and streaming execution with retries, prompt
> assembly, cost accounting, ports, error taxonomy, an in-memory state store,
> and speech-to-text — batch and live — over AssemblyAI, Deepgram and Groq. It
> is ready for use with a consumer-owned model catalog.

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

## Ports

Everything the library needs from the outside arrives through `src/ports.ts`:
`KeyProvider`, `UsageSink`, `TraceSink`, `StateStore`, `Clock`. All are optional
except keys — a library that cannot be called until five interfaces are
implemented gets worked around instead of used.

`StateStore` matters more than it looks: circuit breaker and rate limiter state
must be shared, because with two API processes behind a balancer, a model banned
by one is happily used by the other. `MemoryStateStore` ships with the package
for tests and single-process deployments; anything larger implements the port
over Redis.

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
catalog refuses to load when a task class nominates the wrong kind of model.

## Development

```bash
pnpm install
pnpm check   # lint, typecheck, format, tests
pnpm build
```

## Licence

MIT.
