import { Fragment, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";

export function RequireAccount({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading")
    return (
      <div role="status" className="p-6 text-sm text-muted">
        正在恢复账号…
      </div>
    );
  if (!auth.user)
    return (
      <Navigate
        replace
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
      />
    );
  return <Fragment key={`${auth.user.id}:${auth.epoch}`}>{children}</Fragment>;
}
