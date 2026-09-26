import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck, Users, Mail, FileText, Boxes, Grid3x3, Factory,
  Store as StoreIcon, Tag, ServerCog, ChevronRight, Lock, Printer,
} from "lucide-react";
import { settingsService } from "../services/settingsService.js";
import { barcodeService } from "../services/barcodeService.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useStores } from "../context/StoreContext.jsx";
import Glyph from "../components/Glyph.jsx";
import BarcodeLabel from "../components/BarcodeLabel.jsx";
import PrinterStatus from "../components/label/PrinterStatus.jsx";
import { printerStatusKey } from "../components/label/usePrinterStatus.js";

// Shortcuts to the admin-manageable screens that already exist — one place to
// reach everything, instead of rebuilding them here.
const HUB = [
  { to: "/admin", label: "User Management", desc: "Users, roles, per-module rights, passwords", icon: Users },
  { to: "/departments", label: "Department Emails", desc: "Reorder / low-stock mail recipients", icon: Mail },
  { to: "/report-recipients", label: "Report Recipients", desc: "Who gets the daily window-time sheet", icon: FileText },
  { to: "/parts", label: "Part Master", desc: "Min / reorder / max, rate, category", icon: Boxes },
  // Child Parts Store only — hidden while that store is switched off.
  { to: "/rack-bins", label: "Rack / Bin Master", desc: "Bin capacity, block / unblock", icon: Grid3x3, store: "CHILD_PART" },
  { to: "/suppliers", label: "Supplier Master", desc: "Supplier list and details", icon: Factory },
];

// QR is the internal label's code (it carries only the Part No.); the 1D codes
// stay selectable for scanners that cannot read a QR.
const SYMBOLOGIES = [
  { key: "QR", label: "QR code" },
  { key: "CODE128", label: "Code-128" },
  { key: "CODE39", label: "Code-39" },
];

// The label preview shows the template on a sample part (spec 3's example),
// not a real one — it is the layout being checked here, not a part's data.
const SAMPLE = { partNo: "SP-10254", description: "Proximity Sensor", location: "A1-03" };

const PRINTER_CONNECTIONS = [
  { key: "BROWSER", label: "Browser print dialog" },
  { key: "NETWORK", label: "Network printer (host + port)" },
];

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
  const { stores: liveStores } = useStores();
  const hub = HUB.filter((h) => !h.store || liveStores.some((s) => s.code === h.store));
  const [status, setStatus] = useState(null);
  const [visibility, setVisibility] = useState([]);
  const [label, setLabel] = useState(null);
  const [savingLabel, setSavingLabel] = useState(false);
  // Label printer: undefined = loading, null = could not load.
  const [printer, setPrinter] = useState(undefined);
  const [savingPrinter, setSavingPrinter] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (!user?.is_admin) return;
    settingsService.systemStatus().then((r) => setStatus(r.data.data)).catch(() => {});
    settingsService.storeVisibility().then((r) => setVisibility(r.data.data || [])).catch(() => {});
    settingsService.labelConfig().then((r) => setLabel(r.data.data)).catch(() => {});
    barcodeService.labelPrinter().then((r) => setPrinter(r.data.data || null)).catch(() => setPrinter(null));
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
        show_location: label.show_location !== false,
        description_max_chars: Number(label.description_max_chars),
      });
      setLabel(res.data.data);
      // Every print dialog reads the template from this shared cache.
      qc.invalidateQueries({ queryKey: ["label-config"] });
      toast.success("Label settings saved");
    } catch (e) {
      toast.error(e?.response?.data?.message || "Could not save label settings");
    } finally {
      setSavingLabel(false);
    }
  };

  const setPrinterField = (k, val) => setPrinter((p) => ({ ...p, [k]: val }));
  const printerNetwork = printer?.connection === "NETWORK";

  const savePrinter = async () => {
    const name = (printer?.name || "").trim();
    const host = (printer?.host || "").trim();
    const port = Number(printer?.port);
    if (!name) { toast.error("Give the printer a name"); return; }
    if (printerNetwork && !host) { toast.error("A network printer needs its host (IP address or name)"); return; }
    if (printerNetwork && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
      toast.error("Port must be a whole number from 1 to 65535"); return;
    }
    setSavingPrinter(true);
    try {
      const res = await barcodeService.saveLabelPrinter({
        name,
        connection: printer.connection || "BROWSER",
        host: host || null,
        port: Number.isInteger(port) && port > 0 ? port : 9100,
      });
      if (res.data.data) setPrinter(res.data.data);
      // Re-check with the new settings (a network printer is dialled again).
      qc.invalidateQueries({ queryKey: printerStatusKey });
      toast.success("Label printer saved");
    } catch (e) {
      toast.error(e?.response?.data?.message || "Could not save the label printer");
    } finally {
      setSavingPrinter(false);
    }
  };

  // A saved symbology this screen no longer offers (e.g. an old EAN13) stays
  // visible in the list rather than silently reading as something else.
  const symbologies = label && !SYMBOLOGIES.some((s) => s.key === label.symbology) && label.symbology
    ? [...SYMBOLOGIES, { key: label.symbology, label: `${label.symbology} (prints as Code-128)` }]
    : SYMBOLOGIES;

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
          {hub.map(({ to, label: l, desc, icon: Icon }) => (
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
                  <Glyph icon={s.icon || StoreIcon} size={18} className="shrink-0 text-slate-500 dark:text-slate-400" />
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
          <SectionHead icon={Tag} title="Part label"
            hint="The printed internal label — QR (Part No. only) + Part No., description and location" />
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
                  {symbologies.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
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
              <label className="col-span-2 flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={label.show_location !== false}
                  onChange={(e) => setLabelField("show_location", e.target.checked)} className="accent-toyotared" />
                <span className="text-sm text-slate-600 dark:text-slate-300">
                  Show location on label <span className="text-slate-400">(prints “Location: —” when a part has none)</span>
                </span>
              </label>
              <div className="col-span-2">
                <button onClick={saveLabel} disabled={savingLabel} className="btn-primary">
                  {savingLabel ? "Saving…" : "Save label settings"}
                </button>
              </div>
            </div>

            {/* live preview — the real label renderer, at the label's real proportion */}
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-3 dark:border-navy-700 dark:bg-navy-800">
                <BarcodeLabel value={SAMPLE.partNo} partNo={SAMPLE.partNo} description={SAMPLE.description}
                  location={SAMPLE.location} config={label} maxWidth={280} maxHeight={170} />
              </div>
              <span className="text-[11px] text-slate-400">
                Sample part · {label.width_mm} × {label.height_mm} mm ·{" "}
                {(symbologies.find((s) => s.key === label.symbology) || {}).label || label.symbology}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 3b — the store label printer + its live status */}
      <div className="card">
        <SectionHead icon={Printer} title="Label printer"
          hint="The printer the part labels go to, and how the app checks it" />
        {printer === undefined && <div className="skeleton h-24 w-full max-w-lg" />}
        {printer === null && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Could not load the label printer settings. Reload the page to try again.
          </p>
        )}
        {printer && (
          <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,22rem)]">
            <div className="grid max-w-lg grid-cols-2 gap-3">
              <label className="col-span-2 block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Name</span>
                <input value={printer.name || ""} maxLength={80}
                  onChange={(e) => setPrinterField("name", e.target.value)}
                  placeholder="Spare Parts Store Label Printer" className="input-field mt-1 w-full" />
              </label>
              <label className="col-span-2 block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Connection</span>
                <select value={printer.connection || "BROWSER"}
                  onChange={(e) => setPrinterField("connection", e.target.value)} className="input-field mt-1 w-full">
                  {PRINTER_CONNECTIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Host</span>
                <input value={printer.host || ""} disabled={!printerNetwork}
                  onChange={(e) => setPrinterField("host", e.target.value)}
                  placeholder="e.g. 192.168.1.50" className="input-field mt-1 w-full disabled:opacity-50" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Port</span>
                <input type="number" min="1" max="65535" value={printer.port ?? 9100} disabled={!printerNetwork}
                  onChange={(e) => setPrinterField("port", e.target.value)}
                  className="input-field mt-1 w-full disabled:opacity-50" />
              </label>
              <div className="col-span-2">
                <button onClick={savePrinter} disabled={savingPrinter} className="btn-primary">
                  {savingPrinter ? "Saving…" : "Save label printer"}
                </button>
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-navy-800">
              <p className="kpi-label">Live status</p>
              <PrinterStatus />
              <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                Labels always print through the browser's print dialog. With <b>Browser</b> the app cannot
                see the printer, so no status is shown. With <b>Network</b> the server tries a connection to
                host:port (a label printer's raw port is usually 9100) and shows <b>Reachable</b> or{" "}
                <b>Not reachable</b> with the time it checked — reachable means the printer answered on the
                network, not that it has labels loaded. Save first; the status shows the saved settings.
              </p>
            </div>
          </div>
        )}
      </div>

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
