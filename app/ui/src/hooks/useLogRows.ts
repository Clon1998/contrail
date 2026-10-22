import { useCallback, useRef, useState } from "react";
import { commands, type LogEvent } from "@/bindings";

/** Rows are fetched from the Rust buffer in pages of this size. */
export const PAGE_SIZE = 500;

const NO_PAGES = new Map<number, LogEvent[]>();

/**
 * The rows of a log view, loaded page by page as the list asks for them. Only pages that were
 * on screen are kept; the buffer itself stays in Rust.
 */
export function useLogRows(viewId: number | null) {
  // The pages remember which view they belong to: a new view simply finds none (no effect needed
  // to reset them).
  const [loaded, setLoaded] = useState<{ viewId: number | null; pages: Map<number, LogEvent[]> }>({
    viewId,
    pages: NO_PAGES,
  });
  const pages = loaded.viewId === viewId ? loaded.pages : NO_PAGES;
  // Pages being fetched right now, as "view:page" (a ref: changing it must not re-render).
  const inFlight = useRef(new Set<string>());

  /** Makes sure the rows `from..=to` are (being) loaded. */
  const ensure = useCallback(
    (from: number, to: number) => {
      if (viewId === null) return;
      for (let page = Math.floor(from / PAGE_SIZE); page <= Math.floor(to / PAGE_SIZE); page++) {
        const key = `${viewId}:${page}`;
        if (pages.has(page) || inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        void commands.getLogRows(viewId, page * PAGE_SIZE, PAGE_SIZE).then((result) => {
          inFlight.current.delete(key);
          if (result.status !== "ok") return;
          setLoaded((previous) => ({
            viewId,
            pages: new Map(previous.viewId === viewId ? previous.pages : NO_PAGES).set(
              page,
              result.data,
            ),
          }));
        });
      }
    },
    [viewId, pages],
  );

  const row = useCallback(
    (index: number): LogEvent | undefined =>
      pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE],
    [pages],
  );

  return { row, ensure };
}
