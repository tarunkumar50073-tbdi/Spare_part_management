import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { stockKeys } from "../lib/stockQueries.js";

// Opens ONE Server-Sent Events connection for the app and turns server pushes
// into React-Query cache invalidations plus a window event, so screens refresh
// live rather than only on their poll interval. If SSE can't connect it fails
// silently — the existing React-Query refetch intervals still cover the gap, and
// the browser auto-reconnects an EventSource on its own.
//
// Stock pushes are debounced: an issue followed by its confirmation, or a
// burst of counts, arrives as several events a moment apart, and every open
// stock screen should refetch once for the lot, not once per event.
const STOCK_DEBOUNCE_MS = 800;

export default function useRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    let es;
    let timer;
    try {
      es = new EventSource("/api/v1/events/stream");
    } catch {
      return undefined;
    }
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "stock") {
        clearTimeout(timer);
        timer = setTimeout(() => {
          // Every stock screen's queries live under ["stock", …] — one call
          // refreshes the lists, summaries, ops, ledgers and supplier values.
          qc.invalidateQueries({ queryKey: stockKeys.all });
          qc.invalidateQueries({ queryKey: ["notifications"] });
        }, STOCK_DEBOUNCE_MS);
      }
      // For screens outside the query cache (the Live Dashboard wallboard runs
      // its own loaders) — they listen for this and refresh themselves.
      window.dispatchEvent(new CustomEvent("dx:realtime", { detail: msg }));
    };
    return () => {
      clearTimeout(timer);
      if (es) es.close();
    };
  }, [qc]);
}
