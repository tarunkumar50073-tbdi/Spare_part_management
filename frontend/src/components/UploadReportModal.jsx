import React from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import Modal from "./Modal.jsx";

/** Success/error report shown after a bulk Excel import — every master
 * page uses the same shape: {total_rows, created, error_count, errors}. */
export default function UploadReportModal({ report, onClose }) {
  if (!report) return null;
  const { total_rows, created, error_count, errors = [] } = report;

  return (
    <Modal
      open={!!report}
      onClose={onClose}
      title="Import Report"
      footer={<button className="btn-primary" onClick={onClose}>Close</button>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 size={16} /> {created} imported
          </span>
          {error_count > 0 && (
            <span className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 font-medium">
              <AlertTriangle size={16} /> {error_count} skipped
            </span>
          )}
          <span className="text-slate-400">of {total_rows} rows</span>
        </div>
        {errors.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-navy-800">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-navy-800 text-slate-600 dark:text-slate-300 sticky top-0">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Row</th>
                  <th className="text-left font-semibold px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {errors.map((e, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 whitespace-nowrap">{e.row}</td>
                    <td className="px-3 py-2">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
