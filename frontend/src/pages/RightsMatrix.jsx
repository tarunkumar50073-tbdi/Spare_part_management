import React, { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Grid3x3, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { adminService } from "../services/adminService.js";
import { useAuth } from "../context/AuthContext.jsx";
import { BLANK_RIGHTS, crudOf, fullRights, withRight } from "../lib/rights.js";

// Rights Matrix — every store user (rows) against every module (columns), with
// the module's own rights in each cell: R read, C create, E edit, D delete
// (CRUD since 24 Oct 2026 — a screen shows only the rights it has). The same per-module rights the Admin screen
// sets one user at a time, but seen and changed for everyone at once. Admins are
// listed read-only (they always have everything). Saving writes only the users
// that changed, through the existing admin API — no new backend.
const BLANK = BLANK_RIGHTS;
const clone = (obj) => JSON.parse(JSON.stringify(obj || {}));

export default function RightsMatrix() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});     // { [userId]: permissionsMap } — only changed users
  const [saving, setSaving] = useState(false);

  const reload = () => {
    setLoading(true);
    Promise.all([adminService.users(), adminService.modules()])
      .then(([ur, mr]) => { setUsers(ur.data.data); setModules(mr.data.data); setEdits({}); })
      .catch(() => toast.error("Could not load users / modules"))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (user?.is_admin) reload(); /* eslint-disable-next-line */ }, [user?.is_admin]);

  const storeUsers = useMemo(() => users.filter((u) => !u.is_admin), [users]);
  const admins = useMemo(() => users.filter((u) => u.is_admin), [users]);

  const permsFor = (u) => edits[u.id] || u.permissions || {};
  const cellOf = (u, key) => permsFor(u)[key] || BLANK;

  const setCell = (u, key, action, val) => {
    setEdits((prev) => {
      const base = prev[u.id] ? clone(prev[u.id]) : clone(u.permissions || {});
      base[key] = withRight(base[key], action, val);   // a write brings Read; no Read, no writes
      return { ...prev, [u.id]: base };
    });
  };

  // Per-row quick fill: give a user Read only / every right / nothing on every module at once.
  const fillRow = (u, mode) => {
    const map = {};
    if (mode !== "none") {
      modules.forEach((m) => { map[m.key] = fullRights(m, mode === "view"); });
    }
    setEdits((prev) => ({ ...prev, [u.id]: map }));
  };

  const dirtyIds = Object.keys(edits);
  const save = async () => {
    if (!dirtyIds.length) return;
    setSaving(true);
    try {
      for (const id of dirtyIds) {
        // eslint-disable-next-line no-await-in-loop
        await adminService.updateUser(Number(id), { permissions: edits[id] });
      }
      toast.success(`Saved rights for ${dirtyIds.length} user${dirtyIds.length === 1 ? "" : "s"}`);
      reload();
    } catch (e) {
      toast.error(e?.response?.data?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!user?.is_admin) {
    return (
      <div className="card max-w-lg mx-auto mt-10 text-center">
        <ShieldCheck size={28} className="mx-auto text-slate-300 mb-2" />
        <p className="text-sm text-slate-500 dark:text-slate-400">This page is for administrators only.</p>
      </div>
    );
  }

  const Chk = ({ checked, onChange, title }) => (
    <input type="checkbox" checked={checked} title={title} onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 accent-toyotared cursor-pointer" />
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
            <Grid3x3 size={22} className="text-toyotared" /> Rights Matrix
          </h2>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Every store user against every module. <b>R</b> = read only (no action) · <b>C</b> = create / add new ·
            <b>E</b> = edit what exists · <b>D</b> = delete / cancel. C, E or D turns R on; a screen shows only the rights it has.
            Admins always have everything.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirtyIds.length > 0 && (
            <button className="btn-secondary" onClick={reload} disabled={saving}>
              <RotateCcw size={15} /> Discard
            </button>
          )}
          <button className="btn-primary" onClick={save} disabled={saving || !dirtyIds.length}>
            <Save size={16} /> {saving ? "Saving…" : dirtyIds.length ? `Save (${dirtyIds.length})` : "Saved"}
          </button>
        </div>
      </div>

      <div className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          {loading ? (
            <p className="px-4 py-12 text-center text-slate-400 text-sm">Loading…</p>
          ) : storeUsers.length === 0 ? (
            <p className="px-4 py-12 text-center text-slate-400 text-sm">
              No store users yet — add one on the User Management page first, then set their rights here.
            </p>
          ) : (
            <table className="text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-navy-900/60">
                  <th className="sticky left-0 z-10 bg-slate-50 dark:bg-navy-900 px-3 py-2 text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-r border-slate-200 dark:border-navy-800 min-w-[190px]">
                    User
                  </th>
                  {modules.map((m) => (
                    <th key={m.key} title={m.label}
                      className="px-2 py-2 text-center text-[11px] font-semibold text-slate-500 dark:text-slate-300 border-b border-slate-200 dark:border-navy-800 align-bottom min-w-[92px]">
                      <span className="block leading-tight">{m.label}</span>
                      <span className="mt-1 flex justify-center gap-2.5 text-[10px] text-slate-400 font-normal">
                        {crudOf(m).map((c) => <span key={c.key} title={`${c.label} — ${c.hint}`}>{c.short}</span>)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {storeUsers.map((u) => {
                  const dirty = Boolean(edits[u.id]);
                  return (
                    <tr key={u.id} className={dirty ? "bg-amber-50/50 dark:bg-amber-500/5" : "hover:bg-slate-50 dark:hover:bg-navy-900/40"}>
                      <td className={`sticky left-0 z-10 px-3 py-2 border-r border-slate-200 dark:border-navy-800 min-w-[190px] ${dirty ? "bg-amber-50 dark:bg-navy-900" : "bg-white dark:bg-navy-900"}`}>
                        <div className="font-semibold text-slate-800 dark:text-white flex items-center gap-1.5">
                          {u.username}{dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Unsaved" />}
                        </div>
                        <div className="text-[11px] text-slate-400">{u.full_name || "—"}{u.is_active ? "" : " · disabled"}</div>
                        <div className="mt-1 flex gap-1">
                          <button type="button" onClick={() => fillRow(u, "view")} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-navy-800 text-slate-500 hover:text-toyotared">All read</button>
                          <button type="button" onClick={() => fillRow(u, "all")} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-navy-800 text-slate-500 hover:text-toyotared">All rights</button>
                          <button type="button" onClick={() => fillRow(u, "none")} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-navy-800 text-slate-500 hover:text-toyotared">Clear</button>
                        </div>
                      </td>
                      {modules.map((m) => {
                        const c = cellOf(u, m.key);
                        return (
                          <td key={m.key} className="px-2 py-2 text-center border-l border-slate-50 dark:border-navy-900">
                            <div className="flex justify-center gap-2.5">
                              {crudOf(m).map((r) => (
                                <Chk key={r.key} checked={!!c[r.key]} title={`${u.username} — ${r.label} (${r.hint}): ${m.label}`}
                                  onChange={(v) => setCell(u, m.key, r.key, v)} />
                              ))}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {admins.length > 0 && (
        <p className="text-xs text-slate-400 dark:text-slate-500">
          Admins (full access, not shown above): {admins.map((a) => a.username).join(", ")}.
        </p>
      )}
    </div>
  );
}
