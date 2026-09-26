import React from "react";
import { Link } from "react-router-dom";
import Modal from "../Modal.jsx";
import PartTimeline, { TIMELINE_LIMIT, usePartTimeline } from "../spare/PartTimeline.jsx";

// "View History" (spec 21): the part's full timeline — every receipt, GRN,
// quality clearance, issue, installation, return, inspection, RGP, label print
// and location move, newest first. Read through usePartTimeline, so a write
// here or a stock push from another terminal refreshes it, and the part
// drawer's trace shares the same cached copy.
export default function HistoryModal({ part, onClose }) {
  const { data, isPending, isError, refetch } = usePartTimeline(part.id);
  const rows = data?.rows || [];
  return (
    <Modal open onClose={onClose} size="xl" variant="drawer" title={`Part history — ${part.part_no}`}>
      {isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading the part history">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-14 w-full" />)}
        </div>
      ) : isError ? (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          Couldn&apos;t load this part&apos;s history.{" "}
          <button type="button" onClick={() => refetch()} className="font-semibold underline underline-offset-2">Retry</button>
        </div>
      ) : (
        <>
          <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
            {part.part_name ? `${part.part_name} · ` : ""}{rows.length} event{rows.length === 1 ? "" : "s"}, newest first.
            Events marked ERP were read from the ERP; everything else was recorded in this app.
          </p>
          <PartTimeline rows={rows} />
          {data?.has_more && (
            <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-navy-800 dark:text-slate-400">
              Showing the newest {TIMELINE_LIMIT} events. The{" "}
              <Link to={`/spare-part-history?part_id=${part.id}`} onClick={onClose} className="font-semibold text-toyotared hover:underline">Part Ledger</Link>{" "}
              has every stock movement of this part.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
