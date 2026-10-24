import React from "react";
import { partService } from "../services/partService.js";

// A part's saved photos, big — one at a time, with the angles below to switch
// between (up to 3 since 24 Oct 2026, Photo 1 the main one). The caller keeps
// which one is on show (`n`), so its footer can act on that photo.
export default function PartPhotoView({ part, n, onShow, maxHeight = "max-h-[64vh]" }) {
  const photos = partService.photosOf(part);
  if (!photos.length) return <p className="text-sm text-slate-400">No photo.</p>;
  const at = Math.min(n, photos.length - 1);
  return (
    <>
      <img src={partService.imageUrl(part, false, at)} alt={`Photo ${at + 1} of ${part.part_no}`}
        className={`mx-auto ${maxHeight} w-auto rounded-lg`} />
      {photos.length > 1 && (
        <div className="mt-3 flex justify-center gap-3">
          {photos.map((name, i) => (
            <button key={name} type="button" onClick={() => onShow(i)} aria-pressed={i === at}
              aria-label={`Show photo ${i + 1}`}
              className={`relative h-16 w-16 overflow-hidden rounded-lg transition ${i === at
                ? "ring-[3px] ring-toyotared ring-offset-2 dark:ring-offset-navy-900"
                : "opacity-70 ring-1 ring-slate-200 hover:opacity-100 dark:ring-navy-700"}`}>
              <img src={partService.imageUrl(part, true, i)} alt="" className="h-full w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] font-semibold text-white">
                {i === 0 ? "1 · main" : i + 1}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
