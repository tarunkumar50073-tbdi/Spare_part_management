import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * A recoverable "something broke" panel. `full` centres it as a whole-screen
 * state (used by the top-level boundary); without it, it sits inline inside a
 * content area (used by the in-layout boundary, so the shell stays put).
 */
export default function ErrorState({
  title = "Something went wrong",
  message = "This screen hit an unexpected error. You can try again, or reload the app.",
  error,
  onRetry,
  full = false,
}) {
  const body = (
    <div className="mx-auto max-w-md text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl2 bg-red-50 text-toyotared dark:bg-red-500/10">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-bold text-slate-900 dark:text-white">{title}</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{message}</p>
      {error?.message && (
        <p className="mt-3 break-words rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-500 dark:bg-navy-800 dark:text-slate-400">
          {String(error.message)}
        </p>
      )}
      <div className="mt-5 flex items-center justify-center gap-2">
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn-secondary inline-flex items-center gap-1.5">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
          </button>
        )}
        <button type="button" onClick={() => window.location.reload()} className="btn-primary">
          Reload app
        </button>
      </div>
    </div>
  );
  if (full) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 dark:bg-navy-950">{body}</div>;
  }
  return <div className="flex items-center justify-center px-6 py-16">{body}</div>;
}
