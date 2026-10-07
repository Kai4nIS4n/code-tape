import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecordingEvent } from "@/shared/recording-schema";
import { EventTimeline } from "../EventTimeline";

function events(count: number): RecordingEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e-${index}`,
    seq: index + 1,
    timestampMs: index * 100,
    source: "shortcut",
    track: "ui",
    type: "shortcut",
    payload: { keys: ["Ctrl", "S"], label: `保存 ${index}` },
  }));
}
describe("EventTimeline", () => {
  it("offers the identical full-render list only as an explicit performance A/B control", () => {
    render(<EventTimeline events={events(2001)} currentTimeMs={0} onSeek={() => {}} renderAll />);
    expect(screen.getAllByTestId("event-timeline-row")).toHaveLength(2001);
  });
  it("caps mounted rows for 2,001 events and supports logical keyboard focus", async () => {
    const onSeek = vi.fn();
    render(<EventTimeline events={events(2001)} currentTimeMs={0} onSeek={onSeek} />);
    const viewport = screen.getByTestId("event-timeline-viewport");
    expect(screen.getAllByTestId("event-timeline-row").length).toBeLessThanOrEqual(16);
    fireEvent.keyDown(viewport, { key: "End" });
    await waitFor(() => expect(screen.getByRole("button", { name: /保存 2000$/ })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: /保存 2000$/ }));
    expect(onSeek).toHaveBeenCalledWith(200000);
    expect(screen.getAllByTestId("event-timeline-row").length).toBeLessThanOrEqual(16);
    fireEvent.change(screen.getByLabelText("事件筛选"), { target: { value: "run" } });
    expect(screen.queryAllByTestId("event-timeline-row")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("事件筛选"), { target: { value: "important" } });
    expect(screen.getByRole("button", { name: /保存 0$/ })).toBeInTheDocument();
  });
  it("manual scroll stops follow until the user returns to the current event", () => {
    const { rerender } = render(
      <EventTimeline events={events(2001)} currentTimeMs={0} onSeek={() => {}} />,
    );
    fireEvent.wheel(screen.getByTestId("event-timeline-viewport"));
    rerender(<EventTimeline events={events(2001)} currentTimeMs={199000} onSeek={() => {}} />);
    expect(screen.getByRole("button", { name: "回到当前" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "回到当前" }));
    expect(screen.getByRole("button", { name: "回到当前" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /保存 1990$/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
