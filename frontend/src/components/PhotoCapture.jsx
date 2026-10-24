import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Check, CheckCircle2, Plus, RotateCcw } from "lucide-react";
import Modal from "./Modal.jsx";

// Checking a part's photo before it is saved, on a tablet / phone (the store,
// 23 Oct 2026: "tap to take photo par click karke sidha camera khulna chahiye
// and photo retake ka option bhi ho … 2-3 angle"; "ok ki jagah save rhe").
// The caller opens the camera straight from the tap and hands the shot here;
// it shows big with Save, Retake and + Another angle.
//
// A shot that came out right is one tap: Save ("agar 1 bar me sahi aa gyi to
// 2-3 angel lene ki jarurat nhi"). The angles are only tries, not a set — a part
// keeps ONE photo, the shot picked (the newest, unless another is tapped) — so a
// part that won't come out clear from one side can be tried from another and
// the clearest kept ("jis angel se sahi aaye wo usse kar saske"). Nothing
// reaches the app until Save.
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
  const [picked, setPicked] = useState(0);
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
    if (retaking.current) {
      setShots((s) => s.map((f, i) => (i === picked ? file : f)));
    } else if (shots.length < MAX_SHOTS) {
      setShots((s) => [...s, file]);
      setPicked(shots.length);                            // the new angle
    }
  };
  const save = async () => {
    const file = shots[picked];
    if (!file || saving) return;
    setSaving(true);
    try {
      await onSave(file);                                 // the caller closes this on success
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
              <Check size={18} aria-hidden="true" className="shrink-0" /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}>
        <Shot file={shots[picked]} alt={`Photo of ${part.part_no}`}
          className="mx-auto max-h-[52vh] w-auto rounded-lg object-contain" />
        {more ? (
          <>
            <p className="mt-3 text-center text-[13px] text-slate-500 dark:text-slate-400">
              Tap the clearest angle — only that one is saved on the part.
            </p>
            <div className="mt-2 flex justify-center gap-3">
              {shots.map((f, i) => (
                <button key={i} type="button" onClick={() => setPicked(i)} aria-pressed={i === picked} disabled={saving}
                  className={`relative h-20 w-20 overflow-hidden rounded-lg transition ${i === picked
                    ? "ring-[3px] ring-toyotared ring-offset-2 dark:ring-offset-navy-900"
                    : "opacity-60 ring-1 ring-slate-200 hover:opacity-100 dark:ring-navy-700"}`}>
                  <Shot file={f} alt={`Angle ${i + 1}`} className="h-full w-full object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] font-semibold text-white">
                    Angle {i + 1}
                  </span>
                  {i === picked && (
                    <CheckCircle2 size={18} aria-hidden="true" className="absolute right-1 top-1 rounded-full bg-white text-toyotared" />
                  )}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-3 text-center text-[13px] text-slate-500 dark:text-slate-400">
            Looks right? Tap <b>Save</b>. If not, Retake it — or try another angle (up to {MAX_SHOTS}) and keep the clearest.
          </p>
        )}
      </Modal>
      {/* capture: the tablet / phone camera opens straight away. */}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => took(e.target.files?.[0])} />
    </>
  );
}
