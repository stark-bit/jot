# Keep jot vanilla JS

The UI layer stays plain vanilla JavaScript with ES modules. No framework, no bundler.

## Context

- The UI layer is ~2,400 lines of vanilla ES modules: `app.js`, `collab-editor.js`, `components.js`.
- The collab editor is a `<textarea>` driven imperatively. Every mutation sets `textarea.value` and the selection in one pass. No framework can improve on that assignment.
- The rest of the UI updates coarsely, one `innerHTML` template at a time. `state` in `app.js` has 18 fields and changes a few times a second.
- Signals need fine-grained state with many independent subscribers. This app has none. Wrapping the editor text in a signal re-runs the same assignment the code already does.
- The virtual DOM adds a layer where there is no diffing to do.
- The hot path, CRDT ops over WebSocket, lives in `src/collab.ts` and stays framework-free either way.
- Most future code will be written by agents, so syntax taste carries little weight.
- Research: syntax comparison at [component-party.dev](https://component-party.dev) (React, Solid, Svelte); framework behavior at [todomvc.com](https://todomvc.com). Every framework version of the same app added structure around the core without adding capability.

## Rejected options

| Option | Why rejected |
| --- | --- |
| React | Controlled-input model fights the imperative textarea. Biggest ecosystem, but the training-data advantage did not outweigh the cost of wrapping the editor. |
| Solid | Best fit of the frameworks, but its JSX differs enough from React's to be a trap, and the fit advantage does not buy anything the vanilla code lacks. |
| Svelte | Solves problems the app does not have; needs its own compiler toolchain. |
| Vue | Same as Svelte: mature and fine, but no capability gain over the current code. |
| Lit | Closest to what `components.js` already does by hand; no state or routing help. |

## Consequences

- The browser loads the ES modules in `public/` directly, so debugging works against the code as written.
- `collab-editor.js` keeps owning the textarea. Future UI work wraps it, never replaces it.
- `app.js` grows by refactoring JS, not by adopting a framework. The next structural cleanup is splitting it into modules.
