# Module boundaries between server, client, shared and cli

The code is split into four zones, and oxlint enforces them with `eslint-plugin-boundaries` (configured in `.oxlintrc.json`):

- `server/` and `client/` never import each other.
- Both may import from `shared/`, but only with `import type`. Shared runtime code would have to compile for both Node (CommonJS) and the browser (ES modules), and the client has no bundler to resolve it.
- `shared/` imports nothing from the other zones.
- `cli/` imports nothing from the other zones, and nothing imports it. It talks to the server over HTTP and ships as `dist/cli` without the server sources.

Shared types live in `shared/` instead of being imported from `server/`, so the client depends on the protocol, not on server internals.

## Consequences

- Imports are resolved with `eslint-import-resolver-typescript`. Without it, extensionless and `.js` → `.ts` imports go unresolved, and the rule lets them through without any error.
- `tests/` is outside the zones and may import anything.
- Sharing runtime code, such as unifying `client/collab-shared.ts` with `server/collab.ts`, needs a new decision: either a build that emits `shared/` for both targets, or relaxing the type-only rule.
