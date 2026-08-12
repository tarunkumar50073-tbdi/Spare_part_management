import React, { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Mail, Plus, Check, BellRing } from "lucide-react";
import { departmentService } from "../services/departmentService.js";
import { useAuth } from "../context/AuthContext.jsx";

// Department Email Master — where each department's reorder / low-stock mail is
// sent. The reorder notifier reads its recipient list straight off the rows
// flagged "Reorder mail" that carry an address, so this screen is the one place
// that decides who hears about a part that needs buying.
const INPUT =
  "w-full rounded-lg border border-slate-200 dark:border-navy-700 bg-white dark:bg-navy-900 " +
  "px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 " +
  "focus:outline-none focus:ring-2 focus:ring-toyotared/40 disabled:opacity-60 disabled:cursor-not-allowed";

const clean = (s) => (s.trim() ? s.trim() : null);

export default function DepartmentMaster() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState({ name: "", email: "", notify_reorder: false, saving: false });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await departmentService.list();
      setRows(res.data.data.map((d) => ({
        ...d, _email: d.email || "", _notify: d.notify_reorder, saving: false,
      })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchRow = (id, patch) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const isDirty = (r) => r._email !== (r.email || "") || r._notify !== r.notify_reorder;

  const saveRow = async (r) => {
    patchRow(r.id, { saving: true });
    try {
      const res = await departmentService.update(r.id, { email: clean(r._email), notify_reorder: r._notify });
      const d = res.data.data;
      patchRow(r.id, { ...d, _email: d.email || "", _notify: d.notify_reorder, saving: false });
      toast.success(`${d.name} saved`);
    } catch {
      patchRow(r.id, { saving: false }); // api interceptor already surfaced the error
    }
  };

  const addDept = async () => {
    const name = adding.name.trim();
    if (!name) { toast.error("Department name is required"); return; }
    setAdding((a) => ({ ...a, saving: true }));
    try {
      await departmentService.create({ name, email: clean(adding.email), notify_reorder: adding.notify_reorder });
      setAdding({ name: "", email: "", notify_reorder: false, saving: false });
      toast.success(`${name} added`);
      load();
    } catch {
      setAdding((a) => ({ ...a, saving: false }));
    }
  };

  // The exact list the reorder mail will reach: flagged AND carrying an address.
  const recipients = useMemo(
    () => rows.filter((r) => r.notify_reorder && (r.email || "").trim()),
    [rows],
  );
  const flaggedNoAddress = useMemo(
    () => rows.filter((r) => r.notify_reorder && !(r.email || "").trim()),
    [rows],
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="section-title">Department Emails</h3>
        <p className="section-hint">
          Who the reorder / low-stock mail is sent to. Tick “Reorder mail” for the department that should receive it
          and give it an address.
        </p>
      </div>

      {/* Who will actually be mailed — computed the same way the backend does,
          so this line is a true preview, not a promise. */}
      <div className="card !p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <BellRing size={16} className="text-toyotared" />
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {recipients.length} department{recipients.length === 1 ? "" : "s"}
          </span>
          <span className="text-slate-500 dark:text-slate-400">will receive the reorder mail</span>
        </span>
        {recipients.length > 0 && (
          <span className="text-slate-500 dark:text-slate-400 truncate">
            → {recipients.map((r) => r.name).join(", ")}
          </span>
        )}
        {flaggedNoAddress.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            ⚠ {flaggedNoAddress.map((r) => r.name).join(", ")} flagged but no address — will be skipped
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
                <th className="px-4 py-3 font-semibold">Department</th>
                <th className="px-4 py-3 font-semibold text-center">Reorder mail</th>
                <th className="px-4 py-3 font-semibold">E-mail address</th>
                <th className="px-4 py-3 font-semibold text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {loading && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">No departments yet.</td></tr>
              )}
              {!loading && rows.map((r) => (
                <tr key={r.id} className={r.is_active ? "" : "opacity-50"}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                    {!r.is_active && <span className="ml-2 text-[11px] text-slate-400">(inactive)</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-toyotared cursor-pointer disabled:cursor-not-allowed"
                      checked={r._notify}
                      disabled={!isAdmin}
                      onChange={(e) => patchRow(r.id, { _notify: e.target.checked })}
                      aria-label={`Send reorder mail to ${r.name}`}
                    />
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
            <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Add a department</p>
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              <input
                className={`${INPUT} md:max-w-[14rem]`}
                placeholder="Department name"
                value={adding.name}
                onChange={(e) => setAdding((a) => ({ ...a, name: e.target.value }))}
              />
              <input
                type="email"
                className={`${INPUT} md:max-w-sm`}
                placeholder="name@toyota-boshoku.com (optional)"
                value={adding.email}
                onChange={(e) => setAdding((a) => ({ ...a, email: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") addDept(); }}
              />
              <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 px-1 whitespace-nowrap">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-toyotared cursor-pointer"
                  checked={adding.notify_reorder}
                  onChange={(e) => setAdding((a) => ({ ...a, notify_reorder: e.target.checked }))}
                />
                Reorder mail
              </label>
              <button
                type="button"
                onClick={addDept}
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
