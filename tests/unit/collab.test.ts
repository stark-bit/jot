import { describe, expect, it } from "vitest";

import {
  type ClientMutation,
  type CollabState,
  TrackedIdList,
  applyClientMutations,
  collabFromMarkdown,
  collabToMarkdown,
  idAtIndex,
  idBeforeIndex,
  loadCollabState,
  newCollabState,
  saveCollabState,
} from "../../src/collab";
import { IdList, type ElementId } from "articulated";

function emptyTracked(): TrackedIdList {
  return new TrackedIdList(IdList.new(), true);
}

function insertMutation(
  before: ElementId | null,
  id: ElementId,
  content: string,
  clientCounter = 1,
  isInWord = false,
): ClientMutation {
  return { name: "insert", clientCounter, args: { before, id, content, isInWord } };
}

function deleteMutation(
  startId: ElementId,
  endId?: ElementId,
  contentLength?: number,
  clientCounter = 1,
): ClientMutation {
  return { name: "delete", clientCounter, args: { startId, endId, contentLength } };
}

function textOf(state: CollabState): string {
  return collabToMarkdown(state);
}

describe("TrackedIdList", () => {
  it("tracks insertAfter updates with count", () => {
    const tracked = emptyTracked();
    const id: ElementId = { bunchId: "b1", counter: 0 };
    tracked.insertAfter(null, id, 3);
    expect(tracked.getAndResetUpdates()).toEqual([{ type: "insertAfter", before: null, id, count: 3 }]);
  });

  it("tracks deleteRange as a single update and deletes the ids", () => {
    const tracked = emptyTracked();
    const ids: ElementId[] = [0, 1, 2, 3].map((counter) => ({ bunchId: "b1", counter }));
    tracked.insertAfter(null, ids[0], 4);
    tracked.deleteRange(1, 2);
    expect(tracked.getAndResetUpdates()).toEqual([
      { type: "insertAfter", before: null, id: ids[0], count: 4 },
      { type: "deleteRange", startIndex: 1, endIndex: 2 },
    ]);
    expect(tracked.idList.has(ids[1])).toBe(false);
    expect(tracked.idList.has(ids[2])).toBe(false);
    expect(tracked.idList.has(ids[3])).toBe(true);
    // Deleted ids stay known (tombstones) so late anchors still resolve.
    expect(tracked.idList.isKnown(ids[1])).toBe(true);
  });

  it("applies updates without recording them", () => {
    const tracked = emptyTracked();
    const ids: ElementId[] = [0, 1, 2].map((counter) => ({ bunchId: "b1", counter }));
    tracked.insertAfter(null, ids[0], 3);
    tracked.getAndResetUpdates();

    tracked.apply({ type: "insertAfter", before: null, id: { bunchId: "b2", counter: 0 }, count: 1 });
    tracked.apply({ type: "deleteRange", startIndex: 1, endIndex: 1 });
    expect(tracked.getAndResetUpdates()).toEqual([]);
    expect(tracked.idList.has(ids[0])).toBe(false);
    expect(tracked.idList.has({ bunchId: "b2", counter: 0 })).toBe(true);
  });

  it("getAndResetUpdates clears the update list", () => {
    const tracked = emptyTracked();
    tracked.insertAfter(null, { bunchId: "b1", counter: 0 });
    expect(tracked.getAndResetUpdates()).toHaveLength(1);
    expect(tracked.getAndResetUpdates()).toEqual([]);
  });

  it("throws when tracking is not enabled", () => {
    const tracked = new TrackedIdList(IdList.new(), false);
    expect(() => tracked.getAndResetUpdates()).toThrow("trackChanges not enabled");
  });
});

describe("applyClientMutations: concurrent same-anchor edits", () => {
  it("applies two inserts at the same anchor without losing either", () => {
    let state = collabFromMarkdown("ab");
    const anchor = idAtIndex(state, 0);

    const first = applyClientMutations(state, [insertMutation(anchor, { bunchId: "c1", counter: 0 }, "X")]);
    const second = applyClientMutations(first.state, [insertMutation(anchor, { bunchId: "c2", counter: 0 }, "Y")]);

    // The later insert lands immediately after the shared anchor.
    expect(textOf(second.state)).toBe("aYXb");
    expect(second.changed).toBe(true);
    expect(second.state.serverCounter).toBeGreaterThan(state.serverCounter);
  });

  it("resolves an insert racing a delete on the same anchor", () => {
    let state = collabFromMarkdown("abcd");
    const anchor = idAtIndex(state, 1);

    const deleted = applyClientMutations(state, [deleteMutation(idAtIndex(state, 1), idAtIndex(state, 2), 2)]);
    const inserted = applyClientMutations(deleted.state, [insertMutation(anchor, { bunchId: "c1", counter: 0 }, "Z")]);

    // Insert after a tombstoned anchor still lands next to it.
    expect(textOf(inserted.state)).toBe("aZd");
  });

  it("drops a duplicate insert of an already known id", () => {
    let state = collabFromMarkdown("ab");
    const mutation = insertMutation(idAtIndex(state, 0), { bunchId: "c1", counter: 0 }, "X");

    const first = applyClientMutations(state, [mutation]);
    const replay = applyClientMutations(first.state, [mutation]);

    expect(textOf(replay.state)).toBe("aXb");
    expect(replay.changed).toBe(false);
    expect(replay.state.serverCounter).toBe(first.state.serverCounter);
  });

  it("drops an insert whose anchor is unknown", () => {
    const state = collabFromMarkdown("ab");
    const result = applyClientMutations(state, [
      insertMutation({ bunchId: "ghost", counter: 9 }, { bunchId: "c1", counter: 0 }, "X"),
    ]);
    expect(textOf(result.state)).toBe("ab");
    expect(result.changed).toBe(false);
  });

  it("drops an isInWord insert whose anchor was deleted", () => {
    let state = collabFromMarkdown("word");
    const anchor = idAtIndex(state, 2);
    state = applyClientMutations(state, [deleteMutation(anchor)]).state;

    const result = applyClientMutations(state, [insertMutation(anchor, { bunchId: "c1", counter: 0 }, "X", 1, true)]);
    expect(textOf(result.state)).toBe("wod");
    expect(result.changed).toBe(false);
  });

  it("keeps an isInWord insert whose anchor is present", () => {
    const state = collabFromMarkdown("word");
    const result = applyClientMutations(state, [
      insertMutation(idAtIndex(state, 1), { bunchId: "c1", counter: 0 }, "X", 1, true),
    ]);
    expect(textOf(result.state)).toBe("woXrd");
  });

  it("supports a null anchor to prepend", () => {
    const state = collabFromMarkdown("bc");
    const result = applyClientMutations(state, [insertMutation(null, { bunchId: "c1", counter: 0 }, "a")]);
    expect(textOf(result.state)).toBe("abc");
  });

  it("ignores empty insert content", () => {
    const state = collabFromMarkdown("ab");
    const result = applyClientMutations(state, [
      insertMutation(idAtIndex(state, 0), { bunchId: "c1", counter: 0 }, ""),
    ]);
    expect(textOf(result.state)).toBe("ab");
    expect(result.changed).toBe(false);
  });
});

describe("applyClientMutations: deletes", () => {
  it("deletes exactly the given range and keeps tombstones known", () => {
    let state = collabFromMarkdown("abcdef");
    const start = idAtIndex(state, 1);
    const end = idAtIndex(state, 3);

    const result = applyClientMutations(state, [deleteMutation(start, end, 3)]);

    expect(textOf(result.state)).toBe("aef");
    expect(result.state.idList.isKnown(start)).toBe(true);
    expect(result.state.idList.isKnown(end)).toBe(true);
  });

  it("deletes a single char when endId is omitted", () => {
    let state = collabFromMarkdown("abc");
    const result = applyClientMutations(state, [deleteMutation(idAtIndex(state, 1))]);
    expect(textOf(result.state)).toBe("ac");
  });

  it("ignores a delete whose startId is unknown", () => {
    const state = collabFromMarkdown("abc");
    const result = applyClientMutations(state, [
      deleteMutation({ bunchId: "ghost", counter: 0 }, idAtIndex(state, 1), 2),
    ]);
    expect(textOf(result.state)).toBe("abc");
    expect(result.changed).toBe(false);
  });

  it("deletes nothing when endId is unknown", () => {
    const state = collabFromMarkdown("abc");
    const result = applyClientMutations(state, [deleteMutation(idAtIndex(state, 1), { bunchId: "ghost", counter: 0 })]);
    expect(textOf(result.state)).toBe("abc");
    expect(result.changed).toBe(false);
  });

  it("ignores a delete whose range is far larger than contentLength", () => {
    const state = collabFromMarkdown("abcdefghijklmno");
    const result = applyClientMutations(state, [deleteMutation(idAtIndex(state, 0), idAtIndex(state, 12), 1)]);
    expect(textOf(result.state)).toBe("abcdefghijklmno");
  });

  it("only increments serverCounter when something changed", () => {
    const state = collabFromMarkdown("abc");
    const noop = applyClientMutations(state, [deleteMutation({ bunchId: "ghost", counter: 0 })]);
    const change = applyClientMutations(state, [deleteMutation(idAtIndex(state, 0))]);
    expect(noop.state.serverCounter).toBe(state.serverCounter);
    expect(change.state.serverCounter).toBe(state.serverCounter + 1);
  });

  it("ignores mutation kinds other than insert and delete", () => {
    const state = collabFromMarkdown("abc");
    const bogus = {
      name: "rename",
      clientCounter: 1,
      args: {},
    } as unknown as ClientMutation;
    const result = applyClientMutations(state, [bogus]);
    expect(textOf(result.state)).toBe("abc");
    expect(result.changed).toBe(false);
    expect(result.idListUpdates).toEqual([]);
  });
});

describe("markdown round-trip", () => {
  const samples = [
    "",
    "plain text",
    "# heading\n\n- list item\n- another\n",
    "line one\nline two\n",
    "unicode héllo 🎉 wörld",
    "tabs\tand  spaces",
    "code `inline` and **bold**",
  ];

  for (const markdown of samples) {
    it(`round-trips ${JSON.stringify(markdown.slice(0, 24))}`, () => {
      const state = collabFromMarkdown(markdown);
      expect(collabToMarkdown(state)).toBe(markdown);
    });
  }

  it("survives edits between the two directions", () => {
    let state = collabFromMarkdown("hello world");
    state = applyClientMutations(state, [deleteMutation(idAtIndex(state, 5), idAtIndex(state, 10), 6)]).state;
    state = applyClientMutations(state, [
      insertMutation(idAtIndex(state, 4), { bunchId: "c1", counter: 0 }, " there"),
    ]).state;
    expect(collabToMarkdown(state)).toBe("hello there");

    expect(collabToMarkdown(collabFromMarkdown(collabToMarkdown(state)))).toBe("hello there");
  });

  it("starts an empty state with an empty id list", () => {
    const state = newCollabState();
    expect(collabToMarkdown(state)).toBe("");
    expect(state.serverCounter).toBe(0);
  });

  it("derives markdown-only state with sequential ids in one bunch", () => {
    const state = collabFromMarkdown("abc", 7);
    expect(state.serverCounter).toBe(7);
    const ids = Array.from(state.idList.values());
    expect(ids).toHaveLength(3);
    expect(new Set(ids.map((id) => id.bunchId)).size).toBe(1);
  });
});

describe("collab state save/load round-trip", () => {
  function stateWithHistory(): CollabState {
    let state = collabFromMarkdown("the quick brown fox");
    state = applyClientMutations(state, [deleteMutation(idAtIndex(state, 4), idAtIndex(state, 8), 5)]).state;
    state = applyClientMutations(state, [
      insertMutation(idAtIndex(state, 3), { bunchId: "c1", counter: 0 }, "very "),
    ]).state;
    return state;
  }

  it("restores text, ids, and counter", () => {
    const state = stateWithHistory();
    const saved = saveCollabState(state);
    const loaded = loadCollabState(saved);

    expect(collabToMarkdown(loaded)).toBe(collabToMarkdown(state));
    expect(loaded.idList.save()).toEqual(state.idList.save());
    expect(loaded.serverCounter).toBe(state.serverCounter);
  });

  it("keeps tombstones so late duplicate inserts stay dropped", () => {
    let state = collabFromMarkdown("abc");
    const anchor = idAtIndex(state, 1);
    state = applyClientMutations(state, [deleteMutation(anchor)]).state;

    const loaded = loadCollabState(saveCollabState(state));
    const result = applyClientMutations(loaded, [insertMutation(anchor, { bunchId: "c1", counter: 0 }, "X", 1, true)]);
    expect(collabToMarkdown(result.state)).toBe("ac");
    expect(result.changed).toBe(false);
  });

  it("accepts further mutations after loading", () => {
    const loaded = loadCollabState(saveCollabState(stateWithHistory()));
    const before = collabToMarkdown(loaded);
    const result = applyClientMutations(loaded, [
      insertMutation(idBeforeIndex(loaded, 1), { bunchId: "c9", counter: 0 }, "!"),
    ]);
    expect(collabToMarkdown(result.state)).toContain("!");
    expect(result.state.serverCounter).toBe(loaded.serverCounter + 1);
    expect(before.length).toBeGreaterThan(0);
  });
});
