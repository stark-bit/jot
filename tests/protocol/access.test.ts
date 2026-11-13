// Access control: things that can silently break because the owner, who is
// always let through, never sees them. Every request here is anonymous unless
// it explicitly sends the owner cookie or an API key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNote, startTestServer, type TestServer } from "../helpers/server-harness";
import { FakeWsClient } from "../helpers/ws-client";

type ShareAccess = "none" | "view" | "comment" | "edit";
const LEVELS: ShareAccess[] = ["none", "view", "comment", "edit"];
const RANK: Record<ShareAccess, number> = { none: 0, view: 1, comment: 2, edit: 3 };

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server?.stop();
});

// Anonymous request (no owner cookie), optionally with visitor cookies.
function anon(path: string, init: { method?: string; body?: unknown; cookie?: string; auth?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.auth) headers.Authorization = init.auth;
  return fetch(`${server.baseUrl}${path}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function setShareAccess(noteId: string, shareAccess: ShareAccess) {
  const response = await server.requestPath(`/api/notes/${noteId}`, { method: "PUT", body: { shareAccess } as never });
  expect(response.ok).toBe(true);
}

async function sharedNote(markdown: string, shareAccess: ShareAccess) {
  const note = await createNote(server, markdown);
  await setShareAccess(note.id, shareAccess);
  const collab = (await (await server.requestPath(`/api/notes/${note.id}/collab`)).json()) as { shareId: string };
  return { id: note.id, shareId: collab.shareId };
}

async function ownerMarkdown(noteId: string) {
  const payload = (await (await server.requestPath(`/api/notes/${noteId}`)).json()) as { note: { markdown: string } };
  return payload.note.markdown;
}

// Registers a visitor identity on a share link and returns its cookies.
async function visitor(shareId: string, name: string) {
  const response = await anon(`/api/share/${shareId}/identity`, { method: "POST", body: { name } });
  expect(response.ok).toBe(true);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

const anchorFor = (quote: string) => ({ quote, start: 0, end: quote.length });

function shareWsUrl(shareId: string) {
  return `ws://127.0.0.1:${server.port}/?shareId=${shareId}`;
}

const tick = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe("owner API refuses everyone else", () => {
  it("rejects anonymous, bogus-session, and bogus-key requests", async () => {
    const note = await createNote(server, "private");
    for (const init of [{}, { cookie: "md_owner_session=nope" }, { auth: "Bearer not-a-real-key" }]) {
      expect((await anon("/api/notes", init)).status).toBe(401);
      expect((await anon(`/api/notes/${note.id}`, init)).status).toBe(401);
      expect((await anon(`/api/notes/${note.id}`, { ...init, method: "PUT", body: { markdown: "x" } })).status).toBe(
        401,
      );
    }
    expect(await ownerMarkdown(note.id)).toBe("private");
  });
});

describe("share link HTTP access per level", () => {
  for (const level of LEVELS) {
    describe(`shareAccess=${level}`, () => {
      const canView = RANK[level] >= RANK.view;
      const canComment = RANK[level] >= RANK.comment;
      const canEdit = RANK[level] >= RANK.edit;

      it(`read: ${canView ? "allowed" : "refused"}`, async () => {
        const { shareId } = await sharedNote("secret text", level);
        const expected = canView ? 200 : 404;
        expect((await anon(`/s/${shareId}`)).status).toBe(expected);
        expect((await anon(`/api/share/${shareId}`)).status).toBe(expected);
        const noteResponse = await anon(`/api/share/${shareId}/note`);
        expect(noteResponse.status).toBe(expected);
        expect((await noteResponse.text()).includes("secret text")).toBe(canView);
      });

      it(`comment: ${canComment ? "allowed" : "refused"}`, async () => {
        const { id, shareId } = await sharedNote("comment me", level);
        const identity = await anon(`/api/share/${shareId}/identity`, { method: "POST", body: { name: "Eve" } });
        expect(identity.status).toBe(canComment ? 200 : 404);
        const thread = await anon(`/api/share/${shareId}/threads`, {
          method: "POST",
          body: { name: "Eve", anchor: anchorFor("comment"), body: "hi" },
        });
        expect(thread.status).toBe(canComment ? 200 : 404);
        const owner = (await (await server.requestPath(`/api/notes/${id}`)).json()) as { threads: unknown[] };
        expect(owner.threads).toHaveLength(canComment ? 1 : 0);
      });

      it(`edit via API: ${canEdit ? "allowed" : "refused"}`, async () => {
        const { id, shareId } = await sharedNote("edit me", level);
        expect((await anon(`/api/share/${shareId}/collab`)).status).toBe(canEdit ? 200 : 404);
        const edit = await anon(`/api/share/${shareId}/edit`, {
          method: "POST",
          body: { edits: [{ oldText: "edit", newText: "HACKED" }] },
        });
        expect(edit.status).toBe(canEdit ? 200 : 404);
        expect(await ownerMarkdown(id)).toBe(canEdit ? "HACKED me" : "edit me");
      });
    });
  }

  it("unknown share ids are 404", async () => {
    expect((await anon("/s/doesnotexist")).status).toBe(404);
    expect((await anon("/api/share/doesnotexist")).status).toBe(404);
  });
});

describe("share link websocket access", () => {
  it("none: connection is closed", async () => {
    const { shareId } = await sharedNote("closed", "none");
    const client = await FakeWsClient.connect(shareWsUrl(shareId));
    expect(await client.expectClose()).toBe(true);
  });

  for (const level of ["view", "comment"] as const) {
    it(`${level}: stays connected but cannot edit`, async () => {
      const { id, shareId } = await sharedNote("read only", level);
      const client = await FakeWsClient.connect(shareWsUrl(shareId));
      await tick(100);
      expect(client.closed).toBe(false);
      expect(client.received("hello")).toHaveLength(0);

      // Try every clientId the server could plausibly have assigned.
      for (let n = 1; n <= 50; n++) {
        client.send({
          type: "mutation",
          clientId: `c${n}`,
          mutations: [
            {
              name: "insert",
              clientCounter: 1,
              args: { before: null, id: { bunchId: `evil-${n}`, counter: 0 }, content: "X", isInWord: false },
            },
          ],
        });
      }
      await tick();
      expect(await ownerMarkdown(id)).toBe("read only");
      client.close();
    });
  }

  it("edit: receives hello and can edit", async () => {
    const { id, shareId } = await sharedNote("shared", "edit");
    const client = await FakeWsClient.connect(shareWsUrl(shareId));
    const hello = await client.waitFor("hello");
    const clientId = hello.clientId as string;
    client.send({
      type: "mutation",
      clientId,
      mutations: [
        {
          name: "insert",
          clientCounter: 1,
          args: { before: null, id: { bunchId: "guest", counter: 0 }, content: "guest ", isInWord: false },
        },
      ],
    });
    await client.waitFor("mutation", (message) => message.senderId === clientId);
    expect(await ownerMarkdown(id)).toBe("guest shared");
    client.close();
  });

  it("lowering edit -> view disconnects public editors", async () => {
    const { id, shareId } = await sharedNote("downgrade", "edit");
    const client = await FakeWsClient.connect(shareWsUrl(shareId));
    await client.waitFor("hello");
    await setShareAccess(id, "view");
    expect(await client.expectClose()).toBe(true);
  });

  it("lowering view -> none disconnects viewers", async () => {
    const { id, shareId } = await sharedNote("revoke", "view");
    const client = await FakeWsClient.connect(shareWsUrl(shareId));
    await tick(100);
    expect(client.closed).toBe(false);
    await setShareAccess(id, "none");
    expect(await client.expectClose()).toBe(true);
  });
});

async function threadMessages(noteId: string) {
  const payload = (await (await server.requestPath(`/api/notes/${noteId}`)).json()) as {
    threads: { id: string; messages: { id: string; body: string }[] }[];
  };
  return payload.threads;
}

describe("comment permissions for visitors", () => {
  it("visitors can only edit or delete their own messages", async () => {
    const { id, shareId } = await sharedNote("discuss this", "comment");
    const alice = await visitor(shareId, "Alice");
    const bob = await visitor(shareId, "Bob");

    const created = await anon(`/api/share/${shareId}/threads`, {
      method: "POST",
      cookie: alice,
      body: { anchor: anchorFor("discuss"), body: "alice says" },
    });
    expect(created.ok).toBe(true);
    const [thread] = await threadMessages(id);
    const messageId = thread.messages[0].id;

    const bobEdit = await anon(`/api/share/${shareId}/messages/${messageId}`, {
      method: "PATCH",
      cookie: bob,
      body: { body: "bob was here" },
    });
    expect(bobEdit.status).toBe(403);
    const bobDelete = await anon(`/api/share/${shareId}/messages/${messageId}`, { method: "DELETE", cookie: bob });
    expect(bobDelete.status).toBe(403);
    const anonDelete = await anon(`/api/share/${shareId}/messages/${messageId}`, { method: "DELETE" });
    expect(anonDelete.status).toBe(403);
    expect((await threadMessages(id))[0].messages[0].body).toBe("alice says");

    const aliceEdit = await anon(`/api/share/${shareId}/messages/${messageId}`, {
      method: "PATCH",
      cookie: alice,
      body: { body: "alice edited" },
    });
    expect(aliceEdit.status).toBe(200);
    expect((await threadMessages(id))[0].messages[0].body).toBe("alice edited");
  });

  it("visitors cannot delete a whole thread", async () => {
    const { id, shareId } = await sharedNote("thread here", "comment");
    const alice = await visitor(shareId, "Alice");
    await anon(`/api/share/${shareId}/threads`, {
      method: "POST",
      cookie: alice,
      body: { anchor: anchorFor("thread"), body: "mine" },
    });
    const [thread] = await threadMessages(id);
    const response = await anon(`/api/share/${shareId}/threads/${thread.id}`, { method: "DELETE", cookie: alice });
    expect(response.status).toBe(403);
    expect(await threadMessages(id)).toHaveLength(1);
  });

  it("visitors cannot touch owner comments by forging the owner author id", async () => {
    const { id, shareId } = await sharedNote("owner remark", "comment");
    const created = await server.requestPath(`/api/notes/${id}/threads`, {
      method: "POST",
      body: { quote: "owner", body: "owner wrote this" } as never,
    });
    expect(created.ok).toBe(true);
    const [thread] = await threadMessages(id);
    const messageId = thread.messages[0].id;

    const forged = "md_commenter_id=__owner__; md_commenter_name=Mallory";
    const edit = await anon(`/api/share/${shareId}/messages/${messageId}`, {
      method: "PATCH",
      cookie: forged,
      body: { body: "owner did not write this" },
    });
    expect(edit.status).toBe(403);
    const remove = await anon(`/api/share/${shareId}/messages/${messageId}`, { method: "DELETE", cookie: forged });
    expect(remove.status).toBe(403);
    const resolve = await anon(`/api/share/${shareId}/threads/${thread.id}`, {
      method: "PATCH",
      cookie: forged,
      body: { resolved: true },
    });
    expect(resolve.status).toBe(403);

    const asSeen = (await (await anon(`/api/share/${shareId}/note`, { cookie: forged })).json()) as {
      threads: { resolved: boolean; messages: { body: string; canEdit: boolean; canDelete: boolean }[] }[];
    };
    expect(asSeen.threads[0].resolved).toBe(false);
    expect(asSeen.threads[0].messages[0]).toMatchObject({
      body: "owner wrote this",
      canEdit: false,
      canDelete: false,
    });
  });
});

describe("API keys", () => {
  it("a deleted key stops working immediately, over HTTP and websocket", async () => {
    const created = await server.requestPath("/api/keys", { method: "POST", body: { label: "temp" } as never });
    const { id: keyId, key } = (await created.json()) as { id: string; key: string };
    const auth = `Bearer ${key}`;
    const note = await createNote(server, "keyed");

    expect((await anon("/api/notes", { auth })).status).toBe(200);
    const live = await FakeWsClient.connect(`ws://127.0.0.1:${server.port}/?noteId=${note.id}`, {
      Authorization: auth,
    });
    await live.waitFor("hello");
    live.close();

    const removed = await server.requestPath(`/api/keys/${keyId}`, { method: "DELETE" });
    expect(removed.ok).toBe(true);

    expect((await anon("/api/notes", { auth })).status).toBe(401);
    expect((await anon(`/api/notes/${note.id}`, { method: "PUT", auth, body: { markdown: "x" } })).status).toBe(401);
    const refused = await FakeWsClient.connect(`ws://127.0.0.1:${server.port}/?noteId=${note.id}`, {
      Authorization: auth,
    });
    expect(await refused.expectClose()).toBe(true);
    expect(refused.received("hello")).toHaveLength(0);
  });

  it("logout revokes the session token", async () => {
    const login = await anon("/api/auth/login", { method: "POST", body: { password: server.ownerPassword } });
    const { token } = (await login.json()) as { token: string };
    const exchange = await anon("/api/auth/token", { method: "POST", body: { token } });
    const cookie = exchange.headers
      .getSetCookie()
      .find((c) => c.startsWith("md_owner_session="))!
      .split(";")[0];

    expect((await anon("/api/notes", { cookie })).status).toBe(200);
    expect((await anon("/api/auth/logout", { method: "POST", cookie })).ok).toBe(true);
    expect((await anon("/api/notes", { cookie })).status).toBe(401);
  });

  it("wrong password is refused and setup cannot be re-run", async () => {
    expect((await anon("/api/auth/login", { method: "POST", body: { password: "wrong-password" } })).status).toBe(401);
    const setup = await anon("/api/auth/setup", {
      method: "POST",
      body: { password: "takeover123", confirmPassword: "takeover123" },
    });
    expect(setup.status).toBe(400);
    expect((await anon("/api/auth/login", { method: "POST", body: { password: "takeover123" } })).status).toBe(401);
  });
});
