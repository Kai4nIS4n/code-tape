export type StoredCollaborationUpdate = { updateId: string; data: Uint8Array };
export type CollaborationStore = {
  load(): Promise<{ updates: Uint8Array[]; outbox: StoredCollaborationUpdate[] }>;
  append(data: Uint8Array, outbound?: StoredCollaborationUpdate): Promise<void>;
  acknowledge(updateId: string): Promise<void>;
  close(): void;
};

/** A single transaction commits the local CRDT log and its delivery obligation. */
export function createCollaborationStore(userId: string, roomId: string, epoch: number): CollaborationStore {
  const partition = JSON.stringify([userId, roomId, epoch]);
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("codetape-collaboration", 1);
    request.onupgradeneeded = () => {
      const updates = request.result.createObjectStore("updates", { autoIncrement: true });
      updates.createIndex("partition", "partition");
      const outbox = request.result.createObjectStore("outbox", { keyPath: "key" });
      outbox.createIndex("partition", "partition");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let closed = false;
  const database = async () => {
    const db = await opened;
    if (closed) throw new Error("Collaboration store closed");
    return db;
  };
  return {
    async load() {
      const db = await database();
      const tx = db.transaction(["updates", "outbox"], "readonly");
      const updates = tx.objectStore("updates").index("partition").getAll(IDBKeyRange.only(partition));
      const outbox = tx.objectStore("outbox").index("partition").getAll(IDBKeyRange.only(partition));
      await transactionDone(tx);
      return {
        updates: (updates.result as Array<{ data: Uint8Array }>).map((entry) => entry.data),
        outbox: (outbox.result as StoredCollaborationUpdate[]).map(({ updateId, data }) => ({ updateId, data })),
      };
    },
    async append(data, outbound) {
      const db = await database();
      const tx = db.transaction(["updates", "outbox"], "readwrite");
      tx.objectStore("updates").add({ partition, data });
      if (outbound) tx.objectStore("outbox").put({ ...outbound, partition, key: `${partition}:${outbound.updateId}` });
      await transactionDone(tx);
    },
    async acknowledge(updateId) {
      const db = await database();
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").delete(`${partition}:${updateId}`);
      await transactionDone(tx);
    },
    close() { closed = true; void opened.then((db) => db.close()); },
  };
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Local collaboration save aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("Local collaboration save failed"));
  });
}
