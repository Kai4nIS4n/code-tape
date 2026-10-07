import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createCollaborationStore } from "../collaborationStore";

describe("collaboration local durability", () => {
  it("commits update + outbox together, retains received updates and clears only acknowledged delivery", async () => {
    const room = crypto.randomUUID();
    const store = createCollaborationStore("alice", room, 1);
    await store.append(Uint8Array.from([1]), { updateId: "local", data: Uint8Array.from([1]) });
    await store.append(Uint8Array.from([2]));
    expect((await store.load()).updates).toEqual([Uint8Array.from([1]), Uint8Array.from([2])]);
    expect((await store.load()).outbox).toHaveLength(1);
    await store.acknowledge("local");
    expect((await store.load()).outbox).toHaveLength(0);
    expect((await store.load()).updates).toHaveLength(2);
    store.close();
  });
  it("partitions account, room and document epoch, without claiming another account's draft", async () => {
    const room = crypto.randomUUID();
    const alice = createCollaborationStore("alice", room, 1);
    const bob = createCollaborationStore("bob", room, 1);
    const nextEpoch = createCollaborationStore("alice", room, 2);
    await alice.append(Uint8Array.from([1]), { updateId: "pending", data: Uint8Array.from([1]) });
    expect((await bob.load()).updates).toEqual([]);
    expect((await nextEpoch.load()).outbox).toEqual([]);
    expect((await alice.load()).outbox).toHaveLength(1);
    alice.close(); bob.close(); nextEpoch.close();
  });
});
