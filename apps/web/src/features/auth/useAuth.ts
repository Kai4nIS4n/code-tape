import { useContext, useSyncExternalStore } from "react";
import { AuthContext } from "./authContext";

export function useAuth() {
  const client = useContext(AuthContext);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return { ...snapshot, client };
}
