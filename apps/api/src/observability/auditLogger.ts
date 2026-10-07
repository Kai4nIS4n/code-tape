export type AuditEvent =
  | "http.completed"
  | "session.created"
  | "session.refreshed"
  | "session.revoked"
  | "ws.authorized"
  | "ws.closed"
  | "ws.transport-error"
  | "update.received"
  | "update.committed"
  | "update.duplicate"
  | "update.rejected"
  | "ack.enqueued";
export type AuditRouteClass =
  | "auth"
  | "room"
  | "recording"
  | "upload"
  | "playback-asset"
  | "shared-playback"
  | "not-found";
export type AuditContext = { requestId?: string };
export type AuditFields = AuditContext & {
  sessionId?: string;
  roomId?: string;
  connectionId?: string;
  updateId?: string;
  epoch?: number;
  persistedRevision?: number;
  status?: number;
  closeCode?: number;
  routeClass?: AuditRouteClass;
  purpose?: "signaling" | "collaboration";
  code?: string;
};
export type AuditRecord = Readonly<
  { event: AuditEvent; at: string } & AuditFields
>;
export type AuditSink = (record: AuditRecord) => void;
const stringFields = [
  "requestId",
  "sessionId",
  "roomId",
  "connectionId",
  "updateId",
  "routeClass",
  "purpose",
  "code",
] as const;
const numberFields = [
  "epoch",
  "persistedRevision",
  "status",
  "closeCode",
] as const;

/** An explicit allowlist: never pass URLs, headers, message bodies or errors. */
export function createAuditLogger(
  options: { sink?: AuditSink; now?: () => number } = {},
) {
  const sink =
    options.sink ?? ((record) => console.log(JSON.stringify(record)));
  return {
    emit(event: AuditEvent, fields: AuditFields = {}) {
      const record: Record<string, string | number> = {
        event,
        at: new Date((options.now ?? Date.now)()).toISOString(),
      };
      for (const key of stringFields) {
        const value = fields[key];
        if (
          typeof value === "string" &&
          value.length <= 128 &&
          /^[\w.-]+$/u.test(value)
        )
          record[key] = value;
      }
      for (const key of numberFields) {
        const value = fields[key];
        if (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
        )
          record[key] = value;
      }
      // A failing diagnostic sink must not roll back or misreport a committed update.
      try {
        sink(record as AuditRecord);
      } catch {
        /* Application behavior is independent of logging. */
      }
    },
  };
}
export type AuditLogger = ReturnType<typeof createAuditLogger>;
