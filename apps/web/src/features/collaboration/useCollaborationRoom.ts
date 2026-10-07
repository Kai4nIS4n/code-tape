import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient } from "@/features/auth/authClient";
import { CollaborationSession } from "./collaborationSession";
import { featureFlags } from "@/shared/featureFlags";

export function useCollaborationRoom(roomId: string | null, joinCode?: string | null) {
  const auth = useSyncExternalStore(authClient.subscribe, authClient.getSnapshot, authClient.getSnapshot);
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"candidate" | "interviewer" | null>(null);
  const userId = auth.user?.id;
  const displayName = auth.user?.displayName ?? "";
  const authEpoch = authClient.epoch;
  useEffect(() => {
    if (!roomId || !userId) return;
    let cancelled = false;
    let current: CollaborationSession | null = null;
    const accountEpoch = authEpoch;
    const unsubscribeAuth = authClient.subscribe(() => {
      if (authClient.epoch !== accountEpoch || authClient.getSnapshot().user?.id !== userId) current?.invalidate();
    });
    void (async () => {
      try {
        if (joinCode) {
          const joined = await authClient.fetch(`/api/interviews/rooms/${encodeURIComponent(roomId)}/join`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ joinCode }),
          });
          if (!joined.ok) throw new Error("邀请已过期、房间已满或账号无权加入。");
        }
        const response = await authClient.fetch(`/api/interviews/rooms/${encodeURIComponent(roomId)}`);
        if (!response.ok) throw new Error("无法读取房间，请确认当前账号的成员权限。");
        const result = await response.json() as { room?: { id: string; epoch: number }; epoch?: number; role?: "candidate" | "interviewer" };
        const epoch = result.room?.epoch ?? result.epoch;
        if (!Number.isSafeInteger(epoch)) throw new Error("房间版本无效。");
        if (cancelled || accountEpoch !== authClient.epoch) return;
        if (result.role !== "candidate" && result.role !== "interviewer") throw new Error("房间成员身份无效。");
        setRole(result.role);
        if (!featureFlags.collaboration) { setError(null); return; }
        current = new CollaborationSession({ userId, displayName, role: result.role, roomId, epoch: epoch!, request: authClient.fetch });
        setSession(current);
        setError(null);
        await current.start();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; unsubscribeAuth(); current?.destroy(); setSession(null); setRole(null); };
  }, [roomId, joinCode, userId, displayName, authEpoch]);
  return { session, error, role };
}
