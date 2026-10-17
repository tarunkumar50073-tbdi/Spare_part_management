import React, { useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock, ArrowRight, ChevronRight, Clock3, Eye, FileText, History, ListChecks, Pencil, Play, RefreshCw,
  TriangleAlert, Users, Workflow,
} from "lucide-react";
import Modal from "../../components/Modal.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { errorText } from "../../components/email/MessageDrawer.jsx";
import {
  AdminOnly, MailStatusBadge, PageHead, SmtpBanner, fmtWhen, mailTypeLabel,
} from "../../components/email/EmailKit.jsx";
import { isDue, runsTodayWords, scheduleStart } from "../../components/email/schedule.js";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";
import { num } from "../../lib/format.js";

// Workflow Center: every automated mail as one pipeline —
// TRIGGER (when) → CONTENT (what it would carry right now) → RECIPIENTS (who)
// → LAST RUN (how it went). Read off /mail-engine/rules and /reminders; the
// schedule and the audience are edited on their own screens. A rule can be
// switched on and off here — on only after a confirm that says when it first runs.

const AMBER = "text-amber-600 dark:text-amber-400";
const MUTED = "text-slate-500 dark:text-slate-400";

// ------------------------------------------------------- schedule in words

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];   // the API counts 0 = Monday

const hhmm = (hour, minute) =>
  (hour == null ? null : `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`);

// [0,1,2,3,4,5] -> "Mon–Sat" · [0,2,4] -> "Mon, Wed, Fri" · all seven -> "day".
function daysInWords(days) {
  const list = [...new Set((days || []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (!list.length) return null;
  if (list.length === 7) return "day";
  const runs = [];
  for (const d of list) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  return runs
    .map(([a, b]) => (a === b ? DAY_NAMES[a] : b === a + 1 ? `${DAY_NAMES[a]}, ${DAY_NAMES[b]}` : `${DAY_NAMES[a]}–${DAY_NAMES[b]}`))
    .join(", ");
}

// "every Mon–Sat at 08:00"; null when no day is chosen (it would never run).
function scheduleWords(days, hour, minute) {
  const d = daysInWords(days);
  if (!d) return null;
  const t = hhmm(hour, minute);
  return `every ${d}${t ? ` at ${t}` : ""}`;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------ pipeline UI

// A small on/off switch (the same control Settings uses for store visibility).
function Toggle({ on, onClick, disabled, label }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} role="switch" aria-checked={on} aria-label={label}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50
        ${on ? "bg-emerald-500" : "bg-slate-300 dark:bg-navy-700"}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

// One step of a pipeline: what it is, its headline, and the small print.
function Stage({ icon: Icon, label, tone = "text-slate-800 dark:text-white", main, children }) {
  return (
    <div className="h-full min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-navy-800 dark:bg-navy-800">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <Icon size={13} aria-hidden="true" /> {label}
      </p>
      <div className={`mt-1 break-words text-sm font-semibold ${tone}`}>{main}</div>
      <div className={`mt-0.5 space-y-0.5 break-words text-[11px] leading-snug ${MUTED}`}>{children}</div>
    </div>
  );
}

// The steps left to right with an arrow between them; stacked (arrow pointing
// down) where four boxes do not fit side by side.
function Pipeline({ children }) {
  return (
    <ol className="flex flex-col gap-1.5 lg:flex-row lg:items-stretch">
      {React.Children.toArray(children).map((stage, i) => (
        <React.Fragment key={stage.key}>
          {i > 0 && (
            <li aria-hidden="true" className="flex shrink-0 items-center justify-center text-slate-300 dark:text-navy-700">
              <ChevronRight size={18} className="rotate-90 lg:rotate-0" />
            </li>
          )}
          <li className="min-w-0 lg:flex-1">{stage}</li>
        </React.Fragment>
      ))}
    </ol>
  );
}

function LoadError({ what, error, onRetry }) {
  return (
    <div className="card py-8 text-center">
      <TriangleAlert size={22} className="mx-auto mb-2 text-rose-500" aria-hidden="true" />
      <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t load {what}.</p>
      {error?.response?.data?.message && <p className="mt-1 text-xs text-slate-400">{error.response.data.message}</p>}
      <button type="button" onClick={onRetry} className="mt-3 text-sm font-medium text-toyotared hover:underline">Retry</button>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="card space-y-3" aria-busy="true">
      <div className="skeleton h-5 w-56" />
      <div className="skeleton h-3 w-80 max-w-full" />
      <div className="grid gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-20 w-full" />)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ preview

function AddressLine({ label, list }) {
  if (!list.length) return null;
  return (
    <div className="flex gap-3">
      <dt className="w-14 shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words text-slate-700 dark:text-slate-200">{list.join(", ")}</dd>
    </div>
  );
}

function PreviewDialog({ rule, onClose }) {
  const q = useQuery({
    queryKey: [...mailKeys.rules, "preview", rule.key],
    queryFn: () => mailEngineService.previewRule(rule.key).then((r) => r.data.data),
    // Rendered from live data every time it is opened — a kept copy would show old counts.
    staleTime: 0,
    gcTime: 0,
    // The dialog has its own Retry; a silent second try would only toast twice.
    retry: false,
  });
  const p = q.data;
  const to = p?.to || [];
  const cc = p?.cc || [];
  const bcc = p?.bcc || [];

  return (
    <Modal open onClose={onClose} title={`Preview — ${rule.title}`} size="xl"
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {q.isPending || (!p && q.isFetching) ? (
        <div className="space-y-3" aria-busy="true">
          <div className="skeleton h-5 w-2/3" />
          <div className="skeleton h-4 w-1/2" />
          <div className="skeleton h-64 w-full" />
        </div>
      ) : !p ? (
        <div className="py-6 text-center">
          <TriangleAlert size={22} className="mx-auto mb-2 text-rose-500" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t build the preview.</p>
          {q.error?.response?.data?.message && <p className="mt-1 text-xs text-slate-400">{q.error.response.data.message}</p>}
          <button type="button" onClick={() => q.refetch()} className="mt-3 text-sm font-medium text-toyotared hover:underline">Retry</button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className={`text-xs ${MUTED}`}>
            This is the mail as it would go out right now, built from live data. Nothing was sent or stored.
          </p>
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-3">
              <dt className="w-14 shrink-0 text-slate-400">Subject</dt>
              <dd className="min-w-0 break-words font-semibold text-slate-800 dark:text-white">{p.subject || "(no subject)"}</dd>
            </div>
            <AddressLine label="To" list={to} />
            <AddressLine label="Cc" list={cc} />
            <AddressLine label="Bcc" list={bcc} />
            {to.length + cc.length + bcc.length === 0 && (
              <div className="flex gap-3">
                <dt className="w-14 shrink-0 text-slate-400">To</dt>
                <dd className={`font-semibold ${AMBER}`}>No one to mail</dd>
              </div>
            )}
            {p.count != null && (
              <div className="flex gap-3">
                <dt className="w-14 shrink-0 text-slate-400">Carries</dt>
                <dd className="text-slate-700 dark:text-slate-200 tabular">
                  {num(p.count)}{rule.content?.label ? ` ${rule.content.label}` : ""}
                </dd>
              </div>
            )}
          </dl>
          {p.html ? (
            <>
              {/* sandbox="" is the point: mail markup is shown but can run no
                  script, submit no form and reach neither the app nor its
                  session. The frame stays white in both themes — the mail's
                  own inline styles assume a white page, as a mail client gives it. */}
              <iframe title="Mail body preview" sandbox="" srcDoc={p.html}
                className="h-[420px] w-full rounded-lg border border-slate-200 bg-white dark:border-navy-700" />
              {p.text && (
                <details className="text-xs">
                  <summary className={`cursor-pointer font-medium ${MUTED}`}>Plain-text version</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-slate-700 dark:bg-navy-800 dark:text-slate-200">{p.text}</pre>
                </details>
              )}
            </>
          ) : (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700 dark:bg-navy-800 dark:text-slate-200">
              {p.text || "This mail has no body."}
            </pre>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- rule card

const AUDIENCE_HINT = {
  custom: "Chosen departments and extra addresses",
  departments_flagged: "Departments ticked “Reorder mail” in Department Emails — each gets its own parts",
  report_recipients: "The Report Recipients list",
};

// What a switched-on mail is doing while the engine is off. A server started
// with mail held off cannot be switched on from the app, so nothing waits there.
const offWords = (engine) => (engine?.forced_off ? "Mail is held off on this server" : "Waiting — the mail engine is off");

// Why a run sent nothing, in plain words. A reason not listed here is shown as
// the server gave it.
const SKIP_REASON = {
  smtp_not_configured: "the mail server is not configured",
  no_recipient: "there is no one to mail",
  no_recipient_email: "there is no one to mail",
  nothing_to_reorder: "no part needs reordering right now",
  nothing_to_report: "there is nothing to report right now",
  no_department_flagged: "no department is ticked “Reorder mail”",
  attachment_too_large: "the attachment is over the size limit",
};
const reasonText = (reason) => SKIP_REASON[reason] || String(reason || "no reason was given").replace(/_/g, " ");

function runToast(rule, res) {
  const n = res?.messages?.length || 0;
  const mails = n ? ` — ${plural(n, "mail")}` : "";
  if (res?.status === "sent") toast.success(`${rule.title}: sent${mails}`);
  else if (res?.status === "queued") toast.success(`${rule.title}: queued${mails}, going out at the next check`);
  else if (res?.status === "skipped") toast(`${rule.title}: not sent — ${reasonText(res.reason)}`);
  else toast(`${rule.title}: ${res?.status || "finished"}`);
}

function RuleCard({ rule, engine, onPreview }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const engineOff = engine?.enabled === false;
  const to = rule.recipients?.to || [];
  const cc = rule.recipients?.cc || [];
  const bcc = rule.recipients?.bcc || [];
  const people = to.length + cc.length + bcc.length;
  const nobody = people === 0;
  const schedule = scheduleWords(rule.days, rule.hour, rule.minute);
  const content = rule.content || {};
  const lastRun = rule.last_run;

  const toggle = useMutation({
    mutationFn: (enabled) => mailEngineService.saveRule(rule.key, { enabled }).then((r) => r.data.data),
    onSuccess: (saved, enabled) => {
      // The PUT answers with the whole rule: show it at once, then re-read the
      // list (next run) and the status (how many rules are on, what is next).
      if (saved?.key) {
        qc.setQueryData(mailKeys.rules, (list) => (Array.isArray(list) ? list.map((r) => (r.key === saved.key ? saved : r)) : list));
      }
      qc.invalidateQueries({ queryKey: mailKeys.rules });
      qc.invalidateQueries({ queryKey: mailKeys.status });
      toast.success(`${rule.title} switched ${enabled ? "on" : "off"}`);
    },
  });

  // Switching a rule on is a sending action, so it asks first and says when the
  // first mail goes — at the engine's next check when today's time has passed.
  const switchOn = async () => {
    const start = scheduleStart(rule);
    const time = hhmm(rule.hour, rule.minute);
    const who = `${num(people)} ${people === 1 ? "address" : "addresses"}`;
    let message;
    if (nobody) {
      message = "No one is set to receive it, so each run would send nothing. Switch it on anyway?";
    } else if (!start.at) {
      message = "It has no day to run on, so it will not run until one is chosen under Edit. Switch it on anyway?";
    } else if (engine?.forced_off) {
      message = "Mail is held off on this server, so this rule sends nothing from here whatever its schedule says. Switch it on?";
    } else if (start.dueNow) {
      message = `${runsTodayWords(rule, time, who, engine)} Switch it on?`;
    } else {
      const day = start.at.toDateString() === new Date().toDateString()
        ? "today"
        : `on ${start.at.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}`;
      const waiting = engineOff ? " — once the mail engine is back on; it is off now" : "";
      message = `Its first run is ${day} at ${time}, to ${who}${waiting}. Switch it on?`;
    }
    if (!(await confirm({ title: `Switch on “${rule.title}”`, message, confirmText: "Switch on", danger: false }))) return;
    toggle.mutate(true);
  };

  const run = useMutation({
    mutationFn: () => mailEngineService.runRule(rule.key).then((r) => r.data.data),
    onSuccess: (res) => {
      runToast(rule, res);
      // A run adds to the queue / log and becomes this rule's "last run".
      qc.invalidateQueries({ queryKey: mailKeys.rules });
      qc.invalidateQueries({ queryKey: mailKeys.status });
      qc.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
  });

  const runNow = async () => {
    // The counts are every department's people together; say that they do not all get one mail.
    const own = rule.audience === "departments_flagged" ? " — each department gets its own parts" : "";
    const who = nobody
      ? "No one is set to receive it, so nothing would go out."
      : `It goes to ${num(to.length)} To, ${num(cc.length)} Cc and ${num(bcc.length)} Bcc${own}.`;
    if (!(await confirm({
      title: `Run “${rule.title}” now`,
      message: `This builds and sends the mail now, whatever its schedule says. ${who}`,
      confirmText: "Run now",
      danger: false,
    }))) return;
    run.mutate();
  };

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-slate-800 dark:text-white">{rule.title || rule.key}</h3>
          {rule.description && <p className={`mt-0.5 text-xs ${MUTED}`}>{rule.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-xs font-semibold ${rule.enabled ? "text-emerald-600 dark:text-emerald-400" : MUTED}`}>
            {rule.enabled ? "On" : "Off"}
          </span>
          <Toggle on={!!rule.enabled} disabled={toggle.isPending}
            onClick={() => (rule.enabled ? toggle.mutate(false) : switchOn())}
            label={`${rule.enabled ? "Switch off" : "Switch on"} ${rule.title || rule.key}`} />
        </div>
      </div>

      <Pipeline>
        <Stage icon={Clock3} label="Trigger"
          tone={!rule.enabled ? MUTED : schedule ? undefined : AMBER}
          main={!rule.enabled ? "Off" : schedule ? capital(schedule) : "No day chosen"}>
          {!rule.enabled && schedule && <p>Would run {schedule}</p>}
          {rule.enabled && !schedule && <p>It is switched on but has no day to run on.</p>}
          {rule.enabled && rule.next_run_at && (
            // Today's time counts as the next run until that run has happened —
            // once it has passed, the rule is due, not scheduled.
            <p>
              {!isDue(rule.next_run_at) ? `Next run ${fmtWhen(rule.next_run_at)}`
                : engineOff ? "Due now" : "Due now — runs at the next check"}
            </p>
          )}
          {rule.enabled && engineOff && <p className={AMBER}>{offWords(engine)}</p>}
          {rule.is_default && <p>Default settings — nothing saved yet</p>}
        </Stage>
        <Stage icon={FileText} label="Content"
          tone={content.count == null ? MUTED : undefined}
          main={content.count == null ? "Count not available" : `${num(content.count)} ${content.label || "items"}`}>
          {content.count == null && content.label && <p>{content.label}</p>}
          <p>{mailTypeLabel(rule.mail_type)} · what it would carry now</p>
        </Stage>
        <Stage icon={Users} label="Recipients"
          tone={nobody ? AMBER : undefined}
          main={nobody ? "No one to mail" : `${num(to.length)} To · ${num(cc.length)} Cc · ${num(bcc.length)} Bcc`}>
          {to.length > 0 && (
            <p title={to.join(", ")}>{to.slice(0, 2).join(", ")}{to.length > 2 ? ` +${to.length - 2} more` : ""}</p>
          )}
          {AUDIENCE_HINT[rule.audience] && <p>{AUDIENCE_HINT[rule.audience]}</p>}
        </Stage>
        <Stage icon={History} label="Last run"
          tone={lastRun ? undefined : MUTED}
          main={lastRun ? <MailStatusBadge status={lastRun.status} /> : "Never run"}>
          {lastRun && <p>{fmtWhen(lastRun.at)}</p>}
          {/* The subject of the mail — or, for one that has not left, its error, worded as in the queue. */}
          {lastRun?.detail && <p>{errorText(lastRun.detail)}</p>}
        </Stage>
      </Pipeline>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary !py-1.5 disabled:opacity-50" onClick={runNow}
          disabled={run.isPending || engineOff}
          title={engine?.forced_off ? "Mail is held off on this server"
            : engineOff ? "The mail engine is switched off — switch it on in the Control Center"
            : "Send this mail now, ignoring the schedule"}>
          <Play size={14} aria-hidden="true" /> {run.isPending ? "Running…" : "Run now"}
        </button>
        <button type="button" className="btn-secondary !py-1.5" onClick={() => onPreview(rule)}>
          <Eye size={14} aria-hidden="true" /> Preview
        </button>
        <Link to="/email/rules" className="btn-secondary !py-1.5">
          <Pencil size={14} aria-hidden="true" /> Edit
        </Link>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ reminder card

function ReminderCard({ reminders, engine }) {
  const r = reminders;
  const engineOff = engine?.enabled === false;
  const lines = r.lines || [];
  const remind = lines.filter((l) => l.next_action === "remind").length;
  const escalate = lines.filter((l) => l.next_action === "escalate").length;
  const watched = lines.filter((l) => l.status === "OPEN" && l.target_date).length;
  const time = hhmm(r.hour, r.minute);
  const escalateTo = (r.escalate_to || []).length;
  const days = (n) => `${num(n)} day${n === 1 ? "" : "s"}`;

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-white">
            <AlarmClock size={17} className="text-toyotared" aria-hidden="true" /> Reminder &amp; Escalation
          </h3>
          <p className={`mt-0.5 text-xs ${MUTED}`}>
            Chases the open Action Tracker lines: a reminder to the owners near the target date, an escalation once it is well past.
          </p>
        </div>
        <span className={`badge shrink-0 ${r.enabled ? "badge-success" : "badge-neutral"}`}>{r.enabled ? "On" : "Off"}</span>
      </div>

      <Pipeline>
        <Stage icon={Clock3} label="Trigger"
          tone={r.enabled ? undefined : MUTED}
          main={r.enabled ? `Every day${time ? ` at ${time}` : ""}` : "Off"}>
          {!r.enabled && time && <p>Would run every day at {time}</p>}
          {r.enabled && engineOff && <p className={AMBER}>{offWords(engine)}</p>}
          {r.repeat_every_days != null && <p>A line is chased at most once every {days(r.repeat_every_days)}</p>}
        </Stage>
        <Stage icon={ListChecks} label="Content"
          main={`${plural(watched, "open line")} with a target date`}>
          <p>Of {plural(lines.length, "Action Tracker line")} in all</p>
          {r.remind_before_days != null && <p>Reminder from {days(r.remind_before_days)} before the target date</p>}
          {r.escalate_after_days != null && <p>Escalation once {days(r.escalate_after_days)} overdue</p>}
        </Stage>
        <Stage icon={Users} label="Due right now"
          tone={remind + escalate === 0 ? MUTED : undefined}
          main={remind + escalate === 0 ? "Nothing due" : `${num(remind)} to remind · ${num(escalate)} to escalate`}>
          {!r.enabled && remind + escalate > 0 && <p>Not sent while reminders are off</p>}
          <p className={escalateTo ? undefined : AMBER}>
            {escalateTo
              ? `Escalations go to ${num(escalateTo)} ${escalateTo === 1 ? "address" : "addresses"}`
              : "No escalation address set"}
          </p>
        </Stage>
      </Pipeline>

      <div className="mt-3">
        <Link to="/email/reminders" className="btn-secondary !py-1.5">
          Open Reminder &amp; Escalation <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- page

function WorkflowCenterBody() {
  const [preview, setPreview] = useState(null);

  // The status is read only for the "not configured" strip and the engine switch.
  const status = useQuery({
    queryKey: mailKeys.status,
    queryFn: () => mailEngineService.status().then((r) => r.data.data),
  });
  const rules = useQuery({
    queryKey: mailKeys.rules,
    queryFn: () => mailEngineService.rules().then((r) => r.data.data),
  });
  const reminders = useQuery({
    queryKey: mailKeys.reminders,
    queryFn: () => mailEngineService.reminders().then((r) => r.data.data),
  });

  const engine = status.data?.engine;
  const engineOff = engine?.enabled === false;
  const list = Array.isArray(rules.data) ? rules.data : null;
  const fetching = rules.isFetching || reminders.isFetching;
  const refresh = () => { status.refetch(); rules.refetch(); reminders.refetch(); };

  return (
    <div className="space-y-5">
      <PageHead icon={Workflow} title="Workflow Center"
        hint="Every automated mail as one pipeline: when it fires, what it would carry right now, who receives it, and how the last run went.">
        {list && rules.dataUpdatedAt > 0 && (
          // The counts and recipients are a reading, not a live feed — say when it
          // was taken (dataUpdatedAt is this browser's clock, not a server stamp).
          <span className="text-[11px] text-slate-400">
            Read at {new Date(rules.dataUpdatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <button type="button" className="btn-secondary" onClick={refresh} disabled={fetching}>
          <RefreshCw size={14} className={fetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
      </PageHead>

      <SmtpBanner smtp={status.data?.smtp} />

      {engineOff && (
        <div role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <TriangleAlert size={16} className="shrink-0" aria-hidden="true" />
          {engine.forced_off ? (
            <span className="font-medium">Mail is held off on this server — no rule or reminder sends anything from it.</span>
          ) : (
            <>
              <span className="font-medium">The mail engine is switched off — no rule or reminder runs until it is back on.</span>
              <Link to="/email/control-center" className="font-semibold underline underline-offset-2 hover:text-toyotared">
                Open Control Center
              </Link>
            </>
          )}
        </div>
      )}

      {rules.isPending || (!list && rules.isFetching) ? (
        // First load, or a Retry after a failed one — so Retry visibly does something.
        <>
          <CardSkeleton />
          <CardSkeleton />
        </>
      ) : !list ? (
        <LoadError what="the mail rules" error={rules.error} onRetry={() => rules.refetch()} />
      ) : (
        <>
          {rules.isError && (
            // A failed re-read keeps the last loaded rules, labelled as such.
            <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
              Couldn&apos;t refresh the rules — showing what was loaded before.
              <button type="button" onClick={() => rules.refetch()} className="font-medium text-toyotared hover:underline">Retry</button>
            </p>
          )}
          {list.length === 0 && (
            <div className={`card py-8 text-center text-sm ${MUTED}`}>No automated mail is defined.</div>
          )}
          {list.map((rule) => (
            <RuleCard key={rule.key} rule={rule} engine={engine} onPreview={setPreview} />
          ))}
        </>
      )}

      {reminders.isPending || (!reminders.data && reminders.isFetching) ? (
        <CardSkeleton />
      ) : !reminders.data ? (
        <LoadError what="the reminder settings" error={reminders.error} onRetry={() => reminders.refetch()} />
      ) : (
        <ReminderCard reminders={reminders.data} engine={engine} />
      )}

      {preview && <PreviewDialog rule={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

export default function WorkflowCenter() {
  return (
    <AdminOnly>
      <WorkflowCenterBody />
    </AdminOnly>
  );
}
