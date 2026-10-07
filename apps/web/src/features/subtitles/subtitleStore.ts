import { awaitTransaction, openDatabase, promisifyRequest } from "@/features/library/idb";
import type { SubtitleAsset, SubtitleChapter, SubtitleStore, SubtitleTrack } from "./types";

export type SubtitleStoreOptions = {
  databaseName?: string;
};

const DEFAULT_DB_NAME = "code-tape-subtitles";
const DB_VERSION = 3;
const STORE_SUBTITLES = "subtitles";
const STORE_CHAPTERS = "chapters";
const STORE_ANCHORS = "anchors";

export function createSubtitleStore(options: SubtitleStoreOptions = {}): SubtitleStore {
  const databaseName = options.databaseName ?? DEFAULT_DB_NAME;
  const getDb = (() => {
    let cached: Promise<IDBDatabase> | null = null;
    const clearCached = () => {
      cached = null;
    };
    return () => {
      if (!cached) {
        cached = openDatabase({
          name: databaseName,
          version: DB_VERSION,
          onUpgrade(db) {
            if (!db.objectStoreNames.contains(STORE_SUBTITLES)) {
              db.createObjectStore(STORE_SUBTITLES, { keyPath: "recordingId" });
            }
            if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
              db.createObjectStore(STORE_CHAPTERS, { keyPath: "recordingId" });
            }
            if (!db.objectStoreNames.contains(STORE_ANCHORS)) {
              db.createObjectStore(STORE_ANCHORS, { keyPath: "recordingId" });
            }
          },
          onVersionChange: clearCached,
        }).catch((err) => {
          clearCached();
          throw err;
        });
      }
      return cached;
    };
  })();

  return {
    async loadAsset(recordingId) {
      const db = await getDb();
      const tx = db.transaction([STORE_SUBTITLES, STORE_CHAPTERS, STORE_ANCHORS], "readonly");
      const [track, chapterRecord, anchorRecord] = await Promise.all([
        promisifyRequest(tx.objectStore(STORE_SUBTITLES).get(recordingId)) as Promise<
          SubtitleTrack | undefined
        >,
        promisifyRequest(tx.objectStore(STORE_CHAPTERS).get(recordingId)) as Promise<
          { chapters: SubtitleChapter[] } | undefined
        >,
        promisifyRequest(tx.objectStore(STORE_ANCHORS).get(recordingId)) as Promise<
          Omit<SubtitleAsset, "track" | "chapters"> | undefined
        >,
      ]);
      await awaitTransaction(tx);
      if (!track) return null;
      return {
        recordingId,
        track,
        chapters: chapterRecord?.chapters ?? [],
        anchors: anchorRecord?.anchors ?? [],
        sourceEventsChecksum: anchorRecord?.sourceEventsChecksum ?? "",
        subtitleTrackRevision: track.revision ?? 0,
      };
    },
    async saveAsset(asset, expectedRevision, signal) {
      if (signal?.aborted) throw new DOMException("字幕保存已取消", "AbortError");
      const db = await getDb();
      if (signal?.aborted) throw new DOMException("字幕保存已取消", "AbortError");
      const tx = db.transaction([STORE_SUBTITLES, STORE_CHAPTERS, STORE_ANCHORS], "readwrite");
      const onAbort = () => {
        try {
          tx.abort();
        } catch {
          /* A completed transaction cannot be canceled. */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const saved = (await promisifyRequest(
          tx.objectStore(STORE_SUBTITLES).get(asset.recordingId),
        )) as SubtitleTrack | undefined;
        if ((saved?.revision ?? 0) !== expectedRevision) {
          await awaitTransaction(tx);
          return false;
        }
        if (signal?.aborted) {
          onAbort();
          throw new DOMException("字幕保存已取消", "AbortError");
        }
        const revision = expectedRevision + 1;
        tx.objectStore(STORE_SUBTITLES).put({ ...asset.track, revision });
        tx.objectStore(STORE_CHAPTERS).put({
          recordingId: asset.recordingId,
          chapters: asset.chapters,
        });
        tx.objectStore(STORE_ANCHORS).put({
          recordingId: asset.recordingId,
          sourceEventsChecksum: asset.sourceEventsChecksum,
          subtitleTrackRevision: revision,
          anchors: asset.anchors,
        });
        await awaitTransaction(tx);
        return true;
      } catch (error) {
        onAbort();
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    async load(recordingId: string): Promise<SubtitleTrack | null> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readonly");
      const value = (await promisifyRequest(tx.objectStore(STORE_SUBTITLES).get(recordingId))) as
        | SubtitleTrack
        | undefined;
      await awaitTransaction(tx);
      return value ?? null;
    },

    async save(track: SubtitleTrack): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readwrite");
      tx.objectStore(STORE_SUBTITLES).put(track);
      await awaitTransaction(tx);
    },

    async loadChapters(recordingId: string): Promise<SubtitleChapter[]> {
      const db = await getDb();
      const tx = db.transaction(STORE_CHAPTERS, "readonly");
      const value = (await promisifyRequest(tx.objectStore(STORE_CHAPTERS).get(recordingId))) as
        | { recordingId: string; chapters?: SubtitleChapter[] }
        | undefined;
      await awaitTransaction(tx);
      return Array.isArray(value?.chapters) ? value.chapters : [];
    },

    async saveChapters(recordingId: string, chapters: SubtitleChapter[]): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(STORE_CHAPTERS, "readwrite");
      tx.objectStore(STORE_CHAPTERS).put({ recordingId, chapters });
      await awaitTransaction(tx);
    },

    async saveWithChapters(track: SubtitleTrack, chapters: SubtitleChapter[]): Promise<void> {
      const db = await getDb();
      const tx = db.transaction([STORE_SUBTITLES, STORE_CHAPTERS, STORE_ANCHORS], "readwrite");
      try {
        tx.objectStore(STORE_SUBTITLES).put(track);
        tx.objectStore(STORE_CHAPTERS).put({ recordingId: track.recordingId, chapters });
        tx.objectStore(STORE_ANCHORS).delete(track.recordingId);
      } catch (error) {
        tx.abort();
        throw error;
      }
      await awaitTransaction(tx);
    },

    async remove(recordingId: string): Promise<void> {
      const db = await getDb();
      const tx = db.transaction([STORE_SUBTITLES, STORE_CHAPTERS, STORE_ANCHORS], "readwrite");
      tx.objectStore(STORE_SUBTITLES).delete(recordingId);
      tx.objectStore(STORE_CHAPTERS).delete(recordingId);
      tx.objectStore(STORE_ANCHORS).delete(recordingId);
      await awaitTransaction(tx);
    },
  };
}
