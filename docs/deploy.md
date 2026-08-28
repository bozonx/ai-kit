# Publishing to npm

This repository is public, but the package is currently intended for use by
Bozonx projects. Do not publish a version unless a consuming project needs it.

## Prerequisites

- Node.js 22 and pnpm 10.
- An npm account with permission to publish packages in the `@bozonx` scope.
- npm authentication on the current machine:

  ```bash
  npm login
  npm whoami
  ```

If the npm account requires two-factor authentication, provide the one-time
password when npm requests it.

## Release

1. Start from the intended commit and inspect the working tree.

   ```bash
   git status
   pnpm install --frozen-lockfile
   pnpm check
   ```

2. Update the version according to semantic versioning. This command also
   creates a Git tag; push the version commit and tag after publication.

   ```bash
   pnpm version patch
   # or: pnpm version minor
   # or: pnpm version major
   ```

3. Inspect the exact npm archive. `prepack` removes old build output and
   rebuilds `dist`, so this is also a clean-build check.

   ```bash
   npm pack --dry-run
   ```

   Confirm that it contains `dist/index.js`, `dist/index.d.ts`,
   `models.example.yaml`, `LICENSE`, and `package.json`.

4. Publish the public scoped package.

   ```bash
   npm publish
   ```

   `publishConfig.access` already sets the package access to `public`.
   The `prepublishOnly` lifecycle runs `pnpm check` before publishing.

5. Verify the release and push the Git version metadata.

   ```bash
   npm view @bozonx/ai-kit version
   git push origin main --follow-tags
   ```

## First publication

Before the first release, ensure the `@bozonx` npm organization exists and the
publishing account is a member with publish permissions. The package name is
`@bozonx/ai-kit`.
