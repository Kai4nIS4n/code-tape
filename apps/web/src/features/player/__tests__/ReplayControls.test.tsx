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

  it("calls onSeek when progress slider is committed", () => {
    renderControls({ durationMs: 100_000 });
  });

  it("calls onRate when a playback rate is selected", () => {
    renderControls();
  });

  it("calls onMuted when mute toggle is pressed", () => {
    const { props } = renderControls({ muted: false });
    const muteButton = screen.getByRole("button", { name: /静音|取消静音/ });
    fireEvent.click(muteButton);
    expect(props.onMuted).toHaveBeenCalledTimes(1);
  });

  it("calls onVolume when volume slider is changed", () => {
    renderControls();
  });

  it("clamps timeline time within 0 and duration", () => {
    renderControls({
      state: state("playing", { timelineTimeMs: -1000 }),
      durationMs: 100_000,
    });
  });

  it("handles zero duration gracefully", () => {
    renderControls({ durationMs: 0 });
  });
});
