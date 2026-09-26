import React, { memo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ClipboardList } from "lucide-react";
import { spareFlowService } from "../../services/spareFlowService.js";
import { num } from "../../lib/format.js";

// What is waiting on the store as a whole — GRN / quality, return inspection,
// supplier rework, RGP GRN, fitter confirmation — as counts, with the Work
// Queue one click away. Kept small: the workstation is about the part in hand;
// the lists themselves live on the Work Queue. Under a "stock" key, so a stock
// push (another terminal's write) refreshes the counts too.
const COUNTS = [
  { key: "quality", label: "GRN / Quality" },
  { key: "inspection", label: "Inspection" },
  { key: "with_supplier", label: "With supplier" },
  { key: "rgp_grn_pending", label: "RGP GRN" },
  { key: "awaiting_confirmation", label: "Awaiting line / machine" },
];

function WorkQueueLink({ storeCode }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["stock", "flow-queues", storeCode],
    queryFn: () => spareFlowService.queues(storeCode).then((r) => r.data.data),
    enabled: Boolean(storeCode),
  });
  const counts = data?.counts || {};
  const total = COUNTS.reduce((s, c) => s + (Number(counts[c.key]) || 0), 0);
  return (
    <Link to="/work-queue"
      className="card card-interactive group block p-3.5"
      aria-label={isPending || isError ? "Open the Work Queue" : `Open the Work Queue — ${total} open items`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
            <ClipboardList size={16} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-sm font-semibold text-slate-800 dark:text-white">Work Queue</span>
            <span className="block text-[11px] leading-tight text-slate-400">
              {isPending ? "Loading…" : isError ? "Counts unavailable — open the queue" : total === 0 ? "Nothing waiting" : `${num(total)} waiting across the store`}
            </span>
          </span>
        </span>
        <ChevronRight size={16} className="text-slate-400 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
      {!isPending && !isError && total > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {COUNTS.filter((c) => Number(counts[c.key]) > 0).map((c) => (
            <span key={c.key} className="badge badge-warning gap-1">
              {c.label}<b className="tabular">{num(counts[c.key])}</b>
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

export default memo(WorkQueueLink);
