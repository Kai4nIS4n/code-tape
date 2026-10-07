import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient } from "@/features/auth/authClient";
import { CollaborationSession } from "./collaborationSession";

export function useCollaborationRoom(roomId: string | null, joinCode?: string | null) {
  const auth = useSyncExternalStore(authClient.subscribe, authClient.getSnapshot, authClient.getSnapshot);
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"candidate" | "interviewer" | null>(null);
  useEffect(() => {
    if (!roomId || !auth.user) return;
    let cancelled = false;
    let current: CollaborationSession | null = null;
    const accountEpoch = authClient.epoch;
    const unsubscribeAuth = authClient.subscribe(() => {
      if (authClient.epoch !== accountEpoch || authClient.getSnapshot().user?.id !== auth.user?.id) current?.invalidate();
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
        current = new CollaborationSession({ userId: auth.user!.id, displayName: auth.user!.displayName, roomId, epoch: epoch!, request: authClient.fetch });
        setSession(current);
        setError(null);
        await current.start();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; unsubscribeAuth(); current?.destroy(); setSession(null); setRole(null); };
  }, [roomId, joinCode, auth.user?.id]);
  return { session, error, role };
}
