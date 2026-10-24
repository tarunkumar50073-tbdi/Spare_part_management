import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Check, Plus, RotateCcw, X } from "lucide-react";
import Modal from "./Modal.jsx";

// Checking a part's photos before they are saved, on a tablet / phone (the
// store, 23 Oct 2026: "tap to take photo par click karke sidha camera khulna
// chahiye and photo retake ka option bhi ho … 2-3 angle"; "ok ki jagah save
// rhe"). The caller opens the camera straight from the tap and hands the shot
// here; it shows big with Save, Retake and + Another angle.
//
// A shot that came out right is one tap: Save ("agar 1 bar me sahi aa gyi to
// 2-3 angel lene ki jarurat nhi"). Every angle shown is kept on the part, the
// first the main one ("3 angle se photo li ya do angle se photo li to dono
// thik lagi to dono rhni chahiye", 24 Oct 2026), and one that came out wrong
// is taken out with its ✕ before Save ("teen khechi and 2 sahi lagi to 1 hta
// sake"). Retake redoes the angle on show. Nothing reaches the app until Save.
export const MAX_SHOTS = 3;

// A preview of a shot that is not uploaded yet; its blob URL goes with it.
function Shot({ file, alt, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file) return undefined;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}

export default function PhotoCapture({ part, first, onSave, onClose }) {
  const [shots, setShots] = useState(() => (first ? [first] : []));
  const [shown, setShown] = useState(0);
  const [saving, setSaving] = useState(false);
  const camera = useRef(null);
  const retaking = useRef(false);

  const openCamera = (retake) => {
    if (saving) return;
    retaking.current = retake;
    if (camera.current) {
      camera.current.value = "";
      camera.current.click();
    }
  };
  const took = (file) => {
    if (!file) return;                                    // the camera was shut without a shot
    if (!file.type.startsWith("image/")) {
      toast.error("That is not a photo");
      return;
    }
    if (retaking.current && shots.length) {
      setShots((s) => s.map((f, i) => (i === shown ? file : f)));
    } else if (shots.length < MAX_SHOTS) {
      setShots((s) => [...s, file]);
      setShown(shots.length);                             // the new angle
    }
  };
  const drop = (i) => {
    if (saving || shots.length < 2) return;               // one photo always stays — Retake redoes it
    setShots((s) => s.filter((_, j) => j !== i));
    setShown((at) => (i < at ? at - 1 : Math.min(at, shots.length - 2)));
  };
  const save = async () => {
    if (!shots.length || saving) return;
    setSaving(true);
    try {
      await onSave(shots);                                // the caller closes this on success
    } finally {
      setSaving(false);
    }
  };

  const more = shots.length > 1;
  return (
    <>
      <Modal open onClose={() => { if (!saving) onClose(); }} size="xl"
        title={`${part.part_no} — ${part.part_name}`}
        footer={(
          <div className="grid w-full grid-cols-3 gap-2">
            <button type="button" className="btn-secondary justify-center py-3 disabled:cursor-not-allowed disabled:opacity-50" disabled={saving}
              onClick={() => openCamera(true)}>
              <RotateCcw size={17} aria-hidden="true" className="shrink-0" /> Retake
            </button>
            <button type="button" className="btn-secondary justify-center py-3 disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || shots.length >= MAX_SHOTS}
              onClick={() => openCamera(false)}>
              <Plus size={17} aria-hidden="true" className="shrink-0" />
              {/* a phone has room for one word under three buttons */}
              <span className="sm:hidden">Angle</span><span className="hidden sm:inline">Another angle</span>
            </button>
            <button type="button" className="btn-primary justify-center py-3 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || !shots.length}
              onClick={save}>
              <Check size={18} aria-hidden="true" className="shrink-0" />
              {saving ? "Saving…" : more ? `Save ${shots.length}` : "Save"}
            </button>
          </div>
        )}>
        <Shot file={shots[shown]} alt={`Photo ${shown + 1} of ${part.part_no}`}
          className="mx-auto max-h-[52vh] w-auto rounded-lg object-contain" />
        {more ? (
          <>
            <p className="mt-3 text-center text-[13px] text-slate-500 dark:text-slate-400">
              All {shots.length} photos are saved on the part, Photo 1 the main one. One came out wrong? Tap its <b>✕</b>.
            </p>
            <div className="mt-2 flex justify-center gap-3">
              {shots.map((f, i) => (
                <div key={i} className="relative">
                  <button type="button" onClick={() => setShown(i)} aria-pressed={i === shown} disabled={saving}
                    aria-label={`Show photo ${i + 1}`}
                    className={`block h-20 w-20 overflow-hidden rounded-lg transition ${i === shown
                      ? "ring-[3px] ring-toyotared ring-offset-2 dark:ring-offset-navy-900"
                      : "ring-1 ring-slate-200 dark:ring-navy-700"}`}>
                    <Shot file={f} alt="" className="h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] font-semibold text-white">
                      {i === 0 ? "Photo 1 · main" : `Photo ${i + 1}`}
                    </span>
                  </button>
                  {/* big enough for a finger on a tablet */}
                  <button type="button" onClick={() => drop(i)} disabled={saving}
                    aria-label={`Remove photo ${i + 1}`} title="Remove this photo"
                    className="absolute -right-2.5 -top-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-white text-red-600 shadow ring-1 ring-red-200
                      hover:bg-red-600 hover:text-white disabled:opacity-50 dark:bg-navy-900 dark:ring-red-500/40">
                    <X size={15} aria-hidden="true" strokeWidth={2.5} />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-3 text-center text-[13px] text-slate-500 dark:text-slate-400">
            Looks right? Tap <b>Save</b>. If not, Retake it — or take another angle (up to {MAX_SHOTS}); every angle you keep is saved.
          </p>
        )}
      </Modal>
      {/* capture: the tablet / phone camera opens straight away. */}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => took(e.target.files?.[0])} />
    </>
  );
}
