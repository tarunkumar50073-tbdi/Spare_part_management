import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

// `full` is for a list you are meant to read rather than glance at — a drill
// -down of 481 parts across eight columns has nowhere to go in 768px.
const MAX_WIDTH = { md: "max-w-lg", xl: "max-w-3xl", full: "max-w-[95vw]" };
// A drawer slides in from the right and keeps the page it came from visible.
const DRAWER_WIDTH = { md: "max-w-md", xl: "max-w-2xl", full: "max-w-[95vw]" };

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Open dialogs, innermost last. A print dialog opened from the part drawer
// sits on top of it: Escape and Tab belong to the top one only, so Escape
// closes the print dialog and leaves the drawer open.
const openStack = [];

export default function Modal({
  open, onClose, title, children, footer, size = "md",
  // "dialog" (centred, the default) or "drawer" (right-hand slide-over).
  variant = "dialog",
}) {
  const panelRef = useRef(null);
  const titleId = useId();
  const drawer = variant === "drawer";

  // Accessibility: on open, move focus into the dialog and remember where it
  // was so it can be restored on close; trap Tab within the panel; close on
  // Escape; and lock background scroll. (Audit: Modal had none of these.)
  useEffect(() => {
    if (!open) return undefined;
    const prevActive = document.activeElement;
    const panel = panelRef.current;
    openStack.push(titleId);
    panel?.focus?.();

    const onKey = (e) => {
      if (openStack[openStack.length - 1] !== titleId) return;   // not the top dialog
      if (e.key === "Escape") { onClose?.(); return; }
      if (e.key === "Tab" && panel) {
        const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (!items.length) { e.preventDefault(); panel.focus(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = openStack.lastIndexOf(titleId);
      if (at >= 0) openStack.splice(at, 1);
      document.body.style.overflow = prevOverflow;
      if (prevActive && prevActive.focus) prevActive.focus();
    };
  }, [open, onClose, titleId]);

  if (!open) return null;
  const header = (
    <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-navy-800 sticky top-0 z-10 bg-white dark:bg-navy-900">
      <h3 id={titleId} className="min-w-0 truncate font-semibold text-slate-800 dark:text-white">{title}</h3>
      <button
        onClick={onClose}
        aria-label="Close"
        className="shrink-0 rounded text-slate-400 hover:text-toyotared focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
  const foot = footer && (
    <div className="px-5 py-4 border-t border-slate-100 dark:border-navy-800 flex flex-wrap justify-end gap-2">{footer}</div>
  );

  if (drawer) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={`relative flex h-full w-full ${DRAWER_WIDTH[size] || DRAWER_WIDTH.xl} flex-col bg-white dark:bg-navy-900 shadow-cardHover animate-[slideIn_0.18s_ease-out] focus:outline-none`}
        >
          {header}
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {foot}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`relative bg-white dark:bg-navy-900 rounded-xl2 shadow-cardHover w-full ${MAX_WIDTH[size] || MAX_WIDTH.md} max-h-[85vh] overflow-y-auto animate-[fadeIn_0.15s_ease-out] focus:outline-none`}
      >
        {header}
        <div className="px-5 py-4">{children}</div>
        {foot}
      </div>
    </div>
  );
}
