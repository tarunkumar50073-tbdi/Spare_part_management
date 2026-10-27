import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import Modal from "./Modal.jsx";
import { partService } from "../services/partService.js";
import { downloadXlsx } from "../utils/excel.js";
import { parseServerTime } from "../lib/format.js";

// Part-master import with a preview step (spec §2): parse + validate first,
// show the planned action per row (INSERT / UPDATE / ERROR) and counts, let the
// user download the rejected rows and confirm before anything is written. After
// commit it shows the granular outcome and recent import history.
const ACTION_CLASS = {
  INSERT: "text-emerald-600 dark:text-emerald-400",
  UPDATE: "text-blue-600 dark:text-blue-400",
  ERROR: "text-rose-600 dark:text-rose-400",
};

// Rejected rows go out as a real .xlsx (like every other download in the app),
// not a CSV — `rows` are objects keyed by header.
function downloadRows(name, rows, headers) {
  downloadXlsx(name, headers, rows.map((r) => headers.map((h) => r[h] ?? "")), "Rejected");
}

export default function PartImportModal({ file, storeCode, sectionId, onClose, onImported }) {
  const [phase, setPhase] = useState("loading"); // loading | preview | importing | done
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!file) return;
    setPhase("loading"); setPreview(null); setResult(null);
    partService.previewImport(file, { store_code: storeCode })
      .then((r) => { setPreview(r.data.data); setPhase("preview"); })
      .catch(() => onClose());
    partService.importHistory(8).then((r) => setHistory(r.data.data || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const confirm = async () => {
    setPhase("importing");
    try {
      const r = await partService.import(file, { store_code: storeCode, section_id: sectionId });
      setResult(r.data.data);
      setPhase("done");
      toast.success("Import complete");
      onImported?.();
    } catch {
      setPhase("preview");
    }
  };

  const counts = preview?.counts || { insert: 0, update: 0, error: 0 };
  const rejected = (preview?.rows || []).filter((r) => r.action === "ERROR");
  const downloadRejected = () =>
    downloadRows("rejected_rows",
      rejected.map((r) => ({ Row: r.row, "Part No": r.part_no, "Part Name": r.part_name, Reason: r.reason })),
      ["Row", "Part No", "Part Name", "Reason"]);

  const footer = phase === "done" ? (
    <button className="btn-primary" onClick={onClose}>Close</button>
  ) : (
    <div className="flex gap-2">
      {rejected.length > 0 && <button className="btn-secondary" onClick={downloadRejected}>Download rejected ({rejected.length})</button>}
      <button className="btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn-primary" disabled={phase !== "preview"} onClick={confirm}>
        {phase === "importing" ? "Importing…" : `Confirm import (${counts.insert} add · ${counts.update} update)`}
      </button>
    </div>
  );

  return (
    <Modal open={!!file} onClose={onClose} title="Import Parts" size="xl" footer={footer}>
      {phase === "loading" && <p className="py-6 text-center text-slate-500">Reading file…</p>}

      {phase !== "loading" && phase !== "done" && preview && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm font-semibold">
            <span className="text-emerald-600 dark:text-emerald-400">{counts.insert} new</span>
            <span className="text-blue-600 dark:text-blue-400">{counts.update} update</span>
            <span className="text-rose-600 dark:text-rose-400">{counts.error} error</span>
            <span className="text-slate-400">of {preview.total_rows} rows</span>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-navy-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-600 dark:bg-navy-800 dark:text-slate-300">
                <tr><th className="px-3 py-2 text-left">Row</th><th className="px-3 py-2 text-left">Part No</th>
                  <th className="px-3 py-2 text-left">Description</th><th className="px-3 py-2 text-left">Action</th>
                  <th className="px-3 py-2 text-left">Reason</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.row}</td>
                    <td className="px-3 py-1.5 font-mono">{r.part_no || "—"}</td>
                    <td className="px-3 py-1.5">{r.part_name || "—"}</td>
                    <td className={`px-3 py-1.5 font-semibold ${ACTION_CLASS[r.action]}`}>{r.action}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.reason || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">Nothing is saved until you confirm. Parts missing from the file are never deleted.</p>
        </div>
      )}

      {phase === "done" && result && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm font-semibold">
            <span className="text-emerald-600 dark:text-emerald-400">{result.inserted} added</span>
            <span className="text-blue-600 dark:text-blue-400">{result.updated} updated</span>
            <span className="text-rose-600 dark:text-rose-400">{result.failed} failed</span>
            <span className="text-slate-400">of {result.total_rows} rows</span>
          </div>
          {rejected.length > 0 && (
            <button className="btn-secondary" onClick={downloadRejected}>Download rejected rows ({rejected.length})</button>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-navy-800">
          <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Recent imports</div>
          <div className="max-h-28 overflow-auto text-xs text-slate-500">
            {history.map((h) => (
              <div key={h.id} className="flex justify-between py-0.5">
                <span>{parseServerTime(h.at)?.toLocaleString("en-GB") ?? "—"} · {h.filename || "—"}</span>
                <span>+{h.inserted} ~{h.updated} ✕{h.failed} {h.imported_by ? `· ${h.imported_by}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
