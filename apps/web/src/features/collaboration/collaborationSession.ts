import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { decodeCollaborationFrame, encodeCollaborationFrame, RECORDING_LANGUAGES, recordingDocumentId } from "@/shared/recording-schema";
import type { RecordingLanguage } from "@/shared/recording-schema";
import { createCollaborationStore, type CollaborationStore, type StoredCollaborationUpdate } from "./collaborationStore";

export const REMOTE_COLLABORATION_ORIGIN = Symbol("remote-collaboration");
const RESTORE_ORIGIN = Symbol("restore-collaboration");
export type CollaborationStatus = "loading" | "unsaved" | "local-saved" | "connecting" | "syncing" | "server-saved" | "revoked" | "storage-error";
export type CollaborationState = { status: CollaborationStatus; pendingUpdates: number; persistedRevision: number; ready: boolean; error: string | null; peers: Array<{ id: string; name: string; documentId: string | null; local: boolean }> };
export type CollaborationSessionOptions = {
  userId: string;
  displayName: string;
  roomId: string;
  epoch: number;
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  store?: CollaborationStore;
  createSocket?: (url: string) => WebSocket;
};

export class CollaborationSession {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly roomId: string;
  readonly epoch: number;
  private readonly options: CollaborationSessionOptions;
  private readonly store: CollaborationStore;
  private socket: WebSocket | null = null;
  private state: CollaborationState = { status: "loading", pendingUpdates: 0, persistedRevision: 0, ready: false, error: null, peers: [] };
  private readonly listeners = new Set<() => void>();
  private readonly outbox = new Map<string, StoredCollaborationUpdate>();
  private queue = Promise.resolve();
  private localWrites = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private blocked = false;
  private receivedSync = false;
  private authenticated = false;
  private readonly updateListener = (data: Uint8Array, origin: unknown) => {
    if (origin === RESTORE_ORIGIN || this.closed) return;
    const local = origin !== REMOTE_COLLABORATION_ORIGIN;
    if (local) this.localWrites += 1;
    if (local) this.publish({ status: this.blocked ? "revoked" : "unsaved" });
    const outbound = local ? { updateId: crypto.randomUUID(), data: data.slice() } : undefined;
    this.queue = this.queue.then(async () => {
      await this.store.append(data.slice(), outbound);
      if (outbound) {
        this.outbox.set(outbound.updateId, outbound);
        this.localWrites -= 1;
        this.sendUpdate(outbound);
      }
      this.updateStatus();
    }).catch((error: unknown) => this.publish({ status: "storage-error", error: errorMessage(error) }));
  };
  private readonly awarenessListener = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    this.publish({ peers: Array.from(this.awareness.getStates().entries()).map(([clientId, entry]) => ({
      id: typeof entry.user?.id === "string" ? entry.user.id : String(clientId),
      name: typeof entry.user?.name === "string" ? entry.user.name : typeof entry.user?.displayName === "string" ? entry.user.displayName : "协作者",
      documentId: typeof entry.documentId === "string" ? entry.documentId : null,
      local: clientId === this.doc.clientID,
    })) });
    if (origin === REMOTE_COLLABORATION_ORIGIN || this.closed || this.blocked) return;
    this.send({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]) });
  };

  constructor(options: CollaborationSessionOptions) {
    this.options = options;
    this.roomId = options.roomId;
    this.epoch = options.epoch;
    this.store = options.store ?? createCollaborationStore(options.userId, options.roomId, options.epoch);
    for (const language of RECORDING_LANGUAGES) this.doc.getText(recordingDocumentId(language));
    this.doc.on("update", this.updateListener);
    this.awareness.on("update", this.awarenessListener);
    this.awareness.setLocalStateField("user", { id: options.userId, name: options.displayName });
  }
  getSnapshot = (): CollaborationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getText(language: RecordingLanguage): Y.Text { return this.doc.getText(recordingDocumentId(language)); }
  getDocuments(): Record<RecordingLanguage, string> {
    return Object.fromEntries(RECORDING_LANGUAGES.map((language) => [language, this.getText(language).toString()])) as Record<RecordingLanguage, string>;
  }
  async start(): Promise<void> {
    try {
      const cached = await this.store.load();
      if (this.closed) return;
      for (const update of cached.updates) Y.applyUpdate(this.doc, update, RESTORE_ORIGIN);
      for (const update of cached.outbox) this.outbox.set(update.updateId, update);
      this.publish({ ready: cached.updates.length > 0, pendingUpdates: this.outbox.size, status: "connecting" });
      await this.connect();
    } catch (error) {
      if (!this.closed) this.publish({ status: "storage-error", error: errorMessage(error) });
    }
  }
  invalidate(message = "账号、权限或文档版本已变化，请导出本地草稿。") {
    this.blocked = true;
    this.authenticated = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.publish({ status: "revoked", error: message });
  }
  exportDraft(): Blob {
    return new Blob([JSON.stringify({ roomId: this.roomId, epoch: this.epoch, documents: this.getDocuments() }, null, 2)], { type: "application/json" });
  }
  async whenLocallySaved(): Promise<void> { await this.queue; }
  destroy() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.awareness.setLocalState(null);
    this.socket?.close();
    this.doc.off("update", this.updateListener);
    this.awareness.off("update", this.awarenessListener);
    this.awareness.destroy();
    this.doc.destroy();
    this.listeners.clear();
    void this.queue.finally(() => this.store.close());
  }
  private publish(patch: Partial<CollaborationState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch, pendingUpdates: this.outbox.size + this.localWrites };
    this.listeners.forEach((listener) => listener());
  }
  private updateStatus() {
    if (this.closed || this.state.status === "storage-error") return;
    const status = this.blocked ? "revoked" : this.localWrites > 0 ? "unsaved" : this.socket?.readyState !== WebSocket.OPEN ? "local-saved" : !this.receivedSync ? "syncing" : this.outbox.size > 0 ? "local-saved" : "server-saved";
    this.publish({ status });
  }
  private send(frame: Parameters<typeof encodeCollaborationFrame>[0]) {
    if (!this.blocked && this.authenticated && this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeCollaborationFrame(frame));
  }
  private sendUpdate(update: StoredCollaborationUpdate) {
    this.send({ type: "update", epoch: this.epoch, ...update });
  }
  private async connect() {
    if (this.closed || this.blocked) return;
    this.publish({ status: "connecting" });
    try {
      const response = await this.options.request(`/api/interviews/rooms/${encodeURIComponent(this.roomId)}/ws-tickets`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "collaboration" }),
      });
      if (this.closed || this.blocked) return;
      if (!response.ok) {
        if ([401, 403, 404, 409, 410].includes(response.status)) { this.invalidate("房间权限失效，草稿仍保留在本机。"); return; }
        throw new Error("无法连接协同服务");
      }
      const ticket = await response.json() as { ticket: string; epoch: number };
      if (ticket.epoch !== this.epoch) { this.invalidate("文档已更新为新版本，请导出原版本草稿。"); return; }
      const url = new URL(`/api/interviews/rooms/${encodeURIComponent(this.roomId)}/collaboration`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket.ticket);
      const socket = (this.options.createSocket ?? ((value) => new WebSocket(value)))(url.href);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      this.authenticated = false;
      this.receivedSync = false;
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.closed || this.blocked) return;
        this.queue = this.queue.then(() => this.receive(event.data)).catch((error: unknown) => this.publish({ status: "storage-error", error: errorMessage(error) }));
      };
      socket.onclose = (event) => {
        if (this.socket !== socket || this.closed) return;
        this.authenticated = false;
        removeAwarenessStates(this.awareness, Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.doc.clientID), REMOTE_COLLABORATION_ORIGIN);
        if ([4001, 4003, 4004, 4009, 4010, 4401, 4403, 4409].includes(event.code)) this.invalidate("权限或文档版本已失效，请导出草稿。");
        else { this.updateStatus(); this.scheduleReconnect(); }
      };
      socket.onerror = () => socket.close();
    } catch (error) {
      if (!this.closed && !this.blocked) { this.publish({ status: "local-saved", error: errorMessage(error) }); this.scheduleReconnect(); }
    }
  }
  private scheduleReconnect() {
    if (this.closed || this.blocked || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
  }
  private async receive(data: unknown) {
    if (typeof data === "string") {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.type === "hello") {
        if (message.roomId !== this.roomId || message.epoch !== this.epoch) { this.invalidate(); return; }
        this.authenticated = true;
        this.attempt = 0;
        this.publish({ status: "syncing", error: null });
        this.send({ type: "state-vector", data: Y.encodeStateVector(this.doc) });
        for (const update of this.outbox.values()) this.sendUpdate(update);
        this.send({ type: "awareness", data: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]) });
      } else if (message.type === "ack" && typeof message.updateId === "string") {
        if (!Number.isSafeInteger(message.persistedRevision)) throw new Error("Invalid collaboration ACK");
        await this.store.acknowledge(message.updateId);
        this.outbox.delete(message.updateId);
        this.publish({ persistedRevision: Math.max(this.state.persistedRevision, message.persistedRevision as number) });
        this.updateStatus();
      } else if (message.type === "error") {
        if (message.fatal || ["epoch-mismatch", "forbidden", "room-closed", "unauthorized"].includes(String(message.code))) this.invalidate(String(message.message));
        else this.publish({ status: "local-saved", error: String(message.message ?? message.code) });
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || !this.authenticated) throw new Error("Invalid collaboration message");
    const frame = decodeCollaborationFrame(new Uint8Array(data));
    if (frame.type === "sync") {
      if (frame.epoch !== this.epoch) { this.invalidate(); return; }
      // Persist remote dependencies before applying, and do not echo them to outbox.
      await this.store.append(frame.data);
      this.doc.off("update", this.updateListener);
      try { Y.applyUpdate(this.doc, frame.data, REMOTE_COLLABORATION_ORIGIN); }
      finally { this.doc.on("update", this.updateListener); }
      this.receivedSync = true;
      this.publish({ ready: true, persistedRevision: Math.max(this.state.persistedRevision, frame.persistedRevision) });
      this.updateStatus();
    } else if (frame.type === "state-vector") {
      const update = Y.encodeStateAsUpdate(this.doc, frame.data);
      // Empty struct updates can still contain a delete set. Inspect the full
      // encoding, not state-vector equality, before deciding whether to send.
      if (update.length > 2) {
        const outbound = { updateId: crypto.randomUUID(), data: update };
        await this.store.append(update, outbound);
        this.outbox.set(outbound.updateId, outbound);
        this.sendUpdate(outbound);
        this.updateStatus();
      }
    } else if (frame.type === "awareness") applyAwarenessUpdate(this.awareness, frame.data, REMOTE_COLLABORATION_ORIGIN);
    else throw new Error("Server sent client-only update frame");
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
