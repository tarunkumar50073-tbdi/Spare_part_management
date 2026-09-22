import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  ShieldCheck, Users, Mail, FileText, Boxes, Grid3x3, Factory,
  Store as StoreIcon, Tag, ServerCog, ChevronRight, Lock,
} from "lucide-react";
import { settingsService } from "../services/settingsService.js";
import { useAuth } from "../context/AuthContext.jsx";

// Shortcuts to the admin-manageable screens that already exist — one place to
// reach everything, instead of rebuilding them here.
const HUB = [
  { to: "/admin", label: "User Management", desc: "Users, roles, per-module rights, passwords", icon: Users },
  { to: "/departments", label: "Department Emails", desc: "Reorder / low-stock mail recipients", icon: Mail },
  { to: "/report-recipients", label: "Report Recipients", desc: "Who gets the daily window-time sheet", icon: FileText },
  { to: "/parts", label: "Part Master", desc: "Min / reorder / max, rate, category", icon: Boxes },
  { to: "/rack-bins", label: "Rack / Bin Master", desc: "Bin capacity, block / unblock", icon: Grid3x3 },
  { to: "/suppliers", label: "Supplier Master", desc: "Supplier list and details", icon: Factory },
];

const SYMBOLOGIES = ["CODE128", "CODE39", "EAN13"];

function SectionHead({ icon: Icon, title, hint }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-toyotared/10 text-toyotared">
        <Icon size={18} />
      </span>
      <div>
        <h3 className="text-base font-bold text-slate-800 dark:text-white">{title}</h3>
        {hint && <p className="text-xs text-slate-400">{hint}</p>}
      </div>
    </div>
  );
}

// A small on/off switch.
function Toggle({ on, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50
        ${on ? "bg-emerald-500" : "bg-slate-300 dark:bg-navy-700"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

function YesNo({ ok, yes = "On", no = "Off" }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
      ok ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
         : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400"}`}>
      {ok ? yes : no}
    </span>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-medium text-slate-700 dark:text-slate-200">{children}</span>
    </div>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [visibility, setVisibility] = useState([]);
  const [label, setLabel] = useState(null);
  const [savingLabel, setSavingLabel] = useState(false);

  useEffect(() => {
    if (!user?.is_admin) return;
    settingsService.systemStatus().then((r) => setStatus(r.data.data)).catch(() => {});
    settingsService.storeVisibility().then((r) => setVisibility(r.data.data || [])).catch(() => {});
    settingsService.labelConfig().then((r) => setLabel(r.data.data)).catch(() => {});
  }, [user?.is_admin]);

  const toggleStore = async (code, next) => {
    try {
      await settingsService.setStoreActive(code, next);
      setVisibility((v) => v.map((s) => (s.code === code ? { ...s, is_active: next } : s)));
      toast.success(next ? "Store shown" : "Store hidden");
    } catch (e) {
      toast.error(e?.response?.data?.message || "Could not update the store");
    }
  };

  const toggleSection = async (code, id, next) => {
    try {
      await settingsService.setSectionActive(id, next);
      setVisibility((v) => v.map((s) => (s.code === code
        ? { ...s, sections: s.sections.map((sec) => (sec.id === id ? { ...sec, is_active: next } : sec)) }
        : s)));
    } catch (e) {
      toast.error(e?.response?.data?.message || "Could not update the section");
    }
  };

  const setLabelField = (k, val) => setLabel((l) => ({ ...l, [k]: val }));

  const saveLabel = async () => {
    setSavingLabel(true);
    try {
      const res = await settingsService.setLabelConfig({
        width_mm: Number(label.width_mm),
        height_mm: Number(label.height_mm),
        symbology: label.symbology,
        show_part_no: !!label.show_part_no,
        show_description: !!label.show_description,
        description_max_chars: Number(label.description_max_chars),
      });
      setLabel(res.data.data);
      toast.success("Label settings saved");
    } catch (e) {
      toast.error(e?.response?.data?.message || "Could not save label settings");
    } finally {
      setSavingLabel(false);
    }
  };

  // Preview box keeps the label's real width:height proportion.
  const previewRatio = useMemo(() => {
    const w = Number(label?.width_mm) || 100;
    const h = Number(label?.height_mm) || 50;
    return `${w} / ${h}`;
  }, [label?.width_mm, label?.height_mm]);

  if (!user?.is_admin) {
    return (
      <div className="card max-w-lg mx-auto mt-10 text-center">
        <ShieldCheck size={28} className="mx-auto text-slate-300 mb-2" />
        <p className="text-sm text-slate-500 dark:text-slate-400">This page is for administrators only.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Settings</h2>
        <p className="text-xs text-slate-400">Everything an admin manages, in one place.</p>
      </div>

      {/* 1 — hub of existing admin screens */}
      <div className="card">
        <SectionHead icon={ServerCog} title="Admin & masters" hint="Open any management screen" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {HUB.map(({ to, label: l, desc, icon: Icon }) => (
            <Link key={to} to={to}
              className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3
                hover:border-toyotared/50 hover:shadow-sm dark:border-navy-800 dark:bg-navy-900">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600
                group-hover:bg-toyotared/10 group-hover:text-toyotared dark:bg-navy-800 dark:text-slate-300">
                <Icon size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-800 dark:text-white">{l}</span>
                <span className="block truncate text-xs text-slate-400">{desc}</span>
              </span>
              <ChevronRight size={16} className="text-slate-300 group-hover:text-toyotared" />
            </Link>
          ))}
        </div>
      </div>

      {/* 2 — store / section visibility */}
      <div className="card">
        <SectionHead icon={StoreIcon} title="Store & section visibility"
          hint="Turn a store or a section off to hide it everywhere — sidebar, store list and landing page" />
        <div className="space-y-3">
          {visibility.map((s) => (
            <div key={s.code} className="rounded-xl border border-slate-200 dark:border-navy-800">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-lg">{s.icon || "🏬"}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 dark:text-white truncate">{s.name}</p>
                    <p className="text-[11px] text-slate-400">{s.code}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <YesNo ok={s.is_active} yes="Visible" no="Hidden" />
                  <Toggle on={s.is_active} onClick={() => toggleStore(s.code, !s.is_active)} />
                </div>
              </div>
              {s.sections.length > 0 && (
                <div className="border-t border-slate-100 dark:border-navy-800 px-4 py-2">
                  {s.sections.map((sec) => (
                    <div key={sec.id} className="flex items-center justify-between py-1.5">
                      <span className={`text-sm ${sec.is_active ? "text-slate-700 dark:text-slate-200" : "text-slate-400 line-through"}`}>
                        {sec.name}
                      </span>
                      <Toggle on={sec.is_active} disabled={!s.is_active}
                        onClick={() => toggleSection(s.code, sec.id, !sec.is_active)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {visibility.length === 0 && <p className="text-sm text-slate-400">No stores.</p>}
        </div>
      </div>

      {/* 3 — barcode label editor */}
      {label && (
        <div className="card">
          <SectionHead icon={Tag} title="Barcode label" hint="The printed part-label template — size and what shows on it" />
          <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
            <div className="grid grid-cols-2 gap-3 max-w-lg">
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Width (mm)</span>
                <input type="number" min="20" max="300" value={label.width_mm}
                  onChange={(e) => setLabelField("width_mm", e.target.value)} className="input-field mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Height (mm)</span>
                <input type="number" min="10" max="300" value={label.height_mm}
                  onChange={(e) => setLabelField("height_mm", e.target.value)} className="input-field mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Symbology</span>
                <select value={label.symbology} onChange={(e) => setLabelField("symbology", e.target.value)}
                  className="input-field mt-1 w-full">
                  {SYMBOLOGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Description max chars</span>
                <input type="number" min="8" max="120" value={label.description_max_chars}
                  onChange={(e) => setLabelField("description_max_chars", e.target.value)} className="input-field mt-1 w-full" />
              </label>
              <label className="col-span-2 flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={!!label.show_part_no}
                  onChange={(e) => setLabelField("show_part_no", e.target.checked)} className="accent-toyotared" />
                <span className="text-sm text-slate-600 dark:text-slate-300">Show part number on label</span>
              </label>
              <label className="col-span-2 flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={!!label.show_description}
                  onChange={(e) => setLabelField("show_description", e.target.checked)} className="accent-toyotared" />
                <span className="text-sm text-slate-600 dark:text-slate-300">Show description on label</span>
              </label>
              <div className="col-span-2">
                <button onClick={saveLabel} disabled={savingLabel} className="btn-primary">
                  {savingLabel ? "Saving…" : "Save label settings"}
                </button>
              </div>
            </div>

            {/* live preview, at the label's real proportion */}
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-navy-700 bg-white p-3"
                style={{ width: 260 }}>
                <div className="flex flex-col items-center justify-center gap-1.5 rounded bg-white text-black"
                  style={{ aspectRatio: previewRatio, minHeight: 90 }}>
                  {label.show_part_no && <div className="font-mono text-xs font-bold tracking-wide">SPARE-00123</div>}
                  <div className="flex h-8 items-end gap-[2px]" aria-hidden="true">
                    {Array.from({ length: 34 }).map((_, i) => (
                      <span key={i} className="bg-black"
                        style={{ width: i % 3 === 0 ? 3 : 1.5, height: "100%" }} />
                    ))}
                  </div>
                  {label.show_description && (
                    <div className="max-w-[90%] truncate text-[10px] text-slate-700">
                      {"Hex Bolt M10 x 40 Zinc".slice(0, Number(label.description_max_chars) || 48)}
                    </div>
                  )}
                </div>
              </div>
              <span className="text-[11px] text-slate-400">{label.width_mm} × {label.height_mm} mm · {label.symbology}</span>
            </div>
          </div>
        </div>
      )}

      {/* 4 — read-only system status */}
      {status && (
        <div className="card">
          <SectionHead icon={ServerCog} title="System status" hint="Current operational settings (read-only)" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 dark:border-navy-800 p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
                <Mail size={15} className="text-toyotared" /> Email
              </p>
              <Row label="SMTP configured"><YesNo ok={status.email.configured} yes="Yes" no="No" /></Row>
              <Row label="Daily auto-mail"><YesNo ok={status.email.daily_mail_enabled} /></Row>
              <Row label="Send hour">{String(status.email.daily_mail_hour).padStart(2, "0")}:00</Row>
              <Row label="From">{status.email.from_display || "—"}</Row>
              <Row label="TLS / SSL">{status.email.use_ssl ? "SSL" : status.email.use_tls ? "STARTTLS" : "None"}</Row>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-navy-800 p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
                <ServerCog size={15} className="text-toyotared" /> ERP integration
              </p>
              <Row label="Read sync"><YesNo ok={status.erp.read_sync_configured} yes="Configured" no="Off" /></Row>
              <Row label="Pull horizon">{status.erp.sync_since_days} days</Row>
              <Row label="Sync interval">{status.erp.sync_poll_seconds ? `${status.erp.sync_poll_seconds}s` : "Manual"}</Row>
              <Row label="Ledger scan">{status.erp.ledger_poll_seconds ? `${status.erp.ledger_poll_seconds}s` : "Off"}</Row>
              <Row label="Stock write-back"><YesNo ok={status.erp.stock_write_active} yes="Live" no="Off (queued)" /></Row>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-navy-800 p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
                <Boxes size={15} className="text-toyotared" /> Uploads
              </p>
              <Row label="Max file size">{status.uploads.max_mb ? `${status.uploads.max_mb} MB` : "—"}</Row>
            </div>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>
              Secrets — SMTP password, ERP database credentials, the API key, the database URL and CORS —
              are kept in the server’s <code>.env</code> file and are never shown or editable here. Change
              those on the server, then restart the app.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
