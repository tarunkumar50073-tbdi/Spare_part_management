import React from "react";
import { X } from "lucide-react";

// `full` is for a list you are meant to read rather than glance at — a drill
// -down of 481 parts across eight columns has nowhere to go in 768px.
const MAX_WIDTH = { md: "max-w-lg", xl: "max-w-3xl", full: "max-w-[95vw]" };

export default function Modal({ open, onClose, title, children, footer, size = "md" }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={`relative bg-white dark:bg-navy-900 rounded-xl2 shadow-cardHover w-full ${MAX_WIDTH[size] || MAX_WIDTH.md} max-h-[85vh] overflow-y-auto animate-[fadeIn_0.15s_ease-out]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-navy-800 sticky top-0 bg-white dark:bg-navy-900">
          <h3 className="font-semibold text-slate-800 dark:text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-toyotared">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-slate-100 dark:border-navy-800 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
