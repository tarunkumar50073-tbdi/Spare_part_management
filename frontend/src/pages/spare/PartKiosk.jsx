import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowLeft, ChevronLeft, ChevronRight, Hourglass, ImageOff, Layers, MapPin, PackageCheck, PackageX, Search,
  CircleHelp, X,
} from "lucide-react";
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
//
// Polished for the touchscreen on 28 Oct 2026 (the store's kiosk brief): the
// same two screens and search; photos that never crop or break (a failed one
// shows "No Photo Available"), one stock word read the same on the card and
// the part screen — Available (green), Out of Stock (red), Stock not counted
// yet (grey), and material waiting for quality at the gate apart (amber) —
// and the rack / bin set large, since the kiosk is for finding the part.

const STORE = "MAINTENANCE";
const IDLE_MS = 2 * 60 * 1000;
const PER_PAGE = 24;

// The top bar's tile button and hover (Topbar.jsx), so the kiosk's Back and
// Home read like the rest of the app — 44 px, a finger's width.
const TILE = 44;
const TILE_BTN = "group relative inline-flex shrink-0 items-center justify-center rounded-[11px] "
  + "focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50";
const TILE_HOVER = "transition group-hover:brightness-125 group-hover:-translate-y-px";

// One stock word for a part, the same on its card and its screen. A part
// never counted is not "out of stock": nobody knows (an older server sends no
// `counted`, and its 0 reads as out of stock, as before).
const TONE = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
  out: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30",
  unknown: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-navy-800 dark:text-slate-300 dark:ring-navy-700",
};
function stockOf(part) {
  if (part.available) return { tone: "ok", Icon: PackageCheck, word: "Available" };
  if (part.counted === false) return { tone: "unknown", Icon: CircleHelp, word: "Stock not counted yet" };
  return { tone: "out", Icon: PackageX, word: "Out of Stock" };
}

function StockBadge({ part }) {
  const s = stockOf(part);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-bold ring-1 ${TONE[s.tone]}`}>
      <s.Icon size={15} aria-hidden="true" /> {s.word}{part.available ? ` · ${num(part.qty)} ${part.uom || ""}` : ""}
    </span>
  );
}

// Labelled at the gate, waiting for quality — not stock yet (spare_packets
// QC_PENDING); shown only when there is some.
function QcWaiting({ part, big = false }) {
  if (!(Number(part.qc_pending) > 0)) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-amber-50 font-bold text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-500/30 ${big ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-[12.5px]"}`}>
      <Hourglass size={big ? 16 : 14} aria-hidden="true" /> {num(part.qc_pending)} {part.uom || ""} waiting for quality check
    </span>
  );
}

function NoPhoto({ big = false }) {
  return (
    <span className="flex flex-col items-center justify-center gap-1.5 text-slate-400 dark:text-slate-500">
      <ImageOff size={big ? 56 : 32} aria-hidden="true" />
      <span className={big ? "text-base font-semibold" : "text-xs font-medium"}>No Photo Available</span>
    </span>
  );
}

// A part photo, whole (object-contain); one that fails to load shows the
// placeholder instead of a broken image. Keyed by its address by the caller,
// so a new photo gets a fresh try.
function Photo({ src, alt, big = false, className = "" }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <NoPhoto big={big} />;
  return (
    <img src={src} alt={alt} loading={big ? "eager" : "lazy"} decoding="async" draggable={false}
      onError={() => setBad(true)} className={`h-full w-full object-contain ${className}`} />
  );
}

export default function PartKiosk() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { dark } = useTheme() || {};
  const location = useLocation();
  const [from] = useState(() => pageBefore(location.pathname));
  const home = `/store/${STORE}`;
  let inApp = false;
  try { inApp = (window.history.state?.idx ?? 0) > 0; } catch { inApp = false; }
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  // Back goes to the screen the Kiosk was opened from — on the list only: an
  // open part has "Back to results" in the search bar (the store, 28 Oct 2026:
  // "isme back to result bhi h and back button bhi"). Opened from the main
  // dashboard (or straight on the kiosk) only Home shows — a second tile to
  // the same place read as Back not working.
  const leaves = inApp && Boolean(from) && from !== home && from !== "/";
  const canBack = !open && leaves;
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
  // kiya wahi par puri screen khule"), so the page is exactly one screen high —
  // the visible one (dvh), so nothing hides under browser bars on a touch
  // screen. Never wider than the screen.
  return (
    <div className={`flex flex-col overflow-x-hidden bg-slate-50 dark:bg-navy-950 ${open ? "h-dvh overflow-y-hidden" : "min-h-dvh"}`}>
      <header className="sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-navy-800 dark:bg-navy-900/95">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-10 w-auto shrink-0 rounded bg-white p-0.5" draggable={false} />
              <h1 className="min-w-0 truncate text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl">Spare Part Search</h1>
            </div>
            {can(user, "spare_store") && (
              <span className="flex shrink-0 items-center gap-2">
                {/* Back (canBack) and Home to the main dashboard — the top
                    bar's own tiles (the store, 28 Oct 2026: "jahan se ise khola
                    usi par nhi jata", "icon app me jo already h usi type k use
                    kar"). */}
                {canBack && (
                  <button type="button" onClick={() => navigate(-1)} title="Back" aria-label="Go back" className={TILE_BTN}>
                    <IconTile emoji="⬅️" color="#94a3b8" size={TILE} light={!dark} className={TILE_HOVER} />
                  </button>
                )}
                <button type="button" onClick={() => navigate(`/store/${STORE}`)} title="Main dashboard"
                  aria-label="Go to the main dashboard" className={TILE_BTN}>
                  <IconTile emoji="🏠" color="#60a5fa" size={TILE} light={!dark} className={TILE_HOVER} />
                </button>
              </span>
            )}
          </div>
          {/* The search bar; with a part open, "Back to results" sits at its
              start (the store, 28 Oct 2026: "back to result ... search bar me
              hi aana chahiye") so the part below gets the whole screen. */}
          <div className="mt-3 flex items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white px-2 py-1.5 shadow-sm transition focus-within:border-toyotared dark:border-navy-700 dark:bg-navy-900">
            {open && (
              <button type="button" onClick={() => setOpen(null)}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-[11px] bg-navy-900 px-4 text-base font-bold text-white hover:bg-navy-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared dark:bg-white dark:text-navy-900">
                <ArrowLeft size={20} aria-hidden="true" />
                <span className="hidden sm:inline">Back to results</span><span className="sm:hidden">Back</span>
              </button>
            )}
            <Search size={24} aria-hidden="true" className="ml-2 shrink-0 text-slate-400" />
            <input ref={input} autoFocus value={typed} onChange={(e) => type(e.target.value)} maxLength={80}
              placeholder="Type Part No., name, specification or model no."
              aria-label="Search a part" enterKeyHint="search" autoComplete="off"
              className="min-w-0 flex-1 bg-transparent py-2.5 text-xl text-slate-900 outline-none dark:text-white" />
            {typed && (
              <button type="button" onClick={clear} aria-label="Clear the search"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-navy-800">
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
            <p className="mb-3 text-sm font-medium text-slate-500 dark:text-slate-400">{num(total)} part{total === 1 ? "" : "s"} found</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {rows.map((p) => (
                <PartCard key={p.id} part={p} onOpen={() => { listY.current = window.scrollY; setOpen(p); }} />
              ))}
            </div>
            {search.hasNextPage && (
              <div className="mt-5 text-center">
                <button type="button" className="btn-secondary min-h-[44px] px-6 py-3 text-base" disabled={search.isFetchingNextPage}
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

// One search result: the photo on a clean white box of the same height on
// every card, then Part No., description, spec / model, where it sits and its
// stock — what the floor reads to pick the right part.
function PartCard({ part: p, onOpen }) {
  const thumb = partService.imageUrl(p, true);
  const spec = [p.specification, p.model_no && `Model ${p.model_no}`].filter(Boolean).join(" · ");
  return (
    <button type="button" onClick={onOpen}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared dark:border-navy-800 dark:bg-navy-900">
      {/* The photo sits inside the box (absolute), so a tall photo can never
          stretch the box past 4:3 and every card keeps the same height. */}
      <span className="relative block aspect-[4/3] w-full shrink-0 overflow-hidden border-b border-slate-100 bg-white dark:border-navy-800 dark:bg-navy-900">
        <span className="absolute inset-2 flex items-center justify-center">
          <Photo key={thumb || "none"} src={thumb} alt={`Photo of ${p.part_no}`} />
        </span>
        {p.photos?.length > 1 && (
          <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white">{p.photos.length} photos</span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 p-3.5">
        <span className="truncate font-mono text-lg font-extrabold tracking-tight text-slate-900 dark:text-white">{p.part_no}</span>
        <span className="line-clamp-2 text-[15px] font-semibold leading-snug text-slate-700 dark:text-slate-200" title={p.part_name}>{p.part_name}</span>
        {spec && <span className="line-clamp-1 text-[13px] text-slate-500 dark:text-slate-400" title={spec}>{spec}</span>}
        <span className="mt-auto flex min-w-0 flex-col gap-2 pt-2">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200 dark:bg-navy-800 dark:ring-navy-700">
              <MapPin size={14} aria-hidden="true" className="shrink-0 text-toyotared" />
              <span className={`truncate font-mono font-bold ${p.location ? "text-slate-800 dark:text-slate-100" : "font-sans font-medium text-slate-400"}`}>
                {p.location || "No location"}
              </span>
            </span>
            {p.section && (
              <span className="inline-flex min-w-0 items-center gap-1 text-slate-500 dark:text-slate-400">
                <Layers size={13} aria-hidden="true" className="shrink-0" /><span className="truncate">{p.section}</span>
              </span>
            )}
          </span>
          {p.rework_location && <span className="truncate text-[12px] text-slate-500 dark:text-slate-400">Rework: {p.rework_location}</span>}
          <span className="flex flex-wrap items-center gap-1.5">
            <StockBadge part={p} />
            <QcWaiting part={p} />
            {p.discontinued && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-800">Discontinued</span>}
          </span>
        </span>
      </span>
    </button>
  );
}

// The picked part, filling the screen under the search: its photo as big as the
// room allows, every angle a tap away, and beside it (below it on an upright
// screen) Part No., description, spec / model, stock and — large — its rack /
// bin and section. With no photo the photo box stays small and the details
// take the room. Back, Escape, a new search or the idle reset bring the list
// back.
function PartScreen({ part, onBack }) {
  const photos = partService.photosOf(part);
  const [n, setN] = useState(0);
  const step = (d) => setN((i) => (i + d + photos.length) % photos.length);
  const hasPhoto = photos.length > 0;
  const stock = stockOf(part);

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
  const big = partService.imageUrl(part, false, n);
  return (
    // The whole screen's width, as before (the store, 28 Oct 2026: "photo badi
    // h dikhni chahiye jaise phle th ... puri screen me" — the photo is there
    // to identify the part); the details beside it stay narrow.
    <section aria-label={`${part.part_no} — ${part.part_name}`}
      className="flex min-h-0 w-full flex-1 flex-col">

      {/* Side by side on a wide screen; on an upright kiosk screen the photo
          takes the full width on top and the details sit under it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4 landscape:flex-row">
        {/* The photo — as large as the screen leaves room for; a small box
            when there is none. */}
        {/* Upright, the photo keeps at least a third of the screen and the
            details scroll when a small screen has no more room. */}
        <div className={hasPhoto ? "flex min-h-[35vh] flex-1 flex-col gap-3 landscape:min-h-0"
          : "flex shrink-0 flex-col landscape:w-[34%]"}>
          <div className={`relative flex items-center justify-center overflow-hidden rounded-2xl bg-white p-1 shadow-sm ring-1 ring-slate-200 dark:bg-navy-900 dark:ring-navy-800 ${hasPhoto
            ? "min-h-0 flex-1" : "aspect-[4/3] max-h-[30vh] w-full landscape:max-h-none"}`}>
            <Photo key={big || "none"} src={big} alt={`Photo ${n + 1} of ${part.part_no}`} big />
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
            <div className="flex shrink-0 justify-center gap-2">
              {photos.map((name, i) => (
                <button key={name} type="button" onClick={() => setN(i)} aria-pressed={i === n} aria-label={`Show photo ${i + 1}`}
                  className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg bg-white p-0.5 transition dark:bg-navy-900 ${i === n
                    ? "ring-4 ring-toyotared ring-offset-2 dark:ring-offset-navy-950"
                    : "opacity-70 ring-1 ring-slate-300 hover:opacity-100 dark:ring-navy-700"}`}>
                  <Photo key={name} src={partService.imageUrl(part, true, i)} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* What it is, how many, where — readable from a step away, in the
            order the floor asks: which part, is it there, where is it. */}
        <div className={`flex min-h-0 flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-navy-900 dark:ring-navy-800 ${hasPhoto
          ? "landscape:shrink-0 landscape:w-[240px] landscape:lg:w-[260px] landscape:xl:w-[280px]" : "flex-1 landscape:self-start"}`}>
          <div className="min-w-0">
            <p className="break-all font-mono text-xl font-extrabold tracking-tight text-slate-900 dark:text-white">{part.part_no}</p>
            <p className="mt-1 text-lg font-bold leading-snug text-slate-800 dark:text-slate-100">{part.part_name}</p>
            {spec && <p className="mt-1 text-base text-slate-500 dark:text-slate-400">{spec}</p>}
          </div>

          <div className={`rounded-xl px-4 py-3 ring-1 ${TONE[stock.tone]}`}>
            <p className="flex items-center gap-2 text-base font-bold">
              <stock.Icon size={20} aria-hidden="true" /> {stock.word}
            </p>
            {part.available && (
              <p className="mt-0.5 text-3xl font-extrabold tabular">{num(part.qty)} <span className="text-lg font-bold">{part.uom}</span></p>
            )}
          </div>
          <QcWaiting part={part} big />

          {/* Where to find it — the reason the kiosk is there. */}
          <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200 dark:bg-navy-950/60 dark:ring-navy-800">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Rack / Bin</p>
            <p className="mt-1 flex items-center gap-2">
              <MapPin size={22} aria-hidden="true" className="shrink-0 text-toyotared" />
              {part.location
                ? <span className="break-all font-mono text-xl font-extrabold text-slate-900 dark:text-white">{part.location}</span>
                : <span className="text-base font-semibold text-slate-400">Location not recorded</span>}
            </p>
            {part.rework_location && <p className="mt-1 pl-7 text-sm text-slate-500 dark:text-slate-400">Rework: {part.rework_location}</p>}
          </div>

          {part.section && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Store / Department</p>
              <p className="mt-1 flex items-center gap-2 text-base font-semibold text-slate-700 dark:text-slate-200">
                <Layers size={18} aria-hidden="true" className="shrink-0" />{part.section}
              </p>
            </div>
          )}
          {part.discontinued && (
            <p className="self-start rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-500 dark:bg-navy-800">Discontinued</p>
          )}
        </div>
      </div>
    </section>
  );
}
