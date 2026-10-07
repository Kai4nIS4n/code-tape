import { useRouteError } from "react-router-dom";

export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "页面加载失败";
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <p>页面暂时无法加载，请重试。</p>
      <details className="max-w-xl text-xs text-muted">
        <summary>查看详情</summary>
        {message}
      </details>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
      >
        重新加载
      </button>
    </div>
  );
}
