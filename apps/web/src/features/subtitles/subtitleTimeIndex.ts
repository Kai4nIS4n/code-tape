import type { SubtitleSegment } from "./types";

type Interval = { startMs: number; endMs: number; segmentIndex: number };
/** Overlaps keep the earliest original segment, matching the existing UI rule. */
export function buildSubtitleTimeIndex(segments: SubtitleSegment[]): Interval[] {
  const points = segments
    .flatMap((segment, index) =>
      Number.isFinite(segment.startMs) &&
      Number.isFinite(segment.endMs) &&
      segment.endMs > segment.startMs
        ? [
            { time: segment.startMs, index, start: true },
            { time: segment.endMs, index, start: false },
          ]
        : [],
    )
    .sort((a, b) => a.time - b.time || Number(a.start) - Number(b.start));
  const active = new Set<number>();
  const heap: number[] = [];
  const push = (value: number) => {
    let i = heap.length;
    heap.push(value);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heap[parent] <= value) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = value;
  };
  const pop = () => {
    const last = heap.pop();
    if (!heap.length || last === undefined) return;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1] < heap[child]) child += 1;
      if (heap[child] >= last) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
  };
  const result: Interval[] = [];
  for (let cursor = 0; cursor < points.length; ) {
    const time = points[cursor].time;
    while (cursor < points.length && points[cursor].time === time) {
      const point = points[cursor++];
      if (point.start) {
        active.add(point.index);
        push(point.index);
      } else active.delete(point.index);
    }
    while (heap.length && !active.has(heap[0])) pop();
    const endMs = points[cursor]?.time;
    if (heap.length && endMs !== undefined && endMs > time)
      result.push({ startMs: time, endMs, segmentIndex: heap[0] });
  }
  return result;
}
export function findActiveSubtitleIndex(index: Interval[], timeMs: number): number {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid].startMs <= timeMs) lo = mid + 1;
    else hi = mid;
  }
  const interval = index[lo - 1];
  return interval && timeMs < interval.endMs ? interval.segmentIndex : -1;
}
