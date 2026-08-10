import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";

/**
 * Shared data table.
 *
 * Search, sorting, pagination and export are all opt-in: passing none of them
 * renders exactly what this component rendered before they existed, so the
 * fifteen pages already using it are untouched. Several of those pages do
 * their own searching or paginate server-side, and switching everything on by
 * default would have given them two of each.
 *
 * Table-level props
 *   searchable   true, or a placeholder string, to show the search box
 *   pageSize     rows per page; omit for no pagination
 *   exportName   base filename to enable CSV export
 *   maxHeight    e.g. "60vh" — makes the body scroll under a pinned header
 *   toolbar      extra controls rendered beside the search box
 *
 * Column props (all optional)
 *   sortable     sort on row[key]
 *   sortValue    (row) => comparable, for columns whose cell is composed
 *   searchValue  (row) => text to match, likewise
 *   exportValue  (row) => CSV value, defaults to row[key]
 *   align        "right" for numeric columns
 *
 * onRowClick     (row) => void — makes the whole row a drill-through
 */
export default function Table({
  columns,
  rows,
  loading,
  emptyMessage = "No records found",
  rowClassName,
  // Whole-row drill-through. Keyboard-reachable too, so a table you can click
  // into is not a table only a mouse can use.
  onRowClick,
  noScroll = false,
  searchable = false,
  pageSize = 0,
  exportName = "",
  maxHeight = "",
  toolbar = null,
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: null, dir: "asc" });
  const [page, setPage] = useState(1);

  // Memoised so an undefined `rows` doesn't hand the memos below a brand new
  // array on every render and make them recompute for nothing.
  const safeRows = useMemo(() => rows || [], [rows]);

  // A column can only be sorted if it says how — a cell built out of several
  // fields has no meaningful row[key] to compare.
  const sortableCols = useMemo(
    () => new Set(columns.filter((c) => c.sortable || c.sortValue).map((c) => c.key)),
    [columns],
  );

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return safeRows;
    return safeRows.filter((row) =>
      columns.some((col) => {
        const raw = col.searchValue ? col.searchValue(row) : row[col.key];
        if (raw == null || typeof raw === "object") return false;
        return String(raw).toLowerCase().includes(q);
      }),
    );
  }, [safeRows, columns, query]);

  const sorted = useMemo(() => {
    if (!sort.key) return searched;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return searched;
    const valueOf = (row) => (col.sortValue ? col.sortValue(row) : row[col.key]);
    const factor = sort.dir === "asc" ? 1 : -1;

    return [...searched].sort((a, b) => {
      const x = valueOf(a);
      const y = valueOf(b);
      // Blanks sort last whichever way the column is pointing — an empty cell
      // is not "smallest", it is missing.
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * factor;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * factor;
    });
  }, [searched, columns, sort]);

  const totalPages = pageSize > 0 ? Math.max(Math.ceil(sorted.length / pageSize), 1) : 1;
  // Filtering down to fewer pages while sitting on a later one would otherwise
  // leave the table blank.
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  useEffect(() => {
    setPage(1);
  }, [query, sort.key, sort.dir]);

  const visible = pageSize > 0 ? sorted.slice((page - 1) * pageSize, page * pageSize) : sorted;

  const toggleSort = (key) => {
    if (!sortableCols.has(key)) return;
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  const exportCsv = () => {
    const cell = (col, row) => {
      const raw = col.exportValue ? col.exportValue(row) : row[col.key];
      if (raw == null || typeof raw === "object") return "";
      const text = String(raw);
      // Quote anything that would otherwise break the row apart.
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [
      columns.map((c) => cell({ key: "label", exportValue: () => c.label }, {})).join(","),
      ...sorted.map((row) => columns.map((col) => cell(col, row)).join(",")),
    ];
    // The BOM is what makes Excel read the file as UTF-8; without it part
    // names with ~ and accented characters arrive mangled.
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${exportName}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-10 w-full" />
        ))}
      </div>
    );
  }

  const cellWrap = noScroll ? "break-words" : "whitespace-nowrap";
  const showToolbar = searchable || exportName || toolbar;

  return (
    <div className="space-y-3">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                className="input-field pl-9 py-1.5 text-[13px]"
                placeholder={typeof searchable === "string" ? searchable : "Search…"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          {toolbar}
          {exportName && (
            <button
              onClick={exportCsv}
              disabled={sorted.length === 0}
              className="btn-secondary py-1.5 text-[13px] ml-auto disabled:opacity-40 disabled:cursor-not-allowed"
              title="Download these rows as CSV"
            >
              <Download size={14} /> Export
            </button>
          )}
        </div>
      )}

      <div
        className={`rounded-xl border border-slate-200 dark:border-navy-800 ${noScroll ? "" : "overflow-x-auto"}`}
        style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
      >
        <table className={`w-full text-sm ${noScroll ? "table-fixed" : "min-w-full"}`}>
          {/* Pinned so column names stay readable once a long list is scrolled
              — the header must stay opaque or rows show through it. */}
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-navy-800 text-slate-600 dark:text-slate-300">
            <tr>
              {columns.map((col) => {
                const canSort = sortableCols.has(col.key);
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={`text-[11px] font-semibold uppercase tracking-wide px-3 py-2.5 border-b border-slate-200 dark:border-navy-700 ${cellWrap}
                      ${col.align === "right" ? "text-right" : "text-left"}
                      ${canSort ? "cursor-pointer select-none hover:text-slate-900 dark:hover:text-white" : ""}`}
                  >
                    <span className={`inline-flex items-center gap-1 ${col.align === "right" ? "flex-row-reverse" : ""}`}>
                      {col.label}
                      {canSort && active && (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      {canSort && !active && <ArrowUp size={12} className="opacity-20" />}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800 bg-white dark:bg-navy-900">
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="text-center text-slate-400 py-8">
                  {query ? `Nothing matches “${query}”` : emptyMessage}
                </td>
              </tr>
            )}
            {visible.map((row, idx) => (
              <tr
                key={row.id ?? row.part_id ?? idx}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(row) : undefined}
                className={`hover:bg-slate-50 dark:hover:bg-navy-800/60 transition-colors ${
                  onRowClick ? "cursor-pointer" : ""
                } ${rowClassName ? rowClassName(row) : ""}`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-3 ${cellWrap} ${col.align === "right" ? "text-right tabular" : ""}`}
                  >
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageSize > 0 && sorted.length > pageSize && (
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="tabular">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={page === 1}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-navy-800 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous page"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="px-2 tabular">{page} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              disabled={page === totalPages}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-navy-800 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
