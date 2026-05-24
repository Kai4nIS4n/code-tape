import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaRecorderWrapper } from "../mediaRecorder";

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);

  state: RecordingState = "inactive";
  private listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(_stream: MediaStream, public options: MediaRecorderOptions) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  start(): void {
    this.state = "recording";
  }

  pause(): void {
    this.state = "paused";
  }

  resume(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      listener(new Event("stop"));
    }
  }
}

function makeStream(): MediaStream {
  return {
    getTracks: () => [],
    getAudioTracks: () => [{ kind: "audio" }] as MediaStreamTrack[],
    getVideoTracks: () => [] as MediaStreamTrack[],
  } as unknown as MediaStream;
}

describe("createMediaRecorderWrapper", () => {
  const originalMediaRecorder = globalThis.MediaRecorder;

  afterEach(() => {
    globalThis.MediaRecorder = originalMediaRecorder;
  });

  it("excludes paused wall time from durationMs", async () => {
    let now = 1_000;
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    const wrapper = createMediaRecorderWrapper({ nowProvider: () => now });

    await wrapper.start(makeStream());
    now += 1_000;
    wrapper.pause();
    now += 30_000;
    wrapper.resume();
    now += 500;
    const result = await wrapper.stop();

    expect(result.durationMs).toBe(1_500);
  });
});
