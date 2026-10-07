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
  const opened = openDatabase();
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
    close() { closed = true; void opened.then((db) => db.close(), () => undefined); },
  };
}

/** Historical epochs remain discoverable even after server membership is gone. */
export async function listCollaborationDraftEpochs(userId: string, roomId: string): Promise<number[]> {
  const db = await openDatabase();
  try {
    const tx = db.transaction("updates", "readonly");
    const done = transactionDone(tx);
    const requestedKeys = new Promise<IDBValidKey[]>((resolve, reject) => {
      const result: IDBValidKey[] = [];
      const request = tx.objectStore("updates").index("partition").openKeyCursor(null, "nextunique");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(result); return; }
        result.push(cursor.key); cursor.continue();
      };
    });
    const [keys] = await Promise.all([requestedKeys, done]);
    const epochs = new Set<number>();
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const partition = JSON.parse(key) as unknown;
      if (Array.isArray(partition) && partition[0] === userId && partition[1] === roomId && Number.isSafeInteger(partition[2])) epochs.add(partition[2] as number);
    }
    return Array.from(epochs).sort((left, right) => right - left);
  } finally { db.close(); }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Local collaboration save aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("Local collaboration save failed"));
  });
}
