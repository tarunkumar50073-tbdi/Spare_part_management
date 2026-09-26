import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { LoaderCircle, MapPin, Package, Search } from "lucide-react";
import { useStockList } from "../../lib/stockQueries.js";
import { num } from "../../lib/format.js";

// Type-ahead over the store's parts — Part No., description, reference code or
// rack location. It reads the shared cached stock list (lib/stockQueries), the
// same copy the dashboard and Ctrl+K use, so searching costs no request once the
// app has loaded it. Used by the Scan Part "Search Part No." tab and by "Map to
// Part" (choosing the part a supplier barcode belongs to).
const MAX_RESULTS = 20;

// Best match first: the exact Part No., then Part Nos. that start with the text,
// then any other hit — so typing a full number puts that part on top.
function rank(p, q) {
  const no = (p.part_no || "").toLowerCase();
  if (no === q) return 0;
  if (no.startsWith(q)) return 1;
  if (no.includes(q)) return 2;
  return 3;
}

export default function PartSearch({
  storeCode, onPick, busy = false, autoFocus = true, clearOnPick = true,
  placeholder = "Part No., description or location…", label = "Search part",
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();
  const { data: parts, isPending, isError, refetch } = useStockList(storeCode);

  useEffect(() => {
    if (!autoFocus) return undefined;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [autoFocus]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q || !parts) return [];
    return parts
      .filter((p) => `${p.part_no || ""} ${p.part_name || ""} ${p.old_part_no || ""} ${p.location || ""}`.toLowerCase().includes(q))
      .map((p) => [rank(p, q), p])
      .sort((a, b) => a[0] - b[0] || String(a[1].part_no).localeCompare(String(b[1].part_no)))
      .slice(0, MAX_RESULTS)
      .map(([, p]) => p);
  }, [q, parts]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Cleared after a pick on the workstation (the part card takes over) unless
  // onPick resolves false (the operator kept an open form, or the part could
  // not be identified); kept for "Map to Part", where a cancelled confirmation
  // goes back to the list.
  const pick = async (p) => {
    if (!p || busy) return;
    const went = await onPick?.(p);
    if (clearOnPick && went !== false) setQuery("");
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[active]); }
    else if (e.key === "Escape") { setQuery(""); }
  };

  const optionId = (i) => `${listId}-opt-${i}`;
  return (
    <div>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          placeholder={placeholder}
          aria-label={label}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          className="input-field h-12 pl-9 text-base"
        />
        {busy && (
          <LoaderCircle size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" aria-label="Identifying" />
        )}
      </div>

      <div ref={listRef} id={listId} role="listbox" aria-label="Matching parts"
        className={q ? "mt-2 max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-navy-700" : ""}>
        {q && isPending && !parts && <p className="px-3 py-4 text-center text-sm text-slate-400">Loading the store&apos;s parts…</p>}
        {q && isError && !parts && (
          <p role="alert" className="px-3 py-4 text-center text-sm text-rose-600 dark:text-rose-400">
            Couldn&apos;t load the part list.{" "}
            <button type="button" onClick={() => refetch()} className="font-semibold underline underline-offset-2">Retry</button>
          </p>
        )}
        {q && parts && results.length === 0 && (
          <p className="px-3 py-4 text-center text-sm text-slate-400">No part of this store matches “{query.trim()}”.</p>
        )}
        {results.map((p, i) => (
          <button
            key={p.part_id}
            id={optionId(i)}
            type="button"
            role="option"
            aria-selected={i === active}
            data-idx={i}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(p)}
            disabled={busy}
            className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 transition-colors dark:border-navy-800 ${
              i === active ? "bg-slate-100 dark:bg-navy-800" : "hover:bg-slate-50 dark:hover:bg-navy-800/60"}`}
          >
            <Package size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-sm font-semibold text-slate-800 dark:text-white">{p.part_no}</span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">{p.part_name || "No description"}</span>
            </span>
            <span className="shrink-0 text-right text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} aria-hidden="true" />{p.location || "No location"}
              </span>
              <span className="block tabular">
                {p.qty_on_hand == null ? "Not counted" : <><b className="font-semibold text-slate-700 dark:text-slate-200">{num(p.qty_on_hand)}</b> available</>}
              </span>
            </span>
          </button>
        ))}
        {results.length === MAX_RESULTS && (
          <p className="px-3 py-1.5 text-center text-[11px] text-slate-400">Showing the first {MAX_RESULTS} — type more to narrow it down.</p>
        )}
      </div>
    </div>
  );
}
