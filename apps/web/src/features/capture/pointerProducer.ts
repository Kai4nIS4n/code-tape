import type { CreatePointerProducer } from "./types";

const POINTER_MOVE_THROTTLE_MS = 30;
const TARGET_REFRESH_MS = 16;

export const createPointerProducer: CreatePointerProducer = (deps) => {
  let active = false;
  let disposed = false;
  let host: HTMLElement | null = null;
  let documentTarget: Document | null = null;
  let lastMoveEmittedAt = -Infinity;
  let refreshTimer: number | null = null;

  const stopRefreshTimer = () => {
    if (refreshTimer === null) return;
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  };

  const startRefreshTimer = () => {
    if (refreshTimer !== null) return;
    refreshTimer = window.setInterval(attachCurrentHost, TARGET_REFRESH_MS);
  };

  const detach = () => {
    if (documentTarget) {
      documentTarget.removeEventListener("pointermove", handlePointerMove, true);
      documentTarget.removeEventListener("pointerdown", handlePointerDown, true);
      documentTarget = null;
    }
    host = null;
  };

  const attachCurrentHost = () => {
    if (!active || disposed) return;
    const nextHost = deps.getHost();
    const nextDocument = nextHost?.ownerDocument ?? null;
    if (nextDocument !== documentTarget) {
      if (documentTarget) {
        documentTarget.removeEventListener("pointermove", handlePointerMove, true);
        documentTarget.removeEventListener("pointerdown", handlePointerDown, true);
      }
      documentTarget = nextDocument;
      documentTarget?.addEventListener("pointermove", handlePointerMove, true);
      documentTarget?.addEventListener("pointerdown", handlePointerDown, true);
    }
    if (nextHost === host) return;
    lastMoveEmittedAt = -Infinity;
    host = nextHost;
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

  const isInsideHost = (event: Event): boolean => {
    const currentHost = host;
    const target = event.target;
    return Boolean(currentHost && isNodeTarget(target) && currentHost.contains(target));
  };

  function handlePointerMove(event: PointerEvent) {
    attachCurrentHost();
    if (!active || disposed) return;
    if (!isInsideHost(event)) return;
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
    if (!isInsideHost(event)) return;
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
      startRefreshTimer();
    },
    pause() {
      active = false;
      stopRefreshTimer();
      detach();
    },
    resume() {
      if (disposed) return;
      active = true;
      lastMoveEmittedAt = -Infinity;
      attachCurrentHost();
      startRefreshTimer();
    },
    stop() {
      active = false;
      stopRefreshTimer();
      detach();
    },
    dispose() {
      disposed = true;
      active = false;
      stopRefreshTimer();
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

function isNodeTarget(target: EventTarget | null): target is Node {
  return Boolean(target && typeof (target as Node).nodeType === "number");
}
