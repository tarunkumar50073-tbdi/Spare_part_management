import React, { useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, Lock, Mail, ServerCog, TriangleAlert } from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import { AdminOnly, PageHead } from "../../components/email/EmailKit.jsx";
import { settingsService } from "../../services/settingsService.js";
import { mailKeys } from "../../services/mailEngineService.js";

// Email Configuration: the mail server (SMTP) every mail of the app leaves
// through. This form used to sit on the Settings page; it reads and writes the
// same /admin/smtp-config with the same payload. The password is NOT a field
// here and never will be: it stays in the server's .env, and the server only
// tells this screen whether one is present (password_in_env).

// Under "mail" like every key of this module (never "stock").
const smtpConfigKey = ["mail", "smtp-config"];

// What PUT /admin/smtp-config is sent — the non-secret fields, nothing else.
const payloadOf = (f) => ({
  host: (f.host || "").trim(),
  port: Number(f.port) || 25,
  from_email: (f.from_email || "").trim() || null,
  from_display: (f.from_display || "").trim() || null,
  use_tls: !!f.use_tls,
  use_ssl: !!f.use_ssl,
  requires_auth: !!f.requires_auth,
  username: (f.username || "").trim() || null,
});

// Why a test mail did not go, in plain words. A reason not listed here is
// shown as the server gave it.
const TEST_REASON = {
  smtp_not_configured: "the mail server is not configured",
  no_recipient: "the address is missing or not valid",
  send_failed: "the mail server could not be reached or refused the mail",
};
const reasonText = (reason) => TEST_REASON[reason] || String(reason || "unknown").replace(/_/g, " ");

const FIELD_LABEL = "text-xs font-semibold text-slate-600 dark:text-slate-300";
const CHECK_LABEL = "flex items-center gap-2 cursor-pointer select-none text-sm text-slate-600 dark:text-slate-300";

function ConfigurationForm({ saved }) {
  const qc = useQueryClient();
  // null = showing what the server holds; an object = the admin is editing.
  const [draft, setDraft] = useState(null);
  const [testTo, setTestTo] = useState("");
  // The last test, kept beside the button: { to, ok, reason, logged }.
  const [tested, setTested] = useState(null);

  const form = draft || saved;
  const setField = (k, val) => setDraft({ ...form, [k]: val });
  const dirty = draft != null && JSON.stringify(payloadOf(draft)) !== JSON.stringify(payloadOf(saved));

  // Logging in without TLS or SSL would put the username and password on the
  // network in clear text, so that combination cannot be saved.
  const insecureAuth = !!form.requires_auth && !form.use_tls && !form.use_ssl;
  const port = Number(form.port) || 25;

  const save = useMutation({
    mutationFn: (payload) => settingsService.setSmtpConfig(payload).then((r) => r.data.data),
    onSuccess: (res) => {
      if (res) qc.setQueryData(smtpConfigKey, res);
      setDraft(null);
      // The Control Center and every "not configured" strip read the effective
      // mail server off the engine status.
      qc.invalidateQueries({ queryKey: mailKeys.status });
      toast.success("Mail server settings saved");
    },
  });

  const test = useMutation({
    mutationFn: (to) => settingsService.sendSmtpTest(to).then((r) => r.data.data),
    onSuccess: (res, to) => {
      // The server answers 200 either way; `ok` says whether the mail went.
      if (res?.ok) toast.success(`Test mail sent to ${to}`);
      else toast.error(`Not sent — ${reasonText(res?.reason)}`);
      setTested({
        to, ok: !!res?.ok, logged: true,
        reason: res?.ok ? null : reasonText(res?.reason) + (typeof res?.error === "string" ? ` (${res.error})` : ""),
      });
      // The test goes through the mail engine, so it is a new row in the logs.
      qc.invalidateQueries({ queryKey: mailKeys.status });
      qc.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
    // The API layer already toasted the message — keep it beside the button, no second toast.
    onError: (err, to) => setTested({
      to, ok: false, logged: false, reason: err?.response?.data?.message || "the request failed",
    }),
  });

  const submit = (e) => {
    e.preventDefault();
    if (insecureAuth) return;
    save.mutate(payloadOf(form));
  };

  const sendTest = () => {
    const to = testTo.trim();
    if (!to) { toast.error("Enter an e-mail to send the test to"); return; }
    setTested(null);
    test.mutate(to);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,20rem)]">
      <form className="grid max-w-lg grid-cols-2 content-start gap-3" onSubmit={submit}>
        <label className="block">
          <span className={FIELD_LABEL}>From e-mail</span>
          <input type="email" value={form.from_email || ""}
            onChange={(e) => setField("from_email", e.target.value)}
            placeholder="store@toyota-boshoku.com" className="input-field mt-1 w-full" />
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>From name (shown to recipient)</span>
          <input value={form.from_display || ""} maxLength={120}
            onChange={(e) => setField("from_display", e.target.value)}
            placeholder="TBDI Store" className="input-field mt-1 w-full" />
        </label>
        <label className="col-span-2 block">
          <span className={FIELD_LABEL}>SMTP server (host)</span>
          <input value={form.host || ""} maxLength={255}
            onChange={(e) => setField("host", e.target.value)}
            placeholder="toyotaboshoku-com01e.mail.protection.outlook.com" className="input-field mt-1 w-full" />
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Port</span>
          <input type="number" min="1" max="65535" value={form.port ?? 25}
            onChange={(e) => setField("port", e.target.value)} className="input-field mt-1 w-full" />
        </label>
        <div className="flex flex-col justify-end gap-1.5 pb-1">
          <label className={CHECK_LABEL}>
            <input type="checkbox" checked={!!form.use_tls}
              onChange={(e) => setField("use_tls", e.target.checked)} className="accent-toyotared" />
            Use TLS (STARTTLS)
          </label>
          <label className={CHECK_LABEL}>
            <input type="checkbox" checked={!!form.use_ssl}
              onChange={(e) => setField("use_ssl", e.target.checked)} className="accent-toyotared" />
            Use SSL (port 465)
          </label>
        </div>
        {form.use_ssl && (
          <p className="col-span-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            SSL encrypts the connection from the first byte{form.use_tls ? ", so it is used instead of STARTTLS when both are ticked" : ""}.
            {port !== 465 && ` It normally listens on port 465 — the port here is ${port}.`}
          </p>
        )}
        <label className={`col-span-2 ${CHECK_LABEL}`}>
          <input type="checkbox" checked={!!form.requires_auth}
            onChange={(e) => setField("requires_auth", e.target.checked)} className="accent-toyotared" />
          Server needs a username &amp; password to send
        </label>
        {insecureAuth && (
          <p className="col-span-2 flex items-start gap-1.5 text-xs text-rose-600 dark:text-rose-400" role="alert">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            Tick TLS or SSL before saving: with neither, the username and password would travel to the mail server unencrypted.
          </p>
        )}
        {form.requires_auth && (
          <label className="col-span-2 block">
            <span className={FIELD_LABEL}>Username</span>
            <input value={form.username || ""} maxLength={255}
              onChange={(e) => setField("username", e.target.value)}
              placeholder="store@toyota-boshoku.com" className="input-field mt-1 w-full" />
            {saved.password_in_env ? (
              <span className="mt-1 flex items-center gap-1 text-[11px] leading-relaxed text-emerald-600 dark:text-emerald-400">
                <CircleCheck size={13} className="shrink-0" aria-hidden="true" /> Password is set in the server .env
              </span>
            ) : (
              <span className="mt-1 block text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                Add the password as SMTP_PASSWORD in the server .env — for security it is never typed or stored here.
              </span>
            )}
          </label>
        )}
        <div className="col-span-2">
          <button type="submit" disabled={save.isPending || insecureAuth} className="btn-primary disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save mail server"}
          </button>
        </div>
      </form>

      <div className="space-y-3 self-start rounded-xl border border-slate-200 p-4 dark:border-navy-800">
        <p className="kpi-label">Status &amp; test</p>
        <p className="text-sm">
          {saved.configured
            ? <span className="font-semibold text-emerald-600 dark:text-emerald-400">● Ready to send</span>
            : <span className="font-semibold text-amber-600 dark:text-amber-400">● Not configured yet</span>}
        </p>
        <label className="block">
          <span className={FIELD_LABEL}>Send a test mail to</span>
          <input type="email" value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@toyota-boshoku.com" className="input-field mt-1 w-full" />
        </label>
        <button type="button" onClick={sendTest} disabled={test.isPending || !saved.configured}
          className="btn-secondary w-full justify-center disabled:opacity-50">
          {test.isPending ? "Sending…" : "Send test mail"}
        </button>
        {dirty && (
          <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            You have unsaved changes — the test mail uses the saved settings.
          </p>
        )}
        {tested && (
          <div role="status" className={`rounded-lg px-3 py-2 text-xs ${tested.ok
            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
            : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300"}`}>
            <p className="break-words">
              {tested.ok ? `Test mail sent to ${tested.to}.` : `Not sent to ${tested.to} — ${tested.reason}.`}
            </p>
            {tested.logged && (
              <Link to="/email/logs" className="mt-1 inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                {tested.ok ? "See it in Email Logs" : "See the attempt in Email Logs"} <ArrowRight size={12} aria-hidden="true" />
              </Link>
            )}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          For Office 365 direct-send: host is your tenant&apos;s{" "}
          <b>…mail.protection.outlook.com</b>, port <b>25</b>, no username needed.
          Settings take effect at once — no restart.
        </p>
      </div>
    </div>
  );
}

function EmailConfigurationBody() {
  const q = useQuery({
    queryKey: smtpConfigKey,
    queryFn: () => settingsService.smtpConfig().then((r) => r.data.data),
  });

  return (
    <div className="space-y-5">
      <PageHead icon={ServerCog} title="Email Configuration"
        hint="The mail server every mail of the app leaves through — sender, host, port and encryption. A password, if the server needs one, stays in the server .env and is never typed here." />

      <div className="card">
        <CardHead icon={Mail} tone="blue" title="Mail server (SMTP)"
          hint="Used by the reorder list, the window-time sheet, alerts, digests and reminders" />
        {q.isPending || (!q.data && q.isFetching) ? (
          // First load, or a Retry after a failed one — so Retry visibly does something.
          <div className="skeleton h-40 w-full max-w-lg" aria-busy="true" />
        ) : !q.data ? (
          <div className="py-6 text-center">
            <TriangleAlert size={22} className="mx-auto mb-2 text-rose-500" aria-hidden="true" />
            <p className="text-sm text-slate-600 dark:text-slate-300">Couldn&apos;t load the mail server settings.</p>
            {q.error?.response?.data?.message && (
              <p className="mt-1 text-xs text-slate-400">{q.error.response.data.message}</p>
            )}
            <button type="button" onClick={() => q.refetch()} className="mt-3 text-sm font-medium text-toyotared hover:underline">
              Retry
            </button>
          </div>
        ) : (
          <ConfigurationForm saved={q.data} />
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
        <Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          The SMTP password is never typed, stored or shown on this screen. If the mail server needs one, it
          lives only in the server&apos;s <code>.env</code> file as <code>SMTP_PASSWORD</code> — set it there,
          then restart the app. This screen only shows whether a password is present.
        </span>
      </div>
    </div>
  );
}

export default function EmailConfiguration() {
  return (
    <AdminOnly>
      <EmailConfigurationBody />
    </AdminOnly>
  );
}
