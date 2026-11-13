import type { ClientMutation, ElementId, IdListUpdate, PresenceSelection, SavedIdList } from "../shared/protocol";

function cloneId(id: ElementId | null): ElementId | null {
  return id ? { bunchId: id.bunchId, counter: id.counter } : null;
}

function idsEqual(a: ElementId | null, b: ElementId | null) {
  return !!a && !!b && a.bunchId === b.bunchId && a.counter === b.counter;
}

export class SimpleIdList {
  constructor(entries = []) {
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    this.entries = entries;
    // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    this.length = 0;
    for (const entry of entries) {
      if (!entry.isDeleted) {
        // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
        // @ts-expect-error
        this.length++;
      }
    }
  }

  static load(savedState: SavedIdList) {
    const entries = [];
    for (const item of savedState || []) {
      for (let offset = 0; offset < item.count; offset++) {
        entries.push({
          id: { bunchId: item.bunchId, counter: item.startCounter + offset },
          isDeleted: Boolean(item.isDeleted),
        });
      }
    }
    return new SimpleIdList(entries);
  }

  clone() {
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    return new SimpleIdList(this.entries.map((entry) => ({ id: cloneId(entry.id), isDeleted: entry.isDeleted })));
  }

  findKnownIndex(id: ElementId) {
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    for (let index = 0; index < this.entries.length; index++) {
      // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
      // @ts-expect-error
      const entry = this.entries[index];
      if (idsEqual(entry.id, id)) {
        return index;
      }
    }
    return -1;
  }

  has(id: ElementId) {
    const knownIndex = this.findKnownIndex(id);
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    return knownIndex !== -1 && !this.entries[knownIndex].isDeleted;
  }

  isKnown(id: ElementId) {
    return this.findKnownIndex(id) !== -1;
  }

  at(index) {
    // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`Index out of bounds: ${index}`);
    }
    let visibleIndex = 0;
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    for (const entry of this.entries) {
      if (entry.isDeleted) {
        continue;
      }
      if (visibleIndex === index) {
        return cloneId(entry.id);
      }
      visibleIndex++;
    }
    throw new Error(`Index out of bounds: ${index}`);
  }

  indexOf(id: ElementId, bias = "none") {
    const knownIndex = this.findKnownIndex(id);
    if (knownIndex === -1) {
      throw new Error("id is not known");
    }

    let visibleBefore = 0;
    for (let index = 0; index < knownIndex; index++) {
      // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
      // @ts-expect-error
      if (!this.entries[index].isDeleted) {
        visibleBefore++;
      }
    }

    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    if (!this.entries[knownIndex].isDeleted) {
      return visibleBefore;
    }

    if (bias === "left") {
      return visibleBefore - 1;
    }
    if (bias === "right") {
      return visibleBefore;
    }
    return -1;
  }

  cursorAt(index: number, bind = "left"): ElementId | null {
    // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      throw new Error(`Cursor index out of bounds: ${index}`);
    }
    if (bind === "left") {
      return index === 0 ? null : this.at(index - 1);
    }
    // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    return index === this.length ? null : this.at(index);
  }

  cursorIndex(cursor: ElementId | null, bind = "left") {
    if (bind === "left") {
      return cursor === null ? 0 : this.indexOf(cursor, "left") + 1;
    }
    // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    return cursor === null ? this.length : this.indexOf(cursor, "right");
  }

  maxCounter(bunchId) {
    let max;
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    for (const entry of this.entries) {
      if (entry.id.bunchId === bunchId) {
        if (max === undefined || entry.id.counter > max) {
          max = entry.id.counter;
        }
      }
    }
    return max;
  }

  insertAfter(before: ElementId | null, startId: ElementId, count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid count: ${count}`);
    }
    if (count === 0) {
      return;
    }

    let insertAt = 0;
    if (before !== null) {
      const knownIndex = this.findKnownIndex(before);
      if (knownIndex === -1) {
        throw new Error("before is not known");
      }
      insertAt = knownIndex + 1;
    }

    const inserted = [];
    for (let offset = 0; offset < count; offset++) {
      inserted.push({
        id: { bunchId: startId.bunchId, counter: startId.counter + offset },
        isDeleted: false,
      });
    }
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    this.entries.splice(insertAt, 0, ...inserted);
    // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    this.length += count;
  }

  deleteRange(startIndex, endIndex) {
    if (endIndex < startIndex) {
      return;
    }
    const knownIndexes = [];
    let visibleIndex = 0;
    // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
    // @ts-expect-error
    for (let index = 0; index < this.entries.length; index++) {
      // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
      // @ts-expect-error
      const entry = this.entries[index];
      if (entry.isDeleted) {
        continue;
      }
      if (visibleIndex >= startIndex && visibleIndex <= endIndex) {
        knownIndexes.push(index);
      }
      visibleIndex++;
      if (visibleIndex > endIndex) {
        break;
      }
    }

    for (const knownIndex of knownIndexes) {
      // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
      // @ts-expect-error
      if (!this.entries[knownIndex].isDeleted) {
        // TODO(ts): TS2339 Property 'entries' does not exist on type 'SimpleIdList'.
        // @ts-expect-error
        this.entries[knownIndex] = { ...this.entries[knownIndex], isDeleted: true };
        // TODO(ts): TS2339 Property 'length' does not exist on type 'SimpleIdList'.
        // @ts-expect-error
        this.length--;
      }
    }
  }
}

export class TrackedIdList {
  constructor(idList, trackChanges) {
    // TODO(ts): TS2551 Property '_idList' does not exist on type 'TrackedIdList'. Did you mean 'idList'?
    // @ts-expect-error
    this._idList = idList;
    // TODO(ts): TS2339 Property 'trackChanges' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    this.trackChanges = trackChanges;
    // TODO(ts): TS2339 Property 'updates' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    this.updates = [];
  }

  get idList() {
    // TODO(ts): TS2551 Property '_idList' does not exist on type 'TrackedIdList'. Did you mean 'idList'?
    // @ts-expect-error
    return this._idList;
  }

  getAndResetUpdates() {
    // TODO(ts): TS2339 Property 'trackChanges' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    if (!this.trackChanges) {
      throw new Error("trackChanges not enabled");
    }
    // TODO(ts): TS2339 Property 'updates' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    const updates = this.updates;
    // TODO(ts): TS2339 Property 'updates' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    this.updates = [];
    return updates;
  }

  insertAfter(before: ElementId | null, id: ElementId, count = 1) {
    // TODO(ts): TS2551 Property '_idList' does not exist on type 'TrackedIdList'. Did you mean 'idList'?
    // @ts-expect-error
    this._idList.insertAfter(before, id, count);
    // TODO(ts): TS2339 Property 'trackChanges' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    if (this.trackChanges) {
      // TODO(ts): TS2339 Property 'updates' does not exist on type 'TrackedIdList'.
      // @ts-expect-error
      this.updates.push({ type: "insertAfter", before: cloneId(before), id: cloneId(id), count });
    }
  }

  deleteRange(startIndex, endIndex) {
    // TODO(ts): TS2551 Property '_idList' does not exist on type 'TrackedIdList'. Did you mean 'idList'?
    // @ts-expect-error
    this._idList.deleteRange(startIndex, endIndex);
    // TODO(ts): TS2339 Property 'trackChanges' does not exist on type 'TrackedIdList'.
    // @ts-expect-error
    if (this.trackChanges) {
      // TODO(ts): TS2339 Property 'updates' does not exist on type 'TrackedIdList'.
      // @ts-expect-error
      this.updates.push({ type: "deleteRange", startIndex, endIndex });
    }
  }

  apply(update: IdListUpdate) {
    switch (update.type) {
      case "insertAfter":
        // TODO(ts): TS2551 Property '_idList' does not exist on type 'TrackedIdList'. Did you mean 'idList'?
        // @ts-expect-error
        this._idList.insertAfter(update.before, update.id, update.count);
        return;
      case "deleteRange":
        // TODO(ts): TS2551 Property '_idList' does not exist on type 'TrackedIdList'. Did you mean 'idList'?
        // @ts-expect-error
        this._idList.deleteRange(update.startIndex, update.endIndex);
        return;
    }
  }
}

export class ElementIdGenerator {
  constructor(newBunchId) {
    // TODO(ts): TS2339 Property 'newBunchId' does not exist on type 'ElementIdGenerator'.
    // @ts-expect-error
    this.newBunchId = newBunchId;
    // TODO(ts): TS2339 Property 'nextCounterMap' does not exist on type 'ElementIdGenerator'.
    // @ts-expect-error
    this.nextCounterMap = new Map();
  }

  generateAfter(beforeId, count = 1) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid count: ${count}`);
    }

    if (beforeId) {
      // TODO(ts): TS2339 Property 'nextCounterMap' does not exist on type 'ElementIdGenerator'.
      // @ts-expect-error
      const nextCounter = this.nextCounterMap.get(beforeId.bunchId) || 0;
      if (beforeId.counter + 1 >= nextCounter) {
        const counter = beforeId.counter + 1;
        // TODO(ts): TS2339 Property 'nextCounterMap' does not exist on type 'ElementIdGenerator'.
        // @ts-expect-error
        this.nextCounterMap.set(beforeId.bunchId, counter + count);
        return { bunchId: beforeId.bunchId, counter };
      }
    }

    // TODO(ts): TS2339 Property 'newBunchId' does not exist on type 'ElementIdGenerator'.
    // @ts-expect-error
    const bunchId = this.newBunchId();
    // TODO(ts): TS2339 Property 'nextCounterMap' does not exist on type 'ElementIdGenerator'.
    // @ts-expect-error
    this.nextCounterMap.set(bunchId, count);
    return { bunchId, counter: 0 };
  }
}

export function applyClientMutation(state, mutation: ClientMutation) {
  const trackedIds = new TrackedIdList(state.idList.clone(), false);

  if (mutation.name === "insert") {
    const { before, id, content, isInWord } = mutation.args;
    if (!content) {
      return state;
    }
    if (before !== null && !trackedIds.idList.isKnown(before)) {
      return state;
    }
    if (trackedIds.idList.isKnown(id)) {
      return state;
    }
    if (isInWord && before !== null && !trackedIds.idList.has(before)) {
      return state;
    }

    trackedIds.insertAfter(before, id, content.length);
    const insertIndex = before === null ? 0 : trackedIds.idList.indexOf(id);
    return {
      text: state.text.slice(0, insertIndex) + content + state.text.slice(insertIndex),
      idList: trackedIds.idList,
    };
  }

  const { startId, endId, contentLength } = mutation.args;
  if (!trackedIds.idList.isKnown(startId)) {
    return state;
  }

  const startIndex = trackedIds.idList.indexOf(startId, "right");
  const endIndex =
    endId === undefined
      ? startIndex
      : trackedIds.idList.isKnown(endId)
        ? trackedIds.idList.indexOf(endId, "left")
        : startIndex - 1;

  if (endIndex < startIndex) {
    return state;
  }

  const currentLength = endIndex - startIndex + 1;
  if (contentLength !== undefined && currentLength > contentLength + 10) {
    return state;
  }

  trackedIds.deleteRange(startIndex, endIndex);
  return {
    text: state.text.slice(0, startIndex) + state.text.slice(endIndex + 1),
    idList: trackedIds.idList,
  };
}

export function applyIdListUpdates(idList, updates: IdListUpdate[]) {
  const trackedIds = new TrackedIdList(idList.clone(), false);
  for (const update of updates) {
    trackedIds.apply(update);
  }
  return trackedIds.idList;
}

export function selectionToIds(idList, start: number, end: number, direction = "forward"): PresenceSelection {
  if (start === end) {
    return {
      type: "cursor",
      cursor: idList.cursorAt(start, "left"),
    };
  }

  return {
    type: "range",
    start: idList.cursorAt(start, "right"),
    end: idList.cursorAt(end, "left"),
    direction: direction === "backward" ? "backward" : "forward",
  };
}

export function selectionFromIds(selection: PresenceSelection, idList) {
  try {
    if (selection.type === "cursor") {
      const index = idList.cursorIndex(selection.cursor, "left");
      return { start: index, end: index, direction: "none" };
    }

    const start = idList.cursorIndex(selection.start, "right");
    const end = idList.cursorIndex(selection.end, "left");
    if (selection.direction === "backward") {
      return { start, end, direction: "backward" };
    }
    return { start, end, direction: "forward" };
  } catch {
    return { start: 0, end: 0, direction: "none" };
  }
}
