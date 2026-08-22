# Из микросервиса в библиотеку: `@bozonx/ai-kit`

План переработки. Документ описывает целевое состояние, а не текущее поведение сервиса.

Парный документ: `bloggerdog/dev_docs/ai-platform-plan.md` — как потребляющий продукт использует
получившуюся библиотеку.

---

## 1. Зачем менять

Сервис сейчас решает узкую задачу — «крутить бесплатные модели OpenRouter с фоллбэком на
DeepSeek» — и решает её неплохо. Проблемы начинаются, когда его пробуют использовать как основу
продуктовой AI-платформы:

1. **Сетевой хоп ради вычисления.** Выбор модели — это чистая функция от конфига и состояния.
   Заворачивать её в HTTP-сервис значит платить латентностью и точкой отказа за то, что можно
   вызвать в процессе. Особенно больно в агентных сценариях: 5–15 вызовов модели на один
   пользовательский запрос.
2. **Состояние в памяти процесса.** `CircuitBreakerService` и `RateLimiterService` держат
   `Map` внутри инстанса. Один инстанс — работает. Два за балансировщиком — circuit breaker у
   каждого свой, и модель, забаненная одним, спокойно используется вторым.
3. **Нет учёта стоимости.** Ответ отдаёт `usage` в токенах, но `models.yaml` не знает цен.
   Для SaaS с биллингом это блокер: считать деньги негде.
4. **Свои HTTP-клиенты провайдеров.** `base.provider.ts` + `openrouter` + `deepseek` — 900 строк,
   которые придётся дописывать под каждого нового провайдера, под tool calling с его
   провайдерскими различиями, под reasoning-токены, под кэширование промптов. Это работа,
   которую уже сделали в SDK.
5. **Фокус на «бесплатности».** Реальная задача шире: предсказуемый выбор модели под класс задачи,
   тариф и остаток бюджета. «Бесплатно» — частный случай политики, а не суть продукта.

При этом ~30% кода здесь ценные и переписывать их с нуля глупо.

---

## 2. Что происходит с сервисом

Сервис не убивается — меняется его роль.

- **Ядро** переезжает в пакет `@bozonx/ai-kit`: чистый TypeScript, без Nest, без HTTP, без
  состояния в модулях.
- **HTTP-режим остаётся** как тонкая обёртка (Hono или минимальный Nest, ~150 строк) для тех
  потребителей, которым нужен именно сетевой доступ: n8n-нода, скрипты, другие языки.
- **Продуктовый путь `bloggerdog`** ходит в библиотеку напрямую, без сети.

Один код — два способа запуска. Это же снимает вопрос «что делать с n8n-нодой»: она продолжает
работать против HTTP-обёртки.

---

## 3. Целевая структура пакета

```
packages/ (или репозиторий @bozonx/ai-kit)
  src/
    ports.ts              # интерфейсы наружу: всё, что библиотека не реализует сама
    catalog/
      catalog.ts          # загрузка и валидация каталога моделей
      schema.ts           # Zod-схема models.yaml
      pricing.ts          # расчёт стоимости, версионирование прайса
    policy/
      policy.ts           # (tier, mode, taskClass, signals, budget) -> ModelCandidate[]
      selector.ts         # взвешенный выбор внутри пула (из smart.strategy)
      circuit-breaker.ts  # поверх StateStore
      rate-limiter.ts     # поверх StateStore
    providers/
      registry.ts         # маппинг provider -> фабрика AI SDK
    execute/
      run.ts              # исполнение с ретраями, таймаутами, usage и трейсом
    errors.ts
  http/                   # опциональная обёртка для внешних потребителей
```

`src/` не импортирует `@nestjs/*`, не читает `process.env`, не пишет в файлы и не логирует
самостоятельно — только через переданные порты.

---

## 4. Разбор текущего кода

| Что | Вердикт | Комментарий |
|---|---|---|
| `selector/strategies/smart.strategy.ts` (223) | **Взять**, адаптировать | Взвешенный случайный выбор — то, что нужно free-профилю. Отвязать от Nest DI, сделать чистой функцией. |
| `selector/utils/model-parser.ts` | Взять | Парсинг `provider/model` пригодится. |
| `state/circuit-breaker.service.ts` (147) | **Взять, переписать хранение** | Логика состояний CLOSED/OPEN/HALF_OPEN верная. `Map` заменить на `StateStore`. |
| `state/interfaces/state.interface.ts` | Взять | Хорошо описанные типы, менять почти нечего. |
| `rate-limiter/rate-limiter.service.ts` (147) | Взять, переписать хранение | То же самое: в `StateStore`. |
| `models/models.service.ts` (324) | **Переписать** | Идея каталога верная, реализация обрастает валидаторами. Заменить ручную валидацию на Zod, добавить цены и модальности. |
| `models.yaml` + `scripts/fetch-models.ts` | **Взять и расширить** | Главный актив. См. раздел 5.1. |
| `config/` + `validators/` (6 файлов) | Сильно упростить | Конфиг библиотеки — объект в конструкторе, а не YAML + env + класс-валидаторы. YAML остаётся только для каталога моделей и только в HTTP-обёртке. |
| `router/services/retry-handler.service.ts` (86) | **Упростить радикально** | См. раздел 5.4. |
| `router/router.service.ts` (636) | Разобрать на части | Смешивает оркестрацию, валидацию, сборку запроса и обработку ошибок. Оркестрация → `execute/run.ts`, остальное распределяется. |
| `router/services/request-builder.service.ts` | Выбросить | Сборку запроса берёт на себя AI SDK. |
| `router/validators/*` | Выбросить | Валидация контента и tool-choice — забота SDK и Zod-схем. |
| `providers/base|openrouter|deepseek.provider.ts` (908) | **Выбросить** | Заменяется на `@ai-sdk/*`. Это главная экономия: минус ~900 строк, которые надо было бы поддерживать. |
| `common/utils/json-parser.util.ts` | Выбросить | Заменяется `generateObject` со схемой. Ручное вытаскивание JSON из текста — симптом отсутствия structured output. |
| `common/errors/router.errors.ts` | Взять, дополнить | Классификация ошибок нужна и станет основой правил ретраев. |
| `modules/admin`, `dashboard`, `health`, `shutdown`, `public/` | Выбросить из ядра | Это инфраструктура сервиса. Часть переезжает в HTTP-обёртку, часть не нужна вовсе. |
| `filters/all-exceptions.filter.ts` | В HTTP-обёртку | |
| `n8n-nodes-*` | Оставить как есть | Работает против HTTP-обёртки, менять не требуется. |

Ориентировочно: из ~2 600 строк ядра остаётся и переносится ~700, дописывается ~800 нового
(каталог с ценами, policy, порты, pricing), удаляется ~1 500.

---

## 5. Ключевые изменения по существу

### 5.1 Каталог моделей становится главной сущностью

Сейчас `models.yaml` описывает, *можно ли* использовать модель. Нужно, чтобы он описывал ещё и
*сколько она стоит* и *что умеет*:

```yaml
models:
  - name: gemini-2.5-flash
    provider: google
    model: gemini-2.5-flash
    type: fast
    # Класс качества — то, по чему policy подбирает замену при фоллбэке.
    tier: standard              # economy | standard | premium
    contextSize: 1048576
    maxOutputTokens: 65536
    modalities:
      input: [text, image, audio, pdf]
      output: [text]
    capabilities:
      tools: true
      structuredOutput: true
      promptCaching: true
      reasoning: false
    # Цены за миллион токенов в микроцентах. Целые числа.
    pricing:
      version: "2026-08"
      inputPerMTok: 30000
      outputPerMTok: 250000
      cachedInputPerMTok: 7500
    weight: 10
    available: true
    tags: [json-mode, multilingual]
```

Требования:

- Схема валидируется Zod при загрузке, ошибка — падение на старте, а не в рантайме.
- Поле `pricing.version` попадает в каждое событие использования. Без этого пересчёт истории при
  смене цен невозможен.
- `tier` — то, по чему подбирается замена: фоллбэк ищет модель того же класса качества, а не
  «любую живую». Замена премиум-модели на бесплатную без ведома пользователя недопустима.
- `scripts/fetch-models.ts` дописать так, чтобы подтягивал цены из OpenRouter API, а не только
  список. Для прямых провайдеров цены ведутся вручную — их немного.

### 5.2 Router → Policy engine

Смена фокуса, ради которой всё затевается. Вместо «выбери бесплатную модель» —

```ts
export interface PolicyInput {
  tier: 'free' | 'paid' | 'enterprise';
  mode: 'auto' | 'manual' | 'free';
  taskClass: TaskClass;
  /** Явный выбор пользователя в manual-режиме. */
  requestedModel?: string;
  signals: {
    estimatedInputTokens: number;
    hasImages: boolean;
    needsTools: boolean;
    needsStructuredOutput: boolean;
    language?: string;
    historyLength: number;
  };
  budget: { remainingMicros: number };
}

export function selectCandidates(input: PolicyInput, catalog: Catalog, state: PolicyState)
  : ModelCandidate[];
```

Возвращается **упорядоченный список кандидатов**, а не одна модель: первый — основной, остальные —
для фоллбэка. Кандидаты, чей circuit открыт или чей rate limit исчерпан, отфильтрованы.

Три профиля — это три набора правил над одним движком:

- `free` — только `pricing.inputPerMTok == 0`, взвешенный случайный выбор (существующая
  `smart.strategy`), агрессивные фоллбэки, низкий SLA.
- `auto` — детерминированное сопоставление `taskClass` + сигналы → `tier`, эскалация на класс
  выше по факту неудачи.
- `manual` — ровно то, что выбрал пользователь; фоллбэк только внутри того же `tier` и только
  с пометкой в результате.

### 5.3 Состояние — через порт

```ts
export interface StateStore {
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Атомарный CAS для переходов circuit breaker. */
  compareAndSet(key: string, expected: string | null, next: string, ttlSec: number): Promise<boolean>;
}
```

Реализации: `MemoryStateStore` в пакете (для тестов и однопроцессного запуска), `RedisStateStore`
на стороне потребителя. Circuit breaker и rate limiter переписываются поверх этого интерфейса.

Важная деталь: скользящее окно статистики (`RequestRecord[]` в `ModelStats`) в Redis хранить
целиком не надо — достаточно счётчиков в окнах по минуте. Полная история запросов — задача
Langfuse, а не роутера. Это заметно упростит `circuit-breaker.service.ts`.

### 5.4 Ретраи упрощаются

Текущая схема (`maxModelSwitches` + `maxSameModelRetries` + `retryDelay` + fallback) избыточна для
платных сценариев. Целевые правила:

| Ситуация | Действие |
|---|---|
| Ошибка **до первого токена** (429, 5xx, connect timeout, reset) | Ретрай с экспоненциальным бэкоффом и джиттером, максимум 2 попытки, затем следующий кандидат из списка. |
| Ошибка **после начала стрима** | Не ретраить. Вернуть частичный результат + `StreamInterruptedError`. Решение принимает вызывающий код. |
| 400, 401/403, content filter, context length exceeded | Не ретраить. |
| Профиль `free` | Разрешить длинную цепочку переключений — там это уместно. |

Плюс **бюджет времени на весь вызов**, а не на попытку: три ретрая по 60 с дают три минуты
ожидания и ушедшего пользователя.

### 5.5 Порты вместо инфраструктуры

```ts
export interface KeyProvider  { get(provider: string): Promise<string>; }
export interface UsageSink    { record(event: UsageEvent): Promise<void>; }
export interface TraceSink    { generation(g: GenerationTrace): void; }
export interface Clock        { now(): number; }
```

`UsageEvent` содержит всё для биллинга: провайдер, модель, разбивку токенов (включая cached и
reasoning), рассчитанную стоимость, версию прайса, `routedBy`, латентность, статус. Библиотека
считает стоимость, но никуда её не сохраняет — это дело потребителя.

`TraceSink` реализуется в `bloggerdog` через OTel → Langfuse. В библиотеке — no-op по умолчанию.

---

## 6. Публичный API

```ts
const kit = createAiKit({
  catalog: loadCatalog('./models.yaml'),
  keys: keyProvider,
  state: stateStore,
  usage: usageSink,
  trace: traceSink,
});

const result = await kit.generate({
  policy: { tier: 'paid', mode: 'auto', taskClass: 'summarize', signals, budget },
  messages,
  schema: MySchema,          // опционально: structured output через generateObject
  tools,                     // опционально
  abortSignal,
});

// result: { object | text, model, provider, routedBy, usage, costMicros, traceId, attempts }

const stream = kit.stream({ policy, messages, tools, abortSignal });
```

Ключевое: `result` всегда сообщает, **какая модель и почему** ответила. Скрытый роутинг —
источник тикетов «вчера работало лучше». Потребитель обязан иметь возможность показать это в UI.

---

## 7. HTTP-обёртка

Остаётся для n8n и внешних потребителей. Требования:

- Один эндпоинт `POST /api/v1/chat/completions`, OpenAI-совместимый, как сейчас.
- Вся логика — вызов `kit.generate` / `kit.stream`. Никакой бизнес-логики в обёртке.
- Мета-информация в `_router` сохраняется в текущем формате — это обратная совместимость с n8n-нодой
  и с текущим `LlmService` в `bloggerdog` на время миграции.
- `MemoryStateStore` по умолчанию, `RedisStateStore` — если задан `REDIS_URL`.
- Health-эндпоинт и graceful shutdown переезжают сюда из текущего сервиса почти без изменений.

Стек обёртки — на выбор; Hono даст меньший образ и совпадёт с остальными гейтвеями фронта
(`stt-gateway`, `translate-gateway`), Nest — меньше работы по переносу.

---

## 8. Миграция потребителя

1. `bloggerdog` продолжает ходить в HTTP-сервис. Ничего не ломается.
2. Появляется `@bozonx/ai-kit`, HTTP-обёртка переводится на него. Внешний контракт не меняется,
   n8n-нода работает.
3. В `bloggerdog` появляется `ai-gateway`, который использует библиотеку напрямую; старый
   `LlmService` становится тонкой обёрткой над ним и постепенно вымывается.
4. `FREE_LLM_ROUTER_SERVICE_URL` и вся группа переменных `FREE_LLM_ROUTER_*` из
   `apps/api/src/config/llm.config.ts` удаляются вместе с `CONFIGURATION.md`-записями.
5. HTTP-сервис остаётся развёрнутым только ради n8n, либо гасится, если n8n не используется.

Порядок важен: пункт 3 не начинать, пока пункт 2 не отработал в бою хотя бы неделю.

---

## 9. Версионирование и распространение

- Пакет живёт в этом же репозитории (`packages/ai-kit`), репозиторий переименовывается позже,
  когда «free-llm-router» перестанет соответствовать содержимому.
- Публикация — приватный npm или GitHub Packages. Semver соблюдать строго: у пакета уже будет
  два потребителя.
- Каталог моделей **не** зашивать в пакет как данные — он должен передаваться потребителем.
  В пакете лежит только схема и загрузчик, `models.yaml` — пример.

---

## 10. Тесты

- Юнит: policy (табличные тесты «вход → ожидаемый порядок кандидатов»), pricing (расчёт стоимости
  по каждой комбинации токенов), circuit breaker (переходы состояний против `MemoryStateStore`),
  каталог (валидация схемы).
- Контрактные: `nock` на провайдеров — уже есть в devDependencies, механику переиспользовать.
- Отдельно и **не в CI**: «живые» прогоны по расписанию, проверяющие, что модели из каталога
  реально доступны и цены не разъехались.
- Обязательный тест на каждый класс ошибок из 5.4: убеждаемся, что после начала стрима ретрая
  не происходит.

---

## 11. Чеклист

- [ ] Zod-схема каталога + цены + модальности + `tier`
- [ ] `scripts/fetch-models.ts` тянет цены из OpenRouter
- [ ] `ports.ts`: `StateStore`, `KeyProvider`, `UsageSink`, `TraceSink`, `Clock`
- [ ] `MemoryStateStore` в пакете
- [ ] Circuit breaker и rate limiter переписаны поверх `StateStore`
- [ ] `smart.strategy` перенесена как чистая функция
- [ ] `policy.ts` с тремя профилями (free / auto / manual)
- [ ] `pricing.ts` с версионированием прайса
- [ ] Провайдеры через `@ai-sdk/*`; свои HTTP-клиенты удалены
- [ ] `execute/run.ts` с новыми правилами ретраев и бюджетом времени на вызов
- [ ] Публичный API `generate` / `stream`, всегда сообщающий выбранную модель и `routedBy`
- [ ] HTTP-обёртка, сохраняющая формат `_router`
- [ ] n8n-нода проверена против обёртки
- [ ] Юнит-тесты policy и pricing
- [ ] `docs/CHANGELOG.md`, README переписан под новое назначение
