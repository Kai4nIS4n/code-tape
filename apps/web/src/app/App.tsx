export function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "0 1.5rem",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <p style={{ fontSize: "0.75rem", letterSpacing: "0.3em", textTransform: "uppercase", opacity: 0.6 }}>
        code-tape
      </p>
      <h1 style={{ fontSize: "1.875rem", fontWeight: 600 }}>像胶带一样为代码加上时间维度</h1>
      <p style={{ maxWidth: "32rem", opacity: 0.7 }}>
        基础建设 Stage 1 已就绪。主题、路由、页面装配在后续 stage 实装。
      </p>
    </div>
  );
}
