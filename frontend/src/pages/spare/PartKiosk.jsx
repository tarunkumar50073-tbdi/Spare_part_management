import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, ImageOff, Layers, MapPin, PackageCheck, PackageX, Search, X } from "lucide-react";
import IconTile from "../../components/IconTile.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { useTheme } from "../../context/ThemeContext.jsx";
import { pageBefore } from "../../lib/previousPage.js";
import { can } from "../../utils/permissions.js";
import { num } from "../../lib/format.js";
import { partService } from "../../services/partService.js";
import { partKioskService } from "../../services/partKioskService.js";

// Part Search — the kiosk outside the spare store (the store, 25 Oct 2026:
// "spare store k bahar ki taraf 1 kiosk system lagega jisme user part search kar
// sakta h uski availability dekh sakta h with photo ... only part search kiosk").
// Type a Part No. or a name; each part shows its photo, how many are in stock,
// its location, section and specification / model no. ("sabhi option"). Tap
// one and it opens on the whole screen, its photo as big as the screen allows
// ("part par click se drill screen khule jis par puri screen par part dekh sake
// taaki pic dekh kar pta chal jaaye"). Read only: nothing here changes anything.
//
// It owns the whole screen, like the Live Board, and clears itself after
// IDLE_MS untouched so the next person starts afresh. A kiosk login stays
// signed in (AuthContext deviceOnly); anyone who may open the store gets a way
// back to it.

const STORE = "MAINTENANCE";
const IDLE_MS = 2 * 60 * 1000;
const PER_PAGE = 24;

function Availability({ part }) {
  return part.available ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[13px] font-bold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30">
      <PackageCheck size={15} aria-hidden="true" /> Available · {num(part.qty)} {part.uom}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-[13px] font-bold text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30">
      <PackageX size={15} aria-hidden="true" /> Not available
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

// The top bar's tile button and hover (Topbar.jsx), so the kiosk's Back and
// Home read like the rest of the app.
const TILE_BTN = "group relative inline-flex shrink-0 items-center justify-center rounded-[11px] "
  + "focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50";
const TILE_HOVER = "transition group-hover:brightness-125 group-hover:-translate-y-px";

export default function PartKiosk() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { dark } = useTheme() || {};
  // Back only when opened from a screen other than the main dashboard: from
  // the main dashboard (or straight on the kiosk) Home is the way back, and a
  // second button going to the same place read as Back not working (the
  // store, 28 Oct 2026).
  const location = useLocation();
  const [from] = useState(() => pageBefore(location.pathname));
  const home = `/store/${STORE}`;
  let inApp = false;
  try { inApp = (window.history.state?.idx ?? 0) > 0; } catch { inApp = false; }
  const canBack = inApp && Boolean(from) && from !== home && from !== "/";
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const input = useRef(null);
  // Where the list was scrolled when a part was opened, to come back to it.
  const listY = useRef(0);
  useEffect(() => { if (!open) window.scrollTo(0, listY.current); }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  // Untouched for IDLE_MS: start afresh for the next person.
  useEffect(() => {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { setTyped(""); setQ(""); listY.current = 0; setOpen(null); window.scrollTo(0, 0); }, IDLE_MS);
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
  // A new search (typed or cleared) brings the list back in place of the part.
  const type = (text) => { setTyped(text); listY.current = 0; setOpen(null); };
  const clear = () => { type(""); setQ(""); input.current?.focus(); };

  // The search stays on top; a picked part fills the rest of the same screen
  // (the store's kiosk picture, 25 Oct 2026: "jahan part search kiya and select
  // kiya wahi par puri screen khule"), so the page is exactly one screen high.
  return (
    <div className={`flex flex-col bg-slate-50 dark:bg-navy-950 ${open ? "h-screen overflow-hidden" : "min-h-screen"}`}>
      <header className="sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-navy-800 dark:bg-navy-900/95">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-10 w-auto shrink-0 rounded bg-white p-0.5" draggable={false} />
              <h1 className="min-w-0 truncate text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl">Spare Part Search</h1>
            </div>
            {can(user, "spare_store") && (
              <span className="flex shrink-0 items-center gap-2">
                {/* Back to the screen it was opened from, and Home to the main
                    dashboard — the top bar's own tiles (the store, 28 Oct 2026:
                    "jahan se ise khola usi par nhi jata", "icon app me jo
                    already h usi type k use kar"). Back only when opened from
                    another screen than the main dashboard (canBack). */}
                {canBack && (
                  <button type="button" onClick={() => navigate(-1)} title="Back" aria-label="Go back" className={TILE_BTN}>
                    <IconTile emoji="⬅️" color="#94a3b8" size={36} light={!dark} className={TILE_HOVER} />
                  </button>
                )}
                <button type="button" onClick={() => navigate(`/store/${STORE}`)} title="Main dashboard"
                  aria-label="Go to the main dashboard" className={TILE_BTN}>
                  <IconTile emoji="🏠" color="#60a5fa" size={36} light={!dark} className={TILE_HOVER} />
                </button>
              </span>
            )}
          </div>
          <div className="relative mt-3">
            <Search size={24} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input ref={input} autoFocus value={typed} onChange={(e) => type(e.target.value)} maxLength={80}
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

      {open ? (
        <PartScreen key={open.id} part={open} onBack={() => setOpen(null)} />
      ) : (
      <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
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
                  <button key={p.id} type="button" onClick={() => { listY.current = window.scrollY; setOpen(p); }}
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
      )}
    </div>
  );
}

// The picked part, filling the screen under the search: its photo as big as the
// room allows, every angle a tap away, and its stock and place in large type
// beside it (below it on an upright screen). Back, Escape, a new search or the
// idle reset bring the list back.
function PartScreen({ part, onBack }) {
  const photos = partService.photosOf(part);
  const [n, setN] = useState(0);
  const step = (d) => setN((i) => (i + d + photos.length) % photos.length);

  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") onBack();
      else if (e.target instanceof HTMLInputElement) return;   // arrows move the cursor in the search box
      else if (e.key === "ArrowRight" && photos.length > 1) step(1);
      else if (e.key === "ArrowLeft" && photos.length > 1) step(-1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onBack, photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const spec = [part.specification, part.model_no && `Model ${part.model_no}`].filter(Boolean).join(" · ");
  return (
    <section aria-label={`${part.part_no} — ${part.part_name}`}
      className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 pt-4 sm:px-6">
        <button type="button" onClick={onBack}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-navy-900 px-5 py-3 text-base font-bold text-white hover:bg-navy-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared dark:bg-white dark:text-navy-900">
          <ArrowLeft size={20} aria-hidden="true" /> Back to results
        </button>
        <span className="min-w-0 truncate font-mono text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl">{part.part_no}</span>
      </div>

      {/* Side by side on a wide screen; on an upright kiosk screen the photo
          takes the full width on top and the details sit under it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6 landscape:flex-row">
        {/* The photo — as large as the screen leaves room for. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200 dark:bg-navy-900 dark:ring-navy-800">
            {photos.length ? (
              <img src={partService.imageUrl(part, false, n)} alt={`Photo ${n + 1} of ${part.part_no}`}
                className="h-full w-full object-contain" draggable={false} />
            ) : (
              <span className="flex flex-col items-center gap-2 text-slate-400">
                <ImageOff size={72} aria-hidden="true" /><span className="text-lg font-semibold">No photo yet</span>
              </span>
            )}
            {photos.length > 1 && (
              <>
                <button type="button" onClick={() => step(-1)} aria-label="Previous photo"
                  className="absolute left-3 top-1/2 flex h-14 w-14 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
                  <ChevronLeft size={32} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => step(1)} aria-label="Next photo"
                  className="absolute right-3 top-1/2 flex h-14 w-14 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
                  <ChevronRight size={32} aria-hidden="true" />
                </button>
                <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-sm font-bold text-white">
                  Photo {n + 1} of {photos.length}
                </span>
              </>
            )}
          </div>
          {photos.length > 1 && (
            <div className="flex shrink-0 justify-center gap-3">
              {photos.map((name, i) => (
                <button key={name} type="button" onClick={() => setN(i)} aria-pressed={i === n} aria-label={`Show photo ${i + 1}`}
                  className={`h-20 w-20 overflow-hidden rounded-xl transition ${i === n
                    ? "ring-4 ring-toyotared ring-offset-2 dark:ring-offset-navy-950"
                    : "opacity-70 ring-1 ring-slate-300 hover:opacity-100 dark:ring-navy-700"}`}>
                  <img src={partService.imageUrl(part, true, i)} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* What it is, how many, where — readable from a step away. */}
        <div className="flex shrink-0 flex-col gap-4 rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-navy-900 dark:ring-navy-800 landscape:w-[340px] landscape:lg:w-[380px] landscape:xl:w-[440px]">
          <div>
            <p className="text-2xl font-bold leading-snug text-slate-900 dark:text-white">{part.part_name}</p>
            {spec && <p className="mt-1 text-lg text-slate-500 dark:text-slate-400">{spec}</p>}
          </div>
          <div className={`rounded-2xl px-5 py-4 ${part.available
            ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30"
            : "bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30"}`}>
            <p className="flex items-center gap-2 text-lg font-bold">
              {part.available ? <PackageCheck size={24} aria-hidden="true" /> : <PackageX size={24} aria-hidden="true" />}
              {part.available ? "Available" : "Not available"}
            </p>
            {part.available && (
              <p className="mt-1 text-4xl font-extrabold tabular">{num(part.qty)} <span className="text-xl font-bold">{part.uom}</span></p>
            )}
          </div>
          <div className="space-y-3 text-lg">
            <p className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100">
              <MapPin size={22} aria-hidden="true" className="shrink-0 text-toyotared" />
              {part.location || "No location"}
            </p>
            {part.rework_location && <p className="pl-8 text-base text-slate-500 dark:text-slate-400">Rework: {part.rework_location}</p>}
            {part.section && (
              <p className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <Layers size={20} aria-hidden="true" className="shrink-0" />{part.section}
              </p>
            )}
            {part.discontinued && (
              <p className="inline-block rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-500 dark:bg-navy-800">Discontinued</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
