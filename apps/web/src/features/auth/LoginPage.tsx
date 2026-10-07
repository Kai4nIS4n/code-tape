import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./useAuth";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next");
  const destination = next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (registering) await auth.client.register({ username, password, displayName: displayName || username });
      else await auth.client.login({ username, password });
      setPassword("");
      navigate(destination, { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "账号操作失败"); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col justify-center gap-6 px-6">
      <div><h1 className="font-display text-3xl font-semibold">{registering ? "创建账号" : "登录 CodeTape"}</h1>
        <p className="mt-2 text-sm text-muted">登录后可管理云端录制、分享内容和双人协作。本地录制可直接使用。</p></div>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm">用户名<input aria-label="用户名" autoComplete="username" required minLength={3} maxLength={64} value={username} onChange={(event) => setUsername(event.target.value)} className="rounded-md border border-border bg-surface px-3 py-2" /></label>
        {registering && <label className="flex flex-col gap-2 text-sm">显示名称<input aria-label="显示名称" autoComplete="nickname" maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="rounded-md border border-border bg-surface px-3 py-2" /></label>}
        <label className="flex flex-col gap-2 text-sm">密码<input aria-label="密码" type="password" autoComplete={registering ? "new-password" : "current-password"} required minLength={registering ? 8 : 1} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-md border border-border bg-surface px-3 py-2" /></label>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy ? "正在处理…" : registering ? "注册并登录" : "登录"}</button>
      </form>
      <button type="button" disabled={busy} onClick={() => { setRegistering(!registering); setError(null); setPassword(""); }} className="text-left text-sm text-primary">{registering ? "已有账号？去登录" : "没有账号？创建账号"}</button>
      <Link to="/record" className="text-sm text-muted">继续本地录制</Link>
    </div>
  );
}
