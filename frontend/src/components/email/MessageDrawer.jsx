import React, { useState } from "react";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Paperclip, RotateCcw, TriangleAlert } from "lucide-react";
import Modal from "../Modal.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { Facts } from "../scan/forms/FormKit.jsx";
import { MailStatusBadge, fmtWhen, mailTypeLabel } from "./EmailKit.jsx";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";

// One mail, opened from Email Queue or Email Logs: who it went to, what
// happened on every delivery attempt, and what it said. The small pieces both
// of those tables share with the drawer (how a recipient list, an attempt
// count, a trigger and an error read; Retry / Cancel / Dismiss) live here too,
// so a mail reads the same in the row and in the drawer.

// Every message list whatever its filters, and every opened mail: the two
// mailKeys entries without their last part.
const ALL_MESSAGE_LISTS = mailKeys.messages().slice(0, 2);
const ALL_MESSAGES = mailKeys.message().slice(0, 2);
const REFRESH_MS = 30_000;

/** After anything that moves mail: re-read the lists, an open mail and the queue counts. */
export function refreshMail(qc) {
  qc.invalidateQueries({ queryKey: ALL_MESSAGE_LISTS });
  qc.invalidateQueries({ queryKey: ALL_MESSAGES });
  qc.invalidateQueries({ queryKey: mailKeys.status });
}

const RETRYABLE = new Set(["FAILED", "CANCELLED", "PARTIAL"]);
// Both end as CANCELLED: a queued mail is stopped before it leaves, a failed
// one is closed so it no longer waits in the queue for someone to deal with it.
const CANCELLABLE = new Set(["QUEUED", "FAILED"]);
const ON_ITS_WAY = new Set(["QUEUED", "SENDING"]);
export const canRetry = (status) => RETRYABLE.has(status);
export const canCancel = (status) => CANCELLABLE.has(status);
/** On a failed mail nothing is on its way that could be cancelled, so there the same action reads "Dismiss". */
export const canDismiss = (status) => status === "FAILED";

const TRIGGER_LABEL = { MANUAL: "Manual", SCHEDULED: "Scheduled", RULE: "Rule", TEST: "Test" };
export const triggerLabel = (t) => TRIGGER_LABEL[t] || t || "—";

/** "2 / 5" — attempts made out of the attempts allowed. */
export const attemptsText = (m) => (m?.attempts == null ? "—" : `${m.attempts} / ${m.max_attempts ?? "—"}`);

// The engine stores a short code for the failures it recognises itself, and a
// rule that ran and sent nothing stores the code of its reason; anything else
// is the mail server's own answer (already stripped of secrets), shown as it came.
const ERROR_TEXT = {
  smtp_not_configured: "Mail server is not configured",
  no_recipient: "No valid recipient address",
  invalid_header: "A line break in the subject or in an address",
  attachment_too_large: "Attachments are over the 10 MB limit",
  nothing_to_report: "Nothing to report",
  nothing_to_reorder: "No part needs reordering",
  no_department_flagged: "No department is ticked “Reorder mail” in Department Emails",
  no_recipient_email: "No one to mail",
  tracker_unavailable: "The Action Tracker could not be read",
  report_build_failed: "The window-time sheet could not be built",
  already_sent_today: "Today's mail has already gone out",
  already_queued: "Today's mail is already in the queue",
};
// A code with no wording of its own is at least shown as words, not snake_case.
const codeAsWords = (e) => (/^[a-z_]+$/.test(e) ? (e.charAt(0).toUpperCase() + e.slice(1)).replace(/_/g, " ") : e);
export const errorText = (e) => (e ? ERROR_TEXT[e] || codeAsWords(e) : "");

/** First To address and "+n" for the rest; the full list is in the tooltip. */
export function ToCell({ to }) {
  const list = to || [];
  if (!list.length) return <span className="text-slate-400">—</span>;
  return (
    <span title={list.join(", ")}>
      {list[0]}
      {list.length > 1 && <span className="ml-1 text-xs text-slate-400">+{list.length - 1}</span>}
    </span>
  );
}

function retryQuestion(m) {
  const n = (m.to || []).length + (m.cc || []).length + (m.bcc || []).length;
  const who = n ? `${n} ${n === 1 ? "recipient" : "recipients"}` : "its recipients";
  // A partly delivered mail goes back as a whole; who gets it twice is the server's call.
  const twice = m.status === "PARTIAL" ? " Addresses that already received it may get it a second time." : "";
  return `Put “${m.subject || "this mail"}” back in the queue for ${who}?${twice}`;
}

/**
 * Retry and Cancel for one mail, each behind a confirm. Used by the queue's
 * row buttons and by the drawer footer. On a failed mail, cancel asks and
 * answers as "Dismiss".
 *   const { retry, cancel, busyId } = useMessageActions();   // retry(message)
 */
export function useMessageActions() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  // After a refusal as well: the server says no when the mail has moved on in
  // the meantime (sent, or cancelled from another screen), and the row should
  // then show where it really is. The refusal itself is toasted by the api layer.
  const reread = () => refreshMail(qc);
  const retrying = useMutation({
    mutationFn: (m) => mailEngineService.retry(m.id),
    // Only what is certain: when it leaves depends on the engine and the mail server.
    onSuccess: () => toast.success("Back in the queue"),
    onSettled: reread,
  });
  const cancelling = useMutation({
    mutationFn: (m) => mailEngineService.cancel(m.id),
    onSuccess: (_res, m) => toast.success(canDismiss(m.status) ? "Mail dismissed" : "Cancelled — this mail will not be sent"),
    onSettled: reread,
  });

  const retry = async (m) => {
    if (!(await confirm({ title: "Send again", message: retryQuestion(m), confirmText: "Retry", danger: false }))) return;
    retrying.mutate(m);
  };
  const cancel = async (m) => {
    const name = `“${m.subject || "This mail"}”`;
    if (!(await confirm(canDismiss(m.status) ? {
      title: "Dismiss this failed mail",
      message: `${name} will not be tried again. It leaves the queue and stays in Email Logs as cancelled.`,
      confirmText: "Dismiss", cancelText: "Keep it",
    } : {
      title: "Cancel this mail",
      message: `${name} will not be sent. It stays in Email Logs and can be put back in the queue with Retry.`,
      confirmText: "Cancel mail", cancelText: "Keep it",
    }))) return;
    cancelling.mutate(m);
  };

  const busyId = retrying.isPending ? retrying.variables?.id : cancelling.isPending ? cancelling.variables?.id : null;
  return { retry, cancel, busyId };
}

// ------------------------------------------------------------------- pieces

const fileSize = (bytes) => {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function Section({ title, action, children }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function AddressRow({ label, list }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-8 shrink-0 text-xs font-semibold text-slate-400">{label}</span>
      <span className="min-w-0 break-words text-slate-700 dark:text-slate-200">{list.join(", ")}</span>
    </div>
  );
}

function LoadFailed({ what, onRetry }) {
  return (
    <p className="text-sm text-slate-500 dark:text-slate-400" role="alert">
      Couldn&apos;t load {what}.{" "}
      <button type="button" onClick={onRetry} className="font-medium text-toyotared hover:underline">Retry</button>
    </p>
  );
}

const OUTCOME = {
  SENT: ["Sent", "bg-emerald-500"],
  PARTIAL: ["Sent, but some addresses were refused", "bg-orange-500"],
  FAILED: ["Failed", "bg-rose-500"],
  DEFERRED: ["Not sent — will be tried again", "bg-amber-500"],
};

function AttemptLog({ log }) {
  if (!log.length) return <p className="text-xs text-slate-400">No delivery attempt has been made yet.</p>;
  return (
    <ol className="space-y-3 border-l border-slate-200 pl-4 dark:border-navy-700">
      {/* Index key: attempt numbers start over after a Retry, so they repeat. */}
      {log.map((a, i) => {
        const [label, dot] = OUTCOME[a.outcome] || [a.outcome || "—", "bg-slate-400"];
        return (
          <li key={i} className="relative text-xs">
            <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden="true" />
            <p className="font-medium text-slate-700 dark:text-slate-200">
              Attempt {a.attempt_no ?? i + 1} · {label}
              <span className="ml-2 font-normal text-slate-400 tabular">{fmtWhen(a.at)}</span>
            </p>
            {a.error && <p className="mt-0.5 break-words text-slate-500 dark:text-slate-400">{errorText(a.error)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

// Under the sandbox, a second lock: a stored mail may not fetch anything either
// (no remote image, font or stylesheet) — it shows only what it carries inline.
const NO_NETWORK = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
// Placed after a doctype when there is one, so the mail keeps its rendering mode.
const sealed = (html) => {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + NO_NETWORK + html.slice(doctype[0].length) : NO_NETWORK + html;
};

function MailBody({ m, plain, onPlain }) {
  const hasHtml = Boolean(m.body_html);
  const tab = (on) => `rounded-full px-3 py-1 text-xs font-semibold ${on
    ? "bg-toyotared text-white" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`;
  return (
    <Section title="Message"
      action={hasHtml && (
        <div className="flex gap-1" role="group" aria-label="Show the message as">
          <button type="button" aria-pressed={!plain} onClick={() => onPlain(false)} className={tab(!plain)}>As sent</button>
          <button type="button" aria-pressed={plain} onClick={() => onPlain(true)} className={tab(plain)}>Plain text</button>
        </div>
      )}>
      {hasHtml && !plain ? (
        // sandbox="" allows nothing — no script, no form, no way out of the
        // frame: mail markup is shown, never run. White in both themes, because
        // a mail is written for a white page and carries its own dark text.
        <iframe title="Message as sent" sandbox="" srcDoc={sealed(m.body_html)}
          className="h-[55vh] min-h-[320px] w-full rounded-lg border border-slate-200 bg-white dark:border-navy-700" />
      ) : m.body_text ? (
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 font-sans text-sm text-slate-700 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-200">
          {m.body_text}
        </pre>
      ) : (
        <p className="text-xs text-slate-400">This mail has no text.</p>
      )}
    </Section>
  );
}

function DrawerSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="skeleton h-5 w-40" />
      <div className="skeleton h-24 w-full" />
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-40 w-full" />
    </div>
  );
}

// ------------------------------------------------------------------- drawer

function Drawer({ id, summary, onClose }) {
  const [plain, setPlain] = useState(false);
  const { retry, cancel, busyId } = useMessageActions();

  const detail = useQuery({
    queryKey: mailKeys.message(id),
    queryFn: () => mailEngineService.message(id).then((r) => r.data.data),
    // A mail still on its way is re-read so the drawer follows it to Sent or
    // Failed. Not after a failed read: that one already raised a toast, and
    // repeating it every 30 s helps nobody — Retry below starts it again.
    refetchInterval: (q) => (q.state.status !== "error" && ON_ITS_WAY.has(q.state.data?.status) ? REFRESH_MS : false),
  });
  // The list row fills the drawer while the full mail is on its way (or could not be read).
  const m = detail.data || summary;
  const busy = busyId === id;

  const footer = (
    <>
      <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      {m && canCancel(m.status) && (
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => cancel(m)}>
          <Ban size={15} aria-hidden="true" /> {canDismiss(m.status) ? "Dismiss" : "Cancel mail"}
        </button>
      )}
      {m && canRetry(m.status) && (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => retry(m)}>
          <RotateCcw size={15} aria-hidden="true" /> Retry
        </button>
      )}
    </>
  );

  let body;
  if (!m) {
    body = detail.isPending ? <DrawerSkeleton /> : <LoadFailed what="this mail" onRetry={() => detail.refetch()} />;
  } else {
    const to = m.to || [];
    const cc = m.cc || [];
    const bcc = m.bcc || [];
    const files = m.attachments || [];
    const refused = m.refused || [];
    body = (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <MailStatusBadge status={m.status} />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{mailTypeLabel(m.mail_type)}</span>
          <span className="text-xs text-slate-400 tabular">Mail #{id}</span>
        </div>

        <Facts items={[
          { label: "Trigger", value: triggerLabel(m.trigger) },
          { label: "Started by", value: m.triggered_by },
          { label: "Attempts", value: attemptsText(m) },
          { label: "Created", value: fmtWhen(m.created_at) },
          { label: "Sent", value: m.sent_at ? fmtWhen(m.sent_at) : null, empty: "Not sent" },
          m.status === "QUEUED" && {
            label: "Next try", value: m.next_attempt_at ? fmtWhen(m.next_attempt_at) : null, empty: "On the next run",
          },
        ]} />

        <Section title="Recipients">
          {to.length + cc.length + bcc.length === 0 ? (
            <p className="text-xs text-slate-400">No recipient address on this mail.</p>
          ) : (
            <div className="space-y-1">
              {to.length > 0 && <AddressRow label="To" list={to} />}
              {cc.length > 0 && <AddressRow label="Cc" list={cc} />}
              {bcc.length > 0 && <AddressRow label="Bcc" list={bcc} />}
            </div>
          )}
        </Section>

        {files.length > 0 && (
          <Section title={`Attachments (${files.length})`}>
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={`${f.filename}-${i}`} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <Paperclip size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="min-w-0 truncate">{f.filename || "Unnamed file"}</span>
                  <span className="shrink-0 text-xs text-slate-400 tabular">{fileSize(f.size)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {m.last_error && (m.status === "SKIPPED" ? (
          // A skipped mail did not fail — there was nothing, or no one, to send
          // it to — so its reason is not dressed as an error.
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-navy-700 dark:bg-navy-800">
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Why it was not sent</p>
            <p className="mt-0.5 break-words text-xs text-slate-600 dark:text-slate-300">{errorText(m.last_error)}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 dark:border-rose-500/30 dark:bg-rose-500/10">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
              <TriangleAlert size={14} aria-hidden="true" /> Last error
            </p>
            <p className="mt-0.5 break-words text-xs text-rose-700 dark:text-rose-300">{errorText(m.last_error)}</p>
          </div>
        ))}

        {refused.length > 0 && (
          <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 dark:border-orange-500/30 dark:bg-orange-500/10">
            <p className="text-xs font-semibold text-orange-700 dark:text-orange-300">
              Refused by the mail server ({refused.length})
            </p>
            <p className="mt-0.5 break-words text-xs text-orange-700 dark:text-orange-300">{refused.join(", ")}</p>
          </div>
        )}

        {/* The attempt log and the text come only with the full mail, not with a list row. */}
        {detail.data ? (
          <>
            <Section title="Delivery attempts"><AttemptLog log={detail.data.attempt_log || []} /></Section>
            <MailBody m={detail.data} plain={plain} onPlain={setPlain} />
          </>
        ) : detail.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-40 w-full" />
          </div>
        ) : (
          <LoadFailed what="the delivery attempts and the message text" onRetry={() => detail.refetch()} />
        )}
      </div>
    );
  }

  return (
    <Modal open onClose={onClose} variant="drawer" size="xl" title={m?.subject || `Mail #${id}`} footer={footer}>
      {body}
    </Modal>
  );
}

/**
 * The right-hand drawer for one mail. Closed while `messageId` is null.
 * `summary` is the row it was opened from, when the caller has one — it fills
 * the drawer at once, before the full mail has been read.
 */
export default function MessageDrawer({ messageId, summary = null, onClose }) {
  if (messageId == null) return null;
  // Keyed, so "As sent" / "Plain text" starts over with each mail.
  return <Drawer key={messageId} id={messageId} summary={summary} onClose={onClose} />;
}
