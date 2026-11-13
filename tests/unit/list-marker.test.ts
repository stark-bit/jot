import { describe, expect, it } from "vitest";

// @ts-expect-error plain browser ES module, no types
import { listMarkerAt } from "../../client/collab-editor";

describe("listMarkerAt", () => {
  it("bullets continue as bullets", () => {
    expect(listMarkerAt("- item", 0)).toEqual({ indent: "", current: "- ", marker: "- " });
  });

  it("numbered items increment", () => {
    expect(listMarkerAt("1. item", 0)?.marker).toBe("2. ");
    expect(listMarkerAt("9. item", 0)).toEqual({ indent: "", current: "9. ", marker: "10. " });
  });

  it("task items continue unchecked", () => {
    expect(listMarkerAt("- [ ] todo", 0)).toEqual({ indent: "", current: "- [ ] ", marker: "- [ ] " });
    expect(listMarkerAt("- [x] done", 0)?.marker).toBe("- [ ] ");
  });

  it("keeps indentation and honours lineStart", () => {
    expect(listMarkerAt("first\n  3. nested", 6)).toEqual({ indent: "  ", current: "3. ", marker: "4. " });
  });

  it("ignores non-list lines", () => {
    expect(listMarkerAt("plain text", 0)).toBeNull();
    expect(listMarkerAt("1) paren", 0)).toBeNull();
    expect(listMarkerAt("-no space", 0)).toBeNull();
    expect(listMarkerAt("2024.", 0)).toBeNull();
  });
});
