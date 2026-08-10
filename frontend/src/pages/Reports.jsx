import React from "react";
import { FileSpreadsheet, FileDown, FileText } from "lucide-react";
import { REPORT_TYPES } from "../services/reportService.js";
import { downloadFile } from "../utils/download.js";

export default function Reports() {
  const handleDownload = (reportKey, format) => {
    downloadFile(`/reports/${reportKey}/${format}`, `${reportKey}_report.${format === "excel" ? "xlsx" : "pdf"}`);
  };

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
        <FileSpreadsheet size={18} className="text-toyotared" /> Reports
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORT_TYPES.map((r) => (
          <div key={r.key} className="card flex flex-col justify-between">
            <h3 className="font-semibold text-slate-800 dark:text-white mb-4">{r.label}</h3>
            <div className="flex gap-2">
              <button className="btn-secondary flex-1 justify-center" onClick={() => handleDownload(r.key, "excel")}>
                <FileDown size={15} /> Excel
              </button>
              <button className="btn-secondary flex-1 justify-center" onClick={() => handleDownload(r.key, "pdf")}>
                <FileText size={15} /> PDF
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
