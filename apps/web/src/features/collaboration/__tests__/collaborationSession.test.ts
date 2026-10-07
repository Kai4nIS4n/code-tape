import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeCollaborationFrame, decodeCollaborationFrame } from "@/shared/recording-schema";
import { CollaborationSession } from "../collaborationSession";
import type { CollaborationStore, StoredCollaborationUpdate } from "../collaborationStore";

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
async function fixture(store = memoryStore()) {
  const socket = new Socket();
  const session = new CollaborationSession({ userId: "alice", displayName: "Alice", roomId: "room", epoch: 1, store, request: async () => new Response(JSON.stringify({ ticket: "t", epoch: 1 })), createSocket: () => socket as unknown as WebSocket });
  await session.start();
  socket.receive(JSON.stringify({ type: "hello", roomId: "room", epoch: 1, persistedRevision: 0 }));
  await session.whenLocallySaved();
  return { session, socket, store };
}
function binary(data: Uint8Array): ArrayBuffer { return Uint8Array.from(data).buffer; }

describe("durable collaboration provider", () => {
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
