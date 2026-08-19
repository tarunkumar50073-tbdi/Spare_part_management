import React, { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Mail, Plus, Check, Send } from "lucide-react";
import { reportRecipientService } from "../services/reportRecipientService.js";
import { useAuth } from "../context/AuthContext.jsx";

// Report Recipients master — who the auto-mailed reports go to (To / Cc). Today
// only the daily window-time sheet uses it (report_key='window_time'); the same
// screen generalises to other reports later. The mailer sends only to rows that
// carry an address, and needs at least one TO address, so this screen is the one
// place that decides who receives the sheet.
const REPORT_KEY = "window_time";

const INPUT =
  "w-full rounded-lg border border-slate-200 dark:border-navy-700 bg-white dark:bg-navy-900 " +
  "px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 " +
  "focus:outline-none focus:ring-2 focus:ring-toyotared/40 disabled:opacity-60 disabled:cursor-not-allowed";

const clean = (s) => (s.trim() ? s.trim() : null);

export default function ReportRecipientMaster() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState({ name: "", role: "CC", email: "", saving: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await reportRecipientService.list(REPORT_KEY);
      setRows(res.data.data.map((d) => ({
        ...d, _email: d.email || "", _role: d.role, saving: false,
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchRow = (id, patch) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const isDirty = (r) => r._email !== (r.email || "") || r._role !== r.role;

  const saveRow = async (r) => {
    patchRow(r.id, { saving: true });
    try {
      const res = await reportRecipientService.update(r.id, { email: clean(r._email), role: r._role });
      const d = res.data.data;
      patchRow(r.id, { ...d, _email: d.email || "", _role: d.role, saving: false });
      toast.success(`${d.name} saved`);
    } catch {
      patchRow(r.id, { saving: false }); // api interceptor already surfaced it
    }
  };

  const addRecipient = async () => {
    const name = adding.name.trim();
    if (!name) { toast.error("Name is required"); return; }
    setAdding((a) => ({ ...a, saving: true }));
    try {
      await reportRecipientService.create({ report_key: REPORT_KEY, name, role: adding.role, email: clean(adding.email) });
      setAdding({ name: "", role: "CC", email: "", saving: false });
      toast.success(`${name} added`);
      load();
    } catch {
      setAdding((a) => ({ ...a, saving: false }));
    }
  };

  const withAddr = useMemo(() => rows.filter((r) => r.is_active && (r.email || "").trim()), [rows]);
  const toList = useMemo(() => withAddr.filter((r) => r.role === "TO"), [withAddr]);
  const ccList = useMemo(() => withAddr.filter((r) => r.role === "CC"), [withAddr]);
  const flaggedNoAddress = useMemo(
    () => rows.filter((r) => r.is_active && !(r.email || "").trim()),
    [rows],
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="section-title">Report Recipients</h3>
        <p className="section-hint">
          Who the daily <span className="font-medium">window-time sheet</span> is e-mailed to. Give each person an
          address and mark them <span className="font-medium">To</span> or <span className="font-medium">Cc</span>.
          The mail needs at least one To address; anyone without an address is skipped.
        </p>
      </div>

      {/* True preview of who the backend will actually mail. */}
      <div className="card !p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <Send size={16} className="text-toyotared" />
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {toList.length === 0 ? "Will not send" : `${withAddr.length} recipient${withAddr.length === 1 ? "" : "s"}`}
          </span>
          <span className="text-slate-500 dark:text-slate-400">
            {toList.length === 0 ? "— no To address set yet" : "on the next window-time mail"}
          </span>
        </span>
        {toList.length > 0 && (
          <span className="text-slate-500 dark:text-slate-400 truncate">
            To {toList.map((r) => r.name).join(", ")}
            {ccList.length > 0 && ` · Cc ${ccList.map((r) => r.name).join(", ")}`}
          </span>
        )}
        {flaggedNoAddress.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            ⚠ {flaggedNoAddress.map((r) => r.name).join(", ")} — no address, will be skipped
          </span>
        )}
      </div>

      {!isAdmin && (
        <p className="text-[13px] text-amber-600 dark:text-amber-400">
          You are viewing this master read-only — an administrator can edit the addresses.
        </p>
      )}

      <div className="card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400
                border-b border-slate-200 dark:border-navy-800">
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">To / Cc</th>
                <th className="px-4 py-3 font-semibold">E-mail address</th>
                <th className="px-4 py-3 font-semibold text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {loading && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">No recipients yet.</td></tr>
              )}
              {!loading && rows.map((r) => (
                <tr key={r.id} className={r.is_active ? "" : "opacity-50"}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                    {!r.is_active && <span className="ml-2 text-[11px] text-slate-400">(inactive)</span>}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className={`${INPUT} max-w-[6rem]`}
                      value={r._role}
                      disabled={!isAdmin}
                      onChange={(e) => patchRow(r.id, { _role: e.target.value })}
                      aria-label={`Role for ${r.name}`}
                    >
                      <option value="TO">To</option>
                      <option value="CC">Cc</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="relative max-w-sm">
                      <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                      <input
                        type="email"
                        className={`${INPUT} pl-8`}
                        placeholder="name@toyota-boshoku.com"
                        value={r._email}
                        disabled={!isAdmin}
                        onChange={(e) => patchRow(r.id, { _email: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter" && isDirty(r)) saveRow(r); }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => saveRow(r)}
                        disabled={!isDirty(r) || r.saving}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-toyotared px-3 py-1.5 text-xs font-semibold
                          text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
                      >
                        <Check size={14} />
                        {r.saving ? "Saving…" : "Save"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {isAdmin && (
          <div className="border-t border-slate-200 dark:border-navy-800 bg-slate-50 dark:bg-navy-900/50 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Add a recipient</p>
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              <input
                className={`${INPUT} md:max-w-[14rem]`}
                placeholder="Name"
                value={adding.name}
                onChange={(e) => setAdding((a) => ({ ...a, name: e.target.value }))}
              />
              <select
                className={`${INPUT} md:max-w-[6rem]`}
                value={adding.role}
                onChange={(e) => setAdding((a) => ({ ...a, role: e.target.value }))}
              >
                <option value="TO">To</option>
                <option value="CC">Cc</option>
              </select>
              <input
                type="email"
                className={`${INPUT} md:max-w-sm`}
                placeholder="name@toyota-boshoku.com (optional)"
                value={adding.email}
                onChange={(e) => setAdding((a) => ({ ...a, email: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") addRecipient(); }}
              />
              <button
                type="button"
                onClick={addRecipient}
                disabled={adding.saving || !adding.name.trim()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-toyotared
                  px-3 py-2 text-xs font-semibold text-toyotared transition-colors hover:bg-toyotared hover:text-white
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus size={14} />
                {adding.saving ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
