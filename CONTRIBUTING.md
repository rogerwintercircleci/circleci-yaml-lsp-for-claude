# Contributing

## Local development

Test the plugin without installing it from the marketplace:

```bash
# Validate the manifests
claude plugin validate . --strict
claude plugin validate ./plugins/circleci-yaml-lsp --strict

# Load it for one session
claude --plugin-dir ./plugins/circleci-yaml-lsp

# Then, in a project with a .circleci/config.yml, make a trivial edit to the
# config and confirm diagnostics appear. /plugin → Errors shows any failures.
```

The launcher and proxy are plain Bash + Node and can be exercised directly over stdio; see
the verification approach in [`docs/DESIGN.md`](docs/DESIGN.md).

## Tests

The proxy (the logic-heavy part) has unit + integration tests using Node's built-in test
runner — no dependencies — and a mock LSP server, so they need neither the real
language-server binary nor network:

```bash
npm test        # or: node --test test/lib.test.mjs test/proxy.test.mjs
```

- `test/lib.test.mjs` — pure helpers from `lsp-proxy-lib.mjs` (scope matching, LSP framing,
  `applyEdits`, …).
- `test/proxy.test.mjs` — drives the real `lsp-proxy.mjs` against `test/mock-server.mjs`,
  asserting scope filtering, the `didChange`→`didOpen` replay (the doubling-bug regression),
  full-sync rewrite, token injection + reply-swallowing, and diagnostics scoping.

Tests live at the repo root and are **not** part of the installed plugin.

## Releasing a new version

Claude Code applies plugin updates **only when `plugin.json`'s `version` changes**. Any fix
that ships without a version bump will never reach already-installed users. So every shipped
change must bump the version.

To bump the pinned upstream language server:

1. Set `VERSION` in `plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp` to the new release tag.
2. Regenerate the integrity pins and paste the printed `case` arms into the launcher:
   ```bash
   scripts/update-pins.sh
   ```
   (The size **and** SHA-256 pins must match the new release, or the launcher will refuse to
   run that platform's binary.)
3. Bump `version` in `plugins/circleci-yaml-lsp/.claude-plugin/plugin.json`.
4. Update [`CHANGELOG.md`](CHANGELOG.md).
5. Validate, commit, and (optionally) tag:
   ```bash
   claude plugin validate ./plugins/circleci-yaml-lsp --strict
   claude plugin tag ./plugins/circleci-yaml-lsp   # creates circleci-yaml-lsp--vX.Y.Z
   ```

For any other change (launcher/proxy fixes, `.lsp.json` tweaks), steps 3–5 still apply.

## Conventions

- Keep the launcher POSIX-friendly (`#!/usr/bin/env bash`, runs on macOS bash 3.2 and Linux).
- The proxy targets the Node that ships with / alongside Claude Code; avoid non-builtin deps.
- Don't vendor the server binary — it's downloaded and verified at runtime.
