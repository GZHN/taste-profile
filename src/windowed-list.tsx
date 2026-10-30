import React, { useEffect, useRef, useState } from "react";

type WindowedListProps<T> = {
  items: T[];
  /** Fixed row height in pixels. Playlist list rows are 64, compact rows 38. */
  rowHeight: number;
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
};

const OVERSCAN = 8;

function scrollport(anchor: HTMLElement): { top: number; height: number } {
  let current = anchor.parentElement;
  while (current && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const scrolls = /(auto|scroll)/.test(style.overflowY);
    if (scrolls && current.clientHeight + 1 < current.scrollHeight) {
      const box = current.getBoundingClientRect();
      return { top: box.top, height: Math.max(box.height, 1) };
    }
    current = current.parentElement;
  }
  return { top: 0, height: window.innerHeight };
}

function visibleRange(listTop: number, viewHeight: number, rowHeight: number, count: number): { start: number; end: number } {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(-listTop / rowHeight) - OVERSCAN);
  const end = Math.min(count, Math.ceil((-listTop + viewHeight) / rowHeight) + OVERSCAN);
  return { start, end: Math.max(start, end) };
}

/**
 * Renders only the rows that intersect the scrollport. Scroll listeners sit on
 * `document` in the capture phase so a Spotify parent scroller is included.
 * Spacers keep the scrollbar length stable. Row menus must not be clipped, so
 * this list does not set overflow.
 */
export function WindowedList<T>({ items, rowHeight, getKey, renderItem }: WindowedListProps<T>) {
  const anchorRef = useRef<HTMLLIElement>(null);
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(items.length, 40) }));

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    let frame = 0;

    const update = () => {
      const port = scrollport(anchor);
      const listTop = anchor.getBoundingClientRect().top - port.top;
      const next = visibleRange(listTop, port.height, rowHeight, items.length);
      setRange((current) => (current.start === next.start && current.end === next.end ? current : next));
    };

    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [items.length, rowHeight]);

  const start = Math.min(range.start, items.length);
  const end = Math.max(start, Math.min(range.end, items.length));

  return (
    <>
      <li ref={anchorRef} className="taste__window-spacer" style={{ height: start * rowHeight }} aria-hidden="true" />
      {items.slice(start, end).map((item) => (
        <React.Fragment key={getKey(item)}>{renderItem(item)}</React.Fragment>
      ))}
      <li className="taste__window-spacer" style={{ height: Math.max(0, items.length - end) * rowHeight }} aria-hidden="true" />
    </>
  );
}
