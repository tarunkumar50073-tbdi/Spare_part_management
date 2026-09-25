import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Opens ONE Server-Sent Events connection for the app and turns server pushes
// into React-Query cache invalidations plus a window event, so screens refresh
// live rather than only on their poll interval. If SSE can't connect it fails
// silently — the existing React-Query refetch intervals still cover the gap, and
// the browser auto-reconnects an EventSource on its own.
export default function useRealtime() {
  const qc = useQueryClient();
  useEffect(() => {
    let es;
    try {
      es = new EventSource("/api/v1/events/stream");
    } catch {
      return undefined;
    }
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "stock") {
        qc.invalidateQueries({ queryKey: ["spare-parts"] });
        qc.invalidateQueries({ queryKey: ["notifications"] });
      }
      // Pages that aren't on React Query yet (e.g. the dashboard) can listen for
      // this and refresh themselves.
      window.dispatchEvent(new CustomEvent("dx:realtime", { detail: msg }));
    };
    return () => { if (es) es.close(); };
  }, [qc]);
}
