import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RecordingEvent } from "@/shared/recording-schema";
import { useFixedVirtualList } from "@/shared/virtualization/useFixedVirtualList";
import { findStableEventIndexAtMost } from "./replayIndex";

type Filter = "important" | "all" | "edit" | "run" | "shortcut" | "chapter";
const IMPORTANT = new Set([
  "content-change",
  "language-change",
  "run-start",
  "run-output",
  "run-error",
  "shortcut",
  "chapter-marker",
]);
const TYPE_LABELS: Record<string, string> = {
  "content-change": "编辑",
  "language-change": "语言",
  "run-start": "运行",
  "run-output": "输出",
  "run-error": "错误",
  shortcut: "快捷键",
  "chapter-marker": "章节",
};

export function EventTimeline({
  events,
  currentTimeMs,
  onSeek,
  renderAll = false,
}: {
  events: RecordingEvent[];
  currentTimeMs: number;
  onSeek(timeMs: number): void;
  /** Performance-build A/B control. Normal routes never enable this. */
  renderAll?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("important");
  const [following, setFollowing] = useState(true);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const focusPendingRef = useRef(false);
  const rows = useMemo(
    () =>
      events
        .filter(
          (event) =>
            filter === "all" ||
            (filter === "important"
              ? IMPORTANT.has(event.type)
              : filter === "edit"
                ? event.type === "content-change" || event.type === "language-change"
                : filter === "run"
                  ? event.type.startsWith("run-")
                  : filter === "chapter"
                    ? event.type === "chapter-marker"
                    : event.type === "shortcut"),
        )
        .slice()
        .sort((a, b) => a.timestampMs - b.timestampMs || a.seq - b.seq)
        .map((event) => ({ event, summary: summarizeEvent(event) })),
    [events, filter],
  );
  const eventRows = useMemo(() => rows.map((row) => row.event), [rows]);
  const activeIndex = findStableEventIndexAtMost(eventRows, currentTimeMs);
  const virtual = useFixedVirtualList(rows.length, 48);
  const { scrollToIndex } = virtual;
  useEffect(() => {
    if (following) scrollToIndex(activeIndex);
  }, [activeIndex, following, scrollToIndex]);
  useEffect(() => {
    if (!focusPendingRef.current) return;
    const element = virtual.containerRef.current?.querySelector<HTMLButtonElement>(
      `[data-timeline-index="${focusedIndex}"]`,
    );
    if (element) {
      element.focus();
      focusPendingRef.current = false;
    }
  }, [focusedIndex, virtual.start, virtual.end, virtual.containerRef]);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, focusedIndex + delta));
    setFollowing(false);
    focusPendingRef.current = true;
    virtual.scrollToIndex(index);
    setFocusedIndex(index);
  };
  const selected = useMemo(
    () => rows.find((row) => row.event.id === selectedId),
    [rows, selectedId],
  );
  const handleScroll = () => {
    const element = virtual.containerRef.current;
    const focused = document.activeElement;
    if (element && focused instanceof HTMLButtonElement && element.contains(focused)) {
      const top = focusedIndex * 48;
      if (
        top < element.scrollTop - 5 * 48 ||
        top > element.scrollTop + (element.clientHeight || virtual.viewportHeight) + 5 * 48
      )
        element.focus();
    }
    virtual.onScroll();
  };
  return (
    <aside
      aria-label="事件时间轴"
      className="flex min-h-0 w-full flex-col border-l border-border bg-background md:w-72 md:shrink-0"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border p-2 text-xs">
        <span>事件 · {rows.length}</span>
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
            virtual.scrollToIndex(activeIndex);
          }}
          className="rounded px-2 py-1 hover:bg-surface"
          aria-pressed={following}
        >
          回到当前
        </button>
      </div>
      <label className="px-2 py-1 text-xs">
        筛选{" "}
        <select
          aria-label="事件筛选"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as Filter);
            setFocusedIndex(0);
          }}
          className="rounded border border-border bg-surface px-1 py-1"
        >
          <option value="important">重要事件</option>
          <option value="all">全部事件</option>
          <option value="edit">编辑</option>
          <option value="run">运行与错误</option>
          <option value="shortcut">快捷键</option>
          <option value="chapter">章节</option>
        </select>
      </label>
      <div
        ref={virtual.containerRef}
        data-testid="event-timeline-viewport"
        data-viewport-height={virtual.viewportHeight}
        role="list"
        aria-label="录制事件"
        tabIndex={0}
        onKeyDown={navigate}
        onWheel={() => setFollowing(false)}
        onPointerDown={() => setFollowing(false)}
        onScroll={handleScroll}
        className="relative min-h-48 flex-1 overflow-y-auto overscroll-contain"
      >
        <div style={{ height: virtual.totalHeight, position: "relative" }}>
          {rows
            .slice(renderAll ? 0 : virtual.start, renderAll ? rows.length : virtual.end)
            .map(({ event, summary }, offset) => {
              const index = (renderAll ? 0 : virtual.start) + offset;
              return (
                <div
                  key={event.id}
                  role="listitem"
                  aria-posinset={index + 1}
                  aria-setsize={rows.length}
                  style={{ position: "absolute", top: index * 48, height: 48, left: 0, right: 0 }}
                >
                  <button
                    type="button"
                    data-testid="event-timeline-row"
                    data-timeline-index={index}
                    aria-current={activeIndex === index ? "true" : undefined}
                    tabIndex={focusedIndex === index ? 0 : -1}
                    onFocus={() => setFocusedIndex(index)}
                    onClick={() => {
                      setSelectedId(event.id);
                      onSeek(event.timestampMs);
                    }}
                    className={`flex h-full w-full flex-col justify-center border-b border-border/50 px-2 text-left text-xs hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${activeIndex === index ? "bg-surface-raised" : ""}`}
                  >
                    <span className="truncate text-muted">
                      {formatTime(event.timestampMs)} · #{event.seq} ·{" "}
                      {TYPE_LABELS[event.type] ?? event.type}
                    </span>
                    <span className="truncate">{summary}</span>
                  </button>
                </div>
              );
            })}
        </div>
      </div>
      {selected ? (
        <p
          data-testid="event-timeline-detail"
          className="max-h-24 overflow-y-auto border-t border-border p-2 text-xs break-words"
        >
          #{selected.event.seq} · {selected.summary}
        </p>
      ) : null}
    </aside>
  );
}

function summarizeEvent(event: RecordingEvent): string {
  if (event.type === "content-change")
    return `${event.payload.language} · v${event.payload.version} · ${event.payload.changeCount} 次变化`;
  if (event.type === "language-change") return event.payload.to;
  if (event.type === "shortcut") return event.payload.label;
  if (event.type === "chapter-marker") return event.payload.title;
  if (event.type === "run-error") return event.payload.message.slice(0, 140);
  if (event.type === "run-output")
    return [...event.payload.stdout, ...event.payload.stderr].join(" · ").slice(0, 140);
  return TYPE_LABELS[event.type] ?? event.type;
}
function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
