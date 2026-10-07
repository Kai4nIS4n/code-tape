/** Application framing around Yjs updates. No Yjs or browser dependency. */
export type CollaborationFrame =
  | { type: "state-vector"; data: Uint8Array }
  | { type: "update"; epoch: number; updateId: string; data: Uint8Array }
  | { type: "awareness"; data: Uint8Array }
  | { type: "sync"; epoch: number; persistedRevision: number; data: Uint8Array };

export const COLLABORATION_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const COLLABORATION_MAX_UPDATE_BYTES = 256 * 1024;

export function encodeCollaborationFrame(frame: CollaborationFrame): Uint8Array {
  const bytes: number[] = [];
  const writeNumber = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid frame integer");
    while (value > 127) {
      bytes.push((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  };
  const writeBytes = (value: Uint8Array) => {
    writeNumber(value.length);
    for (const byte of value) bytes.push(byte);
  };
  switch (frame.type) {
    case "state-vector": writeNumber(0); break;
    case "update":
      writeNumber(1);
      writeNumber(frame.epoch);
      writeBytes(new TextEncoder().encode(frame.updateId));
      break;
    case "awareness": writeNumber(2); break;
    case "sync":
      writeNumber(3);
      writeNumber(frame.epoch);
      writeNumber(frame.persistedRevision);
      break;
  }
  writeBytes(frame.data);
  if (bytes.length > COLLABORATION_MAX_FRAME_BYTES) throw new Error("Collaboration frame too large");
  return Uint8Array.from(bytes);
}

export function decodeCollaborationFrame(bytes: Uint8Array): CollaborationFrame {
  if (bytes.length > COLLABORATION_MAX_FRAME_BYTES) throw new Error("Collaboration frame too large");
  let offset = 0;
  const readNumber = () => {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      if (offset >= bytes.length) throw new Error("Truncated collaboration frame");
      const byte = bytes[offset++];
      value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error("Invalid frame integer");
      if (byte < 128) return value;
      multiplier *= 128;
    }
    throw new Error("Invalid frame integer");
  };
  const readBytes = () => {
    const size = readNumber();
    if (size > bytes.length - offset) throw new Error("Truncated collaboration frame");
    const data = bytes.slice(offset, offset + size);
    offset += size;
    return data;
  };
  const kind = readNumber();
  let frame: CollaborationFrame;
  switch (kind) {
    case 0: frame = { type: "state-vector", data: readBytes() }; break;
    case 1: {
      const epoch = readNumber();
      const updateId = new TextDecoder("utf-8", { fatal: true }).decode(readBytes());
      if (updateId.length < 1 || updateId.length > 128) throw new Error("Invalid update ID");
      frame = { type: "update", epoch, updateId, data: readBytes() };
      break;
    }
    case 2: frame = { type: "awareness", data: readBytes() }; break;
    case 3: frame = { type: "sync", epoch: readNumber(), persistedRevision: readNumber(), data: readBytes() }; break;
    default: throw new Error("Unknown collaboration frame type");
  }
  if (offset !== bytes.length) throw new Error("Trailing collaboration frame data");
  return frame;
}
