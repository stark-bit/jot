// Convergence harness: N fake clients throw random insert/delete mutations at
// one authoritative CollabState (as the real server does via
// applyClientMutations). Checks, for every seed:
//   - no character is dropped, duplicated, or reordered;
//   - each client's typed runs survive in order unless explicitly deleted;
//   - retransmitted messages are filtered by the ack bookkeeping the real
//     server keeps (clientCounter > lastAcknowledgedCounter);
//   - after a simulated server restart (state restored from disk, acks lost)
//     a full replay of the insert history changes nothing: engine-level
//     dedup of already-known insert ids is the last line of defense.
//
// Override the collab module with JOT_COLLAB_MODULE to prove the harness
// fails when a reconciliation guard is removed.
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ClientMutation, CollabState, ElementId } from "../../src/collab";

const here = path.dirname(fileURLToPath(import.meta.url));
const collabModule = process.env.JOT_COLLAB_MODULE || path.join(here, "../../src/collab");
const collab = await import(path.resolve(collabModule));

const {
  applyClientMutations,
  collabFromMarkdown,
  collabToMarkdown,
  loadCollabState,
  saveCollabState,
} = collab as typeof import("../../src/collab");

type Args = {
  seeds: number;
  ops: number;
  clients: number;
};

function parseArgs(): Args {
  const args = { seeds: 1000, ops: 40, clients: 4 };
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(seeds|ops|clients)=(\d+)$/);
    if (match) {
      args[match[1] as keyof Args] = Number(match[2]);
    }
  }
  return args;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "abcdefghij0123456789 ";

function randomText(rand: () => number, maxLength: number) {
  const length = Math.floor(rand() * (maxLength + 1));
  let text = "";
  for (let i = 0; i < length; i++) {
    text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return text;
}

type SentMessage = {
  clientId: string;
  // Counters as the real client sends them: increasing, one per mutation.
  counters: number[];
  mutations: ClientMutation[];
};

function keyOf(id: ElementId) {
  return `${id.bunchId}:${id.counter}`;
}

function runSeed(seed: number, args: Args) {
  const rand = mulberry32(seed);
  const initial = randomText(rand, 30);

  let state: CollabState = collabFromMarkdown(initial);
  const messages: SentMessage[] = [];
  const acks = new Map<string, number>();

  const initialIds = Array.from(state.idList.values(), keyOf);
  const insertedIds = new Set<string>();
  const deletedIds = new Set<string>();
  // The character that was placed at each element id.
  const charById = new Map<string, string>();
  // Per client: runs of ordered element ids with the chars typed into them.
  const runsByClient = new Map<string, string[][]>();
  initialIds.forEach((id, index) => charById.set(id, initial[index]));

  function presentIds(): Set<string> {
    return new Set(Array.from(state.idList.values(), keyOf));
  }

  // Fake server: applies fresh mutations in arrival order, like the real one.
  function serverReceive(message: SentMessage) {
    const lastAck = acks.get(message.clientId) || 0;
    const fresh = message.mutations.filter((m) => m.clientCounter > lastAck);
    acks.set(message.clientId, message.counters.at(-1)!);
    if (fresh.length === 0) {
      return;
    }

    const before = presentIds();
    const result = applyClientMutations(state, fresh);
    if (!result.changed) {
      return;
    }
    state = result.state;
    const after = presentIds();
    for (const id of before) {
      if (!after.has(id)) {
        deletedIds.add(id);
      }
    }

    const insert = fresh.find((m) => m.name === "insert");
    if (insert && insert.name === "insert") {
      const ids: string[] = [];
      const content = insert.args.content;
      for (let offset = 0; offset < content.length; offset++) {
        const id = keyOf({ bunchId: insert.args.id.bunchId, counter: insert.args.id.counter + offset });
        ids.push(id);
      }
      if (after.has(ids[0])) {
        for (let offset = 0; offset < ids.length; offset++) {
          insertedIds.add(ids[offset]);
          charById.set(ids[offset], content[offset]);
        }
        const runs = runsByClient.get(message.clientId) || [];
        runs.push(ids);
        runsByClient.set(message.clientId, runs);
      }
    }

    if (collabToMarkdown(state).length !== after.size) {
      throw new Error(`seed ${seed} op: text length does not match present element count`);
    }
  }

  const nextCounter = new Map<string, number>();
  for (let op = 0; op < args.ops; op++) {
    const clientId = `c${Math.floor(rand() * args.clients)}`;
    const present = Array.from(state.idList.values());
    const counters: number[] = [];
    const mutations: ClientMutation[] = [];

    function pushMutation(mutation: Omit<ClientMutation, "clientCounter">) {
      const clientCounter = (nextCounter.get(clientId) || 0) + 1;
      nextCounter.set(clientId, clientCounter);
      counters.push(clientCounter);
      mutations.push({ ...mutation, clientCounter } as ClientMutation);
    }

    if (present.length === 0 || rand() < 0.6) {
      const index = Math.floor(rand() * (present.length + 1));
      const before = index === 0 ? null : present[index - 1];
      const content = randomText(rand, 4).replace(/ /g, "x") || "x";
      pushMutation({
        name: "insert",
        args: { before, id: { bunchId: `${clientId}:m${op}`, counter: 0 }, content, isInWord: rand() < 0.5 },
      });
    } else {
      const start = Math.floor(rand() * present.length);
      const maxLength = Math.min(6, present.length - start);
      const length = 1 + Math.floor(rand() * maxLength);
      pushMutation({
        name: "delete",
        args: {
          startId: present[start],
          endId: length > 1 ? present[start + length - 1] : undefined,
          contentLength: length,
        },
      });
    }

    const message: SentMessage = { clientId, counters, mutations };
    serverReceive(message);
    messages.push(message);

    // Occasional network duplicate: the server ack filter must swallow it.
    if (rand() < 0.25) {
      const beforeText = collabToMarkdown(state);
      serverReceive(message);
      if (collabToMarkdown(state) !== beforeText) {
        throw new Error(`seed ${seed} op ${op}: retransmitted message changed the text`);
      }
    }
  }

  function verifyInvariants(label: string) {
    const finalText = collabToMarkdown(state);
    const finalIds = Array.from(state.idList.values(), keyOf);
    const finalSet = new Set(finalIds);
    const expectedPresent = new Set<string>([...initialIds, ...insertedIds]);
    for (const id of deletedIds) expectedPresent.delete(id);

    if (finalSet.size !== finalIds.length) {
      throw new Error(`seed ${seed} ${label}: duplicate element ids in final list`);
    }
    for (const id of finalSet) {
      if (!expectedPresent.has(id)) {
        throw new Error(`seed ${seed} ${label}: unexpected element present: ${id}`);
      }
    }
    for (const id of expectedPresent) {
      if (!finalSet.has(id)) {
        throw new Error(`seed ${seed} ${label}: character was dropped: ${id}`);
      }
    }

    // Rebuild text from tracked chars; it must match the state's own text.
    let rebuilt = "";
    for (const id of finalIds) {
      const ch = charById.get(id);
      if (ch === undefined) {
        throw new Error(`seed ${seed} ${label}: present element has no tracked char: ${id}`);
      }
      rebuilt += ch;
    }
    if (rebuilt !== finalText) {
      throw new Error(
        `seed ${seed} ${label}: text does not match tracked characters\n` +
        `expected: ${JSON.stringify(rebuilt)}\nactual:   ${JSON.stringify(finalText)}`,
      );
    }

    // Surviving characters of each typed run must keep their order.
    const positions = new Map<string, number>();
    finalIds.forEach((id, index) => positions.set(id, index));
    for (const [clientId, runs] of runsByClient) {
      for (const run of runs) {
        let lastPosition = -1;
        for (const id of run) {
          if (deletedIds.has(id)) continue;
          const position = positions.get(id);
          if (position === undefined) {
            throw new Error(`seed ${seed} ${label}: surviving char of ${clientId} missing: ${id}`);
          }
          if (position <= lastPosition) {
            throw new Error(`seed ${seed} ${label}: ${clientId} chars reordered in final text`);
          }
          lastPosition = position;
        }
      }
    }
    return finalText;
  }

  const liveText = verifyInvariants("live");

  // Restart phase: the server reloads its state from disk and loses its ack
  // bookkeeping. Clients replay their insert history; engine-level dedup of
  // already-known ids must keep the text byte-identical. (Delete replay is
  // deliberately not modeled: deletes have no engine-level dedup, their
  // protection lives entirely in the server's ack layer.)
  let replayed: CollabState = loadCollabState(saveCollabState(state));
  const inserts = messages
    .map((message) => message.mutations.filter((m) => m.name === "insert"))
    .flat();
  for (let round = 0; round < 2; round++) {
    for (const mutation of inserts) {
      replayed = applyClientMutations(replayed, [mutation]).state;
    }
    const replayText = collabToMarkdown(replayed);
    if (replayText !== liveText) {
      throw new Error(
        `seed ${seed} insert replay round ${round}: text changed\n` +
        `before: ${JSON.stringify(liveText)}\nafter:  ${JSON.stringify(replayText)}`,
      );
    }
  }
}

function main() {
  const args = parseArgs();
  const startedAt = Date.now();
  let failures = 0;
  let ran = 0;

  for (let seed = 0; seed < args.seeds; seed++) {
    ran++;
    try {
      runSeed(seed, args);
    } catch (error) {
      failures++;
      console.error(String(error instanceof Error ? error.stack || error.message : error));
      if (failures >= 5) {
        console.error("stopping after 5 failing seeds");
        break;
      }
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (failures > 0) {
    console.error(`convergence harness FAILED: ${failures} corrupt seeds out of ${ran} (${seconds}s)`);
    process.exit(1);
  }
  console.log(`convergence harness OK: ${ran} seeds, ${args.ops} ops, ${args.clients} clients, zero corruption (${seconds}s)`);
}

main();
