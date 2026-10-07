import { useEffect, type ReactNode } from "react";
import { authClient, type AuthClient } from "./authClient";
import { AuthContext } from "./authContext";

export function AuthProvider({ children, client = authClient }: { children: ReactNode; client?: AuthClient }) {
  useEffect(() => { void client.restore(); }, [client]);
  return <AuthContext.Provider value={client}>{children}</AuthContext.Provider>;
}
