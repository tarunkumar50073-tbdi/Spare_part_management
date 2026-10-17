import React, { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { BellRing, Send, TriangleAlert } from "lucide-react";
import { departmentService } from "../services/departmentService.js";
import Can, { useCan } from "../components/Can.jsx";

// Department Email Master — a department's mails go to SEVERAL people (name +
// e-mail), not one address. Tick "Reorder mail" for a department and every
// person listed under it receives the daily reorder list and the excess parts
// list — each holding only the parts of that department's own section.

// What the "Reorder mail" tick decides: the tooltip of its column heading and
// of the same tick on a new department.
const TICK_HINT = "Ticked: gets the daily reorder list and the excess parts list";
// The toast when "Send reorder mail now" sent nothing: what a department needs to get one.
const NOTHING_SENT =
  "Nothing was sent. A department gets the reorder mail only when it is ticked, has parts to reorder and has a person with an e-mail.";
// Why a ticked department's mail does not leave although nothing has failed.
const NOT_A_FAILURE = ["no_recipient", "nothing_to_reorder", "mail_engine_disabled", "list_build_failed"];
// The end of the toast when the mail server did not take a department's mail: the mail engine keeps such a mail.
const SERVER_FAILED =
  "the mail server could not be reached or refused the mail. The unsent mail is in the Email Queue: " +
  "tried again automatically, or shown as Failed there if it cannot be.";

const INPUT =
  "w-full rounded-lg border border-slate-200 dark:border-navy-700 bg-white dark:bg-navy-900 " +
  "px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 " +
  "focus:outline-none focus:ring-2 focus:ring-toyotared/40 disabled:opacity-60 disabled:cursor-not-allowed";

// The company mail domain is fixed and shown as a suffix, so only the username
// is typed. A pasted full address (already has "@") is kept as-is.
const MAIL_DOMAIN = "@toyota-boshoku.com";
const localPart = (email) => (email || "").split("@")[0];
const toEmail = (v) => {
  const t = (v || "").trim();
  if (!t) return "";
  return t.includes("@") ? t : t + MAIL_DOMAIN;
};

// A username field with the fixed domain shown beside it.
function EmailInput({ value, onChange, onBlur, onEnter, disabled, placeholder = "username" }) {
  return (
    <div className="flex items-stretch flex-1 min-w-0">
      <input
        type="text" className={`${INPUT} rounded-r-none`} placeholder={placeholder}
        value={localPart(value)} disabled={disabled}
        onChange={(e) => onChange(toEmail(e.target.value))}
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
      />
      <span className="shrink-0 flex items-center rounded-r-lg border border-l-0 border-slate-200 dark:border-navy-700 bg-slate-50 dark:bg-navy-800 px-2.5 text-sm text-slate-500 dark:text-slate-400 whitespace-nowrap">{MAIL_DOMAIN}</span>
    </div>
  );
}

// To / Cc / Bcc selector — how this person is addressed on the department's mails.
function RoleSelect({ value, onChange, disabled }) {
  return (
    <select value={(value || "TO").toUpperCase()} disabled={disabled} title="To / Cc / Bcc"
      onChange={(e) => onChange(e.target.value)}
      className="shrink-0 rounded-lg border border-slate-200 dark:border-navy-700 bg-white dark:bg-navy-900 px-2 text-sm font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-toyotared/40 disabled:opacity-60 disabled:cursor-not-allowed">
      <option value="TO">To</option>
      <option value="CC">Cc</option>
      <option value="BCC">Bcc</option>
    </select>
  );
}

export default function DepartmentMaster() {
  const canEdit = useCan("departments", "edit");

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // The list could not be read: the screen says so instead of counting nobody.
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState({ name: "", notify_reorder: false, saving: false });
  // What each ticked department is sent, by the server's own rule: the names
  // of its sections, or null for the whole store. Keyed by department name.
  const [scopes, setScopes] = useState({});

  const loadScopes = useCallback(async () => {
    try {
      const d = (await departmentService.reorderMailStatus()).data.data;
      setScopes(Object.fromEntries((d.departments || []).map((x) => [x.department, x])));
    } catch { /* the list is still usable; the "Gets" line is left out */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await departmentService.list();
      setRows(res.data.data.map((d) => ({
        ...d,
        recipients: d.recipients || [],
        _draft: { name: "", email: "", role: "TO" },
      })));
      setLoadFailed(false);
    } catch {
      // The api layer has toasted the reason. Rows read earlier stay on screen.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); loadScopes(); }, [load, loadScopes]);

  const patchRow = (id, patch) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const patchDraft = (id, patch) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, _draft: { ...r._draft, ...patch } } : r)));
  const patchPerson = (rId, recId, patch) =>
    setRows((rs) => rs.map((r) => (r.id === rId
      ? { ...r, recipients: r.recipients.map((x) => (x.id === recId ? { ...x, ...patch } : x)) }
      : r)));

  const toggleNotify = async (r, val) => {
    patchRow(r.id, { notify_reorder: val });
    try {
      await departmentService.update(r.id, { notify_reorder: val });
      loadScopes();
    } catch { patchRow(r.id, { notify_reorder: !val }); }
  };

  const addPerson = async (r) => {
    const name = (r._draft.name || "").trim();
    if (!name) { toast.error("Person name is required"); return; }
    try {
      const res = await departmentService.addRecipient(r.id, { name, email: r._draft.email || null, role: r._draft.role || "TO" });
      patchRow(r.id, { recipients: [...r.recipients, res.data.data], _draft: { name: "", email: "", role: "TO" } });
    } catch { /* interceptor toasts */ }
  };

  const savePerson = async (rec) => {
    try { await departmentService.updateRecipient(rec.id, { name: rec.name, email: rec.email || null, role: rec.role || "TO" }); }
    catch { load(); }
  };

  const removePerson = async (rId, recId) => {
    try {
      await departmentService.deleteRecipient(recId);
      patchRow(rId, { recipients: rows.find((r) => r.id === rId).recipients.filter((x) => x.id !== recId) });
    } catch { /* interceptor toasts */ }
  };

  const [sending, setSending] = useState(false);
  const sendReorderNow = async () => {
    setSending(true);
    try {
      const d = (await departmentService.sendReorderMail()).data.data;
      // With the mail engine off a department's mail is written but held back: it is in the queue, not lost.
      const held = (d.departments || []).some((x) => x.reason === "mail_engine_disabled");
      // Skipped for any other reason: the mail was written and the mail server did not take it.
      const failed = (d.departments || []).filter((x) => x.status !== "sent" && !NOT_A_FAILURE.includes(x.reason)).length;
      // Its list could not be put together at all — nothing to do with the mail server, and the others still went.
      const unbuilt = (d.departments || []).filter((x) => x.reason === "list_build_failed").map((x) => x.department);
      if (unbuilt.length) {
        toast.error(`The reorder list of ${unbuilt.join(", ")} could not be built, so it was not mailed. The other departments are not affected.`,
          { duration: 8000 });
      }
      const sent = `Reorder mail sent to ${d.total_sent} department${d.total_sent === 1 ? "" : "s"}`;
      const unsent = d.total_sent ? `${sent}. ${failed} more ${failed === 1 ? "was" : "were"} not sent` : "Not sent";
      if (d.reason === "smtp_not_configured") toast.error("The mail server is not configured yet — nothing can be sent");
      // Kept up long enough to be read: it says where the unsent mail is.
      else if (failed) toast.error(`${unsent} — ${SERVER_FAILED}`, { duration: 8000 });
      else if (d.total_sent) toast.success(sent);
      else if (held) toast("Not sent — the mail engine is off, so the reorder mail is waiting in the Email Queue", { icon: "ℹ️" });
      else toast(NOTHING_SENT, { icon: "ℹ️" });
    } catch { /* interceptor toasts */ }
    finally { setSending(false); }
  };

  const addDept = async () => {
    const name = adding.name.trim();
    if (!name) { toast.error("Department name is required"); return; }
    setAdding((a) => ({ ...a, saving: true }));
    try {
      await departmentService.create({ name, notify_reorder: adding.notify_reorder });
      setAdding({ name: "", notify_reorder: false, saving: false });
      toast.success(`${name} added`);
      load();
    } catch {
      setAdding((a) => ({ ...a, saving: false }));
    }
  };

  const hasAddr = (r) => r.recipients.some((x) => (x.email || "").trim());
  // The server mails a ticked department only while it is active, so only those are counted.
  const flaggedWith = useMemo(() => rows.filter((r) => r.is_active && r.notify_reorder && hasAddr(r)), [rows]);
  const flaggedNoAddress = useMemo(() => rows.filter((r) => r.is_active && r.notify_reorder && !hasAddr(r)), [rows]);
  const totalPeople = flaggedWith.reduce((n, r) => n + r.recipients.filter((x) => (x.email || "").trim()).length, 0);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="section-title">Department Emails</h3>
        <p className="section-hint">
          Who the reorder list and the excess parts list are mailed to. Tick “Reorder mail” for a department and add
          the people (name + e-mail) who should receive them — several per department is fine. Set each person as To,
          Cc or Bcc.
        </p>
      </div>

      <div className="card !p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {/* The count is shown only once the list is in: "0 people" has to mean nobody is ticked. */}
        {loadFailed ? (
          <span className="text-rose-600 dark:text-rose-400" role="alert">
            Could not load the departments.{" "}
            <button type="button" onClick={load} disabled={loading}
              className="font-semibold underline underline-offset-2 disabled:opacity-50">Retry</button>
          </span>
        ) : !loading && (
          <>
            <span className="inline-flex items-center gap-2">
              <BellRing size={16} className="text-toyotared" />
              <span className="font-semibold text-slate-700 dark:text-slate-200">
                {totalPeople} {totalPeople === 1 ? "person" : "people"}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                across {flaggedWith.length} department{flaggedWith.length === 1 ? "" : "s"} get the reorder list and the
                excess parts list
              </span>
            </span>
            {flaggedNoAddress.length > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                <TriangleAlert size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" />{flaggedNoAddress.map((r) => r.name).join(", ")} flagged but no person — will be skipped
              </span>
            )}
          </>
        )}
        <Can mod="departments" edit>
          <button type="button" onClick={sendReorderNow} disabled={sending || totalPeople === 0}
            title="Send only the reorder list now, to every ticked department (To / Cc / Bcc as set below)"
            className="btn-primary !py-1.5 text-xs inline-flex items-center gap-1.5 ml-auto disabled:opacity-50">
            <Send size={14} aria-hidden="true" /> {sending ? "Sending…" : "Send reorder mail now"}
          </button>
        </Can>
        {/* On its own line of the card: which parts a ticked department is sent. */}
        <p className="basis-full text-xs text-slate-500 dark:text-slate-400">
          A ticked department gets the daily reorder list and the excess parts list of its own section: a department
          named like a section or a section group gets that section&apos;s parts; any other department, such as
          Store, gets the whole store.
        </p>
      </div>

      {!canEdit && (
        <p className="text-[13px] text-amber-600 dark:text-amber-400">
          You are viewing this master read-only — an administrator can edit the recipients.
        </p>
      )}

      <div className="card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-navy-800">
                <th className="px-4 py-3 font-semibold">Department</th>
                <th className="px-4 py-3 font-semibold text-center" title={TICK_HINT}>Reorder mail</th>
                <th className="px-4 py-3 font-semibold">Recipients (person + e-mail)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {loading && <tr><td colSpan={3} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-slate-400">
                    {loadFailed ? "Could not load the departments." : "No departments yet."}
                  </td>
                </tr>
              )}
              {!loading && rows.map((r) => (
                <tr key={r.id} className={r.is_active ? "align-top" : "align-top opacity-50"}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                    {!r.is_active && <span className="ml-2 text-[11px] text-slate-400">(inactive)</span>}
                    {r.is_active && r.notify_reorder && scopes[r.name] && (
                      <p className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                        Gets the parts of: <span className="font-semibold text-slate-600 dark:text-slate-300">
                          {scopes[r.name].sections ? scopes[r.name].sections.join(" + ") : "the whole store"}
                        </span>
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <input type="checkbox" className="h-4 w-4 accent-toyotared cursor-pointer"
                      checked={r.notify_reorder} disabled={!canEdit}
                      onChange={(e) => toggleNotify(r, e.target.checked)} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-1.5">
                      {r.recipients.map((rec) => (
                        <div key={rec.id} className="flex items-stretch gap-2 max-w-3xl">
                          <RoleSelect value={rec.role} disabled={!canEdit}
                            onChange={(v) => { patchPerson(r.id, rec.id, { role: v }); if (canEdit) departmentService.updateRecipient(rec.id, { role: v }).catch(() => load()); }} />
                          <input className={`${INPUT} md:max-w-[12rem]`} placeholder="Person name"
                            value={rec.name} disabled={!canEdit}
                            onChange={(e) => patchPerson(r.id, rec.id, { name: e.target.value })}
                            onBlur={() => canEdit && savePerson(rec)} />
                          <EmailInput value={rec.email} disabled={!canEdit}
                            onChange={(v) => patchPerson(r.id, rec.id, { email: v })}
                            onBlur={() => canEdit && savePerson(rec)} />
                          <Can mod="departments" edit>
                            <button type="button" onClick={() => removePerson(r.id, rec.id)}
                              className="shrink-0 rounded-lg px-2.5 text-slate-400 hover:text-rose-500" title="Remove">✕</button>
                          </Can>
                        </div>
                      ))}
                      {r.recipients.length === 0 && (
                        <div className="text-xs text-slate-400">No people yet.</div>
                      )}
                      <Can mod="departments" edit>
                        <div className="flex items-stretch gap-2 max-w-3xl pt-0.5">
                          <RoleSelect value={r._draft.role || "TO"}
                            onChange={(v) => patchDraft(r.id, { role: v })} />
                          <input className={`${INPUT} md:max-w-[12rem]`} placeholder="Add person name"
                            value={r._draft.name}
                            onChange={(e) => patchDraft(r.id, { name: e.target.value })} />
                          <EmailInput value={r._draft.email}
                            onChange={(v) => patchDraft(r.id, { email: v })}
                            onEnter={() => addPerson(r)} />
                          <button type="button" onClick={() => addPerson(r)}
                            className="shrink-0 rounded-lg bg-toyotared px-3 text-xs font-semibold text-white hover:opacity-90">+ Add</button>
                        </div>
                      </Can>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Can mod="departments" edit>
          <div className="border-t border-slate-200 dark:border-navy-800 bg-slate-50 dark:bg-navy-900/50 px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Add a department</p>
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              <input className={`${INPUT} md:max-w-[14rem]`} placeholder="Department name"
                value={adding.name}
                onChange={(e) => setAdding((a) => ({ ...a, name: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") addDept(); }} />
              <label title={TICK_HINT}
                className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 px-1 whitespace-nowrap">
                <input type="checkbox" className="h-4 w-4 accent-toyotared cursor-pointer"
                  checked={adding.notify_reorder}
                  onChange={(e) => setAdding((a) => ({ ...a, notify_reorder: e.target.checked }))} />
                Reorder mail
              </label>
              <button type="button" onClick={addDept} disabled={adding.saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-toyotared px-3 py-2 text-sm font-semibold text-white disabled:opacity-40 hover:opacity-90">
                {adding.saving ? "Adding…" : "+ Add"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">Add the department first, then add its people below.</p>
          </div>
        </Can>
      </div>
    </div>
  );
}
