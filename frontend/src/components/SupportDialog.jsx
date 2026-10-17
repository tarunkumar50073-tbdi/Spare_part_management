import React from "react";
import { ArrowUpRight, Clock, Mail, MapPin, Phone, Wrench } from "lucide-react";
import Modal from "./Modal.jsx";
import { APP_NAME, APP_OWNER, APP_VERSION, SUPPORT } from "../lib/appInfo.js";

// Who to call when something is stuck — the same contacts as the sign-in card,
// reachable from inside the app (the "Support / Help" button at the foot of
// the menu).
export default function SupportDialog({ open, onClose }) {
  const row = "flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-navy-700";
  const link = `${row} text-navy-800 hover:border-toyotared hover:text-toyotared dark:text-slate-100`;
  const icon = "shrink-0 text-toyotared";
  return (
    <Modal open={open} onClose={onClose} title="Support / Help"
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Stuck on a screen, a wrong figure, or a login problem? Contact the DX support team.
      </p>
      <div className="mt-3 space-y-2">
        <a href={`mailto:${SUPPORT.email}`} className={link}>
          <Mail size={16} className={icon} aria-hidden="true" /> {SUPPORT.email}
        </a>
        <a href={`tel:${SUPPORT.phone.replace(/\s/g, "")}`} className={link}>
          <Phone size={16} className={icon} aria-hidden="true" /> {SUPPORT.phone}
        </a>
        <p className={`${row} text-slate-600 dark:text-slate-300`}>
          <Wrench size={16} className={icon} aria-hidden="true" /> {SUPPORT.team}
        </p>
        <p className={`${row} text-slate-600 dark:text-slate-300`}>
          <Clock size={16} className={icon} aria-hidden="true" /> {SUPPORT.hours}
        </p>
        <p className={`${row} text-slate-600 dark:text-slate-300`}>
          <MapPin size={16} className={icon} aria-hidden="true" />
          <span className="flex flex-wrap items-center gap-2">
            {SUPPORT.plants.map((p, i) => (
              <React.Fragment key={p.label}>
                {i > 0 && <span className="text-slate-300 dark:text-slate-600">·</span>}
                <a href={p.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-navy-800 hover:text-toyotared dark:text-slate-100">
                  {p.label} <ArrowUpRight size={12} aria-hidden="true" />
                </a>
              </React.Fragment>
            ))}
          </span>
        </p>
      </div>
      <p className="mt-4 text-[11px] text-slate-400">{APP_NAME} · v{APP_VERSION} · {APP_OWNER}</p>
    </Modal>
  );
}
