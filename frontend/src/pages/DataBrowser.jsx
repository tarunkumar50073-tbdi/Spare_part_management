import React, { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Database, EyeOff, FileDown, Search } from "lucide-react";
import ErrorState from "../components/ErrorState.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { num } from "../lib/format.js";
import { dataBrowserService } from "../services/dataBrowserService.js";

// Data Browser — every table of the app's database, to look at when needed
// (the store, 27 Oct 2026: "mere db me kon kon se table bani huyi h and unme ko
// kon sa data h ye meri app me add ho sakta h taaki agar jarurat pade to dekh
// sake"). Administrators only, READ ONLY — nothing can be changed here.
// Passwords, hashes, tokens and other secrets always show as hidden.

const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";

function useDebounced(text, ms = 300) {
  const [v, setV] = useState(text);
  useEffect(() => { const t = setTimeout(() => setV(text.trim()), ms); return () => clearTimeout(t); }, [text, ms]);
  return v;
}

export default function DataBrowser() {
  const { user } = useAuth();
  const [pick, setPick] = useState(null);
  const [find, setFind] = useState("");
  const list = useQuery({
    queryKey: ["data-browser", "tables"],
    queryFn: () => dataBrowserService.tables({ silent: true }).then((r) => r.data.data),
    enabled: Boolean(user?.is_admin),
    staleTime: 60_000,
  });
  const groups = useMemo(() => {
    const t = find.trim().toLowerCase();
    const rows = (list.data?.tables || []).filter((x) => !t || x.name.includes(t) || (x.about || "").toLowerCase().includes(t));
    return (list.data?.groups || []).map((g) => [g, rows.filter((x) => x.group === g)]).filter(([, r]) => r.length);
  }, [list.data, find]);

  if (!user?.is_admin) {
    return <div className="card text-sm text-slate-500">The Data Browser is for administrators only.</div>;
  }
  return (
    <div className="space-y-5">
      <div>
        <h1 className="section-title flex items-center gap-2"><Database size={20} aria-hidden="true" /> Data Browser</h1>
        <p className="section-hint">
          Every table in the app&apos;s database and what is in it — read only, nothing can be changed here. Passwords and other
          secrets are always hidden.{list.data ? ` ${list.data.tables.length} tables · ${num(list.data.total_rows)} rows.` : ""}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="card p-0">
          <div className="border-b border-slate-100 p-3 dark:border-navy-800">
            <span className="relative block">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className="input-field w-full py-1.5 pl-8 text-[13px]" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a table…" />
            </span>
          </div>
          {list.isError ? <div className="p-3"><ErrorState title="Tables did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
            <nav aria-label="Tables" className="max-h-[70vh] overflow-y-auto py-1">
              {list.isLoading && <p className="px-3 py-4 text-sm text-slate-400">Loading tables…</p>}
              {groups.map(([g, rows]) => (
                <div key={g} className="py-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g}</p>
                  {rows.map((t) => (
                    <button key={t.name} type="button" onClick={() => setPick(t.name)} aria-pressed={pick === t.name} title={t.about}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] ${pick === t.name
                        ? "bg-toyotared/10 font-semibold text-toyotared" : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-navy-800"}`}>
                      <span className="min-w-0 truncate font-mono">{t.name}</span>
                      <span className={`shrink-0 tabular text-[11px] ${t.rows ? "text-slate-500" : "text-slate-300 dark:text-slate-600"}`}>{num(t.rows)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          )}
        </aside>
        {pick ? <TableView key={pick} name={pick} /> : (
          <div className="card flex items-center justify-center p-10 text-sm text-slate-400">Pick a table on the left to see what is in it.</div>
        )}
      </div>
    </div>
  );
}

function TableView({ name }) {
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [sort, setSort] = useState(null);
  const [desc, setDesc] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPage(1); }, [q, sort, desc]);
  const params = { q: q || undefined, sort: sort || undefined, desc: desc ? 1 : undefined };
  const data = useQuery({
    queryKey: ["data-browser", "rows", name, q, sort, desc, page],
    queryFn: () => dataBrowserService.rows(name, { ...params, page, page_size: 50 }, { silent: true }).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const d = data.data;
  const sortBy = (col) => {
    if (sort === col) setDesc(!desc);
    else { setSort(col); setDesc(false); }
  };
  const download = async () => {
    setBusy(true);
    try { await dataBrowserService.exportFile(name, params); } finally { setBusy(false); }
  };
  return (
    <section className="card min-w-0 p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-slate-800 dark:text-white">{name}</p>
          <p className="text-[11.5px] text-slate-500">{d?.about || d?.group || ""}{d ? ` · ${num(d.total)} row${d.total === 1 ? "" : "s"}${q ? " match" : ""}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input-field w-60 py-1.5 pl-8 text-[13px]" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search in this table…" />
          </span>
          <button type="button" className="btn-secondary text-[12.5px]" onClick={download} disabled={busy || !d?.total}>
            <FileDown size={14} aria-hidden="true" /> {busy ? "Preparing…" : "Excel"}
          </button>
        </div>
      </div>
      {data.isError ? <div className="p-4"><ErrorState title="Rows did not load" message={errText(data.error)} onRetry={() => data.refetch()} /></div> : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="min-w-full text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] text-slate-500 dark:bg-navy-950 dark:text-slate-400">
              <tr>
                {(d?.columns || []).map((c) => (
                  <th key={c.name} className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold dark:border-navy-800">
                    <button type="button" onClick={() => sortBy(c.name)} title={c.type} className="inline-flex items-center gap-1 font-mono hover:text-slate-800 dark:hover:text-white">
                      {c.hidden && <EyeOff size={11} aria-label="hidden" />}{c.name}
                      {sort === c.name && (desc ? <ArrowDown size={11} aria-hidden="true" /> : <ArrowUp size={11} aria-hidden="true" />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {(d?.rows || []).map((r, i) => (
                <tr key={i} className="align-top text-slate-700 hover:bg-slate-50/70 dark:text-slate-200 dark:hover:bg-navy-800/40">
                  {d.columns.map((c) => {
                    const v = r[c.name];
                    return (
                      <td key={c.name} className="max-w-[320px] whitespace-nowrap px-3 py-1.5" title={typeof v === "string" && v.length > 40 ? v : undefined}>
                        {v === null || v === undefined ? <span className="text-slate-300 dark:text-slate-600">—</span>
                          : typeof v === "boolean" ? (v ? "true" : "false")
                            : <span className="block truncate">{String(v)}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {d && d.rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{q ? "Nothing matches." : "This table is empty."}</p>}
        </div>
      )}
      {d && d.pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2 text-[12px] dark:border-navy-800">
          <span className="text-slate-400">Page {d.page} of {num(d.pages)}</span>
          <button type="button" className="btn-secondary py-1 text-[12px]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <button type="button" className="btn-secondary py-1 text-[12px]" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}
