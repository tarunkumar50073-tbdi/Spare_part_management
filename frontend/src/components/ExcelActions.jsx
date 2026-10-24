import React, { useRef, useState } from "react";
import { Plus, Upload, FileDown, Download } from "lucide-react";

/** Standard master-page toolbar: [Add New] / Upload Excel / Download
 * Template / Export Excel. Consistent across every master + data-entry
 * page — Excel is the ingestion path today; onUpload is the only piece
 * that changes once ERP API sync replaces it (see redesign spec).
 * Omit onAddNew for sheet-style pages (e.g. Daily Stock Count) that have
 * no "create new row" concept. Omit onUpload / onDownloadTemplate for a page
 * that takes no Excel in (the Part Master since 21 Oct 2026). */
export default function ExcelActions({ onAddNew, addLabel = "Add New", onUpload, onDownloadTemplate, onExport, canEdit = true }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Add + Upload write data, so they are hidden from a view-only user
          (canEdit=false); Download Template + Export only read, so they stay. */}
      {onAddNew && canEdit && (
        <button className="btn-primary" onClick={onAddNew}>
          <Plus size={16} /> {addLabel}
        </button>
      )}
      {onUpload && canEdit && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xlsm"
            className="hidden"
            id={`excel-upload-${addLabel}`}
            onChange={handleFileChange}
          />
          <label
            htmlFor={`excel-upload-${addLabel}`}
            className={`btn-secondary cursor-pointer ${uploading ? "opacity-60 pointer-events-none" : ""}`}
          >
            <Upload size={16} /> {uploading ? "Uploading..." : "Upload Excel"}
          </label>
        </>
      )}
      {onDownloadTemplate && (
        <button className="btn-secondary" onClick={onDownloadTemplate}>
          <FileDown size={16} /> Download Template
        </button>
      )}
      <button className="btn-secondary" onClick={onExport}>
        <Download size={16} /> Export Excel
      </button>
    </div>
  );
}
