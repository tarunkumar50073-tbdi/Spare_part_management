import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { ArrowLeft, Mail, Plus, Settings2, X } from "lucide-react";
import Modal from "../Modal.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { inputCls } from "../scan/forms/flow.js";
import { fmtDate, num } from "../../lib/format.js";
import { shortMailService } from "../../services/shortMailService.js";

// Short Mail — the mail to Purchase for material received short against an
// invoice (the store, 25 Oct 2026): one mail per invoice and day, every short
// part of it in one table ("jis din, jis invoice me jitna part short receive
// hua uski material short receive ki mail"), in the store's own words. Kept
// apart from the Rejection Mail: its own right and To / CC ("alag alag ho").
//
// The invoices come from the Short tab's ERP GRN lines, grouped by the day
// received + supplier + invoice no.; a mail can also be typed in while ERP is
// not reachable. "Open mail in Outlook" hands over a ready draft — the store
// presses Send; the app sends nothing itself and keeps nothing.

const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";
const pad = (n) => String(n).padStart(2, "0");
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const BLANK_LINE = { part_no: "", description: "", invoice_qty: "", received_qty: "" };
const short = (ln) => Number(ln.invoice_qty) - Number(ln.received_qty);
const MAX_LINES = 60;

// The Short tab's lines as one mail each per day received + supplier + invoice no.
export function groupShortLines(lines) {
  const map = new Map();
  (lines || []).forEach((ln) => {
    const key = [ln.grn_date || "", ln.supplier_code || ln.supplier_name || "", ln.challan_no || ""].join("|");
    if (!map.has(key)) {
      map.set(key, {
        key, received_on: ln.grn_date || "", supplier: ln.supplier_name || "", invoice_no: ln.challan_no || "",
        invoice_date: ln.challan_dt || "", lines: [],
      });
    }
    map.get(key).lines.push({
      part_no: ln.part_no || "", description: ln.description || "",
      invoice_qty: ln.challan_qty ?? "", received_qty: ln.received_qty ?? "",
    });
  });
  return [...map.values()].sort((a, b) => (b.received_on || "").localeCompare(a.received_on || "")
    || a.supplier.localeCompare(b.supplier) || a.invoice_no.localeCompare(b.invoice_no));
}

// What stops the mail, in the store's words — the server checks the same.
function problem(m) {
  if (!m.supplier.trim()) return "Supplier is required";
  if (!m.invoice_no.trim()) return "Invoice no. is required";
  if (!m.received_on) return "Received on is required";
  if (!m.lines.length) return "Add at least one short part";
  if (m.lines.length > MAX_LINES) return `At most ${MAX_LINES} parts in one mail`;
  for (const ln of m.lines) {
    const name = ln.part_no.trim() || "A part";
    if (!ln.part_no.trim()) return "Every line needs a Part No.";
    if (!(Number(ln.invoice_qty) > 0)) return `${name}: Invoice qty must be more than 0`;
    if (ln.received_qty === "" || Number.isNaN(Number(ln.received_qty)) || Number(ln.received_qty) < 0) {
      return `${name}: Received qty must be 0 or more`;
    }
    if (short(ln) <= 0) return `${name}: received ${ln.received_qty} of ${ln.invoice_qty} is not short`;
  }
  return null;
}

function Field({ label, required, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">{label}{required && <span className="text-toyotared"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

export default function ShortMailDialog({ lines, storeCode, canMake, canSettings, onClose }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const groups = useMemo(() => groupShortLines(lines), [lines]);
  const [view, setView] = useState("list");            // list · edit · settings
  const [mail, setMail] = useState(null);
  const settings = useQuery({
    queryKey: ["short-mail", "settings"],
    queryFn: () => shortMailService.settings({ silent: true }).then((r) => r.data.data),
  });

  const edit = (g) => {
    setMail(g
      ? { supplier: g.supplier, invoice_no: g.invoice_no, invoice_date: g.invoice_date || "", received_on: g.received_on || todayIso(), lines: g.lines.map((l) => ({ ...l })) }
      : { supplier: "", invoice_no: "", invoice_date: "", received_on: todayIso(), lines: [{ ...BLANK_LINE }] });
    setView("edit");
  };

  // A mail being typed is not thrown away by one Escape (it also shuts the
  // part suggestions) or a stray click on the backdrop.
  const close = async () => {
    if (view === "edit" && !(await confirm({ title: "Close the short mail?", message: "What is filled in here will be lost.", confirmText: "Close" }))) return;
    onClose();
  };

  const to = settings.data?.to || "";
  const title = view === "settings" ? "Short mail — who it goes to" : view === "edit" ? "Short mail to Purchase" : "Short Mail — to Purchase";
  return (
    <Modal open onClose={close} size="xl" title={title}>
      {view === "list" && (
        <ListView groups={groups} to={to} cc={settings.data?.cc || ""} loadingTo={settings.isLoading}
          canMake={canMake} canSettings={canSettings} onMake={edit} onSettings={() => setView("settings")} onClose={onClose} />
      )}
      {view === "edit" && mail && (
        <EditView mail={mail} setMail={setMail} storeCode={storeCode} canMake={canMake} to={to} onBack={() => setView("list")} />
      )}
      {/* Only on the saved To / CC: a form opened before they were read would
          save blanks over them. */}
      {view === "settings" && (settings.data ? (
        <SettingsView initial={settings.data} onBack={() => setView("list")}
          onSaved={(s) => { qc.setQueryData(["short-mail", "settings"], s); setView("list"); }} />
      ) : (
        <p className="text-sm text-slate-400">{settings.isError ? "Could not read who it goes to — try again." : "Loading…"}</p>
      ))}
    </Modal>
  );
}

function ToLine({ to, cc, loading }) {
  if (loading) return null;
  return to ? (
    <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
      Goes to <b className="text-slate-700 dark:text-slate-200">{to}</b>{cc ? <> · CC {cc}</> : null}
    </p>
  ) : (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
      Purchase&apos;s e-mail is not set yet — the mail opens with an empty To. Set it under &ldquo;Who it goes to&rdquo;.
    </p>
  );
}

function ListView({ groups, to, cc, loadingTo, canMake, canSettings, onMake, onSettings, onClose }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[13px] text-slate-600 dark:text-slate-300">
            One mail per invoice and day — every part that came short on it in one table. Outlook opens it ready to send.
          </p>
          <ToLine to={to} cc={cc} loading={loadingTo} />
        </div>
        <div className="flex shrink-0 gap-2">
          {canSettings && (
            <button type="button" className="btn-secondary text-[12.5px]" onClick={onSettings} disabled={loadingTo}>
              <Settings2 size={14} aria-hidden="true" /> Who it goes to
            </button>
          )}
          {canMake && (
            <button type="button" className="btn-secondary text-[12.5px]" onClick={() => onMake(null)}>
              <Plus size={14} aria-hidden="true" /> Type a mail
            </button>
          )}
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400 dark:border-navy-700">
          No short invoice in this period. Use &ldquo;Type a mail&rdquo; for one ERP has not reported yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-navy-700">
          <table className="w-full text-[12.5px]">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Received on</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Invoice no.</th>
                <th className="px-3 py-2 text-right">Parts</th>
                <th className="px-3 py-2 text-right">Short qty</th>
                <th className="px-3 py-2" aria-label="Mail" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key} className="border-t border-slate-100 dark:border-navy-800">
                  <td className="whitespace-nowrap px-3 py-2">{g.received_on ? fmtDate(g.received_on) : "—"}</td>
                  <td className="px-3 py-2">{g.supplier || "—"}</td>
                  <td className="px-3 py-2 font-mono">{g.invoice_no || "—"}</td>
                  <td className="px-3 py-2 text-right tabular">{num(g.lines.length)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular text-rose-600 dark:text-rose-400">
                    {num(g.lines.reduce((s, l) => s + short(l), 0))}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canMake && (
                      <button type="button" onClick={() => onMake(g)}
                        className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-semibold text-toyotared hover:underline">
                        <Mail size={13} aria-hidden="true" /> Make mail
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function EditView({ mail, setMail, storeCode, canMake, to, onBack }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 250); return () => clearTimeout(t); }, [typed]);
  const found = useQuery({
    queryKey: ["short-mail", "parts", storeCode, q],
    queryFn: () => shortMailService.parts(storeCode, q, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode) && q.length >= 2,
  });
  const parts = found.data || [];

  const set = (k) => (e) => setMail((m) => ({ ...m, [k]: e.target.value }));
  const setLine = (i, k, v) => setMail((m) => ({ ...m, lines: m.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const pickPart = (i, value) => {
    setLine(i, "part_no", value);
    setTyped(value);
    const hit = parts.find((p) => p.part_no.toLowerCase() === value.trim().toLowerCase());
    if (hit) setMail((m) => ({ ...m, lines: m.lines.map((l, j) => (j === i && !l.description ? { ...l, description: hit.part_name || "" } : l)) }));
  };
  const why = problem(mail);

  const open = async () => {
    if (why || busy) return;
    setBusy(true);
    setError(null);
    const payload = {
      ...mail, invoice_date: mail.invoice_date || null,
      lines: mail.lines.map((l) => ({ ...l, invoice_qty: Number(l.invoice_qty), received_qty: Number(l.received_qty) })),
    };
    const name = `${mail.supplier} short ${mail.invoice_no}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
    try {
      await shortMailService.downloadDraft(payload, `${name}.eml`);
      toast.success("Short mail ready — open it in Outlook and send");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <ToLine to={to} loading={false} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier" required><input className={inputCls(false, "w-full")} maxLength={160} value={mail.supplier} onChange={set("supplier")} /></Field>
        <Field label="Invoice no." required><input className={inputCls(false, "w-full")} maxLength={60} value={mail.invoice_no} onChange={set("invoice_no")} /></Field>
        <Field label="Invoice date" hint={'"on dated …" in the mail; left out when blank'}>
          <input type="date" className={inputCls(false, "w-full")} value={mail.invoice_date} onChange={set("invoice_date")} />
        </Field>
        <Field label="Received on" required hint={'Today reads "today"; an earlier day is named'}>
          <input type="date" className={inputCls(false, "w-full")} value={mail.received_on} onChange={set("received_on")} />
        </Field>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-navy-700">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
            <tr>
              <th className="px-2 py-2">Part No.</th>
              <th className="px-2 py-2">Part Description</th>
              <th className="px-2 py-2 text-right">Invoice Qty</th>
              <th className="px-2 py-2 text-right">Received Qty</th>
              <th className="px-2 py-2 text-right">Short Qty</th>
              <th className="px-2 py-2" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {mail.lines.map((l, i) => {
              const s = short(l);
              return (
                <tr key={i} className="border-t border-slate-100 dark:border-navy-800">
                  <td className="px-2 py-1.5">
                    <input className={inputCls(false, "w-32 font-mono")} maxLength={60} list="short-mail-parts" value={l.part_no}
                      aria-label={`Part No. ${i + 1}`} onChange={(e) => pickPart(i, e.target.value)} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input className={inputCls(false, "w-full min-w-[160px]")} maxLength={255} value={l.description}
                      aria-label={`Description ${i + 1}`} onChange={(e) => setLine(i, "description", e.target.value)} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-20 text-right")} value={l.invoice_qty}
                      aria-label={`Invoice qty ${i + 1}`} onChange={(e) => setLine(i, "invoice_qty", e.target.value)} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-20 text-right")} value={l.received_qty}
                      aria-label={`Received qty ${i + 1}`} onChange={(e) => setLine(i, "received_qty", e.target.value)} />
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular text-rose-600 dark:text-rose-400">
                    {Number.isFinite(s) && s > 0 ? num(s) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button type="button" disabled={mail.lines.length < 2} title="Remove this part" aria-label={`Remove part ${i + 1}`}
                      onClick={() => setMail((m) => ({ ...m, lines: m.lines.filter((_, j) => j !== i) }))}
                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 dark:hover:bg-rose-500/10">
                      <X size={15} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <datalist id="short-mail-parts">
          {parts.map((p) => <option key={p.id} value={p.part_no}>{p.part_name}</option>)}
        </datalist>
      </div>
      <button type="button" className="btn-secondary text-[12.5px]" disabled={mail.lines.length >= MAX_LINES}
        onClick={() => setMail((m) => ({ ...m, lines: [...m.lines, { ...BLANK_LINE }] }))}>
        <Plus size={14} aria-hidden="true" /> Add part
      </button>

      {(error || why) && (
        <p role="alert" className={`rounded-lg px-3 py-2 text-[12.5px] ${error ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" : "bg-slate-50 text-slate-500 dark:bg-navy-950/40 dark:text-slate-400"}`}>
          {error || why}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Back</button>
        {canMake && (
          <button type="button" className="btn-primary" onClick={open} disabled={Boolean(why) || busy}>
            <Mail size={15} aria-hidden="true" /> {busy ? "Making…" : "Open mail in Outlook"}
          </button>
        )}
      </div>
    </div>
  );
}

function SettingsView({ initial, onBack, onSaved }) {
  const [f, setF] = useState({ to: initial?.to || "", cc: initial?.cc || "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await shortMailService.saveSettings(f);
      toast.success("Short mail settings saved");
      onSaved(res.data.data);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <Field label="To" hint="Purchase — e-mail addresses, separated by commas">
        <input className={inputCls(false, "w-full")} value={f.to} onChange={set("to")} />
      </Field>
      <Field label="CC" hint="e.g. the store, the user department">
        <input className={inputCls(false, "w-full")} value={f.cc} onChange={set("cc")} />
      </Field>
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
        Dear Sir, This is to inform you that today we have short material received against invoice no. … on dated …. Detail is given below:- (Part No. · Part Description · Invoice Qty · Received Qty · Short Qty)
      </p>
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Back</button>
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
