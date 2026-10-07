import { authClient } from "@/features/auth/authClient";

export type InterviewRoomStatus = "waiting" | "connecting" | "live" | "ended" | "expired";

export type CreateInterviewRoomResponse = {
  roomId: string;
  joinCode: string;
  status: InterviewRoomStatus;
  expiresAt: string;
  signalingUrl: string;
};

export type GetInterviewRoomResponse = {
  joinCode?: string;
  roomId: string;
  status: InterviewRoomStatus;
  expiresAt: string;
  candidateConnected: boolean;
  interviewerConnected: boolean;
  signalingUrl: string;
};

export type EndInterviewRoomResponse = {
  roomId: string;
  status: InterviewRoomStatus;
  expiresAt: string;
};

export type InterviewRoomClientError = {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
};

export type InterviewRoomClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: InterviewRoomClientError };

export type EndInterviewRoomInput = {
  joinCode: string;
  connectionId: string;
};

export type InterviewRoomClient = {
  createRoom(): Promise<InterviewRoomClientResult<CreateInterviewRoomResponse>>;
  getRoom(
    roomId: string,
    joinCode: string,
  ): Promise<InterviewRoomClientResult<GetInterviewRoomResponse>>;
  endRoom(
    roomId: string,
    input: EndInterviewRoomInput,
  ): Promise<InterviewRoomClientResult<EndInterviewRoomResponse>>;
};

export type InterviewRoomClientOptions = {
  baseUrl?: string | URL;
  fetch?: typeof fetch;
};

export function createInterviewRoomInvite(
  roomId: string,
  options: InterviewRoomClientOptions = {},
): Promise<InterviewRoomClientResult<{ joinCode: string; expiresAt: string }>> {
  return requestJson({
    fetch: options.fetch ?? authClient.fetch,
    url: buildUrl(`/api/interviews/rooms/${encodeURIComponent(roomId)}/invites`, options.baseUrl),
    init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    validate(value) {
      if (!isJsonObject(value)) return null;
      const joinCode = value.joinCode ?? value.token;
      return isNonEmptyString(joinCode) && isNonEmptyString(value.expiresAt)
        ? { joinCode, expiresAt: value.expiresAt }
        : null;
    },
  });
}

export function createInterviewRoomClient(
  options: InterviewRoomClientOptions = {},
): InterviewRoomClient {
  const fetchImpl = options.fetch ?? authClient.fetch;

  const authorizeSignaling = async <T extends { roomId: string; signalingUrl: string }>(result: InterviewRoomClientResult<T>): Promise<InterviewRoomClientResult<T>> => {
    if (!result.ok || options.fetch) return result;
    try {
      const response = await fetchImpl(buildUrl(`/api/interviews/rooms/${encodeURIComponent(result.value.roomId)}/ws-tickets`, options.baseUrl), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "signaling" }),
      });
      // A failed optional media ticket must not discard a successfully created
      // room and prevent its independent collaboration connection.
      if (!response.ok) return result;
      const ticket = await response.json() as { ticket: string };
      const url = buildUrl(result.value.signalingUrl, options.baseUrl);
      url.searchParams.set("ticket", ticket.ticket);
      return { ok: true, value: { ...result.value, signalingUrl: url.href } };
    } catch { return result; }
  };

  return {
    createRoom() {
      return requestJson({
        fetch: fetchImpl,
        url: buildUrl("/api/interviews/rooms", options.baseUrl),
        init: { method: "POST" },
        validate: parseCreateRoomResponse,
      }).then(authorizeSignaling);
    },
    async getRoom(roomId, joinCode) {
      if (joinCode && !options.fetch) {
        const joined = await fetchImpl(buildUrl(`/api/interviews/rooms/${encodeURIComponent(roomId)}/join`, options.baseUrl), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ joinCode }),
        });
        if (!joined.ok) return { ok: false, error: { code: "join-failed", message: "邀请已失效或账号无权加入", status: joined.status } };
      }
      const url = buildUrl(
        `/api/interviews/rooms/${encodeURIComponent(roomId)}`,
        options.baseUrl,
      );
      url.search = `joinCode=${encodeURIComponent(joinCode)}`;
      return requestJson({
        fetch: fetchImpl,
        url,
        init: { method: "GET" },
        validate: parseGetRoomResponse,
      }).then(authorizeSignaling);
    },
    endRoom(roomId, input) {
      return requestJson({
        fetch: fetchImpl,
        url: buildUrl(
          `/api/interviews/rooms/${encodeURIComponent(roomId)}/end`,
          options.baseUrl,
        ),
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        validate: parseEndRoomResponse,
      });
    },
  };
}

async function requestJson<T>(input: {
  fetch: typeof fetch;
  url: URL;
  init: RequestInit;
  validate(value: unknown): T | null;
}): Promise<InterviewRoomClientResult<T>> {
  let response: Response;
  try {
    response = await input.fetch(input.url, input.init);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "network-error",
        message: error instanceof Error ? error.message : "interview room request failed",
      },
    };
  }

  const parsed = await readJson(response);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: "bad-response",
        message: "interview room response must be valid JSON",
        status: response.status,
      },
    };
  }

  if (!response.ok) {
    return { ok: false, error: parseErrorResponse(parsed.value, response.status) };
  }

  const value = input.validate(parsed.value);
  if (!value) {
    return {
      ok: false,
      error: {
        code: "bad-response",
        message: "interview room response shape is invalid",
        status: response.status,
      },
    };
  }
  return { ok: true, value };
}

async function readJson(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: (await response.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseErrorResponse(value: unknown, status: number): InterviewRoomClientError {
  const error = isJsonObject(value) && isJsonObject(value.error) ? value.error : null;
  return {
    code: isNonEmptyString(error?.code) ? error.code : "http-error",
    message: isNonEmptyString(error?.message)
      ? error.message
      : `interview room request failed with status ${status}`,
    requestId: isNonEmptyString(error?.requestId) ? error.requestId : undefined,
    status,
  };
}

function parseCreateRoomResponse(value: unknown): CreateInterviewRoomResponse | null {
  if (!isJsonObject(value)) return null;
  if (isJsonObject(value.room)) {
    const room = value.room;
    value = { ...room, roomId: room.id, signalingUrl: buildSignalingUrl(String(room.id)) };
  }
  if (!isJsonObject(value)) return null;
  if (
    !isNonEmptyString(value.roomId) ||
    !isNonEmptyString(value.joinCode) ||
    !isInterviewRoomStatus(value.status) ||
    !isNonEmptyString(value.expiresAt) ||
    !isNonEmptyString(value.signalingUrl)
  ) {
    return null;
  }
  return {
    roomId: value.roomId,
    joinCode: value.joinCode,
    status: value.status,
    expiresAt: value.expiresAt,
    signalingUrl: value.signalingUrl,
  };
}

function parseGetRoomResponse(value: unknown): GetInterviewRoomResponse | null {
  if (!isJsonObject(value)) return null;
  if (isJsonObject(value.room)) {
    const room = value.room;
    value = { ...room, roomId: room.id, candidateConnected: room.candidateConnected ?? false, interviewerConnected: room.interviewerConnected ?? false, signalingUrl: buildSignalingUrl(String(room.id)) };
  }
  if (!isJsonObject(value)) return null;
  if (
    !isNonEmptyString(value.roomId) ||
    !isInterviewRoomStatus(value.status) ||
    !isNonEmptyString(value.expiresAt) ||
    typeof value.candidateConnected !== "boolean" ||
    typeof value.interviewerConnected !== "boolean"
  ) {
    return null;
  }
  return {
    roomId: value.roomId,
    joinCode: typeof value.joinCode === "string" ? value.joinCode : undefined,
    status: value.status,
    expiresAt: value.expiresAt,
    candidateConnected: value.candidateConnected,
    interviewerConnected: value.interviewerConnected,
    signalingUrl: isNonEmptyString(value.signalingUrl)
      ? value.signalingUrl
      : buildSignalingUrl(value.roomId),
  };
}

function buildSignalingUrl(roomId: string): string {
  return `/api/interviews/rooms/${encodeURIComponent(roomId)}/signaling`;
}

function parseEndRoomResponse(value: unknown): EndInterviewRoomResponse | null {
  if (!isJsonObject(value)) return null;
  if (isJsonObject(value.room)) value = { ...value.room, roomId: value.room.id };
  if (!isJsonObject(value)) return null;
  if (
    !isNonEmptyString(value.roomId) ||
    !isInterviewRoomStatus(value.status) ||
    !isNonEmptyString(value.expiresAt)
  ) {
    return null;
  }
  return {
    roomId: value.roomId,
    status: value.status,
    expiresAt: value.expiresAt,
  };
}

function buildUrl(path: string, baseUrl?: string | URL): URL {
  return new URL(path, baseUrl ?? defaultBaseUrl());
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.href;
  }
  return "http://localhost/";
}

function isInterviewRoomStatus(value: unknown): value is InterviewRoomStatus {
  return (
    value === "waiting" ||
    value === "connecting" ||
    value === "live" ||
    value === "ended" ||
    value === "expired"
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
