import assert from "node:assert/strict";
import test from "node:test";
import { decodeCollaborationFrame, encodeCollaborationFrame, type CollaborationFrame } from "./collaborationProtocol.js";

test("binary frames preserve updates, epoch, durable revision and Unicode IDs", () => {
  const frames: CollaborationFrame[] = [
    { type: "state-vector", data: Uint8Array.from([1, 2]) },
    { type: "update", epoch: 128, updateId: "update-你好", data: Uint8Array.from([0, 255, 1]) },
    { type: "awareness", data: Uint8Array.from([1]) },
    { type: "sync", epoch: 3, persistedRevision: 65536, data: Uint8Array.from([3, 1]) },
  ];
  for (const frame of frames) assert.deepEqual(decodeCollaborationFrame(encodeCollaborationFrame(frame)), frame);
});

test("binary decoder rejects truncated, unknown and trailing frames", () => {
  for (const data of [[1], [0, 10, 1], [9, 0], [0, 0, 1]]) assert.throws(() => decodeCollaborationFrame(Uint8Array.from(data)));
});
