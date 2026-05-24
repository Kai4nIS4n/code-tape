import { describe, expect, it } from "vitest";
import { acceptRuntimeMessage, createIframeRuntime } from "../iframeRuntime";

describe("acceptRuntimeMessage — schema + source validation", () => {
  const expected = { runId: "run-1", source: null };

  it("accepts a well-formed console message matching runId", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "console",
        payload: { level: "log", args: ["hello"] },
      },
      expected,
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("console");
  });

  it("rejects messages with wrong source", () => {
    const result = acceptRuntimeMessage(
      {
        source: "evil-runtime",
        runId: "run-1",
        type: "console",
        payload: { level: "log", args: [] },
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with mismatching runId", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-OLD",
        type: "console",
        payload: { level: "log", args: [] },
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with unknown type", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "drop-table",
        payload: {},
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with malformed payload", () => {
    const result = acceptRuntimeMessage(
      { source: "code-tape-runtime", runId: "run-1", type: "console", payload: "string" },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects payloads that do not match their runtime message type", () => {
    expect(
      acceptRuntimeMessage(
        {
          source: "code-tape-runtime",
          runId: "run-1",
          type: "console",
          payload: { level: "debug", args: ["hello"] },
        },
        expected,
      ),
    ).toBeNull();
    expect(
      acceptRuntimeMessage(
        {
          source: "code-tape-runtime",
          runId: "run-1",
          type: "complete",
          payload: { previewHtml: 42 },
        },
        expected,
      ),
    ).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(acceptRuntimeMessage(null, expected)).toBeNull();
    expect(acceptRuntimeMessage("hi", expected)).toBeNull();
    expect(acceptRuntimeMessage(42, expected)).toBeNull();
  });
});

describe("IframeRuntime sandbox lifecycle", () => {
  it("creates a fresh run iframe for every run", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const mountedFrame = host.querySelector("iframe");
    await runtime.run({ runId: "run-1", compiledCode: "", timeoutMs: 1 });
    const firstRunFrame = host.querySelector("iframe");
    await runtime.run({ runId: "run-2", compiledCode: "", timeoutMs: 1 });
    const secondRunFrame = host.querySelector("iframe");

    expect(firstRunFrame).not.toBe(mountedFrame);
    expect(secondRunFrame).not.toBe(firstRunFrame);
    runtime.destroy();
    host.remove();
  });

  it("renders replay preview in a no-script sandbox", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview("<body><script>window.__executed = true</script><p>safe</p></body>");
    const frame = host.querySelector("iframe");

    expect(frame?.getAttribute("sandbox")).toBe("");
    runtime.destroy();
    host.remove();
  });
});
