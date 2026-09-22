import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Send, X, ArrowUpRight, CornerDownRight } from "lucide-react";
import { assistantService } from "../services/assistantService.js";

const GREETING = {
  role: "bot",
  text: "Hi! Ask me about your stock — try “reorder”, “out of stock”, “stock value”, a part number, or a screen like “scan part”.",
  results: [],
  suggestions: [],
};

// A floating helper that answers from the app's own data. It never leaves the
// app: it queries this store's figures and links you to the right screen.
export default function AssistantWidget() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const go = (route) => {
    if (!route) return;
    navigate(route);
    setOpen(false);
  };

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setBusy(true);
    try {
      const res = await assistantService.ask(q);
      const d = res.data.data;
      setMessages((m) => [...m, {
        role: "bot", text: d.answer, results: d.results || [], suggestions: d.suggestions || [],
      }]);
    } catch {
      setMessages((m) => [...m, {
        role: "bot", text: "Sorry — I couldn't reach the data just now. Please try again.",
        results: [], suggestions: [],
      }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* the panel */}
      {open && (
        <div className="fixed bottom-24 right-5 z-50 w-[92vw] max-w-sm overflow-hidden rounded-2xl border border-slate-200
          bg-white shadow-2xl dark:border-navy-800 dark:bg-navy-900">
          <div className="flex items-center justify-between gap-2 bg-gradient-to-r from-[#ff2a3c] to-toyotared px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <Sparkles size={18} />
              <div className="leading-tight">
                <p className="text-sm font-bold">Ask</p>
                <p className="text-[11px] text-white/80">Answers from your store data</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-lg p-1 hover:bg-white/20">
              <X size={18} />
            </button>
          </div>

          <div ref={bodyRef} className="h-[52vh] max-h-[26rem] overflow-y-auto px-3 py-3 space-y-3 bg-slate-50 dark:bg-navy-950">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-toyotared text-white rounded-br-sm"
                    : "bg-white text-slate-700 border border-slate-200 rounded-bl-sm dark:bg-navy-900 dark:text-slate-200 dark:border-navy-800"}`}>
                  <p className="whitespace-pre-wrap">{m.text}</p>

                  {m.results?.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {m.results.map((r, j) => (
                        <button key={j} onClick={() => go(r.route)}
                          className="w-full text-left rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5
                            hover:border-toyotared/50 hover:bg-white transition dark:border-navy-700 dark:bg-navy-800">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-[13px] text-slate-800 dark:text-white truncate">{r.title}</span>
                            {r.right && <span className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">{r.right}</span>}
                          </div>
                          {(r.subtitle || r.detail) && (
                            <div className="text-[11px] text-slate-400 truncate">
                              {r.detail || r.subtitle}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {m.suggestions?.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-slate-400">
                        <CornerDownRight size={12} /> Open a screen
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {m.suggestions.map((s, j) => (
                          <button key={j} onClick={() => go(s.route)}
                            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1
                              text-[12px] font-medium text-slate-600 hover:border-toyotared hover:text-toyotared transition
                              dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300">
                            {s.icon && <span>{s.icon}</span>} {s.title}
                            <ArrowUpRight size={12} />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="flex justify-start"><div className="rounded-2xl bg-white border border-slate-200 px-3 py-2 text-sm text-slate-400 dark:bg-navy-900 dark:border-navy-800">Looking…</div></div>}
          </div>

          <form onSubmit={(e) => { e.preventDefault(); send(); }}
            className="flex items-center gap-2 border-t border-slate-200 bg-white px-3 py-2.5 dark:border-navy-800 dark:bg-navy-900">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about stock, a part, a screen…"
              className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm focus:outline-none
                focus:ring-2 focus:ring-toyotared/40 focus:border-toyotared dark:border-navy-700 dark:bg-navy-800"
            />
            <button type="submit" disabled={busy || !input.trim()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-toyotared text-white disabled:opacity-40 hover:brightness-110">
              <Send size={16} />
            </button>
          </form>
        </div>
      )}

      {/* the floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Ask the assistant"
        className="fixed bottom-5 right-5 z-50 inline-flex items-center gap-2 rounded-full bg-gradient-to-b from-[#ff2a3c] to-toyotared
          px-4 py-3 text-sm font-bold text-white shadow-[0_10px_30px_rgba(235,10,30,0.45)] hover:brightness-110 transition"
      >
        <Sparkles size={18} /> {open ? "Close" : "Ask"}
      </button>
    </>
  );
}
