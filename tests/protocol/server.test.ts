import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  type ClientMutation,
  type CollabState,
  applyClientMutations,
  collabToMarkdown,
  idAtIndex,
  loadCollabState,
} from "../../server/collab";
import { createNote, startTestServer, writeLegacyNote, type TestServer } from "../helpers/server-harness";
import { FakeWsClient, type ServerMessage } from "../helpers/ws-client";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    beforeStart: (dataDir) => {
      writeLegacyNote(dataDir, "legacy1", "legacy note", "# legacy\n\nold text\n");
    },
  });
});

afterAll(async () => {
  await server?.stop();
});

function wsUrl(noteId: string): string {
  return `ws://127.0.0.1:${server.port}/?noteId=${noteId}`;
}

async function connectEditor(noteId: string): Promise<FakeWsClient> {
  const client = await FakeWsClient.connect(wsUrl(noteId), { Cookie: server.ownerCookie });
  return client;
}

async function connectEditorExpectHello(noteId: string): Promise<FakeWsClient> {
  const client = await connectEditor(noteId);
  await client.waitFor("hello");
  return client;
}

// Fetches the live collab state and returns the element id at an index.
async function idAt(noteId: string, index: number) {
  const response = await server.requestPath(`/api/notes/${noteId}/collab`);
  const payload = (await response.json()) as { collabState: Parameters<typeof loadCollabState>[0] };
  const state = loadCollabState(payload.collabState);
  return idAtIndex(state, index);
}

// Fetches the live collab state as the fold base for expectations.
async function liveState(noteId: string): Promise<CollabState> {
  const response = await server.requestPath(`/api/notes/${noteId}/collab`);
  const payload = (await response.json()) as { collabState: Parameters<typeof loadCollabState>[0] };
  return loadCollabState(payload.collabState);
}

function asMutation(message: ServerMessage) {
  return message as unknown as {
    senderId: string;
    senderCounter: number;
    serverCounter: number;
    markdown: string;
    idListUpdates: { type: string }[];
  };
}

function insertMutation(before: unknown, bunchId: string, content: string, clientCounter: number): ClientMutation {
  return {
    name: "insert",
    clientCounter,
    args: { before: before as never, id: { bunchId, counter: 0 }, content, isInWord: false },
  };
}

describe("websocket authentication", () => {
  it("rejects unauthenticated editor connections on ?noteId=", async () => {
    const note = await createNote(server, "secret draft");
    const client = await FakeWsClient.connect(wsUrl(note.id));
    const closed = await client.expectClose();
    expect(closed).toBe(true);
    expect(client.received("hello")).toEqual([]);
  });

  it("rejects an invalid owner cookie", async () => {
    const note = await createNote(server, "secret draft");
    const client = await FakeWsClient.connect(wsUrl(note.id), {
      Cookie: "md_owner_session=not-a-real-token",
    });
    const closed = await client.expectClose();
    expect(closed).toBe(true);
    expect(client.received("hello")).toEqual([]);
  });

  it("accepts the owner session cookie and sends hello", async () => {
    const note = await createNote(server, "# hello\n\ncontent\n");
    const client = await connectEditor(note.id);
    try {
      const hello = await client.waitFor("hello");
      expect(hello.noteId).toBe(note.id);
      expect(hello.title).toBe(note.title);
      expect(hello.markdown).toBe("# hello\n\ncontent\n");
      expect(Array.isArray(hello.idListState)).toBe(true);
      expect(typeof hello.serverCounter).toBe("number");
      expect(typeof hello.clientId).toBe("string");
    } finally {
      client.close();
    }
  });
});

describe("mutation ordering and acks", () => {
  it("applies interleaved client mutations in one total order", async () => {
    const note = await createNote(server, "hello world");
    const clientA = await connectEditorExpectHello(note.id);
    const clientB = await connectEditorExpectHello(note.id);

    // Fully ordered: each batch is acked before the next is sent, so the
    // server's apply order equals the send order.
    const batches: { clientId: string; mutations: ClientMutation[] }[] = [];

    async function sendFrom(client: FakeWsClient, mutations: ClientMutation[]) {
      const clientId = (await client.waitFor("hello")).clientId as string;
      const lastCounter = mutations.at(-1)!.clientCounter;
      client.send({ type: "mutation", clientId, mutations });
      const broadcast = await client.waitFor("mutation", (message) => {
        const m = message as { senderId?: string; senderCounter?: number };
        return m.senderId === clientId && m.senderCounter === lastCounter;
      });
      batches.push({ clientId, mutations });
      return asMutation(broadcast);
    }

    const id1 = await idAt(note.id, 1);
    const ackA1 = await sendFrom(clientA, [insertMutation(id1, "bunch-a1", "XX", 1)]);
    const expectedState = applyClientMutations(await liveState(note.id), batches[0].mutations);

    const id2 = await idAt(note.id, 5);
    const ackB1 = await sendFrom(clientB, [
      { name: "delete", clientCounter: 1, args: { startId: id2, contentLength: 1 } },
    ]);
    const expectedAfterB = applyClientMutations(expectedState.state, batches[1].mutations);

    const ackA2 = await sendFrom(clientA, [insertMutation(null, "bunch-a2", ">>", 2)]);
    const expectedFinal = applyClientMutations(expectedAfterB.state, batches[2].mutations);

    const final = (await (await server.requestPath(`/api/notes/${note.id}`)).json()) as {
      note: { markdown: string };
    };

    expect(final.note.markdown).toBe(collabToMarkdown(expectedFinal.state));
    // Every broadcast carried exactly the server state at that point.
    expect(ackA1.markdown).toBe(collabToMarkdown(expectedState.state));
    expect(ackB1.markdown).toBe(collabToMarkdown(expectedAfterB.state));
    expect(ackA2.markdown).toBe(final.note.markdown);
    // B saw the same three broadcasts in the same order: A, B, A.
    const idA = clientA.inbox.find((message) => message.type === "hello")?.clientId as string;
    const idB = clientB.inbox.find((message) => message.type === "hello")?.clientId as string;
    const bSenderIds = clientB.received("mutation").map((message) => asMutation(message).senderId);
    expect(bSenderIds).toEqual([idA, idB, idA]);
    expect(clientB.received("mutation").length).toBe(3);
    clientA.close();
    clientB.close();
  });

  it("echoes the sender counter in acks and filters retransmissions", async () => {
    const note = await createNote(server, "target text");
    const client = await connectEditorExpectHello(note.id);
    const clientId = client.inbox[0].clientId as string;

    client.send({
      type: "mutation",
      clientId,
      mutations: [insertMutation(null, "ack-bunch", "new ", 3), insertMutation(null, "ack-bunch2", "words", 5)],
    });
    const ack = await client.waitFor("mutation", (message) => (message as { senderId?: string }).senderId === clientId);
    const ackMessage = asMutation(ack);
    expect(ackMessage.senderCounter).toBe(5);
    expect(ackMessage.idListUpdates.length).toBeGreaterThan(0);

    // Retransmission of the same message: filtered, empty ack, no change.
    client.send({
      type: "mutation",
      clientId,
      mutations: [insertMutation(null, "ack-bunch", "new ", 3), insertMutation(null, "ack-bunch2", "words", 5)],
    });
    const repeatAck = await client.waitFor("mutation", (message) => {
      const m = asMutation(message);
      return m.senderId === clientId && m.senderCounter === 5 && m.idListUpdates.length === 0;
    });
    expect(repeatAck.type).toBe("mutation");

    const after = (await (await server.requestPath(`/api/notes/${note.id}`)).json()) as {
      note: { markdown: string };
    };
    // "words" was inserted at the same null anchor afterwards, so it lands first.
    expect(after.note.markdown).toBe("wordsnew target text");
    client.close();
  });

  it("never echoes a client's own intent back as someone else's truth", async () => {
    const note = await createNote(server, "steady");
    const clientA = await connectEditorExpectHello(note.id);
    const clientB = await connectEditorExpectHello(note.id);
    const clientIdA = clientA.inbox[0].clientId as string;

    clientA.send({
      type: "mutation",
      clientId: clientIdA,
      mutations: [insertMutation(null, "echo-bunch", "ONE ", 1)],
    });

    // The sender gets exactly one mutation message: its own ack.
    const ownAck = await clientA.waitFor(
      "mutation",
      (message) => (message as { senderId?: string }).senderId === clientIdA,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const aMutationMessages = clientA.received("mutation").map(asMutation);
    expect(aMutationMessages).toHaveLength(1);
    expect(aMutationMessages[0].senderId).toBe(clientIdA);
    expect(aMutationMessages[0].markdown).toBe("ONE steady");

    // The other client receives the same single broadcast.
    const bBroadcast = await clientB.waitFor(
      "mutation",
      (message) => (message as { senderId?: string }).senderId === clientIdA,
    );
    expect(asMutation(bBroadcast).markdown).toBe("ONE steady");
    expect(asMutation(ownAck)).toEqual(asMutation(bBroadcast));
    clientA.close();
    clientB.close();
  });

  it("ignores mutation kinds other than insert and delete", async () => {
    const note = await createNote(server, "unchanged");
    const client = await connectEditorExpectHello(note.id);
    const clientId = client.inbox[0].clientId as string;

    client.send({
      type: "mutation",
      clientId,
      mutations: [
        {
          name: "rename",
          clientCounter: 1,
          args: {},
        } as unknown as ClientMutation,
      ],
    });
    const ack = await client.waitFor("mutation", (message) => (message as { senderId?: string }).senderId === clientId);
    const ackMessage = asMutation(ack);
    expect(ackMessage.senderCounter).toBe(1);
    expect(ackMessage.idListUpdates).toEqual([]);
    expect(ackMessage.markdown).toBe("unchanged");
    client.close();
  });

  it("rejects mutations claiming another clientId", async () => {
    const note = await createNote(server, "mine");
    const client = await connectEditorExpectHello(note.id);
    client.send({
      type: "mutation",
      clientId: "not-my-client",
      mutations: [insertMutation(null, "spoof-bunch", "nope", 1)],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.received("mutation")).toEqual([]);
    const current = (await (await server.requestPath(`/api/notes/${note.id}`)).json()) as {
      note: { markdown: string };
    };
    expect(current.note.markdown).toBe("mine");
    client.close();
  });
});

describe("captured REST behaviors", () => {
  it("POST /edit becomes delete plus insert mutations", async () => {
    const note = await createNote(server, "alpha beta gamma");
    const client = await connectEditorExpectHello(note.id);

    const response = await server.requestPath(`/api/notes/${note.id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: [{ oldText: "beta", newText: "BETA!" }] }),
    });
    expect(response.ok).toBe(true);

    const broadcast = await client.waitFor(
      "mutation",
      (message) => (message as { senderId?: string }).senderId === "__api__",
    );
    const message = asMutation(broadcast);
    expect(message.idListUpdates[0].type).toBe("deleteRange");
    expect(message.idListUpdates.some((update) => update.type === "insertAfter")).toBe(true);
    expect(message.markdown).toBe("alpha BETA! gamma");

    const current = (await (await server.requestPath(`/api/notes/${note.id}`)).json()) as {
      note: { markdown: string };
    };
    expect(current.note.markdown).toBe("alpha BETA! gamma");
    client.close();
  });

  it("markdown PUT rebuilds the collab state without bypass", async () => {
    const note = await createNote(server, "one");
    const before = (await (await server.requestPath(`/api/notes/${note.id}/collab`)).json()) as {
      serverCounter: number;
    };

    const put = await server.requestPath(`/api/notes/${note.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "two three four" }),
    });
    expect(put.ok).toBe(true);

    const collab = (await (await server.requestPath(`/api/notes/${note.id}/collab`)).json()) as {
      serverCounter: number;
      collabState: Parameters<typeof loadCollabState>[0];
    };
    expect(collab.serverCounter).toBe(before.serverCounter + 1);
    const state = loadCollabState(collab.collabState);
    expect(collabToMarkdown(state)).toBe("two three four");
    // Rebuilt from markdown: a single fresh bunch covering the whole text.
    const bunches = new Set(Array.from(state.idList.values()).map((id) => id.bunchId));
    expect(bunches.size).toBe(1);

    // The rebuilt state is really editable, not a stale bypass.
    const edit = await server.requestPath(`/api/notes/${note.id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: [{ oldText: "three", newText: "3" }] }),
    });
    expect(edit.ok).toBe(true);
    const current = (await (await server.requestPath(`/api/notes/${note.id}`)).json()) as {
      note: { markdown: string };
    };
    expect(current.note.markdown).toBe("two 3 four");

    const client = await connectEditorExpectHello(note.id);
    const hello = client.inbox.find((message) => message.type === "hello");
    expect(hello?.markdown).toBe("two 3 four");
    client.close();
  });

  it("converts legacy notes from .md on load", async () => {
    const response = await server.requestPath("/api/notes/legacy1");
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      note: { id: string; title: string; markdown: string };
    };
    expect(payload.note.title).toBe("legacy note");
    expect(payload.note.markdown).toBe("# legacy\n\nold text\n");

    const collab = (await (await server.requestPath("/api/notes/legacy1/collab")).json()) as {
      serverCounter: number;
      collabState: Parameters<typeof loadCollabState>[0];
    };
    expect(collab.serverCounter).toBe(0);
    const state: CollabState = loadCollabState(collab.collabState);
    expect(collabToMarkdown(state)).toBe("# legacy\n\nold text\n");
  });

  it("writes the .md file as a derived artifact", async () => {
    const note = await createNote(server, "disk check");
    const mdPath = path.join(server.dataDir, "notes", `${note.id}.md`);
    expect(fs.readFileSync(mdPath, "utf8")).toBe("disk check");

    // WS mutation updates the file too.
    const client = await connectEditorExpectHello(note.id);
    const clientId = client.inbox[0].clientId as string;
    client.send({
      type: "mutation",
      clientId,
      mutations: [insertMutation(null, "disk-bunch", "LIVE ", 1)],
    });
    await client.waitFor("mutation", (message) => (message as { senderId?: string }).senderId === clientId);
    expect(fs.readFileSync(mdPath, "utf8")).toBe("LIVE disk check");

    // PUT markdown rewrites the file as well.
    await server.requestPath(`/api/notes/${note.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "replaced" }),
    });
    expect(fs.readFileSync(mdPath, "utf8")).toBe("replaced");
    const meta = JSON.parse(fs.readFileSync(path.join(server.dataDir, "notes", `${note.id}.json`), "utf8")) as {
      collab?: unknown;
    };
    expect(meta.collab).toBeDefined();
    client.close();
  });

  it("comments work against the derived markdown", async () => {
    const note = await createNote(server, "alpha\n\nbeta section\n");

    await server.requestPath(`/api/notes/${note.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "gamma delta\n" }),
    });
    const thread1 = await server.requestPath(`/api/notes/${note.id}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: "gamma delta", body: "first comment" }),
    });
    expect(thread1.ok).toBe(true);

    const edit = await server.requestPath(`/api/notes/${note.id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: [{ oldText: "gamma", newText: "GAMMA" }] }),
    });
    expect(edit.ok).toBe(true);

    const thread2 = await server.requestPath(`/api/notes/${note.id}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: "GAMMA delta", body: "second comment" }),
    });
    expect(thread2.ok).toBe(true);

    const payload = (await (await server.requestPath(`/api/notes/${note.id}`)).json()) as {
      note: { markdown: string };
      threads: { anchor: { quote: string; start: number }; messages: { body: string }[] }[];
    };
    expect(payload.note.markdown).toBe("GAMMA delta\n");
    expect(payload.threads).toHaveLength(2);
    expect(payload.threads[0].messages[0].body).toBe("first comment");
    expect(payload.threads[1].anchor.quote).toBe("GAMMA delta");
    expect(payload.threads[1].anchor.start).toBe(0);
    expect(payload.threads[1].messages[0].body).toBe("second comment");
  });
});
