# Releasing

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`, which:

1. **Checks** the build and the tests, and that every published package has the tag's version.
2. **Publishes to npm:** `evalreplay`, `@evalreplay/core`, `@evalreplay/recorder-openai` and `@evalreplay/recorder-anthropic`, with [provenance](https://docs.npmjs.com/generating-provenance-statements). `workspace:` versions become real ones (`^0.1.0`).
3. **Creates the GitHub release**, with the version's section of `CHANGELOG.md` as its notes.
4. **Moves the `v0` tag** to the release, since the action is used as `JahanzaibMohsin9/evalreplay@v0`.

## Once, before the first release

1. **npm:** sign in at [npmjs.com](https://www.npmjs.com) with two-factor authentication on, and create the free organization `evalreplay` (Add Organization), which owns the `@evalreplay` scope. The unscoped `evalreplay` name goes to whoever publishes it first.
2. **Token:** on npmjs.com, go to Access Tokens, then Generate New Token, then Granular Access Token. Give it read and write access to packages and scopes, covering the `@evalreplay` scope and all packages (for the unscoped `evalreplay`). If your account requires 2FA for publishing, tick "Bypass two-factor authentication", since CI can't answer a 2FA prompt. Copy the token.
3. **GitHub:** in the repository's Settings, open Secrets and variables, then Actions, and add a new repository secret named `NPM_TOKEN` with that token.

## Each release

1. Set the version in `packages/*/package.json` (all four the same) and add a `## <version>` section to `CHANGELOG.md`. Merge that to `main`.
2. Tag `main` and push the tag:

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

3. **GitHub Marketplace**, the first time only: open the release on GitHub, choose Edit, tick "Publish this Action to the GitHub Marketplace", accept the agreement, pick a category (Continuous integration), and update the release.

After the first release, npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) can replace the token: add this repository and `release.yml` as a trusted publisher on each package's settings page, then delete the `NPM_TOKEN` secret.
