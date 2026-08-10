import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function Pagination({ meta, onPageChange }) {
  if (!meta) return null;
  const { page, total_pages: totalPages, total } = meta;

  return (
    <div className="flex items-center justify-between mt-4 text-sm text-slate-500 dark:text-slate-400">
      <span>
        Page {page} of {totalPages || 1} • {total} records
      </span>
      <div className="flex gap-2">
        <button
          className="btn-secondary px-3 py-1.5 disabled:opacity-40"
          disabled={!meta.has_prev}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="btn-secondary px-3 py-1.5 disabled:opacity-40"
          disabled={!meta.has_next}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
