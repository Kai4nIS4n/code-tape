import { useSyncExternalStore } from "react";
import type { CollaborationSession, CollaborationStatus as Status } from "./collaborationSession";

const LABELS: Record<Status, string> = { loading: "加载本地草稿", unsaved: "未保存", "local-saved": "本机已保存，等待服务端确认", connecting: "连接中", syncing: "同步中", "server-saved": "服务端已保存", revoked: "权限已失效", "storage-error": "本机保存失败" };

export function CollaborationStatus({ session }: { session: CollaborationSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 text-xs text-muted" data-collaboration-status={state.status} role="status">
    <span>{LABELS[state.status]}{state.pendingUpdates ? ` · ${state.pendingUpdates} 条待确认` : ""}</span>
    {state.peers.filter((peer) => !peer.local).map((peer) => <span key={peer.id}>{peer.name} 在线{peer.documentId ? ` · ${peer.documentId.slice(7)}` : ""}</span>)}
    {state.error ? <span className="text-danger">{state.error}</span> : null}
    <button type="button" className="ml-auto underline" onClick={() => {
      const url = URL.createObjectURL(session.exportDraft());
      const link = document.createElement("a"); link.href = url; link.download = `codetape-draft-${session.roomId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>导出本地草稿</button>
  </div>;
}
