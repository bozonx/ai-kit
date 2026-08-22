## Agent Rules (alwaysApply)

- Microservice with REST API
- Stack: TypeScript, NestJS, Fastify, Docker

### Structure and Practices

- Node.js: version 22
- Package manager: `pnpm`
- Unit tests: `test/unit/`
- E2E tests: `test/e2e/`
- setup of unit tests: `test/setup/unit.setup.ts`
- setup of e2e tests: `test/setup/e2e.setup.ts`
- Guides: `docs/`
- Development stage docs: `dev_docs/`
- Update `docs/CHANGELOG.md` for significant changes
- jsdoc, messages and strings have to be in English
- Environment variables: `.env.production.example` is the source of truth for expected variables
- Souce of truth for models and router config is `models.yaml` and `config.yaml`
