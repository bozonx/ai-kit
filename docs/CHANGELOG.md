# Changelog

Все заметные изменения в проекте будут документированы в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/),
и этот проект придерживается [Semantic Versioning](https://semver.org/lang/ru/).

## [1.0.0] - 2025-12-12

### Добавлено

#### Фаза 1: Инфраструктура и конфигурация
- Добавлены зависимости: `js-yaml`, `@nestjs/axios`, `axios`
- Созданы TypeScript интерфейсы для моделей и конфигурации
- Реализован загрузчик YAML конфигурации с поддержкой переменных окружения
- Добавлены конфигурационные файлы: `config/config.yaml`, `config/models.yaml`
- Обновлены переменные окружения: `ROUTER_CONFIG_PATH`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`

#### Фаза 2: Модуль моделей (Models)
- Создан `ModelsService` для загрузки и управления списком моделей
- Реализованы методы фильтрации моделей по тегам, типу и размеру контекста
- Создан `ModelsModule` с экспортом `ModelsService`
- Добавлены unit тесты для `ModelsService`

#### Фаза 3: Модуль провайдеров (Providers)
- Определен базовый интерфейс `LlmProvider` для унификации провайдеров
- Создан абстрактный `BaseProvider` с общей логикой HTTP-запросов и обработки ошибок
- Реализован `OpenRouterProvider` для интеграции с OpenRouter API
- Реализован `DeepSeekProvider` для интеграции с DeepSeek API
- Создан `ProvidersModule` с динамической регистрацией провайдеров
- Добавлены unit тесты для провайдеров

#### Фаза 4: Модуль селектора (Selector)
- Определен интерфейс `SelectionStrategy` для алгоритмов выбора
- Реализована стратегия `RoundRobinStrategy` для round-robin ротации моделей
- Создан `SelectorService` для выбора моделей с учетом критериев и исключений
- Создан `SelectorModule` с зависимостью от `ModelsModule`
- Добавлены unit тесты для логики выбора

#### Фаза 5: Модуль роутера (Router)
- Созданы DTO для запроса (`ChatCompletionRequestDto`) и ответа (`ChatCompletionResponseDto`)
- Реализован `RouterService` с логикой:
  - Автоматический выбор модели
  - Retry с jitter при rate limit (429)
  - Fallback между бесплатными моделями
  - Fallback на платную модель при исчерпании попыток
  - Сбор метаданных о попытках и ошибках
- Создан `RouterController` с endpoints:
  - `POST /api/v1/chat/completions` — OpenAI-совместимый chat completion
  - `GET /api/v1/models` — список доступных моделей
- Интеграция `RouterModule` в `AppModule`
- Добавлены unit тесты для `RouterService` и `RouterController`

#### Фаза 6: E2E тесты и финализация
- Созданы E2E тесты для API endpoints
- Полностью обновлена документация в `README.md`:
  - Описание возможностей микросервиса
  - Руководство по быстрому старту
  - Детальная конфигурация
  - API Reference с примерами
  - Логика работы и обработки ошибок
  - Дорожная карта
- Создан `CHANGELOG.md` для отслеживания изменений

### Возможности v1.0.0

- ✅ OpenAI-совместимый API для chat completions
- ✅ Автоматический выбор модели (round-robin)
- ✅ Интеллектуальный retry с обработкой rate limits
- ✅ Fallback на платную модель при исчерпании бесплатных
- ✅ Фильтрация моделей по тегам, типу, размеру контекста
- ✅ Поддержка провайдеров: OpenRouter, DeepSeek
- ✅ Прозрачная метаинформация о попытках и ошибках
- ✅ Полная документация и тесты

### Технические детали

- **Node.js**: 22+
- **Framework**: NestJS + Fastify
- **Package Manager**: pnpm
- **Логирование**: Pino
- **Тестирование**: Jest (unit + e2e)
- **Конфигурация**: YAML с поддержкой переменных окружения

## [Unreleased]

### Добавлено

#### n8n Интеграция
- Создан пакет n8n community node: `n8n-nodes-bozonx-free-llm-router-microservice`
- Реализована нода "Free LLM Router Model" для LangChain workflows
- Добавлены credentials с поддержкой None, Basic Auth, Bearer Token
- Реализовано три режима выбора моделей:
  - Auto (Smart Strategy)
  - Specific Model (конкретная модель)
  - Priority List (приоритетный список)
- Поддержка всех OpenAI-совместимых параметров
- Полная поддержка фильтрации (tags, type, context size, success rate)
- Создана документация: README, QUICKSTART, DEVELOPMENT
- Добавлена иконка и конфигурационные файлы

#### Function Calling
- Реализована полная поддержка OpenAI-совместимых function calling / tools
- Обновлены DTO запросов и ответов
- Интеграция с провайдерами OpenRouter и DeepSeek для передачи инструментов
- Обновлена документация и добавлены примеры использования

### Исправлено

- Исправлено поведение `OpenRouterProvider` в режиме JSON (`response_format: json_object/json_schema`): reasoning больше не попадает в `choices[0].message.content`, ответ нормализуется до валидного JSON для корректной работы structured output парсеров.

### Планируется в v1.1
- Streaming (SSE) поддержка для chat completions
- Загрузка списка моделей по URL
- Vanilla UI для просмотра моделей и статистики

### Планируется в v1.2
- Дополнительные алгоритмы выбора моделей (random, weighted, least-errors, fastest-response)
- Статистика запросов и выбор на основе метрик
- Поддержка vision (изображения в сообщениях)

### Планируется в v1.3
- OpenTelemetry интеграция для метрик и трейсинга
- Кэширование ответов для оптимизации
- Мониторинг и алерты

---

[1.0.0]: https://github.com/bozonx/free-llm-router-microservice/releases/tag/v1.0.0
[Unreleased]: https://github.com/bozonx/free-llm-router-microservice/compare/v1.0.0...HEAD

