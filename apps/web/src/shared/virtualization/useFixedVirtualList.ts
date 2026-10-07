import { useCallback, useEffect, useRef, useState } from "react";

/** A fixed-height viewport: scrolling never mounts the entire collection. */
export function useFixedVirtualList(count: number, rowHeight: number, overscan = 5) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: rowHeight * 4 });
  const measure = useCallback(() => {
    const element = containerRef.current;
    if (element) setViewport({ top: element.scrollTop, height: element.clientHeight || rowHeight * 4 });
  }, [rowHeight]);
  useEffect(() => {
    measure();
    const element = containerRef.current;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (element) observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [measure]);
  const onScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);
  const scrollToIndex = useCallback((index: number) => {
    const element = containerRef.current;
    if (!element || index < 0) return;
    const top = index * rowHeight;
    const height = element.clientHeight || rowHeight * 4;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + height) element.scrollTop = top + rowHeight - height;
    measure();
  }, [measure, rowHeight]);
  const firstVisible = Math.floor(viewport.top / rowHeight);
  const start = Math.max(0, Math.min(count, firstVisible - overscan));
  const end = Math.min(count, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan + 1);
  return { containerRef, onScroll, scrollToIndex, start, end, totalHeight: count * rowHeight, viewportHeight: viewport.height };
}
