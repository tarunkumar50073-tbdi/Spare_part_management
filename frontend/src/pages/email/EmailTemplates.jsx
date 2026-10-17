import React, { useRef, useState } from "react";
import toast from "react-hot-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FileText, PenLine, RotateCcw, TriangleAlert } from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { AdminOnly, PageHead, mailTypeLabel } from "../../components/email/EmailKit.jsx";
import { mailEngineService, mailKeys } from "../../services/mailEngineService.js";

// Email Templates — the wording of each mail the engine sends: its subject, the
// lines before the list (intro) and the lines after it (footer). The server
// keeps a built-in text for every mail type; what is saved here replaces it,
// and a field saved empty goes back to the built-in text, so a mail never goes
// out blank. The sender identity is one setting for all mail types: its Reply-To
// goes on every mail, its signature under every mail the server signs — not the
// reorder list or the window-time sheet (their own footer ends them), nor the
// test mail.

const FIELDS = [
  { key: "subject", label: "Subject", max: 200 },
  { key: "intro", label: "Intro", rows: 4, max: 2000, hint: "The opening lines, before the list." },
  { key: "footer", label: "Footer", rows: 3, max: 2000, hint: "The closing lines, after the list." },
];

const LABEL = "block text-xs font-medium text-slate-600 dark:text-slate-300";
const HINT = "mt-1 block text-[11px] font-normal text-slate-400";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What the preview puts in place of each placeholder. The server fills in the
// real values when it builds the mail.
const sampleValues = () => {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return {
    "{store}": "Spare Parts Store",
    "{date}": `${two(now.getDate())}.${two(now.getMonth() + 1)}.${now.getFullYear()}`,
    "{count}": "12",
    "{department}": "Maintenance",
    "{problem}": "Excess above max",
  };
};

// Plain string work: the result is printed as text, never parsed as HTML.
const fillSamples = (text, tokens, samples) =>
  tokens.reduce((out, token) => out.split(token).join(samples[token]), text || "");

function TemplatePreview({ tpl, text }) {
  const samples = sampleValues();
  // Only the placeholders this mail type really has are swapped — the server
  // leaves any other one exactly as typed, and so does the preview.
  const known = Array.isArray(tpl.placeholders) ? tpl.placeholders : null;
  const tokens = (known || []).filter((t) => t in samples);
  // A placeholder the server offers but this screen has no sample for stays as
  // typed in the preview — named below, so it does not read as a broken one.
  const unfilled = (known || []).filter((t) => !(t in samples));
  const fill = (s) => fillSamples(s, tokens, samples);
  const typed = FIELDS.flatMap((f) => text[f.key].match(/\{[a-z_]+\}/gi) || []);
  const strangers = known ? [...new Set(typed)].filter((t) => !known.includes(t)) : [];

  return (
    <div className="card">
      <CardHead icon={Eye} tone="violet" title="Preview"
        hint="How this mail reads, with sample values in place of the placeholders" />
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-navy-800 dark:bg-navy-800">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Subject</p>
        <p className="mt-0.5 break-words text-sm font-semibold text-slate-800 dark:text-white">{fill(text.subject) || "—"}</p>
        <div className="mt-3 space-y-3 border-t border-slate-200 pt-3 text-sm text-slate-700 dark:border-navy-700 dark:text-slate-200">
          {text.intro && <p className="whitespace-pre-wrap break-words">{fill(text.intro)}</p>}
          <p className="rounded border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-400 dark:border-navy-700">
            The list or sheet this mail carries goes here.
          </p>
          {text.footer && <p className="whitespace-pre-wrap break-words">{fill(text.footer)}</p>}
        </div>
      </div>
      {strangers.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300" role="status">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {strangers.join(", ")} {strangers.length === 1 ? "is not a placeholder" : "are not placeholders"} of this
            mail, so {strangers.length === 1 ? "it" : "they"} will not be filled in.
          </span>
        </p>
      )}
      {tokens.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          Sample values: {tokens.map((t) => `${t} = ${samples[t]}`).join(" · ")}. The real mail carries the real ones.
        </p>
      )}
      {unfilled.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {unfilled.join(", ")} {unfilled.length === 1 ? "has" : "have"} no sample value here — the server fills{" "}
          {unfilled.length === 1 ? "it" : "them"} in when it builds the mail.
        </p>
      )}
    </div>
  );
}

function TemplateWorkspace({ templates }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [selected, setSelected] = useState(templates[0].mail_type);
  // Only the fields being edited. Everything else reads straight from the saved
  // template, so a background refetch never overwrites what is being typed.
  const [draft, setDraft] = useState({});
  // The field the caret was last in — where a placeholder chip goes. null until
  // a field has been clicked into.
  const [active, setActive] = useState(null);
  const inputs = useRef({});

  const tpl = templates.find((t) => t.mail_type === selected) || templates[0];
  const title = tpl.title || mailTypeLabel(tpl.mail_type);
  const value = Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key] ?? tpl[f.key] ?? ""]));
  const changed = FIELDS.filter((f) => value[f.key] !== (tpl[f.key] ?? ""));
  const dirty = changed.length > 0;
  const target = FIELDS.find((f) => f.key === active) || FIELDS[0];

  // An empty field is sent as "" and the server answers with its built-in text,
  // so that is what the preview shows for it.
  const effective = Object.fromEntries(FIELDS.map((f) => [
    f.key, value[f.key].trim() === "" ? tpl.defaults?.[f.key] ?? "" : value[f.key],
  ]));

  const save = useMutation({
    mutationFn: (payload) => mailEngineService.saveTemplate(tpl.mail_type, payload).then((r) => r.data.data),
    onSuccess: (next) => {
      setDraft({});
      // Show the saved wording at once; the refetch below confirms it.
      if (next?.mail_type) {
        qc.setQueryData(mailKeys.templates, (old) => (old
          ? { ...old, templates: (old.templates || []).map((t) => (t.mail_type === next.mail_type ? next : t)) }
          : old));
      }
      qc.invalidateQueries({ queryKey: mailKeys.templates });
    },
    // A failure is already toasted by the api layer; the typed text stays put.
  });
  const busy = save.isPending;

  const pick = async (mailType) => {
    if (mailType === tpl.mail_type) return;
    if (dirty && !(await confirm({
      title: "Discard unsaved changes?",
      message: `Your changes to "${title}" have not been saved. Opening another mail type discards them.`,
      confirmText: "Discard changes", cancelText: "Keep editing",
    }))) return;
    setDraft({});
    setActive(null);
    setSelected(mailType);
  };

  const saveChanges = () => {
    // Only the fields that changed. "" tells the server to drop the saved text
    // and use the built-in one — also sent when a field was typed back to
    // exactly the built-in wording, so the mail type reads "Default" again.
    const payload = Object.fromEntries(changed.map((f) => {
      const text = f.key === "subject" ? value[f.key].trim() : value[f.key];
      return [f.key, text.trim() === "" || text === tpl.defaults?.[f.key] ? "" : text];
    }));
    save.mutate(payload, { onSuccess: () => toast.success(`${title} template saved`) });
  };

  const reset = async () => {
    if (!(await confirm({
      title: "Reset to default",
      message: `Put the subject, intro and footer of "${title}" back to the built-in text? The wording saved for it is removed.`,
      confirmText: "Reset",
    }))) return;
    save.mutate({ subject: "", intro: "", footer: "" },
      { onSuccess: () => toast.success(`${title} is back to the built-in text`) });
  };

  const insert = (token) => {
    const el = inputs.current[target.key];
    const text = value[target.key];
    // The chip never takes the focus (see onMouseDown below), so the caret is
    // still where it was. No field clicked into yet: the token goes at the end.
    const start = active && el ? el.selectionStart : text.length;
    const end = active && el ? el.selectionEnd : text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    if (next.length > target.max) {
      toast.error(`${target.label} can hold ${target.max} characters at most`);
      return;
    }
    setDraft((d) => ({ ...d, [target.key]: next }));
    // Once React has written the new value, put the caret right behind the token.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="card !p-3">
        <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Mail types</p>
        <ul className="space-y-1">
          {templates.map((t) => {
            const on = t.mail_type === tpl.mail_type;
            return (
              <li key={t.mail_type}>
                <button type="button" onClick={() => pick(t.mail_type)} disabled={busy} aria-current={on ? "true" : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-60 ${on
                    ? "border-toyotared bg-rose-50/60 font-semibold text-slate-900 dark:bg-rose-500/10 dark:text-white"
                    : "border-transparent text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
                  <span className="min-w-0 truncate">{t.title || mailTypeLabel(t.mail_type)}</span>
                  <span className={`badge shrink-0 ${t.is_default ? "badge-neutral" : "badge-info"}`}>
                    {t.is_default ? "Default" : "Edited"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="min-w-0 space-y-5">
        <div className="card">
          <CardHead icon={FileText} tone="blue" title={title}
            hint={tpl.is_default ? "The built-in text — nothing has been saved for this mail" : "Edited — this mail uses the wording saved here"}
            action={dirty ? <span className="badge badge-warning">Unsaved changes</span> : null} />

          <div className="space-y-4">
            {FIELDS.map((f) => {
              const Control = f.rows ? "textarea" : "input";
              const state = value[f.key].trim() === "" ? "Empty — the built-in text is used"
                : value[f.key] === tpl.defaults?.[f.key] ? "Built-in text" : "Edited";
              return (
                <label key={f.key} className={LABEL}>
                  <span className="flex items-baseline justify-between gap-2">
                    {f.label}
                    <span className="text-[11px] font-normal text-slate-400">{state}</span>
                  </span>
                  <Control ref={(el) => { inputs.current[f.key] = el; }} rows={f.rows}
                    className={`input-field mt-1 ${f.rows ? "resize-y" : ""}`}
                    value={value[f.key]} maxLength={f.max} disabled={busy}
                    onFocus={() => setActive(f.key)}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                  {f.hint && <span className={HINT}>{f.hint}</span>}
                </label>
              );
            })}

            {tpl.placeholders?.length > 0 && (
              <div>
                <p className={LABEL}>Placeholders</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {tpl.placeholders.map((token) => (
                    <button key={token} type="button" disabled={busy}
                      // Keep the focus (and so the caret) in the field being edited.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insert(token)}
                      className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-700 transition-colors hover:border-toyotared hover:text-toyotared disabled:opacity-60 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-200">
                      {token}
                    </button>
                  ))}
                </div>
                <p className={HINT}>
                  {active
                    ? `Click one to put it into the ${target.label} field at the cursor.`
                    : `Click one to add it to the end of the ${target.label}, or click into a field first to put it at the cursor there.`}
                  {" "}The mail carries the real value in its place.
                </p>
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 dark:border-navy-800">
            <button type="button" className="btn-secondary disabled:cursor-not-allowed disabled:opacity-40" onClick={reset}
              disabled={busy || Boolean(tpl.is_default)}
              title={tpl.is_default ? "This mail already uses the built-in text" : undefined}>
              <RotateCcw size={15} aria-hidden="true" /> Reset to default
            </button>
            <div className="flex flex-wrap gap-2">
              {dirty && (
                <button type="button" className="btn-secondary" onClick={() => setDraft({})} disabled={busy}>Undo changes</button>
              )}
              <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-40" onClick={saveChanges}
                disabled={!dirty || busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>

        <TemplatePreview tpl={tpl} text={effective} />
      </div>
    </div>
  );
}

function IdentityCard({ identity }) {
  const qc = useQueryClient();
  const saved = { signature: (identity?.signature ?? "").trim(), reply_to: (identity?.reply_to ?? "").trim() };
  const [draft, setDraft] = useState({});
  const value = { ...saved, ...draft };
  const signature = value.signature.trim();
  const replyTo = value.reply_to.trim();
  const replyBad = replyTo !== "" && !EMAIL_RE.test(replyTo);

  // Only what changed goes to the server; an emptied Reply-To is saved as "none".
  const changes = {};
  if (signature !== saved.signature) changes.signature = signature;
  if (replyTo !== saved.reply_to) changes.reply_to = replyTo || null;
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: (payload) => mailEngineService.saveIdentity(payload).then((r) => r.data.data),
    onSuccess: (next) => {
      setDraft({});
      if (next) qc.setQueryData(mailKeys.templates, (old) => (old ? { ...old, identity: next } : old));
      qc.invalidateQueries({ queryKey: mailKeys.templates });
      toast.success("Sender identity saved");
    },
  });

  return (
    <div className="card">
      <CardHead icon={PenLine} tone="navy" title="Sender identity"
        hint="One setting for all mail types: Reply-To applies to every mail, the signature to all but the three named under it"
        action={dirty ? <span className="badge badge-warning">Unsaved changes</span> : null} />
      <div className="grid gap-4 md:grid-cols-2">
        <label className={LABEL}>Signature
          <textarea className="input-field mt-1 resize-y" rows={2} maxLength={200} value={value.signature}
            disabled={save.isPending} onChange={(e) => setDraft({ ...draft, signature: e.target.value })} />
          <span className={HINT}>
            The closing lines under every mail except the reorder list and the window-time sheet, which end with their
            own Footer above, and the test mail, whose text is fixed.
          </span>
        </label>
        <label className={LABEL}>Reply-To (optional)
          <input type="email" className="input-field mt-1" maxLength={254} placeholder="name@toyota-boshoku.com"
            value={value.reply_to} disabled={save.isPending} aria-invalid={replyBad}
            onChange={(e) => setDraft({ ...draft, reply_to: e.target.value })} />
          {replyBad ? (
            <span className="mt-1 block text-[11px] font-semibold text-rose-600 dark:text-rose-400" role="alert">
              Enter a full e-mail address, or leave it empty.
            </span>
          ) : (
            <span className={HINT}>Replies go to this address. Leave it empty and they go to the sending mailbox.</span>
          )}
        </label>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 dark:border-navy-800">
        {dirty && (
          <button type="button" className="btn-secondary" onClick={() => setDraft({})} disabled={save.isPending}>Undo changes</button>
        )}
        <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-40" onClick={() => save.mutate(changes)}
          disabled={!dirty || replyBad || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]" aria-busy="true">
      <div className="card space-y-2 !p-3">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-9 w-full" />)}
      </div>
      <div className="card space-y-3">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-9 w-full" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-20 w-full" />
      </div>
    </div>
  );
}

function TemplatesScreen() {
  const q = useQuery({
    queryKey: mailKeys.templates,
    queryFn: () => mailEngineService.templates().then((r) => r.data.data),
  });
  const templates = q.data?.templates || [];

  return (
    <div className="space-y-5">
      <PageHead icon={FileText} title="Email Templates"
        hint="The wording of each mail the engine sends — subject, opening lines and closing lines — and the sender identity: the shared signature and the Reply-To address." />

      {q.isPending ? (
        <Skeleton />
      ) : !q.data ? (
        <div className="card">
          <ErrorState title="Could not load the templates"
            message={q.error?.response?.data?.message || "The server did not answer, so no template is shown."}
            onRetry={() => q.refetch()} />
        </div>
      ) : (
        <>
          {templates.length > 0 ? (
            <TemplateWorkspace templates={templates} />
          ) : (
            <div className="card py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              The server lists no mail type to write a template for.
            </div>
          )}
          <IdentityCard identity={q.data.identity} />
        </>
      )}
    </div>
  );
}

export default function EmailTemplates() {
  return (
    <AdminOnly>
      <TemplatesScreen />
    </AdminOnly>
  );
}
