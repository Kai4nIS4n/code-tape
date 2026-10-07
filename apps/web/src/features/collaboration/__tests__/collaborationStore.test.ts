import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createCollaborationStore, listCollaborationDraftEpochs } from "../collaborationStore";
import { exportStoredCollaborationDraft } from "../collaborationDrafts";
import * as Y from "yjs";

describe("collaboration local durability", () => {
  it("discovers and exports an old epoch after reload without reclaiming another account's data", async () => {
    const room = crypto.randomUUID(); const old = createCollaborationStore("alice", room, 1); const next = createCollaborationStore("alice", room, 2); const bob = createCollaborationStore("bob", room, 9);
    const oldDoc = new Y.Doc(); oldDoc.getText("source:html").insert(0, "my preserved draft");
    await old.append(Y.encodeStateAsUpdate(oldDoc)); await next.append(Uint8Array.from([0, 0])); await bob.append(Uint8Array.from([0, 0]));
    old.close(); next.close(); bob.close(); oldDoc.destroy();
    expect(await listCollaborationDraftEpochs("alice", room)).toEqual([2, 1]);
    expect(await listCollaborationDraftEpochs("bob", room)).toEqual([9]);
    const exported = await exportStoredCollaborationDraft("alice", room, 1);
    const data = JSON.parse(new TextDecoder().decode(await exported.arrayBuffer())) as { epoch: number; documents: { html: string } };
    expect(data.epoch).toBe(1); expect(data.documents.html).toBe("my preserved draft");
  });
  it("commits update + outbox together, retains received updates and clears only acknowledged delivery", async () => {
    const room = crypto.randomUUID();
    const store = createCollaborationStore("alice", room, 1);
    await store.append(Uint8Array.from([1]), { updateId: "local", data: Uint8Array.from([1]) });
    await store.append(Uint8Array.from([2]));
    expect((await store.load()).updates.map((data) => Array.from(data))).toEqual([[1], [2]]);
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
