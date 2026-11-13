import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { createNote, type TestServer } from "../helpers/server-harness";
import { getSharedServer, stopSharedServer } from "./server-shared";

let server: TestServer;

async function ownerContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.addCookies([
    { name: "md_owner_session", value: server.ownerCookie.split("=")[1], url: server.baseUrl },
  ]);
  return context;
}

async function setTitle(noteId: string, title: string) {
  await server.requestPath(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

// Synthesizes a quick single-finger horizontal swipe on the element.
async function swipe(page: Page, selector: string, fromX: number, toX: number) {
  await page.evaluate(
    ({ sel, x0, x1 }) => {
      const el = document.querySelector(sel)!;
      const touch = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
      el.dispatchEvent(
        new TouchEvent("touchstart", { touches: [touch(x0)], changedTouches: [touch(x0)], bubbles: true }),
      );
      el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(x1)], bubbles: true }));
    },
    { sel: selector, x0: fromX, x1: toX },
  );
}

test.beforeAll(async () => {
  server = await getSharedServer();
});

test.afterAll(async () => {
  await stopSharedServer();
});

test("desktop sidebar toggles, persists, and switches notes", async ({ browser }) => {
  const a = await createNote(server, "alpha body");
  const b = await createNote(server, "beta body");
  await setTitle(a.id, "Sidebar Alpha");
  await setTitle(b.id, "Sidebar Beta");

  const context: BrowserContext = await ownerContext(browser, { viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/notes/${a.id}`);

  const sidebar = page.locator("#noteSidebar");
  await expect(sidebar).toBeHidden();
  await page.locator("#sidebarButton button").click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(".note-sidebar-item.active")).toHaveText(/Sidebar Alpha/);
  await expect(sidebar.locator(".note-sidebar-item.active .note-sidebar-snippet")).toHaveText("alpha body");

  await sidebar.locator(`.note-sidebar-item[data-note-id="${b.id}"]`).click();
  await page.waitForURL(`**/notes/${b.id}`);
  // Pinned state survives navigation.
  await expect(page.locator("#noteSidebar")).toBeVisible();
  await expect(page.locator("#noteSidebar .note-sidebar-item.active")).toHaveText(/Sidebar Beta/);

  await context.close();
});

test("mobile swipe right opens the drawer and back closes it", async ({ browser }) => {
  const a = await createNote(server, "mobile body");
  const context = await ownerContext(browser, { viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/notes/${a.id}`);
  await page.waitForSelector("#noteSidebarList .note-sidebar-item");

  const workspace = page.locator("#workspace");
  await expect(workspace).not.toHaveClass(/drawer-open/);

  await swipe(page, ".editor-pane", 80, 260);
  await expect(workspace).toHaveClass(/drawer-open/);

  await page.goBack();
  await expect(workspace).not.toHaveClass(/drawer-open/);
  expect(page.url()).toContain(`/notes/${a.id}`);

  // Swipe left on the drawer closes it too.
  await swipe(page, ".editor-pane", 80, 260);
  await expect(workspace).toHaveClass(/drawer-open/);
  await swipe(page, "#noteSidebar", 260, 60);
  await expect(workspace).not.toHaveClass(/drawer-open/);

  await context.close();
});
