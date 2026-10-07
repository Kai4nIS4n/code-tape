import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient } from "@/features/auth/authClient";
import { listCollaborationDraftEpochs } from "./collaborationStore";
import { exportStoredCollaborationDraft } from "./collaborationDrafts";

export function LocalCollaborationDrafts({ roomId, currentEpoch }: { roomId: string; currentEpoch?: number }) {
  const userId = useSyncExternalStore(authClient.subscribe, authClient.getSnapshot, authClient.getSnapshot).user?.id;
  const [epochs, setEpochs] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void listCollaborationDraftEpochs(userId, roomId).then((values) => {
      if (!cancelled) setEpochs(values.filter((epoch) => epoch !== currentEpoch));
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "本机草稿读取失败"); });
    return () => { cancelled = true; };
  }, [userId, roomId, currentEpoch]);
  if (!userId || (epochs.length === 0 && !error)) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="本机历史协同草稿">
    <span>本机历史草稿（不会自动上传）：</span>
    {epochs.map((epoch) => <button key={epoch} type="button" className="underline" onClick={() => {
      void exportStoredCollaborationDraft(userId, roomId, epoch).then((blob) => {
        const url = URL.createObjectURL(blob); const link = document.createElement("a");
        link.href = url; link.download = `codetape-draft-${roomId}-epoch-${epoch}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "导出草稿失败"));
    }}>导出版本 {epoch}</button>)}
    {error ? <span role="alert" className="text-danger">{error}</span> : null}
  </div>;
}
