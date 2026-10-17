import React, { useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing, Boxes, Clock3, Eye, ListChecks, Mail, PackagePlus, PackageX, Play, RefreshCw, ShoppingCart,
  TriangleAlert,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import Modal from "../../components/Modal.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { errorText } from "../../components/email/MessageDrawer.jsx";
import {
  AdminOnly, MailStatusBadge, PageHead, RecipientPicker, SmtpBanner, fmtWhen,
} from "../../components/email/EmailKit.jsx";
import { isDue, runsTodayWords, startsNow } from "../../components/email/schedule.js";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";
import { num } from "../../lib/format.js";

// Notification Rules — the mails the engine sends by itself, on a schedule. The
// catalogue is fixed: the server decides which rules exist and what each one
// carries. An administrator sets when a rule runs, whether it is on and — for
// the rules with a free audience — who gets it. Every figure on a card (who is
// mailed, what goes out, last and next run) is the server's reading of the
// SAVED rule, so an edit shows there only after Save.

// Index = the server's day number: 0 is Monday.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RULE_ICON = {
  reorder: ShoppingCart, excess_list: PackagePlus, stock_report: Boxes, tracker_digest: ListChecks, window_time: Clock3,
  short_rejection: PackageX,
};

// Where a fixed audience is kept. Those rules cannot be re-addressed here.
// `note`: what the rule does with that audience when it is not one mail for all.
const FIXED_AUDIENCE = {
  departments_flagged: {
    before: "Departments ticked “Reorder mail” in", to: "/departments", link: "Department Emails",
    note: "each department gets its own parts",
  },
  report_recipients: { before: "The people in the", to: "/report-recipients", link: "Report Recipients master" },
};

// Why a run sent nothing, in plain words. A reason not listed is shown as the
// server named it.
const RUN_REASONS = {
  smtp_not_configured: "the mail server is not configured",
  no_recipient: "there is no one to mail",
  no_recipient_email: "there is no one to mail",
  nothing_to_reorder: "no part needs reordering",
  no_department_flagged: "no department is ticked “Reorder mail”",
  already_sent_today: "today's mail has already gone out",
  mail_engine_disabled: "the mail engine is off",
};
const reasonText = (reason) =>
  RUN_REASONS[reason] || (reason ? String(reason).replace(/_/g, " ") : "there was nothing to send");

const HEAD = "text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";
const LABEL = "block text-xs font-medium text-slate-600 dark:text-slate-300";
const LINK = "font-semibold underline underline-offset-2 hover:text-toyotared";

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

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// Extra addresses compared as a set of "ROLE:address" — the order they were added in does not matter.
const addressKey = (list) =>
  list.map((x) => `${String(x.role || "TO").toUpperCase()}:${String(x.email || "").trim().toLowerCase()}`).sort().join("|");
const countPeople = (r) => (r?.to?.length || 0) + (r?.cc?.length || 0) + (r?.bcc?.length || 0);

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

function Fact({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-slate-700 dark:text-slate-200">{children}</dd>
    </div>
  );
}

// The addresses a mail goes to, one line per role. Takes anything shaped
// { to, cc, bcc } — a rule's resolved recipients or a preview.
function RecipientChips({ recipients }) {
  const rows = [["To", recipients?.to], ["Cc", recipients?.cc], ["Bcc", recipients?.bcc]]
    .filter(([, list]) => list?.length);
  if (!rows.length) {
    return (
      <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
        <TriangleAlert size={14} className="shrink-0" aria-hidden="true" /> No one to mail
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {rows.map(([role, list]) => (
        <div key={role} className="flex items-start gap-2">
          <span className="w-7 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{role}</span>
          <div className="flex min-w-0 flex-wrap gap-1">
            {list.map((address) => (
              <span key={address} className="max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-navy-800 dark:text-slate-200">
                {address}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// The mail as it would go out right now. Mounted only while open, so every
// opening asks the server again — a preview is built from live data.
function PreviewDialog({ rule, unsaved, onClose }) {
  const q = useQuery({
    queryKey: [...mailKeys.rules, rule.key, "preview"],
    queryFn: () => mailEngineService.previewRule(rule.key).then((r) => r.data.data),
    staleTime: 0,
    gcTime: 0,
    // The dialog has its own Retry; a silent second try would only toast twice.
    retry: false,
  });
  const d = q.data;

  return (
    <Modal open onClose={onClose} title={`Preview — ${rule.title}`} size="xl"
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {q.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <div className="skeleton h-5 w-2/3" />
          <div className="skeleton h-5 w-1/2" />
          <div className="skeleton h-64 w-full" />
        </div>
      ) : !d ? (
        <div className="py-8 text-center">
          <TriangleAlert size={24} className="mx-auto mb-2 text-rose-500" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t build the preview.</p>
          {q.error?.response?.data?.message && (
            <p className="mt-1 text-xs text-slate-400">{q.error.response.data.message}</p>
          )}
          <button type="button" onClick={() => q.refetch()} disabled={q.isFetching}
            className="mt-3 text-sm font-medium text-toyotared hover:underline disabled:opacity-50">
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {unsaved && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              This shows the saved rule — the unsaved changes on the card are not in it.
            </p>
          )}
          <dl className="space-y-3">
            <div>
              <dt className={HEAD}>Subject</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-slate-800 dark:text-white">{d.subject || "—"}</dd>
            </div>
            <div>
              <dt className={HEAD}>Goes to</dt>
              <dd className="mt-1"><RecipientChips recipients={d} /></dd>
            </div>
          </dl>
          {d.html ? (
            // sandbox="" runs no script and gives the mail no access to this
            // app; the HTML is shown, never trusted.
            <iframe title={`Mail preview — ${rule.title}`} srcDoc={d.html} sandbox=""
              className="h-[55vh] w-full rounded-lg border border-slate-200 dark:border-navy-700"
              // A mail is written for a white page. Without this the frame is
              // see-through and the dark theme would put dark text on navy.
              style={{ background: "#ffffff" }} />
          ) : (
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-200">
              {d.text || "This mail has no text."}
            </pre>
          )}
          <p className="text-xs text-slate-400">
            Built from live data{d.count != null ? ` — ${num(d.count)} ${rule.content?.label || "rows"}` : ""}. A preview
            only: nothing is sent or stored.
          </p>
        </div>
      )}
    </Modal>
  );
}

function RuleCard({ rule, depts, engine }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  // Only the settings being edited. Everything else reads from the saved rule,
  // so a background refetch never undoes an edit in progress.
  const [draft, setDraft] = useState({});
  const [previewing, setPreviewing] = useState(false);
  const patch = (next) => setDraft((d) => ({ ...d, ...next }));

  const custom = rule.audience === "custom";
  const fixed = FIXED_AUDIENCE[rule.audience];
  const saved = {
    enabled: Boolean(rule.enabled),
    time: toTime(rule.hour, rule.minute),
    days: rule.days || [],
    departmentIds: rule.department_ids || [],
    emails: rule.emails || [],
  };
  const value = { ...saved, ...draft };
  const time = fromTime(value.time);

  // Only what differs from the saved rule is sent.
  const changes = {};
  if (value.enabled !== saved.enabled) changes.enabled = value.enabled;
  if (time && time.hour !== rule.hour) changes.hour = time.hour;
  if (time && time.minute !== rule.minute) changes.minute = time.minute;
  if (!sameSet(value.days, saved.days)) changes.days = [...value.days].sort((a, b) => a - b);
  // Never for a fixed-audience rule: the server rejects these two fields there.
  if (custom && !sameSet(value.departmentIds, saved.departmentIds)) changes.department_ids = value.departmentIds;
  if (custom && addressKey(value.emails) !== addressKey(saved.emails)) {
    changes.emails = value.emails.map(({ email, role }) => ({ email, role: role || "TO" }));
  }
  const dirty = Object.keys(changes).length > 0;
  // An emptied time box is an edit too, though there is nothing valid to send yet.
  const edited = dirty || value.time !== saved.time;
  // No day at all is only a mistake on a rule that is on — it must stay possible
  // to switch such a rule off without first picking one.
  const problem = !time ? "Enter the time this rule runs at."
    : value.enabled && value.days.length === 0 ? "Pick at least one day — switched on with no day, the rule never runs."
    : null;

  // "No one to mail": the server's resolved list answers it — unless the
  // audience was just edited, when that list is out of date and the card's own
  // ticks decide (is there anyone with an address at all?).
  const audienceEdited = "department_ids" in changes || "emails" in changes;
  const departments = Array.isArray(depts.data) ? depts.data : null;
  const hasPeople = (id) =>
    (departments || []).find((d) => d.id === id)?.recipients?.some((p) => (p.email || "").trim());
  const people = countPeople(rule.recipients);
  const nobody = audienceEdited
    ? value.emails.length === 0 && !value.departmentIds.some(hasPeople)
    : people === 0;

  const save = useMutation({
    mutationFn: (payload) => mailEngineService.saveRule(rule.key, payload).then((r) => r.data.data),
    onSuccess: (next) => {
      setDraft({});
      // Show the saved rule at once; the refetch below confirms it.
      if (next?.key) {
        qc.setQueryData(mailKeys.rules, (old) => (Array.isArray(old) ? old.map((r) => (r.key === next.key ? next : r)) : old));
      }
      qc.invalidateQueries({ queryKey: mailKeys.rules });
      qc.invalidateQueries({ queryKey: mailKeys.status });   // rules on / next run, shown on Control Center
      toast.success(`${rule.title} saved`);
    },
    // A failure is already toasted by the api layer; the edits stay on the card.
  });

  const run = useMutation({
    mutationFn: () => mailEngineService.runRule(rule.key).then((r) => r.data.data),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: mailKeys.rules });
      qc.invalidateQueries({ queryKey: mailKeys.status });
      qc.invalidateQueries({ queryKey: ["mail", "messages"] });   // every page of the queue and the log
      const sentCount = res?.messages?.length || 0;
      if (res?.status === "sent") {
        toast.success(`${rule.title}: sent`);
      } else if (res?.status === "queued") {
        toast.success(`${rule.title}: ${sentCount ? `${num(sentCount)} mail${sentCount === 1 ? "" : "s"} ` : ""}queued for sending`);
      } else if (res?.status === "skipped") {
        toast(`${rule.title}: nothing sent — ${reasonText(res.reason)}`);
      } else {
        toast(`${rule.title}: ${res?.status || "the server gave no result"}`);
      }
    },
  });
  const busy = save.isPending || run.isPending;

  const onSave = async () => {
    if (nobody) {
      // Switching a rule on while it has no one to mail is almost always a slip.
      if (changes.enabled && !(await confirm({
        title: "Switch on with no one to mail?",
        message: `"${rule.title}" has no one to mail right now, so each run would send nothing. Switch it on anyway?`,
        confirmText: "Switch on", danger: false,
      }))) return;
    } else if (!engine?.forced_off && startsNow(
      { enabled: saved.enabled, hour: rule.hour, minute: rule.minute, days: saved.days },
      { enabled: value.enabled, ...time, days: value.days },
    )) {
      // Switched on, or moved, past today's time the rule does not wait for
      // tomorrow: the engine runs it at its next check. Say so before saving —
      // not on a server with mail held off, where no run sends anything.
      const who = audienceEdited ? "the people chosen on this card"
        : `${num(people)} ${people === 1 ? "address" : "addresses"}`;
      if (!(await confirm({
        title: `"${rule.title}" runs today`,
        message: `${runsTodayWords(rule, toTime(time.hour, time.minute), who, engine)} Save?`,
        confirmText: "Save", danger: false,
      }))) return;
    }
    save.mutate(changes);
  };

  const onRun = async () => {
    const message = [
      `Run "${rule.title}" now, whatever its schedule?`,
      // The count is every department's people together; the note says they do not all get one mail.
      people
        ? `It mails ${num(people)} ${people === 1 ? "address" : "addresses"}${fixed?.note ? ` — ${fixed.note}` : ""}.`
        : "It has no one to mail right now, so nothing would go out.",
      edited ? "The unsaved changes on this card are not used." : "",
    ].filter(Boolean).join(" ");
    if (!(await confirm({ title: "Run now", message, confirmText: "Run now", danger: false }))) return;
    run.mutate();
  };

  const toggleDay = (day) =>
    patch({ days: value.days.includes(day) ? value.days.filter((d) => d !== day) : [...value.days, day] });

  return (
    <section className="card" aria-label={rule.title}>
      <CardHead icon={RULE_ICON[rule.mail_type] || Mail} tone={rule.enabled ? "green" : "navy"}
        title={rule.title} hint={rule.description}
        action={(
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            {value.enabled ? "On" : "Off"}
            <Toggle on={value.enabled} disabled={busy} label={`${rule.title} — switch on or off`}
              onClick={() => patch({ enabled: !value.enabled })} />
          </span>
        )} />

      {(rule.is_default || edited) && (
        <div className="-mt-1 mb-3 flex flex-wrap gap-1.5">
          {rule.is_default && (
            <span className="badge badge-neutral" title="Nothing has been saved for this rule yet">Default settings</span>
          )}
          {edited && <span className="badge badge-warning">Unsaved changes</span>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <p className={HEAD}>Schedule</p>
            <div className="mt-2 flex flex-wrap items-start gap-4">
              <label className={LABEL}>Time
                <input type="time" className="input-field mt-1 w-32 tabular" value={value.time} disabled={busy}
                  onChange={(e) => patch({ time: e.target.value })} />
              </label>
              <div>
                <p className={LABEL}>Days</p>
                <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={`Days ${rule.title} runs on`}>
                  {DAYS.map((name, day) => {
                    const on = value.days.includes(day);
                    return (
                      <button key={name} type="button" aria-pressed={on} disabled={busy} onClick={() => toggleDay(day)}
                        className={`rounded-full border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ${on
                          ? "border-toyotared bg-toyotared text-white"
                          : "border-slate-200 text-slate-600 hover:border-toyotared dark:border-navy-700 dark:text-slate-300"}`}>
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <dl className="space-y-2 border-t border-slate-100 pt-3 text-sm dark:border-navy-800">
            <Fact label="What goes out now">
              {/* null = the server could not count it; never shown as 0. */}
              {rule.content?.count == null
                ? <span className="font-normal text-slate-400">Not known right now</span>
                : <span className="tabular">{num(rule.content.count)} {rule.content.label}</span>}
            </Fact>
            <Fact label="Next run">
              {/* Today's time counts as the next run until that run has happened;
                  once it has passed, the rule is due, not scheduled. */}
              {!rule.enabled ? <span className="font-normal text-slate-400">Off — not scheduled</span>
                : !isDue(rule.next_run_at) ? <span className="tabular">{fmtWhen(rule.next_run_at)}</span>
                : engine?.forced_off ? "Due now — but mail is held off on this server"
                : engine?.enabled === false ? "Due now — waits for the engine to be switched on"
                : "Due now — runs at the next check"}
            </Fact>
            <Fact label="Last run">
              {rule.last_run ? (
                <>
                  <span className="inline-flex flex-wrap items-center justify-end gap-2">
                    <MailStatusBadge status={rule.last_run.status} />
                    <span className="tabular">{fmtWhen(rule.last_run.at)}</span>
                  </span>
                  {rule.last_run.detail && (
                    // The subject of the mail — or, for one that has not left, its error, worded as in the queue.
                    <span className="mt-0.5 block break-words text-xs font-normal text-slate-500 dark:text-slate-400">
                      {errorText(rule.last_run.detail)}
                    </span>
                  )}
                </>
              ) : <span className="font-normal text-slate-400">Not run yet</span>}
            </Fact>
          </dl>
        </div>

        <div className="space-y-4">
          <div>
            <p className={HEAD}>Audience</p>
            <div className="mt-2">
              {!custom ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {fixed ? (
                    <>
                      {fixed.before} <Link to={fixed.to} className={LINK}>{fixed.link}</Link>
                      {fixed.note ? ` — ${fixed.note}` : ""}. This audience is changed there, not on this screen.
                    </>
                  ) : "This rule's audience is fixed and cannot be changed here."}
                </p>
              ) : depts.isPending ? (
                <div className="skeleton h-24 w-full" />
              ) : !departments ? (
                <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
                  Couldn&apos;t load the departments, so the audience cannot be changed right now.{" "}
                  <button type="button" onClick={() => depts.refetch()} className="font-semibold underline underline-offset-2">Retry</button>
                </p>
              ) : (
                <RecipientPicker departments={departments} departmentIds={value.departmentIds} emails={value.emails}
                  disabled={busy} onChange={({ departmentIds, emails }) => patch({ departmentIds, emails })} />
              )}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-3 dark:border-navy-800">
            <p className={HEAD}>Goes to{audienceEdited ? " — as saved" : ""}</p>
            <div className="mt-2"><RecipientChips recipients={rule.recipients} /></div>
            {audienceEdited && <p className="mt-1.5 text-xs text-slate-400">This list updates when you save.</p>}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 dark:border-navy-800">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => setPreviewing(true)}>
            <Eye size={15} aria-hidden="true" /> Preview
          </button>
          <button type="button" className="btn-secondary disabled:cursor-not-allowed disabled:opacity-40" onClick={onRun}
            // While the engine is off the server runs nothing, so the button does not offer it.
            disabled={busy || engine?.enabled === false}
            title={engine?.forced_off ? "Mail is held off on this server"
              : engine?.enabled === false ? "The mail engine is switched off — switch it on in the Control Center"
              : undefined}>
            <Play size={15} aria-hidden="true" /> {run.isPending ? "Running…" : "Run now"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {problem && <span className="text-xs font-semibold text-rose-600 dark:text-rose-400" role="alert">{problem}</span>}
          {edited && (
            <button type="button" className="btn-secondary" onClick={() => setDraft({})} disabled={busy}>Undo changes</button>
          )}
          <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-40" onClick={onSave}
            disabled={!dirty || Boolean(problem) || busy}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {previewing && <PreviewDialog rule={rule} unsaved={edited} onClose={() => setPreviewing(false)} />}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="card space-y-3">
          <div className="skeleton h-8 w-64" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-24 w-full" />
        </div>
      ))}
    </div>
  );
}

function RulesScreen() {
  const rules = useQuery({
    queryKey: mailKeys.rules,
    queryFn: () => mailEngineService.rules().then((r) => r.data.data),
  });
  // The Department Emails master, for the audience picker of the free-audience rules.
  const depts = useQuery({
    queryKey: mailKeys.recipients,
    queryFn: () => mailEngineService.recipients().then((r) => r.data.data),
  });
  const status = useQuery({
    queryKey: mailKeys.status,
    queryFn: () => mailEngineService.status().then((r) => r.data.data),
  });
  const list = Array.isArray(rules.data) ? rules.data : null;
  const engine = status.data?.engine;

  return (
    <div className="space-y-5">
      <PageHead icon={BellRing} title="Notification Rules"
        hint="The mails the engine sends by itself: when each one runs, who gets it and what it would carry right now.">
        <button type="button" className="btn-secondary" onClick={() => rules.refetch()} disabled={rules.isFetching}>
          <RefreshCw size={14} className={rules.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
      </PageHead>

      <SmtpBanner smtp={status.data?.smtp} />
      {/* The master switch stops everything. Without this line a rule would read
          "On" with a next run that is not going to happen. A server started
          with mail held off has no switch to send the admin to. */}
      {engine?.enabled === false && (
        <div role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <TriangleAlert size={16} className="shrink-0" aria-hidden="true" />
          {engine.forced_off ? (
            <span className="font-medium">Mail is held off on this server — no rule sends anything from it.</span>
          ) : (
            <>
              <span className="font-medium">The notification engine is switched off — no rule runs until it is switched on again.</span>
              <Link to="/email/control-center" className={LINK}>Open Control Center</Link>
            </>
          )}
        </div>
      )}

      {rules.isPending ? (
        <Skeleton />
      ) : !list ? (
        <div className="card">
          <ErrorState title="Could not load the rules"
            message={rules.error?.response?.data?.message || "The server did not answer, so no rule is shown."}
            onRetry={() => rules.refetch()} />
        </div>
      ) : (
        <>
          {rules.isError && (
            // A failed refresh keeps the last good reading, labelled as such.
            <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
              Couldn&apos;t refresh — the cards show what was loaded earlier.
              <button type="button" onClick={() => rules.refetch()} className="font-semibold text-toyotared hover:underline">Retry</button>
            </p>
          )}
          {list.length === 0 ? (
            <div className="card py-10 text-center text-sm text-slate-500 dark:text-slate-400">The server lists no notification rule.</div>
          ) : (
            list.map((rule) => <RuleCard key={rule.key} rule={rule} depts={depts} engine={engine} />)
          )}
        </>
      )}
    </div>
  );
}

export default function NotificationRules() {
  return (
    <AdminOnly>
      <RulesScreen />
    </AdminOnly>
  );
}
