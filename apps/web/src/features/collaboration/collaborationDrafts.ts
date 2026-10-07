import * as Y from "yjs";
import { RECORDING_LANGUAGES, recordingDocumentId } from "@/shared/recording-schema";
import { createCollaborationStore } from "./collaborationStore";

export async function exportStoredCollaborationDraft(userId: string, roomId: string, epoch: number): Promise<Blob> {
  const store = createCollaborationStore(userId, roomId, epoch);
  const doc = new Y.Doc();
  try {
    const cached = await store.load();
    for (const update of cached.updates) Y.applyUpdate(doc, update);
    const documents = Object.fromEntries(RECORDING_LANGUAGES.map((language) => [language, doc.getText(recordingDocumentId(language)).toString()]));
    return new Blob([JSON.stringify({ roomId, epoch, documents }, null, 2)], { type: "application/json" });
  } finally { store.close(); doc.destroy(); }
}
