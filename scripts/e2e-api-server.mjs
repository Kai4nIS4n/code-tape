import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createSecureRuntime } from "../apps/api/dist/demo/secureRuntime.js";

// This loopback-only wrapper is a test process, never a production API route.
process.env.NODE_ENV = "test";
const port = Number(process.env.CODE_TAPE_E2E_API_PORT ?? "4173");
const controlToken = process.env.CODE_TAPE_E2E_TOKEN ?? "codetape-e2e-control";
const directory = await mkdtemp(join(tmpdir(), "codetape-e2e-api-"));
const blockedUsers = new Set();
const options = {
  dataDirectory: join(directory, "private-data"),
  authSecret: "codetape-e2e-secret-for-isolated-local-test-only",
  allowedOrigins: [
    process.env.CODE_TAPE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:5173",
  ],
  secureCookie: false,
  testFaults: { blockedUsers },
};
let runtime = createSecureRuntime(options);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const server = createServer((incoming, outgoing) => {
  void handle(incoming, outgoing).catch(() => {
    if (!outgoing.headersSent)
      outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "test request failed" }));
  });
});
server.on("upgrade", (request, socket, head) => {
  if (runtime.sockets.canHandle(request))
    runtime.sockets.handleUpgrade(request, socket, head);
  else socket.destroy();
});

async function handle(incoming, outgoing) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.byteLength;
    if (length > 250 * 1024 * 1024) throw new Error("body budget exceeded");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers))
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  headers.set("x-code-tape-peer", incoming.socket.remoteAddress ?? "unknown");
  const request = new Request(
    `http://127.0.0.1:${port}${incoming.url ?? "/"}`,
    {
      method: incoming.method,
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
    },
  );
  const path = new URL(request.url).pathname;
  let response;
  if (path === "/_e2e/health" && request.method === "GET")
    response = json({ ready: true });
  else if (path.startsWith("/_e2e/")) {
    if (request.headers.get("x-e2e-token") !== controlToken)
      response = json({ error: "unauthorized" }, 403);
    else if (path === "/_e2e/transport" && request.method === "POST") {
      const input = await request.json();
      if (
        typeof input.userId !== "string" ||
        typeof input.blocked !== "boolean"
      )
        response = json({ error: "invalid control" }, 400);
      else {
        if (input.blocked) {
          blockedUsers.add(input.userId);
          runtime.sockets.disconnectCollaboration(input.userId);
        } else blockedUsers.delete(input.userId);
        response = json({ blocked: blockedUsers.has(input.userId) });
      }
    } else if (path === "/_e2e/restart" && request.method === "POST") {
      runtime.close();
      runtime = createSecureRuntime(options);
      response = json({ restarted: true });
    } else response = json({ error: "not found" }, 404);
  } else response = await runtime.handler(request);
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
  else outgoing.end();
}

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log(`CodeTape isolated E2E API ready on 127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    runtime.close();
    server.close(() => process.exit(0));
  });
