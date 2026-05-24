export function App() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-muted">code-tape</p>
        <h1 className="font-display text-4xl font-semibold leading-tight">
          像胶带一样为代码加上时间维度
        </h1>
        <p className="max-w-lg text-muted">
          P0 基础建设进行中。主题、路由、页面装配将随后续 stage 落地。
        </p>
        <pre className="rounded-md border border-border bg-surface px-4 py-2 font-mono text-sm text-muted shadow-elevation-1">
          npm install &amp;&amp; npm run dev
        </pre>
      </main>
    </div>
  );
}
