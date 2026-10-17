import React, { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Inbox, Play, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import Table from "../../components/Table.jsx";
import Pagination from "../../components/Pagination.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import MessageDrawer, {
  ToCell, attemptsText, canCancel, canDismiss, canRetry, errorText, refreshMail, useMessageActions,
} from "../../components/email/MessageDrawer.jsx";
import {
  AdminOnly, MailStatusBadge, PageHead, SmtpBanner, fmtWhen, mailTypeLabel,
} from "../../components/email/EmailKit.jsx";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";
import { num } from "../../lib/format.js";

// Email Queue — the mails that have not been delivered yet: waiting for their
// turn, being sent this minute, or stopped after their last attempt. Everything
// that left (or was closed) is in Email Logs. The list re-reads itself, so the
// screen can stay open while a problem is being sorted out.

const REFRESH_MS = 30_000;
const PER_PAGE = 100;

// The three "not delivered yet" states. A chip's count is the whole queue's
// (from the engine status), not the number of rows on this page.
const CHIPS = [
  { status: "QUEUED", label: "Queued", count: "queued", empty: "No mail is waiting for its turn.",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300" },
  { status: "SENDING", label: "Sending", count: "sending", empty: "No mail is being sent right now.",
    tone: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300" },
  { status: "FAILED", label: "Failed", count: "failed", empty: "No mail has failed.",
    tone: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300" },
];
const ALL_STATUSES = CHIPS.map((c) => c.status).join(",");

// One failed refresh has already raised a toast (the api layer does that), and
// polling on would repeat it every 30 s — so the timer stops until a refresh
// works again. While the tab is hidden react-query holds the timer by itself.
const pollUnlessFailed = (query) => (query.state.status === "error" ? false : REFRESH_MS);

// react-query's own reading of the browser clock (a number), not a server string.
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Why a mail may sit here although nothing is wrong with the mail itself.
function engineNote(engine) {
  if (!engine) return null;
  // A server started with mail held off cannot be switched on from the app.
  if (engine.forced_off) {
    return "Mail is held off on this server — nothing is sent from it, and the mails listed here stay in the queue.";
  }
  if (engine.enabled === false) {
    return "The notification engine is switched off — nothing is sent, and mails wait here until an administrator switches it back on.";
  }
  if (engine.worker_running === false) {
    return "The background sender is not running — mails leave only when “Process queue now” is pressed.";
  }
  return null;
}

function drainResult(r) {
  if (!r?.processed) return "Nothing was due — no mail in the queue has reached its next try";
  const parts = [`${num(r.sent ?? 0)} sent`];
  if (r.failed) parts.push(`${num(r.failed)} failed`);
  if (r.deferred) parts.push(`${num(r.deferred)} left for a later try`);
  return `${num(r.processed)} processed: ${parts.join(", ")}`;
}

const stop = (e) => e.stopPropagation();

function QueueScreen() {
  const qc = useQueryClient();
  const [only, setOnly] = useState(null);   // one chip's status, or null for all three
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  // Stable, so a background refresh of this page does not make the open drawer
  // set itself up again (Modal re-runs its focus handling when onClose changes).
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const { retry, cancel, busyId } = useMessageActions();

  const status = useQuery({
    queryKey: mailKeys.status,
    queryFn: () => mailEngineService.status().then((r) => r.data.data),
    refetchInterval: pollUnlessFailed,
  });
  const params = { status: only || ALL_STATUSES, page, per_page: PER_PAGE };
  const list = useQuery({
    queryKey: mailKeys.messages(params),
    queryFn: () => mailEngineService.messages(params).then((r) => r.data.data),
    placeholderData: keepPreviousData,
    refetchInterval: pollUnlessFailed,
  });

  const drain = useMutation({
    mutationFn: () => mailEngineService.processNow().then((r) => r.data.data),
    onSuccess: (r) => {
      if (r?.processed && !r.failed) toast.success(drainResult(r));
      else toast(drainResult(r));
    },
    onSettled: () => refreshMail(qc),
  });

  const rows = list.data?.items || [];
  const meta = list.data?.meta;
  const queue = status.data?.queue;
  const smtp = status.data?.smtp;
  const engine = status.data?.engine;
  const note = engineNote(engine);
  // Known only once the status has loaded; until then the server decides.
  const blocked = engine?.forced_off ? "Mail is held off on this server"
    : smtp && !smtp.configured ? "The mail server is not configured yet"
      : engine?.enabled === false ? "The notification engine is switched off"
        : null;

  // The queue empties on its own, so a later page can stop existing while it
  // is on screen — and an empty table there would read as "nothing is waiting".
  const lastPage = Math.max(meta?.total_pages || 1, 1);
  useEffect(() => {
    if (meta && page > lastPage) setPage(1);
  }, [meta, page, lastPage]);

  const refresh = () => { list.refetch(); status.refetch(); };
  const pick = (s) => { setOnly((cur) => (cur === s ? null : s)); setPage(1); };

  const columns = [
    { key: "created_at", label: "Created", render: (r) => <span className="tabular">{fmtWhen(r.created_at)}</span> },
    { key: "mail_type", label: "Type", render: (r) => mailTypeLabel(r.mail_type) },
    {
      key: "subject", label: "Subject",
      render: (r) => (
        <span className="block max-w-[22rem] truncate font-medium text-slate-800 dark:text-white" title={r.subject || undefined}>
          {r.subject || "—"}
        </span>
      ),
    },
    { key: "to", label: "To", render: (r) => <ToCell to={r.to} /> },
    { key: "status", label: "Status", render: (r) => <MailStatusBadge status={r.status} /> },
    { key: "attempts", label: "Attempts", render: (r) => <span className="tabular">{attemptsText(r)}</span> },
    {
      // Only a queued mail has a next try; a failed one waits for a person.
      key: "next_attempt_at", label: "Next try",
      render: (r) => (r.status === "QUEUED" && r.next_attempt_at
        ? <span className="tabular">{fmtWhen(r.next_attempt_at)}</span>
        : <span className="text-slate-400">—</span>),
    },
    {
      key: "last_error", label: "Last error",
      render: (r) => (r.last_error ? (
        <span className="block max-w-[16rem] truncate text-rose-600 dark:text-rose-400" title={errorText(r.last_error)}>
          {errorText(r.last_error)}
        </span>
      ) : <span className="text-slate-400">—</span>),
    },
    {
      key: "_actions", label: "",
      render: (r) => (
        // Clicks and key presses stay in the cell: the row itself opens the drawer.
        <div className="flex justify-end gap-1" onClick={stop} onKeyDown={stop}>
          {canRetry(r.status) && (
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === r.id} onClick={() => retry(r)}>
              <RotateCcw size={13} aria-hidden="true" /> Retry
            </button>
          )}
          {canCancel(r.status) && (
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === r.id} onClick={() => cancel(r)}>
              <Ban size={13} aria-hidden="true" /> {canDismiss(r.status) ? "Dismiss" : "Cancel"}
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHead icon={Inbox} title="Email Queue"
        hint="Mails that are waiting for their turn, being sent right now, or stopped after their last attempt.">
        {list.dataUpdatedAt > 0 && (
          <span className="text-[11px] text-slate-400">
            Updated {clock(list.dataUpdatedAt)}{list.isError ? "" : " · every 30 s"}
          </span>
        )}
        <button type="button" className="btn-secondary" onClick={refresh} disabled={list.isFetching}>
          <RefreshCw size={14} className={list.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
        <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => drain.mutate()} disabled={drain.isPending || Boolean(blocked)}
          title={blocked || "Send everything that is due now, without waiting for the next run"}>
          <Play size={14} aria-hidden="true" /> {drain.isPending ? "Processing…" : "Process queue now"}
        </button>
      </PageHead>

      <SmtpBanner smtp={smtp} />
      {note && (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" role="status">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          {note}
        </p>
      )}

      <div className="card p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Show only">
            {CHIPS.map((c) => {
              const on = only === c.status;
              // null / undefined = the count did not load; num() shows that as a dash, not as 0.
              const n = queue?.[c.count];
              return (
                <button key={c.status} type="button" aria-pressed={on} onClick={() => pick(c.status)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${on
                    ? "border-toyotared bg-toyotared text-white"
                    : "border-slate-200 text-slate-600 hover:border-toyotared dark:border-navy-700 dark:text-slate-300"}`}>
                  {c.label}
                  <span className={`tabular rounded-full px-1.5 text-[11px] font-semibold ${on
                    ? "bg-white/20"
                    : n ? c.tone : "bg-slate-100 text-slate-400 dark:bg-navy-800"}`}>
                    {num(n)}
                  </span>
                </button>
              );
            })}
          </div>
          {status.isError && (
            // With an earlier reading the chips keep it, so say that it is old.
            <button type="button" onClick={() => status.refetch()} className="text-xs font-medium text-toyotared hover:underline">
              {status.data ? "The counts could not be refreshed" : "The counts did not load"} — Retry
            </button>
          )}
          {queue?.oldest_queued_at && (
            <span className="ml-auto text-[11px] text-slate-400">Oldest waiting since {fmtWhen(queue.oldest_queued_at)}</span>
          )}
        </div>

        {list.isError && !list.data ? (
          <ErrorState title="Could not load the queue"
            message={list.error?.response?.data?.message || "The server did not answer. Nothing has changed; try again."}
            onRetry={refresh} />
        ) : (
          <>
            {list.isError && (
              // A failed refresh keeps the last good list on screen, labelled as such.
              <p className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" role="status">
                <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
                Couldn&apos;t refresh — this is the queue as of {clock(list.dataUpdatedAt)}, and auto-refresh is paused.
                <button type="button" onClick={refresh} className="font-medium text-toyotared hover:underline">Retry</button>
              </p>
            )}
            <Table
              columns={columns}
              rows={rows}
              loading={list.isPending}
              onRowClick={(r) => setOpenId(r.id)}
              emptyMessage={only
                ? CHIPS.find((c) => c.status === only).empty
                : "Nothing is waiting — every mail has been delivered or closed."}
            />
            {lastPage > 1 && <Pagination meta={meta} onPageChange={setPage} />}
          </>
        )}
      </div>

      <MessageDrawer messageId={openId} summary={rows.find((r) => r.id === openId) || null} onClose={closeDrawer} />
    </div>
  );
}

export default function EmailQueue() {
  // The screen sits inside the gate, so a non-admin never fires its calls.
  return <AdminOnly><QueueScreen /></AdminOnly>;
}
