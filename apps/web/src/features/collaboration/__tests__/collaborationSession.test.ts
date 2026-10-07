import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { encodeCollaborationFrame, decodeCollaborationFrame } from "@/shared/recording-schema";
import { CollaborationSession } from "../collaborationSession";
import type { CollaborationStore, StoredCollaborationUpdate } from "../collaborationStore";
import type { DebugLogOptions, DebugLogRecord } from "@/shared/debugLog";

class Socket {
  readyState = 1;
  binaryType = "arraybuffer";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Uint8Array[] = [];
  send(data: Uint8Array) { this.sent.push(data); }
  close() { this.readyState = 3; }
  receive(data: unknown) { this.onmessage?.({ data }); }
}
function memoryStore(): CollaborationStore & { updates: Uint8Array[]; outbox: Map<string, StoredCollaborationUpdate> } {
  const updates: Uint8Array[] = [];
  const outbox = new Map<string, StoredCollaborationUpdate>();
  return { updates, outbox, async load() { return { updates, outbox: Array.from(outbox.values()) }; }, async append(data, outbound) { updates.push(data); if (outbound) outbox.set(outbound.updateId, outbound); }, async acknowledge(id) { outbox.delete(id); }, close() {} };
}
async function fixture(store = memoryStore(), debug?: DebugLogOptions) {
  const socket = new Socket();
  const session = new CollaborationSession({ userId: "alice", displayName: "Alice", roomId: "room", epoch: 1, store, debug, request: async () => new Response(JSON.stringify({ ticket: "t", epoch: 1 })), createSocket: () => socket as unknown as WebSocket });
  await session.start();
  socket.receive(JSON.stringify({ type: "hello", roomId: "room", epoch: 1, persistedRevision: 0 }));
  await session.whenLocallySaved();
  return { session, socket, store };
}
function binary(data: Uint8Array): ArrayBuffer { return Uint8Array.from(data).buffer; }

describe("durable collaboration provider", () => {
  it("keeps committed log/outbox and reports local-saved rather than storage-error when send throws", async () => {
    const logs: DebugLogRecord[] = [];
    const { session, socket, store } = await fixture(memoryStore(), { enabled: true, sink: (record) => logs.push(record) });
    logs.length = 0;
    socket.send = () => { throw new Error("connection closed during send"); };
    session.getText("html").insert(0, "private-source");
    await session.whenLocallySaved();
    expect(store.updates.length).toBe(1); expect(store.outbox.size).toBe(1);
    expect(session.getSnapshot().status).toBe("local-saved");
    expect(logs.map((record) => record.event)).toEqual(["collab-generated", "collab-local-persisted", "collab-send-attempt", "collab-send-failed"]);
    expect(JSON.stringify(logs)).not.toContain("private-source");
    session.destroy();
  });

  it("distinguishes invalid protocol input from a failed local transaction", async () => {
    const { session, socket } = await fixture();
    socket.receive("not-json"); await session.whenLocallySaved();
    expect(session.getSnapshot().status).toBe("protocol-error");
    expect(socket.readyState).toBe(3);
    session.destroy();
  });

  it("emits durable-ACK stage only for a received receipt and preserves safe correlation metadata", async () => {
    const logs: DebugLogRecord[] = [];
    const { session, socket } = await fixture(memoryStore(), { enabled: true, sink: (record) => logs.push(record) });
    session.getText("javascript").insert(0, "secret-code"); await session.whenLocallySaved();
    expect(logs.some((record) => record.event === "collab-durable-ack")).toBe(false);
    const update = socket.sent.map(decodeCollaborationFrame).find((frame) => frame.type === "update");
    if (update?.type !== "update") throw new Error("Update not sent");
    socket.receive(JSON.stringify({ type: "ack", updateId: update.updateId, persistedRevision: 9 })); await session.whenLocallySaved();
    expect(logs.find((record) => record.event === "collab-durable-ack" && record.outcome === "applied")).toMatchObject({ roomId: "room", epoch: 1, updateId: update.updateId, persistedRevision: 9, pendingUpdateCount: 0 });
    expect(JSON.stringify(logs)).not.toContain("secret-code");
    session.destroy();
  });

  it("does not impersonate a peer when local awareness expiry removes its presence", async () => {
    const { session, socket } = await fixture(); const peerDoc = new Y.Doc(); const peer = new Awareness(peerDoc);
    peer.setLocalState({ user: { name: "Peer", role: "interviewer" } });
    socket.receive(binary(encodeCollaborationFrame({ type: "awareness", data: encodeAwarenessUpdate(peer, [peerDoc.clientID]) })));
    await session.whenLocallySaved(); const count = socket.sent.length;
    removeAwarenessStates(session.awareness, [peerDoc.clientID], "timeout");
    expect(socket.sent).toHaveLength(count);
    session.destroy(); peer.destroy(); peerDoc.destroy();
  });
  it("converges concurrent edits and restores both authors from the persisted local log", async () => {
    const first = await fixture(); const second = await fixture(); const server = new Y.Doc();
    server.getText("source:javascript").insert(0, "const n = 1;\n");
    for (const client of [first, second]) {
      client.socket.receive(binary(encodeCollaborationFrame({ type: "sync", epoch: 1, persistedRevision: 1, data: Y.encodeStateAsUpdate(server) })));
      await client.session.whenLocallySaved();
    }
    first.session.getText("javascript").insert(0, "// A\n");
    second.session.getText("javascript").insert(second.session.getText("javascript").length, "// B\n");
    await Promise.all([first.session.whenLocallySaved(), second.session.whenLocallySaved()]);
    for (const client of [second, first]) {
      for (const frame of client.socket.sent.map(decodeCollaborationFrame)) if (frame.type === "update") Y.applyUpdate(server, frame.data);
    }
    for (const client of [first, second]) {
      client.socket.receive(binary(encodeCollaborationFrame({ type: "sync", epoch: 1, persistedRevision: 3, data: Y.encodeStateAsUpdate(server, Y.encodeStateVector(client.session.doc)) })));
      for (const frame of client.socket.sent.map(decodeCollaborationFrame)) if (frame.type === "update") client.socket.receive(JSON.stringify({ type: "ack", updateId: frame.updateId, persistedRevision: 3 }));
      await client.session.whenLocallySaved();
      expect(client.session.getText("javascript").toString()).toBe(server.getText("source:javascript").toString());
      expect(client.session.getSnapshot().status).toBe("server-saved");
      const restored = new Y.Doc(); client.store.updates.forEach((update) => Y.applyUpdate(restored, update));
      expect(restored.getText("source:javascript").toString()).toBe(server.getText("source:javascript").toString());
      restored.destroy(); client.session.destroy();
    }
    expect(server.getText("source:javascript").toString()).toContain("// A");
    expect(server.getText("source:javascript").toString()).toContain("// B");
    server.destroy();
  });

  it("does not send or report local durability when the IndexedDB transaction fails", async () => {
    const { session, socket, store } = await fixture();
    store.append = async () => { throw new Error("quota exceeded"); };
    session.getText("html").insert(0, "unsaved draft");
    await session.whenLocallySaved();
    expect(socket.sent.map(decodeCollaborationFrame).some((frame) => frame.type === "update")).toBe(false);
    expect(session.getSnapshot().status).toBe("storage-error");
    expect(session.getSnapshot().error).toBe("quota exceeded");
    expect(session.getText("html").toString()).toBe("unsaved draft");
    session.destroy();
  });

  it("receives and persists remote dependencies without outbox, and never treats socket.send as durable ACK", async () => {
    const { session, socket, store } = await fixture();
    const server = new Y.Doc(); server.getText("source:html").insert(0, "remote");
    socket.receive(binary(encodeCollaborationFrame({ type: "sync", epoch: 1, persistedRevision: 1, data: Y.encodeStateAsUpdate(server) })));
    await session.whenLocallySaved();
    expect(session.getText("html").toString()).toBe("remote");
    expect(store.outbox.size).toBe(0);
    session.getText("html").insert(6, " local");
    await session.whenLocallySaved();
    expect(session.getSnapshot().status).toBe("local-saved");
    const sent = socket.sent.map(decodeCollaborationFrame).find((frame) => frame.type === "update");
    expect(sent?.type).toBe("update");
    if (sent?.type !== "update") throw new Error("No update");
    socket.receive(JSON.stringify({ type: "ack", updateId: sent.updateId, persistedRevision: 2 }));
    await session.whenLocallySaved();
    expect(session.getSnapshot().status).toBe("server-saved");
    expect(store.outbox.size).toBe(0);
    const restored = new Y.Doc(); store.updates.forEach((update) => Y.applyUpdate(restored, update));
    expect(restored.getText("source:html").toString()).toBe("remote local");
    session.destroy(); server.destroy(); restored.destroy();
  });
  it("sends delete sets through the durable write path even when state vectors match", async () => {
    const { session, socket, store } = await fixture();
    const server = new Y.Doc(); server.getText("source:javascript").insert(0, "abc");
    socket.receive(binary(encodeCollaborationFrame({ type: "sync", epoch: 1, persistedRevision: 1, data: Y.encodeStateAsUpdate(server) })));
    await session.whenLocallySaved();
    session.getText("javascript").delete(1, 1);
    await session.whenLocallySaved();
    socket.receive(binary(encodeCollaborationFrame({ type: "state-vector", data: Y.encodeStateVector(server) })));
    await session.whenLocallySaved();
    const updates = socket.sent.map(decodeCollaborationFrame).filter((frame) => frame.type === "update");
    expect(updates.length).toBeGreaterThan(0);
    for (const frame of updates) if (frame.type === "update") Y.applyUpdate(server, frame.data);
    expect(server.getText("source:javascript").toString()).toBe("ac");
    expect(store.outbox.size).toBeGreaterThan(0);
    session.destroy(); server.destroy();
  });
  it("epoch invalidation blocks stale writes and preserves a draft for export", async () => {
    const { session, socket, store } = await fixture();
    session.getText("css").insert(0, "body { color: red }");
    await session.whenLocallySaved();
    session.invalidate("epoch changed");
    const sent = socket.sent.length;
    session.getText("css").insert(0, "/* draft */");
    await session.whenLocallySaved();
    expect(socket.sent).toHaveLength(sent);
    expect(session.getSnapshot().status).toBe("revoked");
    expect(store.outbox.size).toBeGreaterThan(0);
    expect(session.exportDraft().size).toBeGreaterThan(0);
    session.destroy();
  });
});
