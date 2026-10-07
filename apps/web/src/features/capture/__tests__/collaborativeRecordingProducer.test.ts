import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createCollaborativeRecordingProducer } from "../collaborativeRecordingProducer";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import type { CollaborationSession } from "@/features/collaboration/collaborationSession";

afterEach(() => vi.useRealTimers());
function fixture() {
  const doc = new Y.Doc();
  const session = { getText: (language: string) => doc.getText(`source:${language}`) } as CollaborationSession;
  const clock = createRecordingClock(); clock.start();
  const bus = createEventBus({ clock });
  const producer = createCollaborativeRecordingProducer({ session, bus, clock, getCurrentLanguage: () => "javascript" });
  producer.start();
  return { doc, session, bus, producer };
}
describe("candidate's sole collaborative content producer", () => {
  it("records inactive HTML without switching JS and gives each document independent debounce", () => {
    vi.useFakeTimers(); const { doc, session, bus, producer } = fixture();
    session.getText("html").insert(0, "<h1>Hello</h1>");
    vi.advanceTimersByTime(200);
    session.getText("javascript").insert(0, "console.log(1)");
    vi.advanceTimersByTime(100);
    expect(bus.peek()).toHaveLength(1);
    expect(bus.peek()[0]).toMatchObject({ type: "content-change", payload: { language: "html", documentId: "source:html", flushedBy: "debounce" } });
    vi.advanceTimersByTime(200);
    expect(bus.peek()).toHaveLength(2);
    producer.dispose(); doc.destroy();
  });
  it("flushes continuous input at the one-second maximum and at an explicit snapshot boundary", () => {
    vi.useFakeTimers(); const { doc, session, bus, producer } = fixture();
    for (let index = 0; index < 5; index += 1) { session.getText("css").insert(index, "a"); vi.advanceTimersByTime(200); }
    expect(bus.peek()[0]).toMatchObject({ payload: { code: "aaaaa", flushedBy: "idle" } });
    session.getText("html").insert(0, "latest"); producer.flushPending("snapshot");
    expect(bus.peek()[1]).toMatchObject({ payload: { code: "latest", flushedBy: "snapshot" } });
    producer.stop(); session.getText("html").insert(0, "late"); vi.advanceTimersByTime(1000);
    expect(bus.peek()).toHaveLength(2);
    producer.dispose(); doc.destroy();
  });
});
