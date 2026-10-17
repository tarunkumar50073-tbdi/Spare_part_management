import React, { useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  AlarmClock, ArrowRight, BellRing, CalendarClock, ChartColumn, ChevronRight, FileText, History, Inbox,
  LayoutDashboard, ListChecks, MailCheck, Power, RefreshCw, ScrollText, Send, ServerCog, Settings2,
  TriangleAlert, Workflow, Zap,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { AdminOnly, PageHead, SmtpBanner, fmtWhen, mailTypeLabel } from "../../components/email/EmailKit.jsx";
import { isDue } from "../../components/email/schedule.js";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";
import { num, parseServerTime } from "../../lib/format.js";

// Control Center: is the mail engine healthy, and what did it do? One reading
// of /mail-engine/status, re-read every minute. A figure the reading did not
// carry shows "—", never 0 — "0 failed" has to mean the server said zero.

const REFRESH_MS = 60_000;
// One failed refresh has already raised a toast (the api layer does that), and
// polling on would repeat it every minute — so the timer stops until a refresh
// works again; the "Couldn't refresh … Retry" strip restarts it.
const pollUnlessFailed = (query) => (query.state.status === "error" ? false : REFRESH_MS);

const every = (seconds) => {
  if (!seconds) return "—";
  if (seconds < 120) return `${num(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
};

// The status days are plant-local calendar dates: parsed as local midnight so
// a bar can never sit under the day before.
const dayLabel = (iso, year = false) => {
  const d = iso ? new Date(`${iso}T00:00:00`) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", ...(year ? { year: "numeric" } : {}) })
    : "—";
};

const sum = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);

// ------------------------------------------------------------------ chips

const CHIP_TONES = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  bad: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300",
  off: "border-slate-200 bg-slate-50 text-slate-600 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300",
};

function StateChip({ tone = "off", label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${CHIP_TONES[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

// State -> [tone, label]. The label says what the state means for the admin.
function engineChip(e) {
  if (e.enabled == null) return ["off", "Unknown"];
  if (e.forced_off) return ["off", "Off on this server"];
  if (!e.enabled) return ["off", "Off — nothing is sent"];
  if (!e.worker_running) return ["bad", "On · worker not running"];
  if (e.consecutive_failures > 0) return ["warn", "On · last check failed"];
  return ["ok", "On · worker running"];
}

function queueChip(q) {
  if (q.queued == null && q.failed == null) return ["off", "Unknown"];
  if (q.failed > 0) return ["bad", `${num(q.failed)} failed`];
  const waiting = (q.queued || 0) + (q.sending || 0);
  return waiting > 0 ? ["warn", `${num(waiting)} waiting`] : ["ok", "Empty"];
}

function todayChip(t) {
  if (t.sent == null && t.failed == null) return ["off", "Unknown"];
  if (t.failed > 0) return ["bad", `${num(t.failed)} failed today`];
  return t.sent > 0 ? ["ok", `${num(t.sent)} sent today`] : ["off", "Nothing sent today"];
}

// ------------------------------------------------------------ status cards

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

function StatusCard({ icon, tone, title, action, chip, children, rows, foot }) {
  return (
    <div className="card flex flex-col">
      <CardHead icon={icon} tone={tone} title={title} action={action} />
      <div className="mb-3"><StateChip tone={chip[0]} label={chip[1]} /></div>
      {children}
      <dl className="flex-1 space-y-1.5 text-xs">
        {rows.filter(Boolean).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-slate-400">{k}</dt>
            <dd className="min-w-0 break-words text-right font-medium text-slate-700 dark:text-slate-200 tabular">{v}</dd>
          </div>
        ))}
      </dl>
      {foot && (
        <div className="mt-3 border-t border-slate-100 pt-2 text-[11px] leading-snug text-slate-400 dark:border-navy-800">
          {foot}
        </div>
      )}
    </div>
  );
}

// Three figures side by side. A count is coloured only when it is above zero —
// a red "0 failed" would read as a problem that is not there.
function Figures({ items }) {
  return (
    <div className="mb-3 grid grid-cols-3 gap-2">
      {items.map(([label, value, tone]) => (
        <div key={label} className="rounded-lg border border-slate-100 px-2.5 py-2 dark:border-navy-800">
          <p className="text-[11px] text-slate-400">{label}</p>
          <p className={`text-lg font-bold tabular ${value > 0 ? tone : "text-slate-700 dark:text-slate-200"}`}>{num(value)}</p>
        </div>
      ))}
    </div>
  );
}

function CardLink({ to, children }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-toyotared hover:underline">
      {children} <ArrowRight size={13} aria-hidden="true" />
    </Link>
  );
}

function StatusCards({ d, onToggleEngine, switching }) {
  const smtp = d.smtp || {};
  const engine = d.engine || {};
  const queue = d.queue || {};
  const today = d.today || {};
  const from = [smtp.from_display, smtp.from_email].filter(Boolean).join(" · ");
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatusCard
        icon={ServerCog} tone={smtp.configured ? "green" : "amber"} title="Mail server"
        chip={!d.smtp ? ["off", "Unknown"] : smtp.configured ? ["ok", "Configured"] : ["warn", "Not configured"]}
        rows={[
          ["Host", smtp.host ? `${smtp.host}${smtp.port ? `:${smtp.port}` : ""}` : "Not set"],
          ["From", from || "Not set"],
          ["Password", smtp.password_in_env == null ? "—" : smtp.password_in_env ? "Set in the server .env" : "None in the server .env"],
        ]}
        foot={<CardLink to="/email/configuration">Open Email Configuration</CardLink>}
      />
      <StatusCard
        icon={Power} tone={engine.enabled ? "green" : "navy"} title="Engine" chip={engineChip(engine)}
        action={engine.enabled != null && !engine.forced_off && (
          <Toggle on={!!engine.enabled} onClick={onToggleEngine} disabled={switching}
            label={engine.enabled ? "Switch the mail engine off" : "Switch the mail engine on"} />
        )}
        rows={[
          ["Worker", engine.worker_running == null ? "—" : engine.worker_running ? "Running" : "Not running"],
          ["Last check", engine.last_tick_at ? fmtWhen(engine.last_tick_at) : "None since the server started"],
          ["Checks every", every(engine.poll_seconds)],
          engine.consecutive_failures > 0 ? ["Failed checks in a row", num(engine.consecutive_failures)] : null,
        ]}
        foot={(
          <>
            {engine.last_error && (
              <p className="mb-1.5 break-words font-mono text-rose-700 dark:text-rose-300">Last error: {engine.last_error}</p>
            )}
            {engine.forced_off
              ? "This server was started with mail held off (the TEST copy), so nothing is sent from it and it cannot be switched on here."
              : engine.enabled === false
              ? "While the engine is off nothing is sent or generated — queued mails, rules and reminders all wait."
              : "Each check runs the rules and reminders that are due, then sends what is queued."}
          </>
        )}
      />
      <StatusCard
        icon={Inbox} tone={queue.failed > 0 ? "red" : "blue"} title="Queue" chip={queueChip(queue)}
        rows={[
          ["Oldest waiting", queue.oldest_queued_at ? fmtWhen(queue.oldest_queued_at) : "Nothing waiting"],
        ]}
        foot={<CardLink to="/email/queue">Open Email Queue</CardLink>}
      >
        <Figures items={[
          ["Queued", queue.queued, "text-amber-600 dark:text-amber-400"],
          ["Sending", queue.sending, "text-blue-600 dark:text-blue-400"],
          ["Failed", queue.failed, "text-rose-600 dark:text-rose-400"],
        ]} />
      </StatusCard>
      <StatusCard
        icon={MailCheck} tone="violet" title="Today" chip={todayChip(today)}
        rows={[]}
        foot={<CardLink to="/email/logs">Open Email Logs</CardLink>}
      >
        <Figures items={[
          ["Sent", today.sent, "text-emerald-600 dark:text-emerald-400"],
          ["Failed", today.failed, "text-rose-600 dark:text-rose-400"],
          ["Skipped", today.skipped, "text-slate-700 dark:text-slate-200"],
        ]} />
      </StatusCard>
    </div>
  );
}

// ------------------------------------------------------------- 7-day chart

// Sent / failed. The pair was checked for colour-blind separation on both card
// surfaces (light and dark); the legend and the tooltip name each bar, so the
// reading never rests on colour alone.
const SERIES = { sent: "#059669", failed: "#f43f5e" };

function DayTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-white/10 bg-navy-900 px-3 py-2 text-xs text-white shadow-xl">
      <p className="font-semibold">{dayLabel(p.date, true)}</p>
      <p className="mt-0.5">Sent <b>{num(p.sent)}</b> · Failed <b>{num(p.failed)}</b></p>
    </div>
  );
}

function WeekChart({ days }) {
  const data = (days || []).map((x) => ({ ...x, label: dayLabel(x.date) }));
  const sent = sum(data, "sent");
  const failed = sum(data, "failed");
  return (
    <div className="card">
      <CardHead icon={ChartColumn} tone="blue" title="Sent and failed · last 7 days" hint="Mails per plant day" />
      {data.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">The 7-day figures did not come with this reading.</p>
      ) : sent + failed === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No mail was sent or failed in the last 7 days.</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm" style={{ background: SERIES.sent }} aria-hidden="true" />
              Sent · {num(sent)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm" style={{ background: SERIES.failed }} aria-hidden="true" />
              Failed · {num(failed)}
            </span>
          </div>
          <div className="h-[220px]" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} barCategoryGap="22%" barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.2)" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }}
                  axisLine={{ stroke: "rgba(148,163,184,0.45)" }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "#94a3b8" }} width={40} axisLine={false} tickLine={false} />
                <Tooltip content={<DayTip />} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
                <Bar dataKey="sent" name="Sent" fill={SERIES.sent} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                <Bar dataKey="failed" name="Failed" fill={SERIES.failed} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* The bars are a picture; a screen reader gets the same seven days as a table. */}
          <table className="sr-only">
            <caption>Mails per day over the last 7 days</caption>
            <thead>
              <tr><th scope="col">Day</th><th scope="col">Sent</th><th scope="col">Failed</th></tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.date}><th scope="row">{dayLabel(x.date, true)}</th><td>{num(x.sent)}</td><td>{num(x.failed)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ side panels

function ByType({ rows }) {
  const list = rows || [];
  return (
    <div className="card">
      <CardHead icon={ListChecks} tone="navy" title="By mail type · 30 days" />
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">No mail in the last 30 days.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-navy-800">
          {list.map((t) => (
            <li key={t.mail_type} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">{mailTypeLabel(t.mail_type)}</span>
              <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400 tabular">
                <b className="text-slate-800 dark:text-white">{num(t.sent)}</b> sent ·{" "}
                <b className={t.failed > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-800 dark:text-white"}>{num(t.failed)}</b> failed
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NextScheduled({ rules, engineOff, heldOff }) {
  const r = rules || {};
  const next = r.next;
  return (
    <div className="card">
      <CardHead icon={CalendarClock} tone="violet" title="Next scheduled"
        hint={r.total != null ? `${num(r.enabled)} of ${num(r.total)} rules switched on` : undefined}
        action={<CardLink to="/email/rules">Rules</CardLink>} />
      {next ? (
        <>
          <p className="text-sm font-semibold text-slate-800 dark:text-white">{next.title || next.key}</p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {/* A rule whose time today has passed stays "next" until it has run: it is due, not upcoming. */}
            {!isDue(next.at) ? `Due ${fmtWhen(next.at)}` : engineOff ? "Due now" : "Due now — runs at the next check"}
          </p>
          {engineOff && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              {heldOff
                ? "Mail is held off on this server, so this run sends nothing from here."
                : "The engine is off, so this run waits until it is switched back on."}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">No rule is switched on, so nothing is scheduled.</p>
      )}
    </div>
  );
}

function LatestActivity({ lastSent, lastFailure }) {
  return (
    <div className="card">
      <CardHead icon={History} tone="navy" title="Latest activity"
        action={<CardLink to="/email/logs">Email Logs</CardLink>} />
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last sent</dt>
          {lastSent ? (
            <dd>
              <p className="truncate font-medium text-slate-800 dark:text-white" title={lastSent.subject}>{lastSent.subject || "(no subject)"}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{fmtWhen(lastSent.sent_at)}</p>
            </dd>
          ) : (
            <dd className="text-slate-500 dark:text-slate-400">Nothing sent yet.</dd>
          )}
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last failure</dt>
          {lastFailure ? (
            <dd>
              <p className="truncate font-medium text-slate-800 dark:text-white" title={lastFailure.subject}>{lastFailure.subject || "(no subject)"}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{fmtWhen(lastFailure.at)}</p>
              {lastFailure.error && (
                <p className="mt-0.5 break-words font-mono text-[11px] text-rose-700 dark:text-rose-300">{lastFailure.error}</p>
              )}
            </dd>
          ) : (
            <dd className="text-slate-500 dark:text-slate-400">No failure recorded.</dd>
          )}
        </div>
      </dl>
    </div>
  );
}

// --------------------------------------------------------- engine settings

// Saving any engine setting answers with the saved settings: show them at
// once, then re-read the whole status.
function useSaveSettings(onSaved) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => mailEngineService.saveSettings(payload).then((r) => r.data.data),
    onSuccess: (saved, payload) => {
      if (saved && typeof saved === "object") {
        qc.setQueryData(mailKeys.status, (s) => (s ? { ...s, engine: { ...s.engine, ...saved } } : s));
      }
      qc.invalidateQueries({ queryKey: mailKeys.status });
      onSaved(payload);
    },
  });
}

// The server's own limits (contract: PUT /mail-engine/settings), checked here
// first so the admin gets the reason beside the field instead of a bare 400.
const SETTING_FIELDS = [
  { key: "poll_seconds", label: "Check the queue every", unit: "seconds", min: 15, max: 3600 },
  { key: "max_attempts", label: "Delivery attempts per mail", unit: "tries", min: 1, max: 10 },
  { key: "retention_days", label: "Keep finished mail for", unit: "days", min: 7, max: 365 },
];

function EngineSettings({ engine }) {
  // null = showing what the server holds; an object = the admin is editing.
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  const save = useSaveSettings(() => {
    setDraft(null);
    toast.success("Engine settings saved");
  });
  const shown = (key) => (draft ? draft[key] : engine?.[key] ?? "");

  const edit = (key, value) => {
    setErr(null);
    setDraft({ ...Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, shown(f.key)])), [key]: value });
  };

  const submit = (e) => {
    e.preventDefault();
    if (!draft) return;
    const payload = {};
    for (const f of SETTING_FIELDS) {
      const n = Number(draft[f.key]);
      if (draft[f.key] === "" || !Number.isInteger(n) || n < f.min || n > f.max) {
        setErr(`"${f.label}" must be a whole number from ${f.min} to ${f.max} ${f.unit}.`);
        return;
      }
      payload[f.key] = n;
    }
    save.mutate(payload);
  };

  return (
    <form className="card" onSubmit={submit}>
      <CardHead icon={Settings2} tone="navy" title="Engine settings"
        hint="How often the worker checks, how many times it retries, how long mail is kept" />
      <div className="space-y-2.5">
        {SETTING_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-3 text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>{f.label} <span className="font-normal text-slate-400">({f.min}–{f.max} {f.unit})</span></span>
            <input type="number" min={f.min} max={f.max} step="1" className="input-field w-24 py-1.5 text-right tabular"
              value={shown(f.key)} onChange={(e) => edit(f.key, e.target.value)} />
          </label>
        ))}
      </div>
      {err && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-slate-400">
          Sent, skipped and cancelled mail older than the keep period is purged once a day; failed mail is kept.
        </p>
        <button type="submit" className="btn-primary shrink-0" disabled={!draft || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// -------------------------------------------------------------- quick links

const SCREENS = [
  { to: "/email/workflows", label: "Workflow Center", desc: "Every automated mail as one pipeline", icon: Workflow },
  { to: "/email/configuration", label: "Email Configuration", desc: "Mail server, sender and a test mail", icon: ServerCog },
  { to: "/email/templates", label: "Email Templates", desc: "Subject, intro, footer and signature", icon: FileText },
  { to: "/email/send", label: "Send Email Alert", desc: "Write and send a one-off alert", icon: Send },
  { to: "/email/queue", label: "Email Queue", desc: "Mails waiting, retrying or failed", icon: Inbox },
  { to: "/email/logs", label: "Email Logs", desc: "Every mail and every delivery attempt", icon: ScrollText },
  { to: "/email/rules", label: "Notification Rules", desc: "What is mailed, when and to whom", icon: BellRing },
  { to: "/email/reminders", label: "Reminder & Escalation", desc: "Chase Action Tracker lines near or past target", icon: AlarmClock },
];

function QuickLinks() {
  return (
    <div className="card">
      <CardHead icon={LayoutDashboard} tone="navy" title="Email & Notifications" hint="Open any screen of the module" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {SCREENS.map(({ to, label, desc, icon: Icon }) => (
          <Link key={to} to={to}
            className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3
              hover:border-toyotared/50 hover:shadow-sm dark:border-navy-800 dark:bg-navy-900">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600
              group-hover:bg-toyotared/10 group-hover:text-toyotared dark:bg-navy-800 dark:text-slate-300">
              <Icon size={18} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-800 dark:text-white">{label}</span>
              <span className="block truncate text-xs text-slate-400">{desc}</span>
            </span>
            <ChevronRight size={16} className="text-slate-300 group-hover:text-toyotared" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- page

function Skeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-3">
            <div className="skeleton h-8 w-40" />
            <div className="skeleton h-5 w-28" />
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-5/6" />
            <div className="skeleton h-3 w-2/3" />
          </div>
        ))}
      </div>
      <div className="card space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-6 w-full" />)}
      </div>
    </div>
  );
}

// What "Process queue now" did, in the server's own counts.
function processToast(res) {
  const r = res || {};
  if (!r.processed) {
    toast("Nothing was due — no mail was waiting to go.");
    return;
  }
  const text = `Processed ${num(r.processed)}: ${num(r.sent)} sent · ${num(r.failed)} failed · ${num(r.deferred)} put back to retry`;
  if (r.failed > 0) toast.error(text);
  else if (r.sent > 0) toast.success(text);
  else toast(text);
}

function ControlCenterBody() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const q = useQuery({
    queryKey: mailKeys.status,
    queryFn: () => mailEngineService.status().then((r) => r.data.data),
    refetchInterval: pollUnlessFailed,
  });
  const d = q.data;
  const engineOff = d?.engine?.enabled === false;

  const engineSwitch = useSaveSettings((payload) => {
    toast.success(payload.enabled
      ? "Mail engine switched on"
      : "Mail engine switched off — nothing is sent until it is back on");
  });

  const toggleEngine = async () => {
    const on = d?.engine?.enabled;
    if (on == null) return;
    // Switching ON only resumes what was already set up; switching OFF stops
    // every scheduled mail, so only that asks first.
    if (on && !(await confirm({
      title: "Switch the mail engine off",
      message: "While it is off nothing is sent or generated: queued mails wait, and scheduled rules and reminders do not run. Switch it off?",
      confirmText: "Switch off",
    }))) return;
    engineSwitch.mutate({ enabled: !on });
  };

  const process = useMutation({
    mutationFn: () => mailEngineService.processNow().then((r) => r.data.data),
    onSuccess: (res) => {
      processToast(res);
      // A drained queue changes this reading, the queue / log lists, any open
      // message and each rule's "last run".
      qc.invalidateQueries({ queryKey: mailKeys.status });
      qc.invalidateQueries({ queryKey: ["mail", "messages"] });
      qc.invalidateQueries({ queryKey: ["mail", "message"] });
      qc.invalidateQueries({ queryKey: mailKeys.rules });
    },
  });

  return (
    <div className="space-y-5">
      <PageHead icon={LayoutDashboard} title="Control Center"
        hint="Is the mail engine healthy, and what did it do? The mail server, the engine and its worker, the queue, and what went out.">
        {d?.generated_at && (
          <span className="text-[11px] text-slate-400">
            Checked {parseServerTime(d.generated_at)?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) ?? "—"}
            {q.isError ? "" : " · every minute"}
          </span>
        )}
        <button type="button" className="btn-secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw size={14} className={q.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
        {d && (
          <button type="button" className="btn-primary disabled:opacity-50" onClick={() => process.mutate()}
            disabled={process.isPending || engineOff}
            title={d?.engine?.forced_off ? "Mail is held off on this server"
              : engineOff ? "The mail engine is switched off — switch it on to send"
              : "Send every mail that is due, without waiting for the next check"}>
            <Zap size={14} aria-hidden="true" /> {process.isPending ? "Processing…" : "Process queue now"}
          </button>
        )}
      </PageHead>

      <SmtpBanner smtp={d?.smtp} />

      {q.isPending || (!d && q.isFetching) ? (
        // First load, or a Retry after a failed one — so Retry visibly does something.
        <Skeleton />
      ) : !d ? (
        <div className="card py-10 text-center">
          <TriangleAlert size={24} className="mx-auto mb-2 text-rose-500" aria-hidden="true" />
          <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t load the mail engine status.</p>
          {q.error?.response?.data?.message && (
            <p className="mt-1 text-xs text-slate-400">{q.error.response.data.message}</p>
          )}
          <button type="button" onClick={() => q.refetch()} className="mt-3 text-sm font-medium text-toyotared hover:underline">
            Retry
          </button>
        </div>
      ) : (
        <>
          {q.isError && (
            // A failed background refresh keeps the last good reading, labelled as such.
            <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
              Couldn&apos;t refresh — showing the reading from {fmtWhen(d.generated_at)}, and auto-refresh is paused.
              <button type="button" onClick={() => q.refetch()} className="font-medium text-toyotared hover:underline">Retry</button>
            </p>
          )}
          <StatusCards d={d} onToggleEngine={toggleEngine} switching={engineSwitch.isPending} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <div className="xl:col-span-2"><WeekChart days={d.last_7_days} /></div>
            <ByType rows={d.by_type_30d} />
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <NextScheduled rules={d.rules} engineOff={engineOff} heldOff={Boolean(d.engine?.forced_off)} />
            <LatestActivity lastSent={d.last_sent} lastFailure={d.last_failure} />
            <EngineSettings engine={d.engine} />
          </div>
        </>
      )}

      {/* Navigation does not depend on the status call: it stays even when that fails. */}
      <QuickLinks />
    </div>
  );
}

export default function ControlCenter() {
  return (
    <AdminOnly>
      <ControlCenterBody />
    </AdminOnly>
  );
}
