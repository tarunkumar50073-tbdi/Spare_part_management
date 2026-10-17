import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Info, ListChecks, Pencil, Play, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import Modal from "../../components/Modal.jsx";
import Table from "../../components/Table.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { AdminOnly, PageHead, RecipientPicker, SmtpBanner, fmtWhen } from "../../components/email/EmailKit.jsx";
import { nextCheckWords, startsNow } from "../../components/email/schedule.js";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";
import { num } from "../../lib/format.js";

// Reminder & Escalation — chases the open lines of the Action Tracker. A line
// whose target date is near (or passed) is mailed to its owners; one left
// overdue long enough is escalated to a second list, with the owners in Cc. The
// lines, their "Action by" and their target dates belong to the Action Tracker
// page; this screen holds only the timing and WHO is mailed. The Level, Next
// action and Note of each line are the server's reading of the saved settings.

const MAX_DAYS = 365;
const DAY_FIELDS = [
  { key: "remind_before_days", name: "Remind within", label: "Remind when the target date is within", min: 0,
    hint: "A line already past its date is reminded too." },
  { key: "repeat_every_days", name: "Repeat every", label: "Repeat every", min: 1,
    hint: "At most one mail per line in this many days." },
  { key: "escalate_after_days", name: "Escalate after", label: "Escalate when overdue by", min: 0,
    hint: "The mail then goes to the Escalate-to list, with the owners in Cc." },
];

const ROLES = [["TO", "To"], ["CC", "Cc"], ["BCC", "Bcc"]];
const LEVEL = { 1: ["Reminded", "badge-warning"], 2: ["Escalated", "badge-danger"] };
const NEXT_ACTION = {
  none: ["None", "badge-neutral"], remind: ["Remind", "badge-warning"], escalate: ["Escalate", "badge-danger"],
};
const STATUS_TONE = { OVERDUE: "badge-danger", OPEN: "badge-warning", CLEAR: "badge-success" };

const LABEL = "block text-xs font-medium text-slate-600 dark:text-slate-300";
const HINT = "mt-1 block text-[11px] font-normal text-slate-400";
const LINK = "font-semibold underline underline-offset-2 hover:text-toyotared";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dash = <span className="text-slate-400">—</span>;

// <input type="time"> speaks "HH:MM"; the server keeps hour and minute apart.
const two = (n) => String(n).padStart(2, "0");
const toTime = (hour, minute) => (hour == null || minute == null ? "" : `${two(hour)}:${two(minute)}`);
const fromTime = (text) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text || "").trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
};
// A day count as typed; null while it is not a whole number.
const wholeDays = (text) => (/^\d+$/.test(String(text).trim()) ? Number(text) : null);

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// Addresses compared as a set of "ROLE:address" — the order they were added in does not matter.
const addressKey = (list) =>
  list.map((x) => `${String(x.role || "TO").toUpperCase()}:${String(x.email || "").trim().toLowerCase()}`).sort().join("|");
const plainAddresses = (list) => list.map(({ email, role }) => ({ email, role: role || "TO" }));

// The same words the Action Tracker page uses for a line.
const statusOf = (line) => (line.overdue ? "OVERDUE" : line.status || "UNKNOWN");
const targetHint = (line) => {
  const d = line.days_to_target;
  if (line.overdue) return d == null ? "Overdue" : `Overdue ${Math.abs(d)} d`;
  if (d == null || d < 0) return null;
  return d === 0 ? "Due today" : `in ${d} d`;
};

// Put the server's answer on screen at once; the refetch confirms it.
const acceptReminders = (qc, next) => {
  if (Array.isArray(next?.lines)) qc.setQueryData(mailKeys.reminders, next);
  qc.invalidateQueries({ queryKey: mailKeys.reminders });
};

// A small on/off switch (the one the Settings screen uses).
function Toggle({ on, onClick, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on
        ? "bg-emerald-500" : "bg-slate-300 dark:bg-navy-700"}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

function RoleSelect({ value, onChange, disabled, label }) {
  return (
    <select value={String(value || "TO").toUpperCase()} disabled={disabled} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="input-field w-auto shrink-0 py-1.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60">
      {ROLES.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  );
}

/**
 * The "Escalate to" list: addresses only, each with its own To / Cc / Bcc role.
 * It works like the extra-address list of the recipient picker — an address is
 * checked and de-duplicated when it is added, so the list never holds a bad one.
 * The box being typed in (`typing`) lives with the caller, which will not save
 * while an address is still sitting in it un-added.
 */
function AddressList({ value, onChange, typing, onTyping, disabled }) {
  const [err, setErr] = useState(null);

  const add = () => {
    const email = typing.email.trim();
    if (!email) { setErr("Type an e-mail address first."); return; }
    if (!EMAIL_RE.test(email)) { setErr("Enter a full e-mail address, e.g. name@toyota-boshoku.com."); return; }
    if (value.some((x) => (x.email || "").toLowerCase() === email.toLowerCase())) {
      setErr(`${email} is already on the list.`);
      return;
    }
    onChange([...value, { email, role: typing.role }]);
    onTyping({ email: "", role: typing.role });
    setErr(null);
  };

  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {value.map((x, i) => (
            <li key={`${x.email}-${i}`} className="flex items-center gap-2">
              <RoleSelect value={x.role} disabled={disabled} label={`Role of ${x.email}`}
                onChange={(role) => onChange(value.map((y, j) => (j === i ? { ...y, role } : y)))} />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{x.email}</span>
              <button type="button" disabled={disabled} aria-label={`Remove ${x.email}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-1 text-slate-400 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-60">
                <X size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <RoleSelect value={typing.role} disabled={disabled} label="Role of the new address"
          onChange={(role) => onTyping({ ...typing, role })} />
        <input type="email" className="input-field min-w-[12rem] flex-1 py-1.5 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="name@toyota-boshoku.com" aria-label="Escalation e-mail address" maxLength={254}
          value={typing.email} disabled={disabled}
          onChange={(e) => { onTyping({ ...typing, email: e.target.value }); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" className="btn-secondary !py-1.5" onClick={add} disabled={disabled}>
          <Plus size={15} aria-hidden="true" /> Add
        </button>
      </div>
      {err && <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400" role="alert">{err}</p>}
    </div>
  );
}

function SettingsCard({ data, toRemind, toEscalate, engine }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  // Only the settings being edited. Everything else reads from the saved
  // settings, so a background refetch never undoes an edit in progress.
  const [draft, setDraft] = useState({});
  const [typing, setTyping] = useState({ email: "", role: "TO" });
  const patch = (next) => setDraft((d) => ({ ...d, ...next }));

  // Day counts are held as typed (text), so a box can be emptied while editing.
  const saved = {
    enabled: Boolean(data.enabled),
    time: toTime(data.hour, data.minute),
    escalate_to: data.escalate_to || [],
    ...Object.fromEntries(DAY_FIELDS.map((f) => [f.key, data[f.key] == null ? "" : String(data[f.key])])),
  };
  const value = { ...saved, ...draft };
  const time = fromTime(value.time);
  const days = Object.fromEntries(DAY_FIELDS.map((f) => [f.key, wholeDays(value[f.key])]));

  // Only what differs from the saved settings is sent.
  const changes = {};
  if (value.enabled !== saved.enabled) changes.enabled = value.enabled;
  if (time && time.hour !== data.hour) changes.hour = time.hour;
  if (time && time.minute !== data.minute) changes.minute = time.minute;
  DAY_FIELDS.forEach((f) => {
    if (days[f.key] != null && days[f.key] !== data[f.key]) changes[f.key] = days[f.key];
  });
  if (addressKey(value.escalate_to) !== addressKey(saved.escalate_to)) changes.escalate_to = plainAddresses(value.escalate_to);
  const dirty = Object.keys(changes).length > 0;
  // A box emptied or mistyped is an edit too, though there is nothing valid to send yet.
  const edited = dirty || ["time", ...DAY_FIELDS.map((f) => f.key)].some((k) => value[k] !== saved[k]);

  const badDays = DAY_FIELDS.find((f) => days[f.key] == null || days[f.key] < f.min || days[f.key] > MAX_DAYS);
  const problem = !time ? "Enter the time the lines are checked at."
    : badDays ? `${badDays.name}: enter a whole number of days, ${badDays.min} to ${MAX_DAYS}.`
    : typing.email.trim() ? "Press Add to put the typed address on the Escalate-to list, or clear the box."
    : null;

  const save = useMutation({
    mutationFn: (payload) => mailEngineService.saveReminders(payload).then((r) => r.data.data),
    onSuccess: (next) => {
      setDraft({});
      acceptReminders(qc, next);
      toast.success("Reminder settings saved");
    },
    // A failure is already toasted by the api layer; the edits stay on the card.
  });
  const busy = save.isPending;

  const onSave = async () => {
    // Switched on, or moved, past today's check time the lines are not left
    // for tomorrow: the engine checks them at its next check and mails whoever
    // is due. Say so, with how many that is, before saving — not on a server
    // with mail held off, where no check sends anything.
    if (!engine?.forced_off && startsNow(
      { enabled: saved.enabled, hour: data.hour, minute: data.minute },
      { enabled: value.enabled, ...time },
    )) {
      // The two counts are the server's, read with the settings as they were.
      const alsoEdited = Object.keys(changes).some((k) => !["enabled", "hour", "minute"].includes(k));
      if (!(await confirm({
        title: "The reminders go out today",
        message: `Today's check time (${toTime(time.hour, time.minute)}) has already passed, so the reminders that are due `
          + `go out ${nextCheckWords(engine)}, unless the lines have already been checked today. `
          + `By the saved settings ${num(toRemind)} to remind and ${num(toEscalate)} to escalate`
          + `${alsoEdited ? " — the other changes on this card can alter that" : ""}. Save?`,
        confirmText: "Save", danger: false,
      }))) return;
    }
    save.mutate(changes);
  };

  const undo = () => {
    setDraft({});
    setTyping({ email: "", role: "TO" });
  };

  return (
    <section className="card" aria-label="Reminder settings">
      <CardHead icon={AlarmClock} tone={data.enabled ? "green" : "navy"} title="Reminder settings"
        hint="When the lines are checked, and when an overdue line is escalated"
        action={(
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {value.enabled ? "On" : "Off"}
            <Toggle on={value.enabled} disabled={busy} label="Reminders — switch on or off"
              onClick={() => patch({ enabled: !value.enabled })} />
          </span>
        )} />

      {edited && <div className="-mt-1 mb-3"><span className="badge badge-warning">Unsaved changes</span></div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label className={LABEL}>Check time
          <input type="time" className="input-field mt-1 w-32 tabular" value={value.time} disabled={busy}
            onChange={(e) => patch({ time: e.target.value })} />
          <span className={HINT}>The lines are checked once a day, at this time.</span>
        </label>
        {DAY_FIELDS.map((f) => (
          <label key={f.key} className={LABEL}>{f.label}
            <span className="mt-1 flex items-center gap-2">
              <input type="number" inputMode="numeric" min={f.min} max={MAX_DAYS} step={1}
                className="input-field w-24 tabular" value={value[f.key]} disabled={busy}
                onChange={(e) => patch({ [f.key]: e.target.value })} />
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">days</span>
            </span>
            <span className={HINT}>{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-navy-800">
        <p className={LABEL}>Escalate to</p>
        <p className="mb-2 mt-0.5 text-[11px] text-slate-400">
          Who is told when a line stays overdue — usually the people above the line&apos;s owners.
        </p>
        <div className="max-w-2xl">
          <AddressList value={value.escalate_to} typing={typing} onTyping={setTyping} disabled={busy}
            onChange={(escalate_to) => patch({ escalate_to })} />
        </div>
        {value.escalate_to.length === 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <TriangleAlert size={14} className="shrink-0" aria-hidden="true" /> No escalation address is set.
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4 dark:border-navy-800">
        {problem && <span className="text-xs font-semibold text-rose-600 dark:text-rose-400" role="alert">{problem}</span>}
        {(edited || typing.email) && (
          <button type="button" className="btn-secondary" onClick={undo} disabled={busy}>Undo changes</button>
        )}
        <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onSave} disabled={!dirty || Boolean(problem) || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

// Who is reminded for one line. Saved straight from the dialog, so the table's
// "Who is reminded" (resolved by the server) is right as soon as it closes.
function OwnersDialog({ line, owners, depts, onClose }) {
  const qc = useQueryClient();
  const current = owners[line.key];
  const before = { departmentIds: current?.department_ids || [], emails: current?.emails || [] };
  const [form, setForm] = useState(before);
  const departments = Array.isArray(depts.data) ? depts.data : null;
  const changed = !sameSet(form.departmentIds, before.departmentIds)
    || addressKey(form.emails) !== addressKey(before.emails);

  const save = useMutation({
    // The whole owners map goes back with this one line changed, so the other
    // lines keep theirs whether the server merges the field or replaces it.
    mutationFn: () => mailEngineService.saveReminders({
      owners: { ...owners, [line.key]: { department_ids: form.departmentIds, emails: plainAddresses(form.emails) } },
    }).then((r) => r.data.data),
    onSuccess: (next) => {
      acceptReminders(qc, next);
      toast.success(`Saved who is reminded — ${line.label}`);
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title={`Who is reminded — ${line.label}`}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => save.mutate()} disabled={!changed || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      )}>
      <div className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          These people get the reminder for this line. When the line is escalated they are put in Cc.
          {line.owner && <> On the Action Tracker it is with <b className="font-semibold text-slate-700 dark:text-slate-200">{line.owner}</b>.</>}
        </p>
        {depts.isPending ? (
          <div className="skeleton h-28 w-full" />
        ) : !departments ? (
          <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
            Couldn&apos;t load the departments, so the people cannot be changed right now.{" "}
            <button type="button" onClick={() => depts.refetch()} className="font-semibold underline underline-offset-2">Retry</button>
          </p>
        ) : (
          <RecipientPicker departments={departments} departmentIds={form.departmentIds} emails={form.emails}
            disabled={save.isPending} onChange={setForm} />
        )}
      </div>
    </Modal>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="card space-y-3">
        <div className="skeleton h-8 w-56" />
        <div className="skeleton h-16 w-full" />
        <div className="skeleton h-10 w-2/3" />
      </div>
      <div className="card space-y-2">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}
      </div>
    </div>
  );
}

function RemindersScreen() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);   // the line whose people are being chosen

  const q = useQuery({
    queryKey: mailKeys.reminders,
    queryFn: () => mailEngineService.reminders().then((r) => r.data.data),
  });
  // The Department Emails master, for the picker in the "who is reminded" dialog.
  const depts = useQuery({
    queryKey: mailKeys.recipients,
    queryFn: () => mailEngineService.recipients().then((r) => r.data.data),
  });
  const status = useQuery({
    queryKey: mailKeys.status,
    queryFn: () => mailEngineService.status().then((r) => r.data.data),
  });
  const data = q.data;
  const engine = status.data?.engine;
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const toRemind = lines.filter((l) => l.next_action === "remind").length;
  const toEscalate = lines.filter((l) => l.next_action === "escalate").length;

  const run = useMutation({
    mutationFn: () => mailEngineService.runReminders().then((r) => r.data.data),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: mailKeys.reminders });
      qc.invalidateQueries({ queryKey: mailKeys.status });
      qc.invalidateQueries({ queryKey: ["mail", "messages"] });   // every page of the queue and the log
      const text = `${num(res?.reminded)} reminded · ${num(res?.escalated)} escalated`;
      if (res?.reminded || res?.escalated) toast.success(text);
      else toast(text);
    },
  });

  const runNow = async () => {
    if (!(await confirm({
      title: "Run now",
      message: `Check every Action Tracker line now and mail whoever is due? Right now ${num(toRemind)} to remind and ${num(toEscalate)} to escalate. The saved settings are used.`,
      confirmText: "Run now", danger: false,
    }))) return;
    run.mutate();
  };

  const columns = useMemo(() => [
    { key: "label", label: "Problem", sortable: true,
      render: (r) => <span className="block max-w-[16rem] whitespace-normal font-medium text-slate-800 dark:text-white">{r.label}</span> },
    { key: "owner", label: "Action by", sortable: true,
      render: (r) => (r.owner ? <span className="block max-w-[11rem] whitespace-normal">{r.owner}</span> : dash) },
    { key: "target_date", label: "Target", sortable: true,
      render: (r) => {
        if (!r.target_date) return dash;
        const hint = targetHint(r);
        return (
          <>
            <div className="tabular">{fmtWhen(r.target_date)}</div>
            {hint && (
              <div className={`text-xs ${r.overdue ? "font-semibold text-rose-600 dark:text-rose-400" : "text-slate-400"}`}>{hint}</div>
            )}
          </>
        );
      } },
    { key: "status", label: "Status", sortValue: statusOf,
      render: (r) => <span className={`badge ${STATUS_TONE[statusOf(r)] || "badge-neutral"}`}>{statusOf(r)}</span> },
    { key: "to", label: "Who is reminded",
      render: (r) => {
        const to = Array.isArray(r.to) ? r.to : [];
        return (
          <div className="flex items-center gap-2">
            {to.length ? (
              <span className="flex flex-wrap items-center gap-1" title={to.join(", ")}>
                {to.slice(0, 2).map((address) => (
                  <span key={address} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-navy-800 dark:text-slate-200">
                    {address}
                  </span>
                ))}
                {to.length > 2 && <span className="text-xs text-slate-500 dark:text-slate-400">+{to.length - 2} more</span>}
              </span>
            ) : (
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300">No one to mail</span>
            )}
            <button type="button" onClick={() => setEditing(r)} title="Choose who is reminded"
              aria-label={`Choose who is reminded — ${r.label}`}
              className="shrink-0 rounded p-1 text-slate-400 hover:text-toyotared">
              <Pencil size={15} aria-hidden="true" />
            </button>
          </div>
        );
      } },
    { key: "level", label: "Level", sortable: true,
      render: (r) => (LEVEL[r.level] ? <span className={`badge ${LEVEL[r.level][1]}`}>{LEVEL[r.level][0]}</span> : dash) },
    { key: "last_notified_at", label: "Last notified", sortable: true,
      render: (r) => <span className="tabular">{fmtWhen(r.last_notified_at)}</span> },
    { key: "next_action", label: "Next action", sortable: true,
      render: (r) => {
        if (!r.next_action) return dash;
        const [name, tone] = NEXT_ACTION[r.next_action] || [r.next_action, "badge-neutral"];
        return <span className={`badge ${tone}`}>{name}</span>;
      } },
    { key: "note", label: "Note",
      render: (r) => (r.note
        ? <span className="block max-w-[18rem] whitespace-normal text-xs text-slate-600 dark:text-slate-300">{r.note}</span>
        : dash) },
  ], []);

  return (
    <div className="space-y-5">
      <PageHead icon={AlarmClock} title="Reminder & Escalation"
        hint="Reminds the owners of the open Action Tracker lines as the target date comes up, and escalates the ones left overdue.">
        <button type="button" className="btn-secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw size={14} className={q.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
        <button type="button" className="btn-secondary disabled:cursor-not-allowed disabled:opacity-40" onClick={runNow}
          // While the engine is off the server checks nothing, so the button does not offer it.
          disabled={!data || run.isPending || engine?.enabled === false}
          title={engine?.forced_off ? "Mail is held off on this server"
            : engine?.enabled === false ? "The mail engine is switched off — switch it on in the Control Center"
            : undefined}>
          <Play size={15} aria-hidden="true" /> {run.isPending ? "Running…" : "Run now"}
        </button>
      </PageHead>

      <SmtpBanner smtp={status.data?.smtp} />
      {/* The master switch stops everything. Without this line the settings would
          read "On" while no reminder is going to leave. A server started with
          mail held off has no switch to send the admin to. */}
      {engine?.enabled === false && (
        <div role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <TriangleAlert size={16} className="shrink-0" aria-hidden="true" />
          {engine.forced_off ? (
            <span className="font-medium">Mail is held off on this server — no reminder goes out from it.</span>
          ) : (
            <>
              <span className="font-medium">The notification engine is switched off — no reminder goes out until it is switched on again.</span>
              <Link to="/email/control-center" className={LINK}>Open Control Center</Link>
            </>
          )}
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
        <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Reminders use the owner and the target date set on the{" "}
          <Link to="/action-tracker" className={LINK}>Action Tracker</Link> page. A line without a target date is never
          reminded. Here you choose when the lines are checked and who gets the mail for each one.
        </span>
      </p>

      {q.isPending ? (
        <Skeleton />
      ) : !data ? (
        <div className="card">
          <ErrorState title="Could not load the reminders"
            message={q.error?.response?.data?.message || "The server did not answer, so no setting and no line is shown."}
            onRetry={() => q.refetch()} />
        </div>
      ) : (
        <>
          {q.isError && (
            // A failed refresh keeps the last good reading, labelled as such.
            <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
              Couldn&apos;t refresh — this shows what was loaded earlier.
              <button type="button" onClick={() => q.refetch()} className="font-semibold text-toyotared hover:underline">Retry</button>
            </p>
          )}

          <SettingsCard data={data} toRemind={toRemind} toEscalate={toEscalate} engine={engine} />

          <section className="card" aria-label="Action Tracker lines">
            <CardHead icon={ListChecks} tone="navy" title="Action Tracker lines"
              hint={`${num(lines.length)} line${lines.length === 1 ? "" : "s"} · ${num(toRemind)} to remind · ${num(toEscalate)} to escalate`} />
            <Table columns={columns} rows={lines} rowKey={(r) => r.key}
              emptyMessage="The Action Tracker has no lines to chase." />
            <p className="mt-3 text-xs text-slate-400">
              Use the pencil on a line to choose who is reminded. Level, Next action and Note follow the saved settings.
            </p>
            {/* Inside the card, not beside it: as a direct child of the page's
                space-y-5 the dialog's full-screen backdrop would inherit that
                top margin and leave a strip of the page undimmed. */}
            {editing && (
              <OwnersDialog key={editing.key} line={editing} owners={data.owners || {}} depts={depts}
                onClose={() => setEditing(null)} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default function ReminderEscalation() {
  return (
    <AdminOnly>
      <RemindersScreen />
    </AdminOnly>
  );
}
