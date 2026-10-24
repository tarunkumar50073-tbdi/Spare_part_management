import React, { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  Check, ClipboardCheck, Eye, EyeOff, KeyRound, Pencil, ScanBarcode, ShieldCheck, Trash2, Tv,
  UserPlus, Wrench,
} from "lucide-react";
import Modal from "../components/Modal.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import { adminService } from "../services/adminService.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useStores } from "../context/StoreContext.jsx";
import { ROLE_TEMPLATES, TEMPLATE_HELP, isBlank, matchTemplate, templateFields } from "../lib/roleTemplates.js";

// The server's rule too (admin_service.MIN_PASSWORD_LEN): 8 since 24 Oct 2026.
const MIN_PASSWORD_LEN = 8;

const ROLES = [
  { value: "STORE_USER", label: "Store User" },
  { value: "ADMIN", label: "Admin (full access)" },
];

// One glyph per role template (lib/roleTemplates.json holds the rights).
const TEMPLATE_ICONS = {
  store_staff: ScanBarcode,
  store_supervisor: ClipboardCheck,
  line_user: Wrench,
  manager: Eye,
  live_board: Tv,
};

// The type of login at the top of the form (store's request of 17 Oct 2026:
// "template bana de"): one tap fills the rights grid and the store access below,
// which stay editable. The heading says which template the form matches now —
// "Custom" once a box is changed away from every template.
//
// No cards while the Role is Admin: a template makes the login a Store User, so
// one stray tap on an admin's form (the signed-in admin's own included) would
// demote it on Save. Turning an admin into a Store User stays the deliberate
// Role change it was; the cards come back once the Role says Store User.
function TemplatePicker({ form, onPick }) {
  const current = matchTemplate(form);
  const admin = form.role === "ADMIN";
  const state = admin
    ? { text: "Admin — every right", badge: "badge-danger" }
    : current
      ? { text: current.short, badge: "badge-success" }
      : isBlank(form)
        ? { text: "None picked", badge: "badge-neutral" }
        : { text: "Custom", badge: "badge-warning" };
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Template</p>
        <span className={`badge ${state.badge}`}>{state.text}</span>
      </div>
      {admin ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          An Admin has every right, so templates do not apply. To give this login a template, set Role to Store User below first.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">{TEMPLATE_HELP}</p>
          <div role="group" aria-label="Template" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ROLE_TEMPLATES.map((t) => {
              const on = current?.key === t.key;
              const Icon = TEMPLATE_ICONS[t.key] || ShieldCheck;
              return (
                <button key={t.key} type="button" aria-pressed={on} onClick={() => onPick(t)}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50 ${on
                    ? "border-toyotared bg-toyotared/5 dark:bg-toyotared/10"
                    : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-navy-700 dark:hover:border-navy-600 dark:hover:bg-navy-900/40"}`}>
                  <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md ${on
                    ? "bg-toyotared text-white" : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-300"}`}>
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-sm font-semibold text-slate-800 dark:text-white">
                      {t.label}
                      {on && <Check size={14} className="shrink-0 text-toyotared" aria-hidden="true" />}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// A blank form for a new user.
const emptyForm = () => ({
  id: null, username: "", full_name: "", password: "", role: "STORE_USER",
  is_active: true, stores: [], permissions: {},
});

// Show the password, masked, with a per-row reveal toggle.
function PasswordCell({ value }) {
  const [show, setShow] = useState(false);
  if (!value) return <span className="text-slate-400 text-xs">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[13px] text-slate-700 dark:text-slate-200">
        {show ? value : "•".repeat(Math.min(value.length, 10))}
      </span>
      <button type="button" onClick={() => setShow((s) => !s)}
        className="text-slate-400 hover:text-toyotared" title={show ? "Hide" : "Show password"}>
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const { stores } = useStores();
  const confirm = useConfirm();
  const [users, setUsers] = useState([]);
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);        // the user being created/edited, or null
  const [saving, setSaving] = useState(false);
  const [resetFor, setResetFor] = useState(null); // { id, username } or null
  const [resetPw, setResetPw] = useState("");

  const reload = () => {
    setLoading(true);
    adminService.users()
      .then((r) => setUsers(r.data.data))
      .catch(() => toast.error("Could not load users"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!user?.is_admin) return;
    reload();
    adminService.modules().then((r) => setModules(r.data.data)).catch(() => setModules([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.is_admin]);

  const isStoreUser = form?.role !== "ADMIN";

  const setPerm = (key, action, val) =>
    setForm((f) => {
      const entry = { ...(f.permissions[key] || { view: false, edit: false }) };
      entry[action] = val;
      if (action === "edit" && val) entry.view = true;       // edit implies view
      if (action === "view" && !val) entry.edit = false;     // can't edit what you can't see
      return { ...f, permissions: { ...f.permissions, [key]: entry } };
    });

  const toggleStore = (code) =>
    setForm((f) => ({
      ...f,
      stores: f.stores.includes(code) ? f.stores.filter((s) => s !== code) : [...f.stores, code],
    }));

  // A template replaces the role, store access and every right at once; the
  // login ID, name, password and Active stay as typed.
  const pickTemplate = (t) => setForm((f) => ({ ...f, ...templateFields(t) }));

  // Store codes the user holds that are not in the store list — a store since
  // switched off (Child Parts in Spare-only mode). Shown so they can be removed:
  // they keep the user's rights from matching a template.
  const hiddenStores = form ? form.stores.filter((code) => !(stores || []).some((s) => s.code === code)) : [];

  const save = async () => {
    if (!form.username.trim()) return toast.error("Username is required");
    if (!form.id && (form.password || "").length < MIN_PASSWORD_LEN) return toast.error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    setSaving(true);
    const payload = {
      username: form.username.trim(),
      full_name: form.full_name.trim(),
      role: form.role,
      is_active: form.is_active,
      ...(form.password ? { password: form.password } : {}),
      ...(form.role === "ADMIN" ? {} : { stores: form.stores, permissions: form.permissions }),
    };
    try {
      if (form.id) await adminService.updateUser(form.id, payload);
      else await adminService.createUser(payload);
      toast.success(form.id ? "User updated" : "User created");
      setForm(null);
      reload();
    } catch (e) {
      toast.error(e?.response?.data?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const doReset = async () => {
    if ((resetPw || "").length < MIN_PASSWORD_LEN) return toast.error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    try {
      await adminService.resetPassword(resetFor.id, resetPw);
      toast.success(`Password reset for ${resetFor.username}`);
      setResetFor(null); setResetPw("");
      reload();
    } catch (e) {
      toast.error(e?.response?.data?.message || "Reset failed");
    }
  };

  const remove = async (u) => {
    if (!(await confirm({ title: "Delete user", message: `Delete user "${u.username}"? This cannot be undone.`, confirmText: "Delete" }))) return;
    try {
      await adminService.deleteUser(u.id);
      toast.success("User deleted");
      reload();
    } catch (e) {
      toast.error(e?.response?.data?.message || "Delete failed");
    }
  };

  // Only rights for modules that still exist count. The server hands back the
  // stored map as saved, so a login made before the kiosk went (17 Oct 2026:
  // "management k according manual detail fill karke issuance karna time waste
  // h") can still carry a "kiosk" key that opens nothing — counted, it showed one
  // module too many and stopped the login matching its template. The key drops
  // off on the server the next time the login is saved. Until the module list
  // has loaded, the map is read as it is.
  const moduleKeys = useMemo(() => new Set(modules.map((m) => m.key)), [modules]);
  const liveRights = (perms) => (moduleKeys.size
    ? Object.fromEntries(Object.entries(perms || {}).filter(([key]) => moduleKeys.has(key)))
    : perms || {});

  const editUser = (u) => setForm({
    id: u.id, username: u.username, full_name: u.full_name || "", password: "",
    role: u.role, is_active: u.is_active, stores: u.stores || [], permissions: liveRights(u.permissions),
  });

  const grantedCount = (perms) => Object.values(liveRights(perms)).filter((p) => p.view || p.edit).length;

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-slate-800 dark:text-white flex items-center gap-2">
            <ShieldCheck size={22} className="text-toyotared" /> User Management
          </h2>
          <p className="text-xs text-slate-400 dark:text-slate-500">Create users, set their rights per module, and manage passwords.</p>
        </div>
        <button className="btn-primary" onClick={() => setForm(emptyForm())}>
          <UserPlus size={16} /> Add user
        </button>
      </div>

      <div className="card !p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-200 dark:border-navy-800">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Password</th>
                <th className="px-4 py-3">Rights</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">No users yet.</td></tr>
              ) : users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-navy-900/40">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-800 dark:text-white">{u.username}</p>
                    <p className="text-[11px] text-slate-400">{u.full_name || "—"}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`badge ${u.is_admin ? "badge-danger" : "badge-neutral"}`}>
                        {u.is_admin ? "Admin" : "Store User"}
                      </span>
                      {/* Which template the saved rights match (store, 17 Oct 2026). */}
                      {!u.is_admin && (() => {
                        const t = matchTemplate({ ...u, permissions: liveRights(u.permissions) });
                        return (
                          <span className={`badge ${t ? "badge-info" : "badge-warning"}`}
                            title={t ? `Rights match the ${t.label} template` : "Rights differ from every template"}>
                            {t ? t.short : "Custom"}
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-3"><PasswordCell value={u.password} /></td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                    {u.is_admin ? "Everything" : `${grantedCount(u.permissions)} module${grantedCount(u.permissions) === 1 ? "" : "s"}`}
                    {!u.is_admin && u.stores?.length ? ` · ${u.stores.join(", ")}` : ""}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${u.is_active ? "badge-success" : "badge-warning"}`}>{u.is_active ? "Active" : "Disabled"}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => editUser(u)} title="Edit"
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-toyotared"><Pencil size={15} /></button>
                      <button onClick={() => { setResetFor({ id: u.id, username: u.username }); setResetPw(""); }} title="Reset password"
                        className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-toyotared"><KeyRound size={15} /></button>
                      {u.id !== user.id && (
                        <button onClick={() => remove(u)} title="Delete"
                          className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600"><Trash2 size={15} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / edit user */}
      <Modal open={Boolean(form)} onClose={() => setForm(null)} size="xl"
        title={form?.id ? `Edit ${form.username}` : "Add user"}
        footer={
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : (form?.id ? "Save changes" : "Create user")}</button>
          </div>
        }>
        {form && (
          <div className="space-y-4">
            <TemplatePicker form={form} onPick={pickTemplate} />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Username</span>
                <input className="input-field mt-1" value={form.username} disabled={Boolean(form.id)}
                  onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="e.g. rajesh" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Full name</span>
                <input className="input-field mt-1" value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Rajesh Kumar" />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">{form.id ? "New password (blank = unchanged)" : "Password"}</span>
                <input className="input-field mt-1" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={`min ${MIN_PASSWORD_LEN} characters`} />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Role</span>
                <select className="input-field mt-1" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
            </div>

            <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Active (can sign in)
            </label>

            {isStoreUser ? (
              <>
                {/* Shown with a single store too: in Spare-only mode it used to
                    be hidden, so a new login got no store and could open
                    nothing; a template fills it, and here it can be unticked. */}
                {(stores?.length > 0 || hiddenStores.length > 0) && (
                  <div>
                    <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">Store access</p>
                    <div className="flex flex-wrap gap-2">
                      {(stores || []).map((s) => (
                        <label key={s.code} className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer ${form.stores.includes(s.code) ? "border-toyotared bg-toyotared/5 text-toyotared" : "border-slate-200 dark:border-navy-700 text-slate-600 dark:text-slate-300"}`}>
                          <input type="checkbox" className="hidden" checked={form.stores.includes(s.code)} onChange={() => toggleStore(s.code)} />
                          {form.stores.includes(s.code) && <Check size={12} aria-hidden="true" />}
                          {s.name}
                        </label>
                      ))}
                      {hiddenStores.map((code) => (
                        <label key={code} title="This store is switched off — untick to remove the access"
                          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer border-slate-300 border-dashed text-slate-500 dark:border-navy-600 dark:text-slate-400">
                          <input type="checkbox" className="hidden" checked onChange={() => toggleStore(code)} />
                          <Check size={12} aria-hidden="true" />
                          {code} (switched off)
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">Module rights — View lets them open it, Edit lets them change data</p>
                  <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 bg-slate-50 dark:bg-navy-900/50">
                          <th className="px-3 py-2">Module</th>
                          <th className="px-3 py-2 text-center w-20">View</th>
                          <th className="px-3 py-2 text-center w-20">Edit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                        {modules.map((m) => {
                          const p = form.permissions[m.key] || { view: false, edit: false };
                          return (
                            <tr key={m.key}>
                              <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{m.label}</td>
                              <td className="px-3 py-2 text-center">
                                <input type="checkbox" checked={p.view} onChange={(e) => setPerm(m.key, "view", e.target.checked)} />
                              </td>
                              <td className="px-3 py-2 text-center">
                                <input type="checkbox" checked={p.edit} onChange={(e) => setPerm(m.key, "edit", e.target.checked)} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <p className="rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs px-3 py-2">
                An Admin has full access to every store and module — individual rights don't apply.
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Reset password */}
      <Modal open={Boolean(resetFor)} onClose={() => setResetFor(null)} size="md"
        title={resetFor ? `Reset password — ${resetFor.username}` : ""}
        footer={
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={() => setResetFor(null)}>Cancel</button>
            <button className="btn-primary" onClick={doReset}>Reset password</button>
          </div>
        }>
        <label className="block">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">New password</span>
          <input className="input-field mt-1" value={resetPw} onChange={(e) => setResetPw(e.target.value)} placeholder={`min ${MIN_PASSWORD_LEN} characters`} autoFocus />
        </label>
      </Modal>
    </div>
  );
}
