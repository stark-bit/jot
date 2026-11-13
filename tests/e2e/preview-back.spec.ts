import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { createNote, type TestServer } from "../helpers/server-harness";
import { getSharedServer, stopSharedServer } from "./server-shared";

let server: TestServer;
let context: BrowserContext;

test.beforeAll(async ({ browser }) => {
  server = await getSharedServer();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
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

// Land on the note from the notes list so there is a page to go back to.
async function openNoteFromList(): Promise<{ page: Page; noteUrl: string }> {
  const note = await createNote(server, "# Preview back\n\nHello.");
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/`);
  const noteUrl = `${server.baseUrl}/notes/${note.id}`;
  await page.goto(noteUrl);
  await expect(page.locator("#previewFab")).toBeVisible();
  return { page, noteUrl };
}

const stage = (page: Page) => page.locator("#previewStage");

test("back button closes the mobile preview instead of leaving the note", async () => {
  const { page, noteUrl } = await openNoteFromList();

  await page.locator("#previewFab").click();
  await expect(stage(page)).toHaveClass(/preview-open/);

  await page.goBack();
  await expect(stage(page)).not.toHaveClass(/preview-open/);
  expect(page.url()).toBe(noteUrl);
  await expect(page.locator("#previewFab")).toBeVisible();

  // The next back press leaves the note as usual.
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseUrl}/`);
  await page.close();
});

test("closing the preview with the X button consumes its history entry", async () => {
  const { page, noteUrl } = await openNoteFromList();

  await page.locator("#previewFab").click();
  await expect(stage(page)).toHaveClass(/preview-open/);

  await page.locator("#previewCloseButton").click();
  await expect(stage(page)).not.toHaveClass(/preview-open/);
  expect(page.url()).toBe(noteUrl);

  // No stale preview entry left behind: one back press leaves the note.
  await page.goBack();
  await expect(page).toHaveURL(`${server.baseUrl}/`);
  await page.close();
});
