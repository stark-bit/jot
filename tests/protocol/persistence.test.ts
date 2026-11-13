// Everything must survive a server restart. Breakage here only shows up later,
// as a note that is quietly missing or reverted.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNote, startTestServer, type TestServer } from "../helpers/server-harness";
import { FakeWsClient } from "../helpers/ws-client";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server?.stop();
});

type NotePayload = {
  note: { id: string; title: string; markdown: string; shareId: string; shareAccess: string; createdAt: string };
  threads: {
    id: string;
    resolved: boolean;
    anchor: { quote: string };
    messages: { body: string; parentId: string | null }[];
  }[];
};

async function getNote(id: string) {
  const response = await server.requestPath(`/api/notes/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as NotePayload;
}

async function listIds() {
  const payload = (await (await server.requestPath("/api/notes")).json()) as { notes: { id: string }[] };
  return payload.notes.map((n) => n.id).sort();
}

describe("restart", () => {
  it("restores text, title, share settings, and comment threads", async () => {
    const note = await createNote(server, "first draft\n\nsecond paragraph\n");
    await server.requestPath(`/api/notes/${note.id}`, {
      method: "PUT",
      body: { title: "Persisted", shareAccess: "comment" } as never,
    });
    await server.requestPath(`/api/notes/${note.id}/edit`, {
      method: "POST",
      body: { edits: [{ oldText: "first", newText: "final" }] } as never,
    });
    const thread = (await (
      await server.requestPath(`/api/notes/${note.id}/threads`, {
        method: "POST",
        body: { quote: "second paragraph", body: "top comment" } as never,
      })
    ).json()) as { thread: { id: string } };
    await server.requestPath(`/api/notes/${note.id}/threads/${thread.thread.id}/replies`, {
      method: "POST",
      body: { body: "a reply" } as never,
    });
    await server.requestPath(`/api/notes/${note.id}/threads/${thread.thread.id}`, {
      method: "PATCH",
      body: { resolved: true } as never,
    });

    const before = await getNote(note.id);
    const idsBefore = await listIds();
    await server.restart();
    const after = await getNote(note.id);

    expect(after.note).toEqual(before.note);
    expect(after.threads).toEqual(before.threads);
    expect(after.note.markdown).toBe("final draft\n\nsecond paragraph\n");
    expect(after.note.title).toBe("Persisted");
    expect(after.note.shareAccess).toBe("comment");
    expect(after.threads[0].resolved).toBe(true);
    expect(after.threads[0].messages.map((m) => m.body)).toEqual(["top comment", "a reply"]);
    expect(await listIds()).toEqual(idsBefore);

    // The share link still points at the same note.
    const shared = await fetch(`${server.baseUrl}/api/share/${before.note.shareId}/note`);
    expect(shared.status).toBe(200);
  });

  it("restores live websocket edits, and editing continues afterwards", async () => {
    const note = await createNote(server, "base");
    const client = await FakeWsClient.connect(`ws://127.0.0.1:${server.port}/?noteId=${note.id}`, {
      Cookie: server.ownerCookie,
    });
    const hello = await client.waitFor("hello");
    const clientId = hello.clientId as string;
    client.send({
      type: "mutation",
      clientId,
      mutations: [
        {
          name: "insert",
          clientCounter: 1,
          args: { before: null, id: { bunchId: "live-bunch", counter: 0 }, content: "live ", isInWord: false },
        },
      ],
    });
    await client.waitFor("mutation", (message) => message.senderId === clientId);
    client.close();

    await server.restart();
    expect((await getNote(note.id)).note.markdown).toBe("live base");

    const edit = await server.requestPath(`/api/notes/${note.id}/edit`, {
      method: "POST",
      body: { edits: [{ oldText: "base", newText: "after restart" }] } as never,
    });
    expect(edit.ok).toBe(true);
    expect((await getNote(note.id)).note.markdown).toBe("live after restart");
  });

  it("a deleted note stays deleted", async () => {
    const note = await createNote(server, "doomed");
    expect((await server.requestPath(`/api/notes/${note.id}`, { method: "DELETE" })).ok).toBe(true);
    await server.restart();
    expect((await server.requestPath(`/api/notes/${note.id}`)).status).toBe(404);
  });

  it("one corrupt note file does not take other notes down", async () => {
    const good = await createNote(server, "healthy");
    const bad = await createNote(server, "corrupted");
    fs.writeFileSync(path.join(server.dataDir, "notes", `${bad.id}.json`), '{"id": "trunc', "utf8");

    await server.restart();
    expect((await getNote(good.id)).note.markdown).toBe("healthy");
    // The corrupt note is skipped (currently without any log message);
    // its markdown file is left on disk for manual recovery.
    expect(fs.existsSync(path.join(server.dataDir, "notes", `${bad.id}.md`))).toBe(true);
  });
});
