import React, { useCallback, useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, ScrollText, Search, TriangleAlert } from "lucide-react";
import Table from "../../components/Table.jsx";
import Pagination from "../../components/Pagination.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import MessageDrawer, { ToCell, attemptsText, errorText, triggerLabel } from "../../components/email/MessageDrawer.jsx";
import {
  AdminOnly, MAIL_TYPE_LABEL, MailStatusBadge, PageHead, fmtWhen, mailTypeLabel,
} from "../../components/email/EmailKit.jsx";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";
import { downloadXlsx } from "../../utils/excel.js";

// Email Logs — every mail the app has sent or tried to send, newest first:
// the answer to "did that mail go out, to whom, and if not, why". The server
// does the filtering and the paging, so the list stays quick however long the
// history grows; a row opens the full mail.

const PER_PAGE = 50;
const SEARCH_DELAY_MS = 300;

// In the order a reader asks about them: what went out, what did not, what is still open.
const STATUSES = [
  ["SENT", "Sent"], ["PARTIAL", "Partial"], ["FAILED", "Failed"], ["QUEUED", "Queued"],
  ["SENDING", "Sending"], ["CANCELLED", "Cancelled"], ["SKIPPED", "Skipped"],
];

const COLUMNS = [
  { key: "created_at", label: "When", render: (r) => <span className="tabular">{fmtWhen(r.created_at)}</span> },
  { key: "mail_type", label: "Type", render: (r) => mailTypeLabel(r.mail_type) },
  {
    key: "subject", label: "Subject",
    render: (r) => (
      <span className="block max-w-[24rem] truncate font-medium text-slate-800 dark:text-white" title={r.subject || undefined}>
        {r.subject || "—"}
      </span>
    ),
  },
  { key: "to", label: "To", render: (r) => <ToCell to={r.to} /> },
  {
    // The reason behind a failed or skipped mail is one hover away.
    key: "status", label: "Status",
    render: (r) => <span title={errorText(r.last_error) || undefined}><MailStatusBadge status={r.status} /></span>,
  },
  { key: "trigger", label: "Trigger", render: (r) => triggerLabel(r.trigger) },
  { key: "triggered_by", label: "By", render: (r) => r.triggered_by || "—" },
  { key: "attempts", label: "Attempts", render: (r) => <span className="tabular">{attemptsText(r)}</span> },
];

// The export carries plain values only — and the Cc / Bcc lists, the sent time
// and the error text that the table keeps in the drawer.
const EXPORT_HEADERS = [
  "When", "Type", "Subject", "To", "Cc", "Bcc", "Status", "Trigger", "By", "Attempts", "Attempts allowed", "Sent", "Last error",
];
const exportRow = (m) => [
  fmtWhen(m.created_at), mailTypeLabel(m.mail_type), m.subject || "",
  (m.to || []).join("; "), (m.cc || []).join("; "), (m.bcc || []).join("; "),
  m.status || "", m.trigger ? triggerLabel(m.trigger) : "", m.triggered_by || "",
  m.attempts ?? "", m.max_attempts ?? "", m.sent_at ? fmtWhen(m.sent_at) : "", errorText(m.last_error),
];

function LogsScreen() {
  const [statuses, setStatuses] = useState([]);   // none picked = every status
  const [mailType, setMailType] = useState("");
  const [text, setText] = useState("");           // the search box as typed
  const [q, setQ] = useState("");                 // what is searched (after a short pause)
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  // Stable, so re-rendering this page does not make the open drawer set itself
  // up again (Modal re-runs its focus handling when onClose changes).
  const closeDrawer = useCallback(() => setOpenId(null), []);

  // Typing costs one request at the end, not one per key. A new search starts on page 1.
  useEffect(() => {
    const t = text.trim();
    if (t === q) return undefined;
    const id = setTimeout(() => { setQ(t); setPage(1); }, SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [text, q]);

  const params = { page, per_page: PER_PAGE };
  if (statuses.length) params.status = statuses.join(",");
  if (mailType) params.mail_type = mailType;
  if (q) params.q = q;

  const list = useQuery({
    queryKey: mailKeys.messages(params),
    queryFn: () => mailEngineService.messages(params).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items || [];
  const meta = list.data?.meta;
  // A mail type the app no longer sends can still be in the log: the filter
  // offers it while such a mail is listed, and keeps it while it is the one picked.
  const oldTypes = [...new Set([mailType, ...rows.map((r) => r.mail_type)])].filter((t) => t && !MAIL_TYPE_LABEL[t]);

  // Old mails are purged by the retention rule, so the last page can go away.
  const lastPage = Math.max(meta?.total_pages || 1, 1);
  useEffect(() => {
    if (meta && page > lastPage) setPage(lastPage);
  }, [meta, page, lastPage]);

  // Kept in the fixed order above, so one filter is one request however it was clicked together.
  const toggleStatus = (value) => {
    setStatuses((cur) => STATUSES.map(([v]) => v).filter((v) => (v === value ? !cur.includes(v) : cur.includes(v))));
    setPage(1);
  };
  const dirty = statuses.length > 0 || Boolean(mailType) || Boolean(text);
  const clear = () => { setStatuses([]); setMailType(""); setText(""); setQ(""); setPage(1); };

  const exportPage = () => {
    const day = new Date().toISOString().slice(0, 10);
    downloadXlsx(`email_logs_${day}_page-${meta?.page ?? page}`, EXPORT_HEADERS, rows.map(exportRow), "Email logs");
  };

  return (
    <div className="space-y-5">
      <PageHead icon={ScrollText} title="Email Logs"
        hint="Every mail the app has sent or tried to send, newest first. Click a row for the recipients, the attempts and the text.">
        <button type="button" className="btn-secondary" onClick={() => list.refetch()} disabled={list.isFetching}>
          <RefreshCw size={14} className={list.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
        <button type="button" className="btn-secondary disabled:cursor-not-allowed disabled:opacity-40"
          onClick={exportPage} disabled={rows.length === 0}
          title="Download the rows shown on this page as an Excel file">
          <Download size={14} aria-hidden="true" /> Export this page
        </button>
      </PageHead>

      <div className="card p-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input className="input-field w-64 pl-9" placeholder="Search subject or address…"
              aria-label="Search subject or address" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <select className="input-field w-52" aria-label="Mail type" value={mailType}
            onChange={(e) => { setMailType(e.target.value); setPage(1); }}>
            <option value="">All mail types</option>
            {Object.entries(MAIL_TYPE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            {oldTypes.map((t) => <option key={t} value={t}>{mailTypeLabel(t)}</option>)}
          </select>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
            {STATUSES.map(([value, label]) => {
              const on = statuses.includes(value);
              return (
                <button key={value} type="button" aria-pressed={on} onClick={() => toggleStatus(value)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${on
                    ? "bg-toyotared text-white" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
                  {label}
                </button>
              );
            })}
          </div>
          {dirty && <button type="button" className="btn-secondary py-1.5 text-xs" onClick={clear}>Clear</button>}
        </div>

        {list.isError && !list.data ? (
          <ErrorState title="Could not load the mail log"
            message={list.error?.response?.data?.message || "The server did not answer. Nothing has changed; try again."}
            onRetry={() => list.refetch()} />
        ) : (
          <>
            {list.isError && (
              // A failed refresh keeps the last good page on screen, labelled as such.
              <p className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" role="status">
                <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
                Couldn&apos;t refresh — these are the rows from the last successful load.
                <button type="button" onClick={() => list.refetch()} className="font-medium text-toyotared hover:underline">Retry</button>
              </p>
            )}
            {/* Dimmed while the rows on screen still belong to the previous page or filter. */}
            <div className={list.isPlaceholderData ? "opacity-60" : ""}>
              <Table
                columns={COLUMNS}
                rows={rows}
                loading={list.isPending}
                onRowClick={(r) => setOpenId(r.id)}
                emptyMessage={statuses.length || mailType || q
                  ? "No mail matches these filters."
                  : "No mail has been recorded yet — every mail the app sends, or tries to send, is listed here."}
              />
            </div>
            <Pagination meta={meta} onPageChange={setPage} />
          </>
        )}
      </div>

      <MessageDrawer messageId={openId} summary={rows.find((r) => r.id === openId) || null} onClose={closeDrawer} />
    </div>
  );
}

export default function EmailLogs() {
  // The screen sits inside the gate, so a non-admin never fires its calls.
  return <AdminOnly><LogsScreen /></AdminOnly>;
}
