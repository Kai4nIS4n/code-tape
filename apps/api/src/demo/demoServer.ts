import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createSecureRuntime, type SecureRuntimeOptions, type SecureRuntime } from "./secureRuntime.js";
import { ApiFailure } from "../auth/accountAuthService.js";
import { createCloudRecordingService } from "../cloud/cloudRecordingService.js";
import { createAuthTokenService } from "../cloud/authTokenService.js";
import { createLocalDevObjectStorage } from "../cloud/localDevObjectStorage.js";
import { createMemoryMetadataRepository } from "../cloud/memoryMetadataRepository.js";
import { processNextRecordingValidationJob } from "../cloud/validationWorker.js";
import { createInterviewRoomService } from "../interview/interviewRoomService.js";
import { createMemoryInterviewRoomRepository } from "../interview/memoryInterviewRoomRepository.js";
import { createApiHandler } from "../http/createApiHandler.js";
import { createCloudApiHandler, type CloudApiHandler } from "../http/cloudApiHandler.js";
import { createInterviewApiHandler } from "../http/interviewApiHandler.js";
import { createLocalDevObjectStorageHandler } from "../http/localDevObjectStorageHandler.js";
import { createInterviewSignalingServer } from "../signaling/interviewSignalingServer.js";
import { createInterviewWebSocketUpgradeHandler } from "../signaling/interviewWebSocketUpgradeHandler.js";

export type DemoRequestHandlerOptions = SecureRuntimeOptions & {
  webRoot: string;
  publicBaseUrl?: string;
  createRequestId?: () => string;
  /** Only old service fixtures may enable the anonymous in-memory adapter. */
  legacyTestMode?: boolean;
};

export type DemoRuntime = {
  handler: CloudApiHandler;
  server: Server;
  controls?: SecureRuntime;
  close(): void;
};

export function createDemoRequestHandler(options: DemoRequestHandlerOptions): CloudApiHandler {
  return createDemoRuntime(options).handler;
}

export function createDemoRuntime(options: DemoRequestHandlerOptions): DemoRuntime {
  if (!options.legacyTestMode) return createAuthenticatedDemoRuntime(options);
  const webRoot = resolve(options.webRoot);
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({
    publicBaseUrl: options.publicBaseUrl ?? "",
  });
  const cloud = createCloudApiHandler({
    allowLegacyAuth: true,
    service: createCloudRecordingService({ metadata, objectStorage }),
    auth: createAuthTokenService({ secret: process.env.CODE_TAPE_AUTH_SECRET }),
    createRequestId: options.createRequestId,
  });
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
  });
  const signaling = createInterviewSignalingServer({ rooms });
  const api = createApiHandler({
    cloud,
    interview: createInterviewApiHandler({
      rooms,
      createRequestId: options.createRequestId,
      onRoomEnded: signaling.notifyRoomEnded,
    }),
    objectStorage: createLocalDevObjectStorageHandler(objectStorage),
  });
  const upgrade = createInterviewWebSocketUpgradeHandler({ signaling });

  const handler: CloudApiHandler = async (request) => {
    const url = new URL(request.url);
    if (isDemoApiPath(url.pathname)) {
      const response = await api(request);
      if (response.ok && isCompleteUploadRequest(request.method, url.pathname)) {
        await processNextRecordingValidationJob({ metadata, objectStorage });
      }
      return response;
    }
    return serveStatic({ request, webRoot });
  };

  const server = createServer((incoming, outgoing) => {
    void sendNodeResponse(handler, incoming, outgoing);
  });
  server.on("upgrade", (request, socket, head) => {
    if (upgrade.canHandle(request)) {
      upgrade.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });

  return {
    handler,
    server,
    close() {
      upgrade.close();
    },
  };
}

function createAuthenticatedDemoRuntime(options: DemoRequestHandlerOptions): DemoRuntime {
  const webRoot = resolve(options.webRoot);
  const dataRoot = resolve(options.dataDirectory ?? process.env.CODE_TAPE_DATA_DIR ?? ".code-tape-data");
  if (isInsideRoot(webRoot, dataRoot)) throw new Error("CODE_TAPE_DATA_DIR must be outside the public web root");
  const runtime = createSecureRuntime(options);
  const handler: CloudApiHandler = request => {
    const path = new URL(request.url).pathname;
    return isDemoApiPath(path) ? runtime.handler(request) : serveStatic({ request, webRoot });
  };
  const server = createServer((incoming, outgoing) => { void sendNodeResponse(handler, incoming, outgoing); });
  server.on("upgrade", (request, socket, head) => {
    if (runtime.sockets.canHandle(request)) runtime.sockets.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  return {handler,server,controls:runtime,close:()=>runtime.close()};
}

async function serveStatic(input: {
  request: Request;
  webRoot: string;
}): Promise<Response> {
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const url = new URL(input.request.url);
  const filePath = await resolveStaticPath(input.webRoot, url.pathname);
  const body = input.request.method === "HEAD" ? null : await readFile(filePath);
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentTypeFor(filePath) },
  });
}

async function resolveStaticPath(webRoot: string, pathname: string): Promise<string> {
  const decodedPath = decodePathname(pathname);
  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const candidate = resolve(webRoot, `.${requested}`);
  if (isInsideRoot(webRoot, candidate) && await isFile(candidate)) {
    return candidate;
  }

  const indexPath = resolve(webRoot, "index.html");
  if (await isFile(indexPath)) return indexPath;
  throw new Error(`missing demo web entry: ${indexPath}`);
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return "/";
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isInsideRoot(webRoot: string, path: string): boolean {
  return path === webRoot || path.startsWith(`${webRoot}${sep}`);
}

function isDemoApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/dev/object-storage/");
}

function isCompleteUploadRequest(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/recordings\/upload-sessions\/[^/]+\/complete$/u.test(pathname)
  );
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function sendNodeResponse(
  handler: CloudApiHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const request = await toWebRequest(incoming);
    const response = await handler(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (request.body && !incoming.readableEnded) {
      // Let Node flush the rejection response, then close the unread stream
      // through normal Connection: close handling without buffering the body.
      outgoing.setHeader("connection", "close");
    }
    if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing);
    else outgoing.end();
  } catch (error) {
    outgoing.statusCode = error instanceof ApiFailure ? error.status : 500;
    outgoing.setHeader("content-type", "text/plain; charset=utf-8");
    outgoing.setHeader("connection", "close");
    outgoing.end(error instanceof ApiFailure ? error.message : "Internal Server Error");
  }
}

async function toWebRequest(incoming: IncomingMessage): Promise<Request> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  const limit = incoming.url?.startsWith("/api/uploads/") ? 250 * 1024 * 1024 : 2 * 1024 * 1024;
  let size = 0;
  const body = hasBody
    ? (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength;
            if (size > limit) {
              throw new ApiFailure(413, "quota-exceeded", "request body exceeds upload budget");
            }
            controller.enqueue(chunk);
          },
        }),
      )
    : undefined;
  return new Request(url, {
    method: incoming.method,
    headers: { ...incoming.headers as Record<string,string>, "x-code-tape-peer": incoming.socket.remoteAddress ?? "unknown" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
