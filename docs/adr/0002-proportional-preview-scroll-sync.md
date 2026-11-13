# Proportional preview scroll sync

On desktop, the preview follows the editor by scroll ratio: when the textarea is scrolled N%, the preview is scrolled N%. One-way (editor to preview), side-by-side layout only (`min-width: 981px`), client-only in `syncPreviewScroll` in `client/app.ts`. Chosen as the trivial version to try in daily use before investing more.

## Considered Options

| Option | Why not (yet) |
| --- | --- |
| Source-line anchors (`data-line` on rendered blocks, interpolate between them) | Accurate with images, code blocks, and mermaid, but touches the server renderer, sanitizer, and client. Upgrade path if ratio drift proves annoying. |
| Text matching around the caret | Fragile with formatting, repeated text, and code. |
| Two-way sync | Risk of scroll feedback loops; preview scroll already drives comment thread layout. |

## Consequences

- Drift is expected where rendered height differs a lot from source height (images, diagrams, tables). On long notes it can be off by a screen.
- The user can scroll the preview freely; the next editor scroll or re-render snaps it back.
