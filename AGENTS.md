# Agent Rules (alwaysApply)

- Reusable TypeScript library, published as `@bozonx/ai-kit`. Not a service.
- Stack: TypeScript, Zod, Vercel AI SDK. No framework, no HTTP layer, no DI container.

### Structure and Practices

- Node.js: version 22, package manager `pnpm`
- Library source: `src/`, one public entry point: `src/index.ts`
- Tests: `test/`, run with `pnpm test`
- Guides: `docs/`, work-in-progress plans: `dev_docs/`
- Update `docs/CHANGELOG.md` for significant changes
- JSDoc, comments, messages and strings in English
- `models.example.yaml` is an example of the catalog format, not a default. The
  catalog is data owned by whoever consumes the library.
- `pnpm check` runs lint, typecheck, format and tests. Everything has to pass.

### The boundary, which is the whole point of the package

Code belongs here only if it would be **word for word the same in a product
about something else entirely**. Anything that knows about tenants, users,
projects, permissions, storage or money belongs to the consumer.

Enforced, not just written down — `test/invariants.spec.ts` and the ESLint rules
in `eslint.config.js` fail the build when `src/` imports a framework or an ORM,
reads `process.env`, logs by itself, or uses a word from somebody's domain.
Everything the library does not implement itself arrives through a port from
`src/ports.ts`.
