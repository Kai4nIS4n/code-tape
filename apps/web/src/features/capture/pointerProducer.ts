import type { CreatePointerProducer } from "./types";

const POINTER_MOVE_THROTTLE_MS = 30;

export const createPointerProducer: CreatePointerProducer = (deps) => {
  let active = false;
  let disposed = false;
  let host: HTMLElement | null = null;
  let lastMoveEmittedAt = -Infinity;

  const detach = () => {
    if (!host) return;
    host.removeEventListener("pointermove", handlePointerMove);
    host.removeEventListener("pointerdown", handlePointerDown);
    host = null;
  };

  const attachCurrentHost = () => {
    if (!active || disposed) return;
    const nextHost = deps.getHost();
    if (nextHost === host) return;
    detach();
    host = nextHost;
    if (!host) return;
    host.addEventListener("pointermove", handlePointerMove);
    host.addEventListener("pointerdown", handlePointerDown);
  };

  const payloadFromEvent = (event: PointerEvent) => {
    const currentHost = host;
    if (!currentHost) return null;
    const rect = currentHost.getBoundingClientRect();
    const containerWidth = rect.width;
    const containerHeight = rect.height;
    if (containerWidth <= 0 || containerHeight <= 0) return null;
    return {
      x: clamp(event.clientX - rect.left, 0, containerWidth),
      y: clamp(event.clientY - rect.top, 0, containerHeight),
      containerWidth,
      containerHeight,
    };
  };

  function handlePointerMove(event: PointerEvent) {
    attachCurrentHost();
    if (!active || disposed) return;
    if (event.currentTarget !== host) return;
    const emittedAt = event.timeStamp ?? Date.now();
    if (emittedAt - lastMoveEmittedAt < POINTER_MOVE_THROTTLE_MS) return;
    const payload = payloadFromEvent(event);
    if (!payload) return;
    lastMoveEmittedAt = emittedAt;
    deps.bus.emit({
      type: "mouse-move",
      source: "pointer",
      track: "ui",
      payload,
    });
  }

  function handlePointerDown(event: PointerEvent) {
    attachCurrentHost();
    if (!active || disposed || !isRecordedButton(event.button)) return;
    if (event.currentTarget !== host) return;
    const payload = payloadFromEvent(event);
    if (!payload) return;
    deps.bus.emit({
      type: "mouse-click",
      source: "pointer",
      track: "ui",
      payload: { ...payload, button: event.button },
    });
  }

  return {
    start() {
      if (disposed) return;
      active = true;
      lastMoveEmittedAt = -Infinity;
      attachCurrentHost();
    },
    pause() {
      active = false;
      detach();
    },
    resume() {
      if (disposed) return;
      active = true;
      attachCurrentHost();
    },
    stop() {
      active = false;
      detach();
    },
    dispose() {
      disposed = true;
      active = false;
      detach();
    },
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecordedButton(button: number): button is 0 | 1 | 2 {
  return button === 0 || button === 1 || button === 2;
}
