# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.1.0]: https://github.com/bozonx/ai-kit/releases/tag/v0.1.0
