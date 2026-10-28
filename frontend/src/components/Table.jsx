import React, { useEffect, useMemo, useRef, useState } from "react";
import { matchesAll, wordMatchers } from "../lib/wordSearch.js";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Columns3, Download, Search } from "lucide-react";
import { downloadCsv, downloadXlsx } from "../utils/excel.js";

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
 *
 * Opt-in extras (used by the big inventory list)
 *   selectable     checkbox column; `selected` (a Set of row keys) +
 *                  `onSelectedChange(nextSet)`; "select all" takes every row
 *                  passing the current search, not just the rows in view
 *   rowKey         (row) => stable key (default row.id ?? row.part_id)
 *   stickyFirst    keep the first column in view while scrolling sideways
 *   defaultHidden  column keys hidden until turned on in the Columns menu
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
  // Fill the parent's height instead of a fixed maxHeight — the body scrolls
  // within the available space (one scrollbar), for a table that owns a flex
  // region (e.g. a drill panel). The parent must be a bounded flex column.
  fill = false,
  toolbar = null,
  // Opt-in: adds a "Columns" menu to show/hide columns (for the big lists).
  columnToggle = false,
  // Opt-in row virtualization for very large, unpaginated lists — only the rows
  // near the viewport render. Uses a bounded scroll box (maxHeight, default 70vh).
  virtualize = false,
  selectable = false,
  selected = null,
  onSelectedChange,
  rowKey = (r) => r.id ?? r.part_id,
  stickyFirst = false,
  defaultHidden = [],
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: null, dir: "asc" });
  const [page, setPage] = useState(1);
  const [hiddenCols, setHiddenCols] = useState(() => new Set(defaultHidden));
  const selectAllRef = useRef(null);
  const [menu, setMenu] = useState(null); // "export" | "columns" | null
  const scrollRef = useRef(null);
  const shownColumns = useMemo(() => columns.filter((c) => !hiddenCols.has(c.key)), [columns, hiddenCols]);

  // Memoised so an undefined `rows` doesn't hand the memos below a brand new
  // array on every render and make them recompute for nothing.
  const safeRows = useMemo(() => rows || [], [rows]);

  // A column can only be sorted if it says how — a cell built out of several
  // fields has no meaningful row[key] to compare.
  const sortableCols = useMemo(
    () => new Set(columns.filter((c) => c.sortable || c.sortValue).map((c) => c.key)),
    [columns],
  );

  // Each row's searchable text, once per rows / columns rather than per key.
  const haystacks = useMemo(() => safeRows.map((row) => columns.map((col) => {
    const raw = col.searchValue ? col.searchValue(row) : row[col.key];
    return raw == null || typeof raw === "object" ? "" : String(raw).toLowerCase();
  }).join(" \u0001 ")), [safeRows, columns]);

  // Word by word, in any order, a plural finding its singular (28 Oct 2026:
  // "bearing", "6204 bearing", "bolts") — lib/wordSearch.js.
  const searched = useMemo(() => {
    const matchers = wordMatchers(query);
    if (!matchers.length) return safeRows;
    return safeRows.filter((_, i) => matchesAll(haystacks[i], matchers));
  }, [safeRows, haystacks, query]);

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

  // Row virtualization (opt-in, dependency-free): render only the rows near the
  // viewport out of a large, unpaginated list. A fixed row height keeps the
  // top/bottom spacer maths exact. Seed the viewport height from the scroll box
  // (60vh) so the very first render is already windowed, not the full 4,800 rows.
  const ROW_H = 44;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(() => (virtualize && typeof window !== "undefined" ? Math.round(window.innerHeight * 0.6) : 0));
  useEffect(() => {
    if (!virtualize) return undefined;
    const el = scrollRef.current;
    if (!el) return undefined;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [virtualize]);
  // A search or sort starts the list over from the top. Without this, a query
  // typed while scrolled far down keeps the old offset, the window lands past
  // the end of the shorter list, and the table shows no rows at all.
  useEffect(() => {
    if (!virtualize) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [virtualize, query, sort.key, sort.dir]);
  const vOn = virtualize && viewH > 0 && sorted.length > 0;
  const overscan = 10;
  const perView = Math.ceil(viewH / ROW_H);
  // Clamped to the last full screen, so a stale offset (the rows shrank under
  // it — a live refresh, a filter from outside) still shows the tail of the
  // list instead of an empty window.
  const firstIndex = vOn ? Math.min(Math.floor(scrollTop / ROW_H), Math.max(0, sorted.length - perView)) : 0;
  const startIndex = vOn ? Math.max(0, firstIndex - overscan) : 0;
  const endIndex = vOn ? Math.min(sorted.length, firstIndex + perView + overscan) : sorted.length;
  const padTop = vOn ? startIndex * ROW_H : 0;
  const padBottom = vOn ? (sorted.length - endIndex) * ROW_H : 0;

  const toggleSort = (key) => {
    if (!sortableCols.has(key)) return;
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  // Export the visible columns, in the current sort/filter order. Numbers stay
  // numeric so Excel can sum/sort them; a rendered <Badge/> etc. has no place in
  // a cell, so such a column should set exportValue to the plain value.
  const buildExport = () => {
    const cellVal = (col, row) => {
      const raw = col.exportValue ? col.exportValue(row) : row[col.key];
      if (raw == null || typeof raw === "object") return "";
      return typeof raw === "number" ? raw : String(raw);
    };
    // A column that shows two things on screen (Part No and its name) exports
    // them as two columns, under the one heading each has in every file
    // (exportAlso: { label, value }) — the store, 27 Oct 2026.
    const cols = shownColumns.flatMap((c) => (c.exportAlso
      ? [c, { key: `${c.key}__also`, label: c.exportAlso.label, exportValue: c.exportAlso.value }]
      : [c]));
    const headers = cols.map((c) => c.label);
    const body = sorted.map((row) => cols.map((col) => cellVal(col, row)));
    return { headers, body, name: `${exportName}_${new Date().toISOString().slice(0, 10)}` };
  };
  const exportXlsx = () => { const { headers, body, name } = buildExport(); downloadXlsx(name, headers, body, "Export"); setMenu(null); };
  const exportCsv = () => { const { headers, body, name } = buildExport(); downloadCsv(name, headers, body); setMenu(null); };

  // ---- bulk selection (opt-in) ----
  const sel = selectable ? (selected || new Set()) : null;
  const allKeys = selectable ? sorted.map(rowKey) : [];
  const selectedInView = selectable ? allKeys.filter((k) => sel.has(k)).length : 0;
  const allSelected = selectable && allKeys.length > 0 && selectedInView === allKeys.length;
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedInView > 0 && !allSelected;
    }
  });
  const toggleAll = () => {
    const next = new Set(sel);
    if (allSelected) allKeys.forEach((k) => next.delete(k));
    else allKeys.forEach((k) => next.add(k));
    onSelectedChange?.(next);
  };
  const toggleOne = (k) => {
    const next = new Set(sel);
    if (next.has(k)) next.delete(k); else next.add(k);
    onSelectedChange?.(next);
  };
  const extraCols = selectable ? 1 : 0;
  // Sticky first data column (after the checkbox column when there is one).
  const stickyLeft = selectable ? "left-10" : "left-0";
  const stickyTh = (i) => (stickyFirst && i === 0 ? `sticky ${stickyLeft} z-20 bg-slate-50 dark:bg-navy-800` : "");
  const stickyTd = (i) => (stickyFirst && i === 0
    ? `sticky ${stickyLeft} z-[1] bg-white dark:bg-navy-900 shadow-[1px_0_0_rgba(148,163,184,0.25)]` : "");

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
  const showToolbar = searchable || exportName || toolbar || columnToggle;

  const renderRow = (row, idx, style) => (
    <tr
      key={rowKey(row) ?? idx}
      style={style}
      role={onRowClick ? "button" : undefined}
      tabIndex={onRowClick ? 0 : undefined}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(row) : undefined}
      className={`hover:bg-slate-50 dark:hover:bg-navy-800/60 transition-colors ${onRowClick ? "cursor-pointer" : ""} ${rowClassName ? rowClassName(row) : ""}`}
    >
      {selectable && (
        <td className="sticky left-0 z-[1] w-10 bg-white px-3 py-3 dark:bg-navy-900" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" className="h-4 w-4 cursor-pointer accent-toyotared"
            aria-label={`Select ${row.part_no || "row"}`}
            checked={sel.has(rowKey(row))} onChange={() => toggleOne(rowKey(row))} />
        </td>
      )}
      {shownColumns.map((col, i) => (
        <td key={col.key} style={col.width ? { width: col.width } : undefined}
          className={`px-3 py-3 ${cellWrap} ${col.align === "right" ? "text-right tabular" : ""} ${stickyTd(i)}`}>
          {col.render ? col.render(row) : row[col.key]}
        </td>
      ))}
    </tr>
  );

  return (
    <div className={fill ? "flex h-full min-h-0 flex-col gap-3" : "space-y-3"}>
      {menu && <div className="fixed inset-0 z-20" onClick={() => setMenu(null)} />}
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
          <div className="ml-auto flex items-center gap-2">
            {columnToggle && (
              <div className="relative">
                <button type="button" onClick={() => setMenu((m) => (m === "columns" ? null : "columns"))}
                  className="btn-secondary py-1.5 text-[13px]" title="Show or hide columns">
                  <Columns3 size={14} /> Columns <ChevronDown size={13} className="opacity-60" />
                </button>
                {menu === "columns" && (
                  <div className="absolute right-0 z-30 mt-1 max-h-72 w-56 overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-cardHover dark:border-navy-700 dark:bg-navy-900">
                    {columns.map((c) => {
                      const on = !hiddenCols.has(c.key);
                      const lastOne = on && shownColumns.length === 1;
                      return (
                        <label key={c.key}
                          className={`flex items-center gap-2 rounded px-2 py-1.5 text-[13px] ${lastOne ? "opacity-40" : "cursor-pointer hover:bg-slate-50 dark:hover:bg-navy-800"}`}>
                          <input type="checkbox" checked={on} disabled={lastOne}
                            onChange={() => setHiddenCols((prev) => {
                              const next = new Set(prev);
                              if (on) next.add(c.key); else next.delete(c.key);
                              return next;
                            })} />
                          <span className="truncate">{c.label || c.key}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {exportName && (
              <div className="relative">
                <button type="button" onClick={() => setMenu((m) => (m === "export" ? null : "export"))}
                  disabled={sorted.length === 0}
                  className="btn-secondary py-1.5 text-[13px] disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Download these rows">
                  <Download size={14} /> Export <ChevronDown size={13} className="opacity-60" />
                </button>
                {menu === "export" && (
                  <div className="absolute right-0 z-30 mt-1 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-cardHover dark:border-navy-700 dark:bg-navy-900">
                    <button type="button" onClick={exportXlsx}
                      className="flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-navy-800">Excel (.xlsx)</button>
                    <button type="button" onClick={exportCsv}
                      className="flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-navy-800">CSV (.csv)</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={virtualize ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
        className={`rounded-xl border border-slate-200 dark:border-navy-800 ${noScroll ? "" : "overflow-x-auto"} ${fill ? "min-h-0 flex-1" : ""}`}
        style={fill
          ? { overflowY: "auto" }
          : (maxHeight || virtualize) ? { maxHeight: maxHeight || "70vh", overflowY: "auto" } : undefined}
      >
        <table className={`w-full text-sm ${noScroll ? "table-fixed" : "min-w-full"}`}>
          {/* Pinned so column names stay readable once a long list is scrolled
              — the header must stay opaque or rows show through it. */}
          <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-navy-800 text-slate-600 dark:text-slate-300">
            <tr>
              {selectable && (
                <th className="sticky left-0 z-20 w-10 border-b border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-navy-700 dark:bg-navy-800">
                  <input ref={selectAllRef} type="checkbox" className="h-4 w-4 cursor-pointer accent-toyotared"
                    aria-label={allSelected ? "Clear selection" : `Select all ${allKeys.length} rows`}
                    checked={allSelected} onChange={toggleAll} disabled={allKeys.length === 0} />
                </th>
              )}
              {shownColumns.map((col, i) => {
                const canSort = sortableCols.has(col.key);
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    style={col.width ? { width: col.width } : undefined}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={`text-[11px] font-semibold uppercase tracking-wide px-3 py-2.5 border-b border-slate-200 dark:border-navy-700 ${cellWrap} ${stickyTh(i)}
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
                <td colSpan={shownColumns.length + extraCols} className="text-center text-slate-400 py-8">
                  {query ? `Nothing matches “${query}”` : emptyMessage}
                </td>
              </tr>
            )}
            {vOn ? (
              <>
                {padTop > 0 && <tr aria-hidden="true" style={{ height: padTop }}><td className="p-0" colSpan={shownColumns.length + extraCols} /></tr>}
                {sorted.slice(startIndex, endIndex).map((row, i) => renderRow(row, startIndex + i, { height: ROW_H }))}
                {padBottom > 0 && <tr aria-hidden="true" style={{ height: padBottom }}><td className="p-0" colSpan={shownColumns.length + extraCols} /></tr>}
              </>
            ) : (
              visible.map((row, idx) => renderRow(row, idx))
            )}
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
