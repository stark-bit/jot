import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../helpers/cli";
import { createNote, type TestServer } from "../helpers/server-harness";
import { getSharedServer, stopSharedServer } from "./server-shared";

const test = base;

let server: TestServer;
let context: BrowserContext;

async function openEditor(noteId: string, initial: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/notes/${noteId}`);
  await page.waitForSelector("#editorTextarea");
  await page.waitForFunction(
    () => {
      const textarea = document.querySelector("#editorTextarea") as HTMLTextAreaElement | null;
      return Boolean(textarea && !textarea.readOnly);
    },
    undefined,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    (expected) => (document.querySelector("#editorTextarea") as HTMLTextAreaElement).value === expected,
    initial,
    { timeout: 20000 },
  );
  // The page also loads the note with a one-shot REST fetch whose .value
  // assignment resets the caret; wait it out before trusting the caret.
  await page.waitForFunction(
    (id) => performance.getEntriesByType("resource").some((entry) => entry.name.includes(`/api/notes/${id}`)),
    noteId,
    { timeout: 20000 },
  );
  await page.waitForTimeout(150);
  return page;
}

function valueOf(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#editorTextarea") as HTMLTextAreaElement).value);
}

function selectionOf(page: Page): Promise<{ start: number; end: number }> {
  return page.evaluate(() => {
    const textarea = document.querySelector("#editorTextarea") as HTMLTextAreaElement;
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
  });
}

function setCursor(page: Page, index: number): Promise<void> {
  return page.evaluate((i) => {
    const textarea = document.querySelector("#editorTextarea") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(i, i);
  }, index);
}

function noteMarkdownPath(noteId: string): string {
  return path.join(server.dataDir, "notes", `${noteId}.md`);
}

test.beforeAll(async ({ browser }) => {
  server = await getSharedServer();
  context = await browser.newContext();
  await context.addCookies([
    {
      name: "md_owner_session",
      value: server.ownerCookie.split("=")[1],
      url: server.baseUrl,
    },
  ]);
});

test.afterAll(async () => {
  await context?.close();
  await stopSharedServer();
});

test.describe("two-tab collab editing", () => {
  const initial = "alpha beta gamma\ndelta epsilon\n";
  let pageA: Page;
  let pageB: Page;
  let noteId: string;

  test.beforeAll(async () => {
    const note = await createNote(server, initial);
    noteId = note.id;
    const thread = await server.requestPath(`/api/notes/${noteId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: "alpha beta", body: "e2e comment" }),
    });
    expect(thread.ok).toBe(true);
    pageA = await openEditor(noteId, initial);
    pageB = await openEditor(noteId, initial);
  });

  test("concurrent typing at speed converges without drops", async () => {
    await setCursor(pageA, 0);
    await setCursor(pageB, initial.length);
    const typedA = "Hello ";
    const typedB = "world";

    for (let i = 0; i < Math.max(typedA.length, typedB.length); i++) {
      if (i < typedA.length) {
        await pageA.keyboard.type(typedA[i]);
        // No reload loop may wipe or reorder what was just typed.
        const value = await valueOf(pageA);
        expect(value.startsWith(typedA.slice(0, i + 1))).toBe(true);
        expect(value).toContain(initial);
      }
      if (i < typedB.length) {
        await pageB.keyboard.type(typedB[i]);
      }
    }

    const expected = typedA + initial + typedB;
    await expect.poll(() => valueOf(pageA), { timeout: 15000 }).toBe(expected);
    await expect.poll(() => valueOf(pageB), { timeout: 15000 }).toBe(expected);
  });

  test("existing comments render on the editor page", async () => {
    const card = pageA.locator("#threadRail .thread-card").filter({ hasText: "e2e comment" });
    await expect(card).toHaveCount(1);
  });

  test("markdown on disk stays current after live edits", async () => {
    const expected = "Hello alpha beta gamma\ndelta epsilon\nworld";
    await expect
      .poll(() => fs.readFileSync(noteMarkdownPath(noteId), "utf8"), {
        timeout: 10000,
      })
      .toBe(expected);
  });

  test("cursor stays stable while remote updates arrive", async () => {
    const note = await createNote(server, initial);
    const editorA = await openEditor(note.id, initial);
    const editorB = await openEditor(note.id, initial);

    // B parks its cursor mid-document; A types at the start.
    await setCursor(editorB, 16);
    await setCursor(editorA, 0);
    const baseline = (await selectionOf(editorB)).start;

    const samples: number[] = [];
    for (const ch of "XYZ") {
      await editorA.keyboard.type(ch);
      samples.push((await selectionOf(editorB)).start);
    }
    await expect.poll(() => valueOf(editorB)).toContain("XYZ");
    expect((await selectionOf(editorB)).start).toBe(baseline + 3);
    for (let i = 0; i < samples.length; i++) {
      const expected = baseline + i + 1;
      // The cursor may lag one update behind, but never jumps or drifts.
      expect([expected - 1, expected]).toContain(samples[i]);
    }

    // B types mid-line while A keeps typing at the start.
    await editorB.keyboard.type("!");
    await editorA.keyboard.type("123");
    const expectedText = "XYZ123alpha beta gamma!\ndelta epsilon\n";
    await expect.poll(() => valueOf(editorA), { timeout: 15000 }).toBe(expectedText);
    await expect.poll(() => valueOf(editorB), { timeout: 15000 }).toBe(expectedText);
    const finalSelection = (await selectionOf(editorB)).start;
    expect(finalSelection).toBe(baseline + 3 + 1 + 3);
    expect((await valueOf(editorB))[finalSelection - 1]).toBe("!");
    editorA.close();
    editorB.close();
  });

  test("backspace, word delete, paste, and newline converge", async () => {
    const note = await createNote(server, "one two three four\n");
    const editorA = await openEditor(note.id, "one two three four\n");
    const editorB = await openEditor(note.id, "one two three four\n");

    await setCursor(editorA, 0);
    await setCursor(editorB, "one two three four\n".length);

    // Interleave A's prepend with B's destructive edits at the other end.
    const paste = () =>
      editorB.evaluate(() => {
        const textarea = document.querySelector("#editorTextarea") as HTMLTextAreaElement;
        textarea.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertFromPaste",
            data: "PASTED",
            bubbles: true,
            cancelable: true,
          }),
        );
      });

    for (let i = 0; i < 4; i++) {
      if (i === 0) await editorB.keyboard.press("Backspace");
      if (i === 1) await editorB.keyboard.press("Control+Backspace");
      if (i === 2) await paste();
      if (i === 3) await editorB.keyboard.press("Enter");
      if (i < 3) await editorA.keyboard.type("A! "[i]);
    }

    const expected = "A! one two three PASTED\n";
    await expect.poll(() => valueOf(editorA), { timeout: 15000 }).toBe(expected);
    await expect.poll(() => valueOf(editorB), { timeout: 15000 }).toBe(expected);
    await expect.poll(() => fs.readFileSync(noteMarkdownPath(note.id), "utf8")).toBe(expected);
    editorA.close();
    editorB.close();
  });

  test("two users typing in the same word both land", async () => {
    const note = await createNote(server, "target");
    const editorA = await openEditor(note.id, "target");
    const editorB = await openEditor(note.id, "target");

    // Both cursors sit at the same spot inside the word.
    await setCursor(editorA, 3);
    await setCursor(editorB, 3);
    await editorA.keyboard.type("AA");
    await editorB.keyboard.type("BB");

    await expect
      .poll(
        async () => {
          const a = await valueOf(editorA);
          const b = await valueOf(editorB);
          return a === b ? a : "";
        },
        { timeout: 15000 },
      )
      .toMatch(/^tar(AABB|BBAA)get$/);
    editorA.close();
    editorB.close();
  });
});

test.describe("CLI round-trip", () => {
  test("list, search, read, edit, update, delete against the live server", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jot-cli-home-"));
    try {
      const register = await runCli(["register", "e2e", server.baseUrl, server.apiKey], home);
      expect(register.code).toBe(0);

      const created = await runCli(["e2e", "create", "CLI note"], home);
      expect(created.code).toBe(0);
      const noteId = created.stdout.trim().split("\t")[0];
      expect(noteId).toBeTruthy();

      const list = await runCli(["e2e", "list"], home);
      expect(list.stdout).toContain(`${noteId}\tCLI note`);

      const update = await runCli(["e2e", "update", noteId, "markdown", "hello cli world"], home);
      expect(update.code).toBe(0);
      expect(update.stdout).toContain("Saved at");

      const read = await runCli(["e2e", "read", noteId], home);
      expect(read.stdout).toContain("hello cli world");

      const search = await runCli(["e2e", "search", "cli world"], home);
      expect(search.stdout).toContain(noteId);

      const edit = await runCli(["e2e", "edit", noteId, JSON.stringify([{ oldText: "cli", newText: "CLI!" }])], home);
      expect(edit.code).toBe(0);
      expect(edit.stdout).toContain("Saved at");
      const readEdited = await runCli(["e2e", "read", noteId], home);
      expect(readEdited.stdout).toContain("hello CLI! world");
      await expect.poll(() => fs.readFileSync(noteMarkdownPath(noteId), "utf8")).toBe("hello CLI! world");

      const comment = await runCli(["e2e", "comment", noteId, "hello", "looks good"], home);
      expect(comment.code).toBe(0);
      expect(comment.stdout).toContain("Comment added");
      const readCommented = await runCli(["e2e", "read", noteId], home);
      expect(readCommented.stdout).toContain("--- Comments ---");
      expect(readCommented.stdout).toContain("looks good");

      const rename = await runCli(["e2e", "update", noteId, "title", "renamed note"], home);
      expect(rename.code).toBe(0);
      const relisted = await runCli(["e2e", "list"], home);
      expect(relisted.stdout).toContain(`${noteId}\trenamed note`);

      const removed = await runCli(["e2e", "delete", noteId], home);
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain(`Deleted ${noteId}`);
      const finalList = await runCli(["e2e", "list"], home);
      expect(finalList.stdout).not.toContain(noteId);
      expect(fs.existsSync(noteMarkdownPath(noteId))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
