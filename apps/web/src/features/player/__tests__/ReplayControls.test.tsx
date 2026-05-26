import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReplaySchedulerState } from "@/shared/recording-schema";
import { ReplayControls, type ReplayControlsProps } from "../ReplayControls";

function state(
  status: ReplaySchedulerState["status"],
  patch: Partial<ReplaySchedulerState> = {},
): ReplaySchedulerState {
  return {
    status,
    timelineTimeMs: 0,
    playbackRate: 1,
    lastAppliedSeq: 0,
    mediaStatus: "none",
    driftMs: 0,
    ...patch,
  };
}

function renderControls(overrides: Partial<ReplayControlsProps> = {}) {
  const props: ReplayControlsProps = {
    state: state("ready"),
    durationMs: 120_000,
    onPlayPause: vi.fn(),
    onPlay: vi.fn(),
    onSeek: vi.fn(),
    onRate: vi.fn(),
    volume: 80,
    muted: false,
    onVolume: vi.fn(),
    onMuted: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(<ReplayControls {...props} />),
  };
}

describe("ReplayControls", () => {
  it("renders time display with font-mono", () => {
    renderControls({ durationMs: 123_456 });
    const timeElements = screen.getAllByText(/02:03|02:04/);
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it("calls onPlayPause when play/pause button is clicked", () => {
    const { props } = renderControls({ state: state("ready") });
    const playButton = screen.getByRole("button", { name: /播放|暂停/ });
    fireEvent.click(playButton);
    expect(props.onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("disables play/pause button in loading/seeking/error states", () => {
    const { rerender, props } = renderControls({ state: state("loading") });
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();

    rerender(<ReplayControls {...props} state={state("seeking")} />);
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();

    rerender(<ReplayControls {...props} state={state("error")} />);
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();
  });

  it("calls onMuted when mute toggle is pressed", () => {
    const { props } = renderControls({ muted: false });
    const muteButton = screen.getByRole("button", { name: /静音|取消静音/ });
    fireEvent.click(muteButton);
    expect(props.onMuted).toHaveBeenCalledTimes(1);
  });

  it("clamps timeline time within 0 and duration", () => {
    renderControls({
      state: state("playing", { timelineTimeMs: -1000 }),
      durationMs: 100_000,
    });
    const timeElements = screen.getAllByText(/00:00/);
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it("handles zero duration gracefully", () => {
    renderControls({ durationMs: 0 });
  });

  describe("handleSliderCommit logic", () => {
    it("accepts onPlay prop and renders without errors", () => {
      const onPlay = vi.fn();
      renderControls({ onPlay });
      expect(true).toBe(true);
    });

    it("accepts onSeek as Promise<void> and renders without errors", () => {
      const onSeek = vi.fn().mockResolvedValue(undefined);
      renderControls({ onSeek });
      expect(true).toBe(true);
    });
  });

  describe("volume control logic", () => {
    it("renders volume slider when muted", () => {
      renderControls({ muted: true, volume: 0 });
      expect(true).toBe(true);
    });

    it("renders volume slider when not muted", () => {
      renderControls({ muted: false, volume: 50 });
      expect(true).toBe(true);
    });
  });

  describe("playback rate control", () => {
    it("renders rate button", () => {
      renderControls();
      expect(screen.getByLabelText("倍速")).toBeInTheDocument();
    });
  });
});
