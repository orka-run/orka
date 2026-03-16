import { useCallback, useEffect, useState } from "react";

export const ITEM_HEIGHT = 48;
export const GAP = 4;
const STRIDE = ITEM_HEIGHT + GAP;
const BUFFER = 5;

export interface VirtualListResult<T> {
  /** Slice of visible items with their original indices */
  visibleItems: { item: T; index: number }[];
  /** Total height of the virtualized container in px */
  totalHeight: number;
  /** Y offset for the inner translated div */
  offsetY: number;
  /** Attach to the scroll container's onScroll */
  onScroll: (e: React.UIEvent<HTMLElement>) => void;
  /** Programmatically scroll an item into view */
  scrollToIndex: (index: number) => void;
}

export function useVirtualList<T>(
  items: T[],
  containerRef: React.RefObject<HTMLElement | null>,
): VirtualListResult<T> {
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setContainerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Use a generous fallback so the first frame renders enough items
  const height = containerHeight || 800;
  const startIndex = Math.max(0, Math.floor(scrollTop / STRIDE) - BUFFER);
  const endIndex = Math.min(
    items.length,
    Math.ceil((scrollTop + height) / STRIDE) + 1 + BUFFER,
  );

  const visibleItems: VirtualListResult<T>["visibleItems"] = [];
  for (let i = startIndex; i < endIndex; i++) {
    visibleItems.push({ item: items[i]!, index: i });
  }

  const totalHeight = items.length > 0 ? items.length * STRIDE - GAP : 0;
  const offsetY = startIndex * STRIDE;

  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = containerRef.current;
      if (!el || index < 0) return;
      const itemTop = index * STRIDE;
      const itemBottom = itemTop + ITEM_HEIGHT;
      if (itemTop < el.scrollTop) {
        el.scrollTop = itemTop;
      } else if (itemBottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = itemBottom - el.clientHeight;
      }
    },
    [containerRef],
  );

  return { visibleItems, totalHeight, offsetY, onScroll, scrollToIndex };
}
