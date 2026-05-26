import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import { createPointerProducer } from "../pointerProducer";

function setup() {
  const clock = createRecordingClock({ nowProvider: () => 1000 });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  clock.start();
  return { bus, clock };
}

function hostRect(host: HTMLElement, rect: Partial<DOMRect>) {
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    top: rect.top ?? 0,
    left: rect.left ?? 0,
    right: (rect.left ?? 0) + (rect.width ?? 0),
    bottom: (rect.top ?? 0) + (rect.height ?? 0),
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function pointer(type: string, init: PointerEventInit & { timeStamp?: number }) {
  const event = new MouseEvent(type, {
    bubbles: true,
    ...init,
  }) as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: 1 });
  if (init.timeStamp !== undefined) {
    Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
  }
  return event;
}

describe("createPointerProducer", () => {
  it("emits throttled mouse-move payloads relative to the current host", () => {
    const { bus, clock } = setup();
    const host = document.createElement("div");
    hostRect(host, { left: 10, top: 20, width: 300, height: 200 });
    const producer = createPointerProducer({ bus, clock, getHost: () => host });
    producer.start();

    host.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 70, timeStamp: 1 }));
    host.dispatchEvent(pointer("pointermove", { clientX: 80, clientY: 100, timeStamp: 10 }));
    host.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 110, timeStamp: 31 }));

    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "mouse-move",
        payload: { x: 30, y: 50, containerWidth: 300, containerHeight: 200 },
      },
      {
        type: "mouse-move",
        payload: { x: 80, y: 90, containerWidth: 300, containerHeight: 200 },
      },
    ]);
  });

  it("emits mouse-click with left, middle, and right button values", () => {
    const { bus, clock } = setup();
    const host = document.createElement("div");
    hostRect(host, { left: 5, top: 10, width: 100, height: 80 });
    const producer = createPointerProducer({ bus, clock, getHost: () => host });
    producer.start();

    host.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 6, clientY: 11 }));
    host.dispatchEvent(pointer("pointerdown", { button: 1, clientX: 50, clientY: 50 }));
    host.dispatchEvent(pointer("pointerdown", { button: 2, clientX: 500, clientY: 500 }));
    host.dispatchEvent(pointer("pointerdown", { button: 3, clientX: 8, clientY: 12 }));

    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "mouse-click",
        payload: { x: 1, y: 1, containerWidth: 100, containerHeight: 80, button: 0 },
      },
      {
        type: "mouse-click",
        payload: { x: 45, y: 40, containerWidth: 100, containerHeight: 80, button: 1 },
      },
      {
        type: "mouse-click",
        payload: { x: 100, y: 80, containerWidth: 100, containerHeight: 80, button: 2 },
      },
    ]);
  });

  it("handles null and changing hosts safely", () => {
    const { bus, clock } = setup();
    const first = document.createElement("div");
    const second = document.createElement("div");
    hostRect(first, { left: 0, top: 0, width: 100, height: 100 });
    hostRect(second, { left: 100, top: 200, width: 50, height: 60 });
    let host: HTMLElement | null = null;
    const producer = createPointerProducer({ bus, clock, getHost: () => host });

    producer.start();
    host = first;
    producer.resume();
    first.dispatchEvent(pointer("pointermove", { clientX: 10, clientY: 20 }));
    host = second;
    first.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 15, clientY: 25 }));
    second.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 120, clientY: 230 }));

    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "mouse-move",
        payload: { x: 10, y: 20, containerWidth: 100, containerHeight: 100 },
      },
      {
        type: "mouse-click",
        payload: { x: 20, y: 30, containerWidth: 50, containerHeight: 60, button: 0 },
      },
    ]);
  });

  it("stops collecting during pause, resumes, and disposes listeners", () => {
    const { bus, clock } = setup();
    const host = document.createElement("div");
    hostRect(host, { left: 0, top: 0, width: 100, height: 100 });
    const producer = createPointerProducer({ bus, clock, getHost: () => host });
    producer.start();
    producer.pause();
    host.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
    producer.resume();
    host.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 20, clientY: 20 }));
    producer.dispose();
    host.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 30, clientY: 30 }));

    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "mouse-click",
        payload: { x: 20, y: 20, containerWidth: 100, containerHeight: 100, button: 0 },
      },
    ]);
  });
});
