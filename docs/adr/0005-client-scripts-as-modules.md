# Load client scripts as ES modules, except theme

Amends [ADR-0003](0003-compile-client-with-tsc.md): `app`, `login` and `components` load with `<script type="module">` instead of as classic scripts. Modules can `import type` from `shared/`, and they let `app.ts` be split into files, which [ADR-0001](0001-stay-vanilla-js.md) names as the next structural cleanup. Without modules, the split files could only share state through `window.__*` globals.

`theme` stays a classic, render-blocking script in `<head>`: it must set the theme before first paint, and the inline scripts right after it call `window.__themeIcon` synchronously. Modules always run deferred.

## Considered Options

| Option | Why not |
| --- | --- |
| Keep classic scripts, type via inline `import("../shared/protocol").T` | Works and stays classic, but every type reference is verbose and `app.ts` cannot be split without more globals. |
| `moduleDetection: "force"` instead of `export {}` markers | `tsc` would also append `export {}` to `theme.js`, which breaks it as a classic script. |

## Consequences

- Module files run in strict mode with their own scope. An assignment to an undeclared variable throws instead of creating a global.
- `app`, `login` and `components` start with `export {};` so TypeScript checks them as modules. The marker can go once a file has a real import.
- Execution order is unchanged: deferred scripts and module scripts both run after parsing, in document order (`components` → mermaid → `app`).
