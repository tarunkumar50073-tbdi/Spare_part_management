import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, ListChecks, Mail, Send, TriangleAlert, Users } from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { Segmented } from "../../components/scan/forms/FormKit.jsx";
import { errorText, refreshMail } from "../../components/email/MessageDrawer.jsx";
import { AdminOnly, PageHead, RecipientPicker, SmtpBanner } from "../../components/email/EmailKit.jsx";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";

// Send Email Alert — a one-off message from an administrator to chosen
// departments and addresses, optionally with the critical parts list or the
// Action Tracker table under it. Nothing leaves from this screen directly: the
// alert goes into the mail queue like every other mail, so it is retried if the
// mail server is down and it shows in Email Logs afterwards.

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;

// `adds` is how the choice reads inside the confirm question.
const INCLUDE = [
  { value: "none", label: "Nothing", hint: "Only the message" },
  { value: "critical", label: "Critical parts list", hint: "Zero-stock and below-minimum parts, worst first",
    adds: "the critical parts list" },
  { value: "tracker", label: "Action Tracker table", hint: "The Action Tracker lines with owner, target date and status",
    adds: "the Action Tracker table" },
];

const EMPTY = { subject: "", message: "", include: "none", departmentIds: [], emails: [] };

const ROLES = [["TO", "To"], ["CC", "Cc"], ["BCC", "Bcc"]];
const roleOf = (r) => (ROLES.some(([k]) => k === String(r || "").toUpperCase()) ? String(r).toUpperCase() : "TO");

// A mail the engine answered with but set aside instead of queueing.
const NOT_GOING = new Set(["SKIPPED", "FAILED", "CANCELLED"]);

const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * Who the alert reaches, worked out the way the engine does it: the people of
 * every chosen department who have an address, each in the role the Department
 * Emails master gives them, plus the extra addresses. One address counts once —
 * To before Cc before Bcc.
 */
function whoGetsIt(departments, departmentIds, emails) {
  const all = [];
  const nobody = [];   // chosen departments that add no one
  for (const d of departments) {
    if (!departmentIds.includes(d.id)) continue;
    const mailable = (d.recipients || []).filter((r) => (r.email || "").trim());
    if (!mailable.length) nobody.push(d.name);
    for (const r of mailable) all.push({ email: r.email.trim(), name: r.name || r.email.trim(), role: roleOf(r.role) });
  }
  for (const e of emails) all.push({ email: e.email, name: e.email, role: roleOf(e.role) });

  const seen = new Set();
  const byRole = { TO: [], CC: [], BCC: [] };
  for (const [role] of ROLES) {
    for (const p of all) {
      const key = p.email.toLowerCase();
      if (p.role !== role || seen.has(key)) continue;
      seen.add(key);
      byRole[role].push(p);
    }
  }
  return { byRole, total: seen.size, nobody };
}

// When a queued mail leaves: the sender wakes every poll_seconds (60 unless an
// administrator changed it) — and not at all while it is off or not running.
// A server started with mail held off cannot be switched on from the app.
function goesOut(engine) {
  if (engine?.forced_off) return "it will not go out, because mail is held off on this server";
  if (engine?.enabled === false) return "it will wait until the notification engine is switched back on";
  if (engine?.worker_running === false) return "it will leave when the queue is next processed";
  const seconds = engine?.poll_seconds;
  return seconds > 60 ? `it will go out within ${Math.ceil(seconds / 60)} minutes` : "it will go out within a minute";
}

/** A labelled text field with its "used / allowed" counter on the right. */
function Counted({ id, label, length, max, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</label>
        <span className={`text-[11px] tabular ${length >= max ? "font-semibold text-amber-600 dark:text-amber-400" : "text-slate-400"}`}>
          {length.toLocaleString("en-IN")} / {max.toLocaleString("en-IN")}
        </span>
      </div>
      {children}
    </div>
  );
}

function SendScreen() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState(EMPTY);
  // Bumped when the form resets: the picker is rebuilt, so an address typed
  // into it but not added goes as well.
  const [round, setRound] = useState(0);
  const [last, setLast] = useState(null);   // the server's answer to the last send
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const status = useQuery({
    queryKey: mailKeys.status,
    queryFn: () => mailEngineService.status().then((r) => r.data.data),
  });
  const depts = useQuery({
    queryKey: mailKeys.recipients,
    queryFn: () => mailEngineService.recipients().then((r) => r.data.data),
  });
  const smtp = status.data?.smtp;
  const engine = status.data?.engine;

  const who = useMemo(
    () => whoGetsIt(depts.data || [], form.departmentIds, form.emails),
    [depts.data, form.departmentIds, form.emails],
  );
  const counts = ROLES.map(([role, label]) => `${who.byRole[role].length} ${label}`).join(" · ");

  const send = useMutation({
    mutationFn: (payload) => mailEngineService.sendAlert(payload).then((r) => r.data.data),
    onSuccess: (msg) => {
      setLast(msg);
      // Set aside rather than queued: the form stays, so it can be corrected and sent again.
      if (NOT_GOING.has(msg?.status)) {
        toast.error("Not queued — the server set this mail aside");
        return;
      }
      toast.success(`Queued — ${goesOut(engine)}`);
      setForm(EMPTY);
      setRound((n) => n + 1);
    },
    onSettled: () => refreshMail(qc),
  });

  const subject = form.subject.trim();
  const message = form.message.trim();
  // Why Send is off, in the order the reader can fix it. An unknown mail-server
  // state (the status has not loaded) does not block: the server decides then.
  const blocker = smtp && !smtp.configured ? "The mail server is not configured yet, so nothing can be sent."
    : !subject ? "Write a subject."
      : !message ? "Write a message."
        : who.total === 0 ? "There is no one to send to — pick a department or add an address."
          : null;

  const submit = async () => {
    if (blocker || send.isPending) return;
    const adds = INCLUDE.find((o) => o.value === form.include)?.adds;
    if (!(await confirm({
      title: `Send to ${people(who.total)}?`,
      message: `“${subject}” goes to ${counts}${adds ? `, with ${adds} under the message` : ""}. `
        + "Until it leaves, it can still be cancelled in Email Queue.",
      confirmText: "Send", danger: false,
    }))) return;
    setLast(null);
    send.mutate({
      subject, message, include: form.include,
      department_ids: form.departmentIds,
      emails: form.emails.map((e) => ({ email: e.email, role: roleOf(e.role) })),
    });
  };

  const sentTo = last ? (last.to || []).length + (last.cc || []).length + (last.bcc || []).length : 0;

  return (
    <div className="space-y-5">
      <PageHead icon={Send} title="Send Email Alert"
        hint="A one-off message to chosen departments and addresses. It goes into the mail queue and shows in Email Logs like every other mail." />

      <SmtpBanner smtp={smtp} />
      {status.isError && !status.data && (
        <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" role="status">
          <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
          Couldn&apos;t check whether the mail server is set up.
          <button type="button" onClick={() => status.refetch()} className="font-medium text-toyotared hover:underline">Retry</button>
        </p>
      )}
      {engine?.enabled === false && (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" role="status">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {engine.forced_off
            ? "Mail is held off on this server — an alert sent now is queued, but does not go out from here."
            : "The notification engine is switched off — an alert sent now waits in the queue until it is switched back on."}
        </p>
      )}

      {last && (NOT_GOING.has(last.status) ? (
        <div role="alert"
          className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Not queued{last.last_error ? `: ${errorText(last.last_error)}` : ""}. Nothing was sent — correct it below and send again.
          </span>
        </div>
      ) : (
        <div role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CircleCheck size={16} className="shrink-0" aria-hidden="true" />
          <span>
            “{last.subject}” is queued{sentTo ? ` for ${people(sentTo)}` : ""} — {goesOut(engine)}.
          </span>
          <Link to="/email/queue" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-toyotared">
            Open Email Queue <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      ))}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-5">
          <div className="card">
            <CardHead icon={Mail} tone="navy" title="Message" />
            <div className="space-y-4">
              <Counted id="alert-subject" label="Subject" length={form.subject.length} max={SUBJECT_MAX}>
                <input id="alert-subject" className="input-field mt-1" maxLength={SUBJECT_MAX} disabled={send.isPending}
                  value={form.subject} onChange={(e) => set({ subject: e.target.value })} />
              </Counted>
              <Counted id="alert-message" label="Message" length={form.message.length} max={MESSAGE_MAX}>
                <textarea id="alert-message" className="input-field mt-1 resize-y" rows={9} maxLength={MESSAGE_MAX}
                  disabled={send.isPending} value={form.message} onChange={(e) => set({ message: e.target.value })} />
              </Counted>
              <div>
                <p className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-300">Include under the message</p>
                <Segmented label="Include under the message" options={INCLUDE} columns={3}
                  value={form.include} onChange={(include) => set({ include })} />
              </div>
            </div>
          </div>

          <div className="card">
            <CardHead icon={Users} tone="blue" title="Recipients"
              hint="Whole departments from the Department Emails master, plus any extra address" />
            {depts.isPending ? (
              <div className="space-y-2" aria-busy="true">
                <div className="skeleton h-12 w-full" />
                <div className="skeleton h-12 w-full" />
              </div>
            ) : (
              <>
                {depts.isError && (
                  <p className="mb-3 text-xs text-rose-600 dark:text-rose-400" role="alert">
                    Couldn&apos;t load the departments — extra addresses can still be added.{" "}
                    <button type="button" onClick={() => depts.refetch()} className="font-semibold underline underline-offset-2">Retry</button>
                  </p>
                )}
                <RecipientPicker key={round} departments={depts.data || []} departmentIds={form.departmentIds}
                  emails={form.emails} onChange={set} disabled={send.isPending} />
              </>
            )}
          </div>
        </div>

        <div className="card self-start">
          <CardHead icon={ListChecks} tone="green" title="Who gets it" hint={counts} />
          {who.total === 0 ? (
            <p className="text-sm text-slate-400">No one yet — pick a department or add an address.</p>
          ) : (
            <dl className="space-y-3">
              {ROLES.map(([role, label]) => who.byRole[role].length > 0 && (
                <div key={role}>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {label} ({who.byRole[role].length})
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {who.byRole[role].map((p) => (
                      <span key={p.email} title={p.email}
                        className="max-w-full truncate rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-navy-800 dark:text-slate-200">
                        {p.name}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {who.nobody.length > 0 && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              {who.nobody.join(", ")} {who.nobody.length === 1 ? "has" : "have"} no one with an e-mail address, so nobody is added from there.
            </p>
          )}

          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-navy-800">
            <button type="button" onClick={submit} disabled={Boolean(blocker) || send.isPending}
              className="btn-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-50">
              <Send size={15} aria-hidden="true" /> {send.isPending ? "Queuing…" : "Send alert"}
            </button>
            {blocker && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{blocker}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SendEmailAlert() {
  // The screen sits inside the gate, so a non-admin never fires its calls.
  return <AdminOnly><SendScreen /></AdminOnly>;
}
