# Compile the client with tsc, no bundler

Amends [ADR-0001](0001-stay-vanilla-js.md): the UI stays vanilla with no framework, but the browser no longer loads hand-written files. The client source is TypeScript in `client/`, compiled file-for-file by `tsc` into `dist/public/` and served at `/static`. The CLI (`cli/jot.mts`) builds the same way into `dist/cli/`. We wanted types on the client and CLI, mainly to share protocol types with the server, without adding build machinery.

## Considered Options

| Option | Why not |
| --- | --- |
| Bundler (esbuild, Vite) | Rewrites module loading and adds a toolchain. `tsc` strips types and leaves the code otherwise as written. |
| `// @ts-check` + JSDoc in plain `.js` | No build step, but JSDoc types are clumsy, and the client still cannot import types from `shared/`. |
| Compile back into `public/` | Generated and hand-written files in one folder, orphaned outputs when a source is deleted, and a habit of editing `public/*.js` that the next build silently overwrites. |

## Consequences

- `npm run build` (or `build:client`) must run before the server can start; it reads `dist/public` at startup.
- The browser debugs compiled output. It matches the source minus types, so this costs little.
- `tsc` passes bare imports through unchanged. The client can only import by path or URL unless an import map is added.
- `app.ts`, `components.ts`, `theme.ts` and `login.ts` are still classic scripts. A file stops being a classic script as soon as it gets an `import`.
- Type errors that existed at conversion are marked `// TODO(ts)` + `// @ts-expect-error` rather than fixed; client and CLI use `strict: false` until they are worked off.
