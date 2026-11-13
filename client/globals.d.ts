// Globals that pages share through `window`. theme.js is a classic script, and server.ts injects
// some of these from inline scripts, so they cannot be plain imports.
interface Window {
  // Inline script in server.ts
  __OWNER_TOKEN_KEY__: string;
  __STATIC_VERSION__: string;
  // Inline module script in server.ts, after mermaid loads
  __mermaid?: typeof import("mermaid").default;
  // theme.ts
  __themeIcon: (theme: string) => string;
  __toggleTheme: () => void;
  // components.ts
  __ICONS__: Record<string, string>;
  // app.ts, on the note page only
  __renderMermaid?: (container: Element) => Promise<void>;
  __clearMermaidCache?: () => void;
}
