import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuditLogger,
  type AuditFields,
  type AuditRecord,
} from "../auditLogger.js";

test("audit uses a strict scalar allowlist and does not expose credentials, URLs or source", () => {
  const records: AuditRecord[] = [];
  const logger = createAuditLogger({
    sink: (record) => records.push(record),
    now: () => 0,
  });
  logger.emit("http.completed", {
    requestId: "request-1",
    routeClass: "shared-playback",
    status: 403,
    password: "secret-password",
    token: "secret-token",
    grant: "secret-grant",
    url: "https://site/s/private-share",
    source: "console.log(secret)",
  } as AuditFields);
  assert.deepEqual(records, [
    {
      event: "http.completed",
      at: "1970-01-01T00:00:00.000Z",
      requestId: "request-1",
      routeClass: "shared-playback",
      status: 403,
    },
  ]);
  logger.emit("update.received", {
    roomId: "room-1",
    updateId: "update-1",
    epoch: 1,
  });
  assert.equal(records[1]?.updateId, "update-1");
});
test("audit sink failure cannot become a business failure", () => {
  const logger = createAuditLogger({
    sink: () => {
      throw new Error("diagnostic sink unavailable");
    },
  });
  assert.doesNotThrow(() =>
    logger.emit("update.committed", { persistedRevision: 1 }),
  );
});
