import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, ImageOff, Layers, MapPin, PackageCheck, PackageX, Search, X } from "lucide-react";
import Modal from "../../components/Modal.jsx";
import PartPhotoView from "../../components/PartPhotoView.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { can } from "../../utils/permissions.js";
import { num } from "../../lib/format.js";
import { partService } from "../../services/partService.js";
import { partKioskService } from "../../services/partKioskService.js";

// Part Search — the kiosk outside the spare store (the store, 25 Oct 2026:
// "spare store k bahar ki taraf 1 kiosk system lagega jisme user part search kar
// sakta h uski availability dekh sakta h with photo ... only part search kiosk").
// Type a Part No. or a name; each part shows its photo, how many are in stock,
// its location, section and specification / model no. ("sabhi option"). Tap
// one for its photos big. Read only: nothing here changes anything.
//
// It owns the whole screen, like the Live Board, and clears itself after
// IDLE_MS untouched so the next person starts afresh. A kiosk login stays
// signed in (AuthContext deviceOnly); anyone who may open the store gets a way
// back to it.

const STORE = "MAINTENANCE";
const IDLE_MS = 2 * 60 * 1000;
const PER_PAGE = 24;

function Availability({ part, big = false }) {
  const size = big ? "px-3 py-1.5 text-[15px]" : "px-2.5 py-1 text-[13px]";
  return part.available ? (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-emerald-50 font-bold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30 ${size}`}>
      <PackageCheck size={big ? 17 : 15} aria-hidden="true" /> Available · {num(part.qty)} {part.uom}
    </span>
  ) : (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-rose-50 font-bold text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30 ${size}`}>
      <PackageX size={big ? 17 : 15} aria-hidden="true" /> Not available
    </span>
  );
}

function Details({ part }) {
  const spec = [part.specification, part.model_no && `Model ${part.model_no}`].filter(Boolean).join(" · ");
  return (
    <>
      {spec && <span className="block text-[13px] text-slate-500 dark:text-slate-400">{spec}</span>}
      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-semibold text-slate-600 dark:text-slate-300">
        <span className="inline-flex items-center gap-1"><MapPin size={14} aria-hidden="true" className="text-toyotared" />{part.location || "No location"}</span>
        {part.rework_location && <span className="inline-flex items-center gap-1 font-normal text-slate-500">Rework: {part.rework_location}</span>}
        {part.section && <span className="inline-flex items-center gap-1 font-normal"><Layers size={13} aria-hidden="true" />{part.section}</span>}
      </span>
    </>
  );
}

export default function PartKiosk() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [photoN, setPhotoN] = useState(0);
  const input = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  // Untouched for IDLE_MS: start afresh for the next person.
  useEffect(() => {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { setTyped(""); setQ(""); setOpen(null); window.scrollTo(0, 0); }, IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "touchstart", "wheel"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, reset)); };
  }, []);

  const search = useInfiniteQuery({
    queryKey: ["part-kiosk", q],
    queryFn: ({ pageParam }) => partKioskService.search({ store_code: STORE, q, page: pageParam, per_page: PER_PAGE }, { silent: true })
      .then((r) => r.data.data),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pages ? last.page + 1 : undefined),
    enabled: q.length >= 2,
    staleTime: 30 * 1000,
  });
  const rows = (search.data?.pages || []).flatMap((p) => p.rows);
  const total = search.data?.pages?.[0]?.total ?? 0;
  const clear = () => { setTyped(""); setQ(""); input.current?.focus(); };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-navy-950">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-navy-800 dark:bg-navy-900/95">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-10 w-auto shrink-0 rounded bg-white p-0.5" draggable={false} />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl">Spare Parts — Part Search</h1>
                <p className="truncate text-[13px] text-slate-500 dark:text-slate-400">Find a part: its photo, stock and where it is kept</p>
              </div>
            </div>
            {can(user, "spare_store") && (
              <button type="button" className="btn-secondary shrink-0" onClick={() => navigate(`/store/${STORE}`)}>
                <ArrowLeft size={15} aria-hidden="true" /> Main Dashboard
              </button>
            )}
          </div>
          <div className="relative mt-3">
            <Search size={24} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input ref={input} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={80}
              placeholder="Type Part No., name, specification or model no."
              aria-label="Search a part" enterKeyHint="search" autoComplete="off"
              className="w-full rounded-2xl border-2 border-slate-200 bg-white py-4 pl-14 pr-14 text-xl text-slate-900 shadow-sm outline-none transition focus:border-toyotared dark:border-navy-700 dark:bg-navy-900 dark:text-white" />
            {typed && (
              <button type="button" onClick={clear} aria-label="Clear the search"
                className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-navy-800">
                <X size={22} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        {q.length < 2 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <Search size={56} aria-hidden="true" className="text-slate-300 dark:text-slate-600" />
            <p className="text-lg font-semibold text-slate-500 dark:text-slate-400">Type at least 2 letters of a Part No. or name</p>
            <p className="text-sm text-slate-400">e.g. CNTR1234 · bearing 6204 · cylinder</p>
          </div>
        ) : search.isError ? (
          <div className="py-20 text-center">
            <p className="text-lg font-semibold text-rose-600">Could not search right now.</p>
            <button type="button" className="btn-secondary mt-3" onClick={() => search.refetch()}>Try again</button>
          </div>
        ) : search.isLoading ? (
          <p className="py-20 text-center text-lg text-slate-400">Searching…</p>
        ) : rows.length === 0 ? (
          <p className="py-20 text-center text-lg font-semibold text-slate-500 dark:text-slate-400">No part found for &ldquo;{q}&rdquo;</p>
        ) : (
          <>
            <p className="mb-3 text-[13px] font-medium text-slate-500 dark:text-slate-400">{num(total)} part{total === 1 ? "" : "s"} found</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {rows.map((p) => {
                const thumb = partService.imageUrl(p, true);
                return (
                  <button key={p.id} type="button" onClick={() => { setPhotoN(0); setOpen(p); }}
                    className="card flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared">
                    <span className="relative flex aspect-[4/3] w-full items-center justify-center bg-slate-100 dark:bg-navy-800">
                      {thumb ? (
                        <img src={thumb} alt={`Photo of ${p.part_no}`} loading="lazy" className="h-full w-full object-contain" />
                      ) : (
                        <span className="flex flex-col items-center gap-1 text-slate-400"><ImageOff size={34} aria-hidden="true" /><span className="text-xs">No photo yet</span></span>
                      )}
                      {p.photos?.length > 1 && (
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white">{p.photos.length} photos</span>
                      )}
                    </span>
                    <span className="flex flex-1 flex-col gap-1 p-3">
                      <span className="font-mono text-lg font-bold text-slate-900 dark:text-white">{p.part_no}</span>
                      <span className="line-clamp-2 text-[15px] font-medium text-slate-700 dark:text-slate-200">{p.part_name}</span>
                      <Details part={p} />
                      <span className="mt-2 flex flex-wrap items-center gap-2">
                        <Availability part={p} />
                        {p.discontinued && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-800">Discontinued</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {search.hasNextPage && (
              <div className="mt-5 text-center">
                <button type="button" className="btn-secondary px-6 py-3 text-base" disabled={search.isFetchingNextPage}
                  onClick={() => search.fetchNextPage()}>
                  {search.isFetchingNextPage ? "Loading…" : "Show more parts"}
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* One part big: every photo angle, its stock and where it is. */}
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} size="xl"
        title={open ? `${open.part_no} — ${open.part_name}` : "Part"}>
        {open && (
          <div className="space-y-4">
            {/* Small enough that the stock line below stays in view on a 768px-high screen. */}
            <PartPhotoView part={open} n={photoN} onShow={setPhotoN} maxHeight="max-h-[42vh]" />
            <div className="rounded-xl bg-slate-50 p-3 dark:bg-navy-950/40">
              <Availability part={open} big />
              <div className="mt-2"><Details part={open} /></div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
