import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { ArrowLeft, Camera, CheckCircle2, ImagePlus, MapPin, Search } from "lucide-react";
import { useCan } from "../../components/Can.jsx";
import PhotoCapture from "../../components/PhotoCapture.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { partService } from "../../services/partService.js";
import { shrinkPhoto } from "../../utils/shrinkPhoto.js";
import { num } from "../../lib/format.js";

// Photo Mode — photographing the store rack by rack on a tablet or phone (the
// store, 21 Oct 2026: "photo mode wala #1 aur #2 bana do"). Pick a rack; its
// parts come up as big cards, those still without a photo first; tap a card
// and the camera opens straight away; the shot shows big with Save / Retake /
// + Another angle (components/PhotoCapture.jsx, 23 Oct 2026) and Save puts it on
// that part; then the next part without one is lit up, with a big "Next" button
// at the bottom.
//
// A browser lets a page open the camera only from a tap, so "next" is one tap
// on that button, never a camera that pops up by itself.
//
// The photo is the Part Master's (one per part, services/part_image_service.py);
// taking one here is the same as the 📷 on the Part Master list.

const PAGE = 60;
const RACK_MAX = 2000;
const PREF = "dx_photo_mode";

function readPref() {
  try {
    return JSON.parse(localStorage.getItem(PREF) || "{}") || {};
  } catch {
    return {};
  }
}
function savePref(value) {
  try {
    localStorage.setItem(PREF, JSON.stringify(value));
  } catch {
    // private window / blocked storage: the screen just starts afresh next time
  }
}

export default function PartPhotos() {
  const { activeCode, activeStore } = useStores();
  const canEdit = useCan("part_master", "edit");
  const sections = activeStore?.sections || [];
  const [sectionId, setSectionId] = useState(() => readPref().section_id || "");
  const [rack, setRack] = useState(() => readPref().rack || "");
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [typed, setTyped] = useState("");
  const [opts, setOpts] = useState(null);
  const [parts, setParts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [nextId, setNextId] = useState(null);
  // The shot being checked before Save: { part, file }.
  const [capture, setCapture] = useState(null);
  const camera = useRef(null);
  const target = useRef(null);
  const cardRefs = useRef({});

  useEffect(() => { savePref({ section_id: sectionId, rack }); }, [sectionId, rack]);
  useEffect(() => {
    const t = setTimeout(() => setKeyword(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const loadOptions = () => {
    if (!activeCode) return;
    partService.filterOptions({ store_code: activeCode, section_id: sectionId || undefined, is_active: true })
      .then((res) => setOpts(res.data.data))
      .catch(() => setOpts(null));
  };
  useEffect(loadOptions, [activeCode, sectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (page = 1) => {
    if (!activeCode || (!rack && !keyword)) {
      setParts([]);
      setMeta(null);
      return;
    }
    setLoading(true);
    try {
      // A whole rack comes at once (the biggest has ~660 parts): paging a
      // "without a photo" list while photos are being taken would shift the
      // pages under the cards and skip parts. A search pages normally.
      // Active parts only — an inactive part needs no photo, and the count
      // above reads the same 4,892 the rest of the app shows (23 Oct 2026).
      const res = await partService.list({
        store_code: activeCode, page, per_page: rack ? RACK_MAX : PAGE, is_active: true,
        section_id: sectionId || undefined, rack: rack || undefined,
        keyword: keyword || undefined, missing: onlyMissing ? "photo" : undefined,
      });
      let rows = res.data.data || [];
      // A rack in bin order (R4-S1-B1, R4-S1-B2 … R4-S1-B10), the way it is walked.
      if (rack) rows = [...rows].sort((a, b) => (a.location || "").localeCompare(b.location || "", "en", { numeric: true }));
      setParts((prev) => (page === 1 ? rows : [...prev, ...rows]));
      setMeta(res.data.meta);
      if (page === 1) setNextId(rows.find((r) => !r.image_file)?.id ?? null);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(1); }, [activeCode, sectionId, rack, keyword, onlyMissing]); // eslint-disable-line react-hooks/exhaustive-deps

  const rackRow = useMemo(() => (opts?.racks || []).find((r) => r.value === rack), [opts, rack]);
  const next = parts.find((p) => p.id === nextId) || null;

  const shoot = (part) => {
    if (!canEdit || busyId) return;
    target.current = part;
    if (camera.current) {
      camera.current.value = "";
      camera.current.click();
    }
  };

  const took = (file) => {
    const part = target.current;
    if (!file || !part) return;
    if (!file.type.startsWith("image/")) {
      toast.error("That is not a photo");
      return;
    }
    setCapture({ part, file });
  };

  const upload = async (part, file) => {
    const firstPhoto = !part.image_file;           // read before the upload changes anything
    setBusyId(part.id);
    try {
      const res = await partService.uploadImage(part.id, await shrinkPhoto(file));
      const saved = res.data.data;
      const updated = parts.map((p) => (p.id === part.id ? { ...p, image_file: saved.image_file } : p));
      setParts(updated);
      if (firstPhoto) {
        // The counts move on the spot; the server's own tally comes with the
        // next rack / section change.
        setOpts((o) => o && {
          ...o,
          photos: { ...o.photos, with_photo: o.photos.with_photo + 1 },
          racks: o.racks.map((r) => (r.value.toUpperCase() === rackOf(part.location).toUpperCase()
            ? { ...r, no_photo: Math.max(0, r.no_photo - 1) } : r)),
        });
      }
      // The next part still without a photo, after this one (then from the top).
      const at = updated.findIndex((p) => p.id === part.id);
      const after = [...updated.slice(at + 1), ...updated.slice(0, at)].find((p) => !p.image_file);
      setNextId(after?.id ?? null);
      if (after) cardRefs.current[after.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      setCapture(null);
      toast.success(`Photo saved — ${part.part_no}`);
    } catch (_) {
      /* handled globally */
    } finally {
      setBusyId(null);
    }
  };

  const total = opts?.photos?.total || 0;
  const withPhoto = opts?.photos?.with_photo || 0;
  const pct = total ? Math.round((withPhoto / total) * 100) : 0;

  return (
    <div className="space-y-4 pb-28">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-white">
            <Camera size={20} aria-hidden="true" /> Photo Mode
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">Pick a rack, tap a part, take the photo, Save — it goes on that part.</p>
        </div>
        <Link to="/parts" className="btn-secondary">
          <ArrowLeft size={15} aria-hidden="true" /> Part Master
        </Link>
      </div>

      {!canEdit && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          You can see the photos here. Taking one needs the Part Master edit right — ask the admin.
        </p>
      )}

      {/* How far the store (or section) has got. */}
      <div className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {num(withPhoto)} of {num(total)} parts have a photo
          </p>
          <p className="text-sm font-bold tabular text-slate-900 dark:text-white">{pct}%</p>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {sections.length > 1 && (
          <label className="text-xs font-medium text-slate-500">
            <span className="mb-1 block">Section</span>
            <select className="input-field w-48 py-2 text-sm" value={sectionId}
              onChange={(e) => { setSectionId(e.target.value); setRack(""); }}>
              <option value="">All sections</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs font-medium text-slate-500">
          <span className="mb-1 block">Find a part</span>
          <span className="relative block">
            <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input-field w-60 py-2 pl-8 text-sm" value={typed} placeholder="Part no, name or model no"
              onChange={(e) => setTyped(e.target.value)} />
          </span>
        </label>
        <label className="mb-2 inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          Only parts without a photo
        </label>
      </div>

      {/* The racks, big enough to tap: how many of each still need a photo. */}
      <div>
        <p className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Rack</p>
        <div className="flex flex-wrap gap-2">
          {(opts?.racks || []).map((r) => {
            const done = r.no_photo === 0;
            const active = r.value === rack;
            return (
              <button key={r.value} type="button" onClick={() => setRack(active ? "" : r.value)}
                className={`min-w-[5.5rem] rounded-xl px-3 py-2 text-left ring-1 ring-inset transition ${
                  active ? "bg-toyotared text-white ring-toyotared"
                    : done ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30"
                      : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50 dark:bg-navy-900 dark:text-slate-200 dark:ring-navy-700"}`}>
                <span className="block text-sm font-bold">{r.value}</span>
                <span className={`block text-[11px] ${active ? "text-white/85" : "text-slate-500 dark:text-slate-400"}`}>
                  {done ? <span className="inline-flex items-center gap-1"><CheckCircle2 size={11} aria-hidden="true" /> all done</span>
                    : `${num(r.no_photo)} of ${num(r.count)} left`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {rackRow && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          <b>{rackRow.value}</b>: {num(rackRow.count - rackRow.no_photo)} of {num(rackRow.count)} done
        </p>
      )}

      {!rack && !keyword ? (
        <p className="card p-8 text-center text-sm text-slate-400">Pick a rack above (or find a part) to start.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {parts.map((p) => {
              const thumb = partService.imageUrl(p, true);
              const isNext = p.id === nextId;
              return (
                <button key={p.id} type="button" ref={(el) => { cardRefs.current[p.id] = el; }}
                  onClick={() => shoot(p)} disabled={!canEdit || Boolean(busyId)}
                  className={`card flex items-stretch gap-3 p-3 text-left transition disabled:cursor-default ${
                    isNext ? "ring-2 ring-toyotared" : p.image_file ? "ring-1 ring-emerald-300 dark:ring-emerald-500/40" : ""}`}>
                  <span className="relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 dark:bg-navy-800">
                    {busyId === p.id ? (
                      <span className="h-full w-full animate-pulse bg-slate-200 dark:bg-navy-700" aria-label="Saving photo" />
                    ) : thumb ? (
                      <img src={thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImagePlus size={30} aria-hidden="true" className="text-slate-400" />
                    )}
                    {p.image_file && busyId !== p.id && (
                      <CheckCircle2 size={20} aria-hidden="true" className="absolute right-1 top-1 rounded-full bg-white text-emerald-600" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[15px] font-bold text-slate-900 dark:text-white">{p.part_no}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-slate-600 dark:text-slate-300">{p.part_name}</span>
                    {(p.specification || p.model_no) && (
                      <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                        {[p.model_no && `Model ${p.model_no}`, p.specification].filter(Boolean).join(" · ")}
                      </span>
                    )}
                    <span className="mt-1 flex items-center gap-1 text-[12px] font-semibold text-slate-500 dark:text-slate-400">
                      <MapPin size={12} aria-hidden="true" /> {p.location || "no location"}
                    </span>
                    {canEdit && (
                      <span className={`mt-1 inline-flex items-center gap-1 text-[12px] font-semibold ${p.image_file ? "text-slate-400" : "text-toyotared"}`}>
                        <Camera size={13} aria-hidden="true" /> {p.image_file ? "Tap to retake" : "Tap to take photo"}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {loading && <p className="text-center text-sm text-slate-400">Loading…</p>}
          {!loading && parts.length === 0 && (
            <p className="card p-8 text-center text-sm text-slate-400">
              {onlyMissing ? "Every part here has a photo." : "No part found."}
            </p>
          )}
          {meta?.has_next && !loading && (
            <div className="text-center">
              <button type="button" className="btn-secondary" onClick={() => load(meta.page + 1)}>Show more parts</button>
            </div>
          )}
        </>
      )}

      {/* The next part without a photo — one tap opens the camera for it. */}
      {canEdit && next && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur dark:border-navy-700 dark:bg-navy-900/95">
          <button type="button" onClick={() => shoot(next)} disabled={Boolean(busyId)}
            className="btn-primary mx-auto flex w-full max-w-xl items-center justify-center gap-2 py-3 text-base">
            <Camera size={20} aria-hidden="true" />
            {busyId ? "Saving…" : <>Next: <span className="font-mono">{next.part_no}</span>{next.location ? ` · ${next.location}` : ""}</>}
          </button>
        </div>
      )}

      {/* capture: on a phone / tablet the camera opens straight away (no
          "Camera or Files?" step); a laptop shows its file picker instead. */}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => took(e.target.files?.[0])} />

      {capture && (
        <PhotoCapture part={capture.part} first={capture.file}
          onSave={(file) => upload(capture.part, file)} onClose={() => setCapture(null)} />
      )}
    </div>
  );
}

const rackOf = (location) => (location || "").split("-")[0].trim();
