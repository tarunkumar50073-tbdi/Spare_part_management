import React, { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight, ChevronRight, CornerDownRight, IndianRupee, RotateCcw, Search, SendHorizontal, X,
} from "lucide-react";
import Glyph from "./Glyph.jsx";
import { assistantService } from "../services/assistantService.js";
import { compactMoney, money } from "../lib/format.js";

// The floating "Ask" assistant, rendered once by MainLayout on every signed-in
// screen. A red launcher bottom-right opens a chat panel that answers from THIS
// app's own data (assistantService.ask -> the backend's keyword assistant, which
// reads plain English and the Hinglish a keeper types) and links to the right
// screen. No external AI: the store decided on 18 Oct 2026 not to connect a
// model for now, so this is the app's own assistant, dressed properly.
//
// Redesigned 18 Oct 2026 because the store found it too plain — "koi na bhai app
// asistant ko badiya design kar do ye thoda simple dikh rha h". So: a Toyota-red
// header with an avatar and a live dot, a greeting, part cards in the store's
// own stock colours, a figure card for a ₹ answer, typing dots while it looks,
// and a bottom sheet on a phone. A chat you type into, nothing to pick from:
// the one-tap question buttons went the same day ("assistant par puch kar jawab
// lenge ... usme list ya quick button ki kya jarurat h"). Then a robot ("asistant
// koa look robotic style me" — 18 Oct 2026): a robot face with glowing eyes that
// blink (RobotFace), a dark control-panel header with a grid and a slow scan
// line, a "processing" read-out while it looks. Since 23 Oct 2026 the face is
// the plant's safety mascot instead of the robot ("mere app ka assitant aisa
// ladka ko bna de" — the boy on the safety-days tag: TB cap, safety goggles,
// hi-vis vest) on the Ask chip's Toyota red (MascotFace). And glass, as on an iPhone
// ("bhai asiistant ko glassy look do ... jaisa iphone me hota h" — 18 Oct 2026):
// the panel and everything in it frosted and see-through, the page behind
// blurred, a bright top edge on each surface (GLASS). The API, the routes a
// card opens and the error text are the same as before.
//
// Movable ("bhai chatbot movable ho" — 21 Oct 2026): the launcher drags
// anywhere on the screen (mouse or finger — a short tap still opens it), the
// panel drags by its header on a wide screen (on a phone it stays the bottom
// sheet), both stay inside the window and are kept on this browser, and a
// double-click on the header puts both back in their corner. Opened from a
// moved launcher, the panel opens beside it.

const ERROR_TEXT = "Sorry — I couldn't reach the data just now. Please try again.";
const MAX_LEN = 300;

// A part's stock status in the store's own colours (14 Oct 2026: "dark red at
// zero, red at or below min or reorder, green in between, yellow above max, grey
// not counted") — the same fills and text as the Daily Stock Report and the
// reorder mail (backend stock_mis_report.py LEVEL_BANDS), so a status reads the
// same in the assistant as on paper. Anything else in `right` ("12 used" on the
// most-consumed list) is a plain grey pill.
const LEVEL_PILL = {
  "Out of Stock": "bg-red-600 text-white",
  "Below Minimum": "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  Reorder: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  Healthy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  "Above Maximum": "bg-yellow-100 text-yellow-800 dark:bg-yellow-400/20 dark:text-yellow-200",
  "Not Counted": "bg-gray-200 text-gray-600 dark:bg-slate-500/25 dark:text-slate-200",
  Discontinued: "bg-slate-200 text-slate-700 dark:bg-slate-600/40 dark:text-slate-200",
};
const OTHER_PILL = "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300";

// Keyframes live here rather than in index.css so the widget stays one file;
// anyone whose OS asks for reduced motion gets none of it (as index.css does).
// The launcher's ring rests for the last third of each cycle — this button sits
// on screens that run all day, so it should invite, not nag.
const CSS = `
@keyframes dxa-panel-in { from { opacity: 0; transform: translateY(14px) scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes dxa-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dxa-ring { 0% { box-shadow: 0 0 0 0 rgba(235,10,30,0.42); } 65%, 100% { box-shadow: 0 0 0 14px rgba(235,10,30,0); } }
@keyframes dxa-q { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes dxa-dot { 0%, 80%, 100% { transform: translateY(0); opacity: 0.35; } 40% { transform: translateY(-3px); opacity: 1; } }
@keyframes dxa-icon-in { from { opacity: 0; transform: rotate(-90deg) scale(0.6); } to { opacity: 1; transform: none; } }
@keyframes dxa-blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.12); } }
@keyframes dxa-antenna { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes dxa-scan { 0% { transform: translateY(-4px); opacity: 0; } 15%, 85% { opacity: 1; } 100% { transform: translateY(84px); opacity: 0; } }
.dxa-panel-in { animation: dxa-panel-in 260ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
.dxa-fade { animation: dxa-fade 200ms ease-out both; }
.dxa-ring { animation: dxa-ring 3.2s cubic-bezier(0.22, 0.61, 0.36, 1) infinite; }
.dxa-dot { animation: dxa-dot 1.2s ease-in-out infinite; }
.dxa-icon-in { animation: dxa-icon-in 220ms cubic-bezier(0.22, 0.61, 0.36, 1) both; }
.dxa-eyes { transform-box: fill-box; transform-origin: center; animation: dxa-blink 4.8s ease-in-out infinite; }
.dxa-antenna { animation: dxa-antenna 1.8s ease-in-out infinite; }
.dxa-scan { animation: dxa-scan 4.5s linear infinite; }
.dxa-q { animation: dxa-q 2.4s ease-in-out infinite; }
.dxa-glow { filter: drop-shadow(0 0 1.6px rgba(34, 211, 238, 0.95)); }
@media (prefers-reduced-motion: reduce) {
  .dxa-panel-in, .dxa-fade, .dxa-ring, .dxa-dot, .dxa-icon-in, .dxa-eyes, .dxa-antenna, .dxa-scan, .dxa-q {
    animation: none !important;
  }
}
`;

// A faint control-panel grid that fades in toward the header's right edge —
// texture, not decoration you read.
const HEADER_GRID = {
  backgroundImage: "linear-gradient(rgba(34,211,238,0.16) 1px, transparent 1px), "
    + "linear-gradient(90deg, rgba(34,211,238,0.16) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
  WebkitMaskImage: "linear-gradient(110deg, transparent 25%, #000 85%)",
  maskImage: "linear-gradient(110deg, transparent 25%, #000 85%)",
};

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50";
// Frosted glass, the iPhone way: a see-through white that blurs and saturates
// what is behind it, a hairline white border and a bright top edge. Dark mode:
// a whisper of white on navy.
const GLASS = "border border-white/70 bg-white/55 backdrop-blur-xl backdrop-saturate-150 "
  + "shadow-[0_6px_18px_-8px_rgba(15,31,56,0.22),inset_0_1px_0_rgba(255,255,255,0.9)] "
  + "dark:border-white/10 dark:bg-white/[0.07] "
  + "dark:shadow-[0_6px_18px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)]";
// A slim, tinted scrollbar for the panel's own scroll boxes — Windows draws the
// classic grey bar with arrows otherwise, which looked heavy inside the chat.
const THIN_SCROLL = "[scrollbar-width:thin] [scrollbar-color:rgba(148,163,184,0.45)_transparent]";

const media = (q) => typeof window !== "undefined" && !!window.matchMedia?.(q).matches;
const reducedMotion = () => media("(prefers-reduced-motion: reduce)");
// A touch screen (the 9:16 HMI, a phone): focusing the input there pops the
// on-screen keyboard over the greeting before anyone asked for it, so focus
// goes to the panel itself and the keyboard waits for a tap on the input.
const coarsePointer = () => media("(pointer: coarse)");
// The panel drags only where it is a floating window, not the phone's sheet.
const isWide = () => media("(min-width: 640px)");

// Where the launcher and the panel were left: their top-left corner on this
// browser, read back inside the window. Storage may be off (a private window):
// then they simply start in their corner.
const POS_KEYS = { launcher: "dx_bot_launcher_pos", panel: "dx_bot_panel_pos" };
function clampTo(x, y, w, h, m = 8) {
  if (typeof window === "undefined") return { x, y };
  return {
    x: Math.round(Math.min(Math.max(m, x), Math.max(m, window.innerWidth - w - m))),
    y: Math.round(Math.min(Math.max(m, y), Math.max(m, window.innerHeight - h - m))),
  };
}
function readPos(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? clampTo(v.x, v.y, 48, 48) : null;
  } catch {
    return null;
  }
}
function savePos(key, v) {
  try {
    if (v) localStorage.setItem(key, JSON.stringify(v));
    else localStorage.removeItem(key);
  } catch {
    // Storage off: the place is just not kept.
  }
}

// "14:05" on this machine's clock, which is the plant's.
const clock = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// The server words a stock value as "₹12,345,678" (Python's grouping). Read the
// number back so the card can show it the Indian way (₹1,23,45,678) beside the
// crore / lakh figure the plant says out loud. Not a ₹ figure -> null.
const rupees = (text) => {
  const s = String(text ?? "").trim();
  if (!s.startsWith("₹")) return null;
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export default function AssistantWidget() {
  const navigate = useNavigate();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  // Empty = the welcome screen. Each message: { id, at, role, text, ... }.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const launcherRef = useRef(null);
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const lastRef = useRef(null);
  const inputRef = useRef(null);
  const nextId = useRef(1);
  // Bumped by "New chat", so an answer still on its way lands nowhere instead
  // of in the fresh chat.
  const chatRef = useRef(0);
  const wasOpenRef = useRef(false);
  const scrolledOpenRef = useRef(false);
  // Moved places ({x, y}, null = the corner) and the drag under way.
  const [launcherPos, setLauncherPos] = useState(() => readPos(POS_KEYS.launcher));
  const [panelPos, setPanelPos] = useState(() => readPos(POS_KEYS.panel));
  const [wide, setWide] = useState(isWide);
  const [, setViewport] = useState(0);
  const dragRef = useRef(null);

  // Keep both inside the window when it changes size (and once on load, now
  // that their real size is known).
  useEffect(() => {
    const fit = () => {
      setWide(isWide());
      setViewport((n) => n + 1);
      const keep = (ref, set) => set((p) => {
        if (!p) return p;
        const r = ref.current?.getBoundingClientRect();
        return clampTo(p.x, p.y, r?.width || 48, r?.height || 48);
      });
      keep(launcherRef, setLauncherPos);
      keep(panelRef, setPanelPos);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const dragStart = (kind) => (e) => {
    if (e.button > 0) return;                                 // left button, a finger or a pen
    if (kind === "panel" && (!wide || e.target.closest("button"))) return;
    const el = kind === "launcher" ? launcherRef.current : panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { kind, id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top,
      w: r.width, h: r.height, moved: false, at: null, el: e.currentTarget };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows it while over the element.
    }
  };
  const dragMove = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;          // a tap, not a drag
    d.moved = true;
    d.at = clampTo(d.ox + dx, d.oy + dy, d.w, d.h);
    (d.kind === "launcher" ? setLauncherPos : setPanelPos)(d.at);
  };
  const dragEnd = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    try {
      d.el.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released.
    }
    if (d.moved) savePos(POS_KEYS[d.kind], d.at);
    // The click that follows a drag must not open or close the panel.
    dragRef.current = d.moved ? { dragged: true } : null;
  };
  const resetPlace = () => {
    setLauncherPos(null);
    setPanelPos(null);
    savePos(POS_KEYS.launcher, null);
    savePos(POS_KEYS.panel, null);
  };
  // The panel's top-left: where it was dragged; else, opened from a moved
  // launcher, beside it without covering it — above it, below it, to its right
  // or its left, the first that fits the window; else its corner (null, the
  // classes place it).
  const panelAt = (() => {
    if (!wide || typeof window === "undefined") return null;
    if (panelPos) return panelPos;
    if (!launcherPos) return null;
    const w = Math.min(400, window.innerWidth - 40);
    const h = Math.min(608, window.innerHeight - 128);
    const L = launcherPos;
    const side = 48;                                         // the open launcher: a 48 px circle
    const atX = (x) => clampTo(x, 0, w, h).x;
    const atY = (y) => clampTo(0, y, w, h).y;
    const fits = ({ x, y }) => x >= 8 && y >= 8 && x + w <= window.innerWidth - 8 && y + h <= window.innerHeight - 8;
    const choices = [
      { x: atX(L.x + side - w), y: L.y - h - 12 },          // above
      { x: atX(L.x + side - w), y: L.y + side + 12 },       // below
      { x: L.x + side + 12, y: atY(L.y + side - h) },       // right
      { x: L.x - w - 12, y: atY(L.y + side - h) },          // left
    ];
    return choices.find(fits) || clampTo(choices[0].x, choices[0].y, w, h);
  })();
  const placed = (at) => (at ? { left: at.x, top: at.y, right: "auto", bottom: "auto" } : undefined);

  const add = (msg) => setMessages((m) => [...m, { id: nextId.current++, at: new Date(), ...msg }]);

  // Focus into the panel on open; back to the launcher on close, so a keyboard
  // user is never dropped at the top of the page. The effect runs after the
  // panel is in the DOM, so no frame wait is needed.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      (coarsePointer() ? panelRef.current : inputRef.current)?.focus({ preventScroll: true });
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      launcherRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  // Newest message into view. A long answer (six part cards and screen links) is
  // read from its first line, so that one scrolls to its top, not its bottom.
  // The first scroll after opening jumps; later ones glide.
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) {
      scrolledOpenRef.current = false;
      return;
    }
    const instant = !scrolledOpenRef.current || reducedMotion();
    scrolledOpenRef.current = true;
    const latest = messages[messages.length - 1];
    const last = lastRef.current;
    let top = body.scrollHeight;
    if (messages.length === 0) top = 0;
    else if (!busy && latest?.role === "bot" && last && last.offsetHeight > body.clientHeight - 32) {
      top = Math.max(0, last.offsetTop - 12);
    }
    body.scrollTo({ top, behavior: instant ? "auto" : "smooth" });
  }, [open, messages, busy]);

  const close = () => setOpen(false);

  const go = (route) => {
    if (!route) return;
    navigate(route);
    setOpen(false);
  };

  const reset = () => {
    chatRef.current += 1;
    setMessages([]);
    setInput("");
    setBusy(false);
    // The New chat button is about to disable itself; keep focus in the panel.
    (coarsePointer() ? panelRef.current : inputRef.current)?.focus({ preventScroll: true });
  };

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    const chat = chatRef.current;
    add({ role: "user", text: q });
    setInput("");
    setBusy(true);
    try {
      const res = await assistantService.ask(q);
      if (chat !== chatRef.current) return;
      const d = res.data.data;
      add({ role: "bot", text: d.answer, results: d.results || [], suggestions: d.suggestions || [] });
    } catch {
      if (chat !== chatRef.current) return;
      add({ role: "bot", text: ERROR_TEXT, results: [], suggestions: [], error: true, retry: q });
    } finally {
      if (chat === chatRef.current) setBusy(false);
    }
  };

  return (
    <>
      <style>{CSS}</style>

      {/* On a phone the panel is a sheet over the page: dim what is behind it,
          and a tap there closes it. On a desktop it stays a popover beside the
          page you are working on. */}
      {open && (
        <div aria-hidden="true" onClick={close}
          className="dxa-fade fixed inset-0 z-40 bg-navy-950/25 backdrop-blur-sm sm:hidden" />
      )}

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Store Saathi"
          tabIndex={-1}
          style={placed(panelAt)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          className="dxa-panel-in fixed inset-x-4 bottom-[5.25rem] z-50 flex h-[min(75dvh,calc(100dvh-6.5rem))]
            origin-bottom flex-col overflow-hidden rounded-[28px] border border-white/60 bg-white/45
            backdrop-blur-3xl backdrop-saturate-[1.8]
            shadow-[0_28px_70px_-18px_rgba(15,31,56,0.45),inset_0_1px_0_rgba(255,255,255,0.95)] ring-1 ring-black/5
            focus:outline-none
            sm:left-auto sm:right-5 sm:bottom-24 sm:h-[min(38rem,calc(100dvh-8rem))] sm:w-[25rem]
            sm:max-w-[calc(100vw-2.5rem)] sm:origin-bottom-right
            dark:border-white/15 dark:bg-[#0b1324]/55 dark:ring-white/5
            dark:shadow-[0_28px_70px_-18px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.12)]"
        >
          {/* Tint and sheen behind the content: a breath of Toyota red at the
              top, the robot's cyan at the bottom, light catching the top edge. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0
            bg-[radial-gradient(120%_55%_at_100%_0%,rgba(235,10,30,0.14),transparent_60%),radial-gradient(110%_55%_at_0%_100%,rgba(34,211,238,0.14),transparent_60%)]" />
          <div aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-white/60 to-transparent dark:from-white/[0.06]" />
          <Header onNew={reset} canReset={messages.length > 0 || busy} onClose={close} movable={wide}
            onPointerDown={dragStart("panel")} onPointerMove={dragMove} onPointerUp={dragEnd}
            onPointerCancel={dragEnd} onReset={resetPlace} />

          <div
            ref={bodyRef}
            aria-live="polite"
            className={`relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4
              ${THIN_SCROLL}`}
          >
            {messages.length === 0 ? (
              <Welcome />
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) => {
                  const latest = i === messages.length - 1;
                  return (
                    <div key={m.id} ref={latest ? lastRef : undefined} className="animate-rise">
                      {m.role === "user" ? (
                        <div className="flex flex-col items-end">
                          <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md
                            bg-gradient-to-br from-toyotared to-[#b00816] px-3.5 py-2.5 text-[13.5px] leading-relaxed
                            text-white shadow-[0_8px_18px_-8px_rgba(235,10,30,0.7),inset_0_1px_0_rgba(255,255,255,0.35)]">
                            {m.text}
                          </p>
                          <Stamp at={m.at} className="pr-1" />
                        </div>
                      ) : (
                        <BotMessage m={m} latest={latest} busy={busy} onGo={go} onAsk={send} />
                      )}
                    </div>
                  );
                })}
                {busy && <Typing />}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="relative shrink-0 border-t border-white/50 bg-white/30 px-3 pb-3 pt-2.5 backdrop-blur-xl
              dark:border-white/10 dark:bg-white/[0.03]"
          >
            <div className="flex items-center gap-2 rounded-full border border-white/80 bg-white/60 py-1 pl-3.5 pr-1
              shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_4px_14px_-6px_rgba(15,31,56,0.2)] backdrop-blur-xl
              transition focus-within:border-toyotared/50 focus-within:bg-white/80 focus-within:ring-2
              focus-within:ring-toyotared/30 dark:border-white/15 dark:bg-white/[0.07] dark:focus-within:bg-white/[0.1]">
              <Search size={16} aria-hidden="true" className="shrink-0 text-slate-400" />
              {/* 16px on a phone: anything smaller and iOS zooms the page in on tap. */}
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={MAX_LEN}
                aria-label="Your question"
                placeholder="Ask about stock, a part, a screen…"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="send"
                className="min-w-0 flex-1 bg-transparent py-1.5 text-base text-slate-800 placeholder:text-slate-400
                  focus:outline-none sm:text-[14px] dark:text-white dark:placeholder:text-slate-500"
              />
              {input.length > MAX_LEN - 60 && (
                <span className="shrink-0 text-[10.5px] tabular text-slate-500 dark:text-slate-400">
                  {input.length}/{MAX_LEN}
                </span>
              )}
              <button
                type="submit"
                aria-label="Send"
                title="Send (Enter)"
                disabled={busy || !input.trim()}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#ff2a3c]
                  to-toyotared text-white shadow-[0_6px_14px_-4px_rgba(235,10,30,0.65)] transition
                  hover:brightness-110 active:scale-95 ${FOCUS}
                  disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none
                  dark:disabled:from-navy-700 dark:disabled:to-navy-700`}
              >
                <SendHorizontal size={17} aria-hidden="true" />
              </button>
            </div>
          </form>
        </div>
      )}

      {/* The launcher: a red "Ask" pill with a soft glow and a slow ring while
          closed; a round close button while the panel is open. */}
      <button
        ref={launcherRef}
        type="button"
        // On a phone the open sheet leaves room for the close button in its
        // corner only: there it sits while the sheet is up.
        style={placed(open && !wide ? null : launcherPos)}
        onPointerDown={dragStart("launcher")}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
        onClick={() => {
          if (dragRef.current?.dragged) {
            dragRef.current = null;
            return;
          }
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) close();
        }}
        aria-label={open ? "Close Store Saathi" : "Ask Store Saathi"}
        title={open ? "Close (drag to move)" : "Ask Store Saathi (drag to move)"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="group fixed bottom-5 right-5 z-50 grid h-16 w-16 touch-none select-none place-items-center rounded-full
          transition-transform duration-200 ease-enterprise motion-safe:hover:-translate-y-0.5
          active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-4
          focus-visible:ring-amber-400/60"
      >
        {/* The safety mascot in a round (the store, 23 Oct 2026: "ye red wala
            htakar kewal ladka rhe round me"), and — "bas 1 ? mark and ask likha
            ho" — one "?" in a speech bubble at his head and an Ask chip on the
            round's lower edge while the panel is shut. */}
        {!open && <span aria-hidden="true" className="dxa-ring pointer-events-none absolute inset-0 rounded-full" />}
        <span aria-hidden="true"
          className="relative grid h-16 w-16 place-items-center overflow-hidden rounded-full bg-gradient-to-b from-[#ff2a3c] to-toyotared
            ring-[3px] ring-white shadow-[0_10px_26px_rgba(235,10,30,0.4)] transition group-hover:brightness-105">
          <MascotFace size={62} />
        </span>
        {!open && (
          <>
            <span aria-hidden="true"
              className="dxa-q pointer-events-none absolute -right-2.5 -top-2.5 grid h-7 w-7 place-items-center rounded-full
                rounded-bl-[4px] bg-white text-[17px] font-black leading-none text-toyotared ring-1 ring-slate-200
                shadow-[0_4px_12px_rgba(15,31,56,0.25)]">?</span>
            <span aria-hidden="true"
              className="pointer-events-none absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full
                bg-gradient-to-b from-[#ff2a3c] to-toyotared px-3 py-[3px] text-[11px] font-bold uppercase leading-none
                tracking-[0.12em] text-white ring-2 ring-white shadow-[0_4px_10px_rgba(235,10,30,0.45)]">Ask</span>
          </>
        )}
        {open && (
          <span key="close" aria-hidden="true"
            className="dxa-icon-in absolute -right-1 -top-1 grid h-6 w-6 place-items-center rounded-full bg-navy-900 text-white
              ring-2 ring-white shadow">
            <X size={14} strokeWidth={3} />
          </span>
        )}
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

// The header is the panel's handle: drag it to move the panel (a wide screen),
// double-click it to put the panel and the launcher back in their corner. The
// grabber bar on top says so, the way an iPhone sheet does.
function Header({ onNew, canReset, onClose, movable, onReset, ...drag }) {
  return (
    <div {...drag} onDoubleClick={(e) => { if (!e.target.closest("button")) onReset(); }}
      title={movable ? "Drag to move · double-click to put it back" : undefined}
      className={`relative shrink-0 select-none overflow-hidden border-b border-white/50 text-slate-900
        dark:border-white/10 dark:text-white ${movable ? "cursor-grab touch-none active:cursor-grabbing" : ""}`}>
      <div aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-slate-400/60 dark:bg-white/30" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60" style={HEADER_GRID} />
      <div aria-hidden="true"
        className="dxa-scan pointer-events-none absolute inset-x-0 top-1 h-px bg-gradient-to-r from-transparent via-cyan-400/70 to-transparent" />

      <div className="relative flex items-center gap-3 px-4 pb-3.5 pt-4">
        <span aria-hidden="true"
          className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl bg-gradient-to-b from-[#ff2a3c] to-toyotared
            shadow-[0_0_0_1px_rgba(255,255,255,0.6),0_8px_20px_-6px_rgba(235,10,30,0.7)]">
          <MascotFace size={46} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold leading-tight tracking-tight">Store Saathi</h2>
          <p className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-cyan-700 dark:text-cyan-200/90">
            <span aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.95)]" />
            <span className="leading-snug">Online · store data</span>
          </p>
        </div>
        <HeaderButton label="New chat" onClick={onNew} disabled={!canReset}>
          <RotateCcw size={17} aria-hidden="true" />
        </HeaderButton>
        <HeaderButton label="Close" onClick={onClose}>
          <X size={19} aria-hidden="true" />
        </HeaderButton>
      </div>
    </div>
  );
}

// Round glass buttons, as an iPhone draws them on a frosted bar.
function HeaderButton({ label, onClick, disabled, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/70 bg-white/50 text-slate-700
        shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-xl transition hover:bg-white/80 hover:text-slate-900
        active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${FOCUS}
        dark:border-white/15 dark:bg-white/10 dark:text-slate-100 dark:hover:bg-white/20`}>
      {children}
    </button>
  );
}

function BotAvatar() {
  return (
    <span aria-hidden="true"
      className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-b from-[#ff2a3c] to-toyotared
        shadow-[0_4px_10px_-3px_rgba(235,10,30,0.6)] ring-2 ring-white dark:ring-navy-950">
      <MascotFace size={31} />
    </span>
  );
}

// The bot's face: the plant's safety mascot — a boy in the navy Toyota Boshoku
// cap with the real TB mark (public/tb-favicon.png) and TOYOTA BOSHOKU under it,
// light-blue safety goggles, rosy cheeks and a smile, in the TB uniform — white,
// the TB mark on the chest over a red stripe, a green collar, a hi-vis vest
// (the store, 23 Oct 2026: "cap par tb logo and tb ki uniform hono chahiye"),
// on the Ask chip's Toyota red ("ladke ka back color bhi ask color jaisa"). His eyes blink
// now and then behind the goggles (not for reduced motion). Drawn to fill a
// round or rounded tile.
function MascotFace({ size = 24, className = "" }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className={className}>
      {/* uniform, collar and the hi-vis vest with its reflective strips */}
      <path d="M7 64 C8 52 18 47 32 47 C46 47 56 52 57 64 Z" fill="#f8fafc" />
      <path d="M12.5 64 C13 56 15.5 51.5 21.5 49.2 L24.5 64 Z" fill="#d9f99d" />
      <path d="M51.5 64 C51 56 48.5 51.5 42.5 49.2 L39.5 64 Z" fill="#d9f99d" />
      <path d="M13.6 56.2 L22.9 55.4 M13.1 60.2 L23.7 59.6" stroke="#94a3b8" strokeWidth="1.7" />
      <path d="M50.4 56.2 L41.1 55.4 M50.9 60.2 L40.3 59.6" stroke="#94a3b8" strokeWidth="1.7" />
      <path d="M25 47.6 L32 55.5 L39 47.6 L36.2 46.8 L32 51.4 L27.8 46.8 Z" fill="#15803d" />
      {/* the TB uniform: the real TB mark on the chest, a red stripe under it */}
      <image href="/tb-favicon.png" x="34.2" y="51.6" width="8.4" height="8.4" preserveAspectRatio="xMidYMid meet" />
      <rect x="33.8" y="60.2" width="9.4" height="1.5" rx="0.6" fill="#dc2626" />
      {/* neck, ears, face */}
      <rect x="28" y="40.5" width="8" height="7.5" rx="2.5" fill="#efc29c" />
      <circle cx="18.6" cy="33.5" r="3.1" fill="#efc29c" />
      <circle cx="45.4" cy="33.5" r="3.1" fill="#efc29c" />
      <ellipse cx="32" cy="32.5" rx="13.4" ry="13" fill="#f8d7b8" />
      {/* hair under the cap */}
      <path d="M18.7 27.5 C18.9 33 19.8 36 21.2 37.6 L22 27.5 Z" fill="#6b3f22" />
      <path d="M45.3 27.5 C45.1 33 44.2 36 42.8 37.6 L42 27.5 Z" fill="#6b3f22" />
      <path d="M21 27.6 C24 29.6 27.5 29.2 30 27.6 C32.5 29.4 37 29.6 43 27.6 Z" fill="#6b3f22" />
      {/* the cap: crown, peak, the real TB mark and TOYOTA BOSHOKU under it */}
      <path d="M17 26.5 C17 14.5 24 8.5 32 8.5 C40 8.5 47 14.5 47 26.5 Z" fill="#1e2a5e" />
      <path d="M15.5 26.2 C24 23 40 23 50.5 27.2 C47.5 29.6 40 28.6 32 28.3 C25 28.1 19 28.9 15.5 26.2 Z" fill="#141c45" />
      <image href="/tb-favicon.png" x="25.5" y="9.6" width="13" height="10.4" preserveAspectRatio="xMidYMid meet" />
      <text x="32" y="22.3" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="2.6" fontWeight="700"
        fill="#ffffff" textLength="16" lengthAdjust="spacingAndGlyphs">TOYOTA BOSHOKU</text>
      {/* safety goggles, with the eyes behind them */}
      <rect x="19.4" y="29.2" width="25.2" height="8.8" rx="4.2" fill="#cdeefc" stroke="#1f2937" strokeWidth="1.6" />
      <path d="M32 29.6 L32 37.6" stroke="#1f2937" strokeWidth="1.1" />
      <g className="dxa-eyes">
        <ellipse cx="26.4" cy="33.6" rx="1.7" ry="2.2" fill="#1f2937" />
        <ellipse cx="37.6" cy="33.6" rx="1.7" ry="2.2" fill="#1f2937" />
        <circle cx="27" cy="32.8" r="0.6" fill="#ffffff" />
        <circle cx="38.2" cy="32.8" r="0.6" fill="#ffffff" />
      </g>
      <path d="M21.5 31 L24 30.4" stroke="#ffffff" strokeWidth="1" strokeLinecap="round" opacity="0.9" />
      {/* cheeks and the smile */}
      <circle cx="23" cy="40.4" r="2.3" fill="#fca5a5" opacity="0.75" />
      <circle cx="41" cy="40.4" r="2.3" fill="#fca5a5" opacity="0.75" />
      <path d="M28.4 40.6 Q32 44.6 35.6 40.6" stroke="#dc2626" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function Stamp({ at, className = "" }) {
  if (!at) return null;
  return (
    <time dateTime={at.toISOString()}
      className={`mt-1 block text-[10.5px] tabular text-slate-500 dark:text-slate-400 ${className}`}>
      {clock(at)}
    </time>
  );
}

// The greeting, in Hinglish for the floor and Japanese for the plant's Japanese
// colleagues (the store, 23 Oct 2026: "Store Saathi kar de aur msg Hinglish and
// japoenese me"). The Japanese line says to ask in English or Hinglish — the
// question reader does not read Japanese.
function Welcome() {
  return (
    <div className="animate-rise flex items-start gap-2.5">
      <BotAvatar />
      <div className={`min-w-0 flex-1 rounded-2xl rounded-tl-md px-4 py-3 ${GLASS}`}>
        <p className="text-[15px] font-bold tracking-tight text-slate-900 dark:text-white">
          Namaste! Main aapka Store Saathi hoon.
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
          Stock, part number ya koi screen — kuch bhi poochiye, jaise “stock khatam”, “kitne ka stock hai”,
          “reorder”, “CNTR3200”.
        </p>
        <div className="mt-2.5 border-t border-slate-200/70 pt-2.5 dark:border-white/10" lang="ja">
          <p className="text-[14px] font-bold tracking-tight text-slate-900 dark:text-white">
            こんにちは！ストア・サーティです。
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300">
            在庫・品番・開きたい画面について、英語またはヒングリッシュで質問してください。
            例：「stock khatam」「reorder」「CNTR3200」
          </p>
        </div>
      </div>
    </div>
  );
}

function BotMessage({ m, latest, busy, onGo, onAsk }) {
  const results = m.results || [];
  const suggestions = m.suggestions || [];
  return (
    <div className="flex items-start gap-2.5">
      <BotAvatar />
      <div className="min-w-0 flex-1">
        <p className={`w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border px-3.5 py-2.5
          text-[13.5px] leading-relaxed ${m.error
            ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
            : `${GLASS} text-slate-700 dark:text-slate-100`}`}>
          {m.text}
        </p>

        {m.error && m.retry && latest && (
          <button type="button" onClick={() => onAsk(m.retry)} disabled={busy}
            className={`mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-full border border-rose-200 bg-white/70 px-3
              text-[12px] font-semibold text-toyotared transition hover:bg-rose-50 disabled:opacity-50 ${FOCUS}
              backdrop-blur-xl dark:border-rose-500/30 dark:bg-white/[0.07] dark:text-rose-200 dark:hover:bg-white/10`}>
            <RotateCcw size={13} aria-hidden="true" /> Try again
          </button>
        )}

        {results.length > 0 && (
          <div className="mt-2.5 space-y-2">
            {results.map((r, j) => (r.kind === "stat"
              ? <StatCard key={j} r={r} onGo={onGo} />
              : <PartCard key={j} r={r} onGo={onGo} />))}
          </div>
        )}

        {suggestions.length > 0 && <Suggestions items={suggestions} onGo={onGo} />}

        <Stamp at={m.at} className="pl-1" />
      </div>
    </div>
  );
}

function StatusPill({ text }) {
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold leading-4
      ${LEVEL_PILL[text] || OTHER_PILL}`}>
      {text}
    </span>
  );
}

// A part as a card. On a ranked answer ("top 10 excess value") the server adds
// `rank` and `metric` — the figure asked for — so the card leads with its place
// and the ₹ / qty, and the stock status moves under it.
function PartCard({ r, onGo }) {
  return (
    <button type="button" onClick={() => onGo(r.route)}
      className={`group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left ${GLASS}
        transition duration-200 ease-enterprise hover:border-toyotared/40 hover:bg-white/75
        motion-safe:hover:-translate-y-0.5 active:translate-y-0 ${FOCUS}
        dark:hover:border-toyotared/50 dark:hover:bg-white/[0.11]`}>
      {r.rank != null && (
        <span aria-label={`Rank ${r.rank}`}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-[11.5px] font-bold tabular
            ${r.rank <= 3
              ? "bg-gradient-to-br from-[#ff2a3c] to-[#b00816] text-white shadow-[0_4px_10px_-4px_rgba(235,10,30,0.7)]"
              : "border border-white/70 bg-white/60 text-slate-600 dark:border-white/10 dark:bg-white/10 dark:text-slate-200"}`}>
          {r.rank}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-all font-mono text-[12.5px] font-bold leading-5 tracking-tight text-slate-900 dark:text-white">
            {r.title}
          </span>
          {r.metric
            ? <span className="shrink-0 whitespace-nowrap text-[13px] font-extrabold leading-5 tabular text-toyotared dark:text-rose-300">{r.metric}</span>
            : r.right && <StatusPill text={r.right} />}
        </span>
        {r.subtitle && (
          <span className="mt-0.5 block break-words text-[12px] leading-snug text-slate-600 dark:text-slate-300">
            {r.subtitle}
          </span>
        )}
        {(r.detail || (r.metric && r.right)) && (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {r.detail && (
              <span className="min-w-0 break-words text-[11px] tabular text-slate-500 dark:text-slate-400">{r.detail}</span>
            )}
            {r.metric && r.right && <StatusPill text={r.right} />}
          </span>
        )}
      </span>
      <ChevronRight size={16} aria-hidden="true"
        className="shrink-0 text-slate-300 transition group-hover:text-toyotared motion-safe:group-hover:translate-x-0.5
          dark:text-slate-600" />
    </button>
  );
}

function StatCard({ r, onGo }) {
  const n = rupees(r.right);
  const figure = n != null ? money(n) : r.right;
  const spoken = n != null && n >= 1e5 ? compactMoney(n) : null;
  return (
    <button type="button" onClick={() => onGo(r.route)}
      className={`group relative w-full overflow-hidden rounded-2xl border border-white/70 bg-gradient-to-br
        from-rose-100/70 via-white/55 to-white/40 p-4 text-left backdrop-blur-xl backdrop-saturate-150
        shadow-[0_6px_18px_-8px_rgba(15,31,56,0.22),inset_0_1px_0_rgba(255,255,255,0.9)]
        transition duration-200 ease-enterprise hover:border-toyotared/40
        motion-safe:hover:-translate-y-0.5 active:translate-y-0 ${FOCUS}
        dark:border-white/10 dark:from-toyotared/20 dark:via-white/[0.06] dark:to-white/[0.03]`}>
      <IndianRupee aria-hidden="true" size={96} strokeWidth={1.5}
        className="pointer-events-none absolute -bottom-5 -right-3 text-toyotared/[0.07] dark:text-white/[0.05]" />
      <span className="relative flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#ff2a3c] to-[#b00816]
          text-white shadow-sm">
          <IndianRupee size={14} aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {r.title}
        </span>
        <ArrowUpRight size={15} aria-hidden="true"
          className="ml-auto shrink-0 text-slate-400 transition group-hover:text-toyotared" />
      </span>
      {figure && (
        <span className="dx-radiant relative mt-3 block break-words text-[28px] font-extrabold leading-tight tracking-tight tabular">
          {figure}
        </span>
      )}
      {(spoken || r.subtitle) && (
        <span className="relative mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-500 dark:text-slate-400">
          {spoken && (
            <span className="rounded-full bg-toyotared/10 px-2 py-0.5 font-semibold text-toyotared dark:bg-toyotared/20 dark:text-rose-200">
              ≈ {spoken}
            </span>
          )}
          {r.subtitle && <span>{r.subtitle}</span>}
        </span>
      )}
    </button>
  );
}

function Suggestions({ items, onGo }) {
  return (
    <div className="mt-3">
      <p className="mb-1.5 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <CornerDownRight size={12} aria-hidden="true" /> Open a screen
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((s, j) => (
          <button key={`${s.route}-${j}`} type="button" onClick={() => onGo(s.route)}
            className={`group inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-white/70 bg-white/55
              py-1 pr-3 text-left text-[12px] font-medium leading-tight text-slate-700 backdrop-blur-xl
              shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition
              hover:border-toyotared/50 hover:text-toyotared ${FOCUS} ${s.icon ? "pl-1" : "pl-3"}
              dark:border-white/10 dark:bg-white/[0.07] dark:text-slate-200 dark:hover:border-toyotared/60 dark:hover:text-white`}>
            {s.icon && (
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500 transition-colors
                group-hover:bg-rose-50 group-hover:text-toyotared dark:bg-navy-800 dark:text-slate-300
                dark:group-hover:bg-toyotared/20 dark:group-hover:text-rose-200">
                <Glyph icon={s.icon} size={14} />
              </span>
            )}
            <span className="min-w-0 break-words">{s.title}</span>
            <ArrowUpRight size={13} aria-hidden="true"
              className="shrink-0 text-slate-400 transition group-hover:text-toyotared motion-safe:group-hover:-translate-y-px
                motion-safe:group-hover:translate-x-px" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="animate-rise flex items-start gap-2.5">
      <BotAvatar />
      <div className={`flex items-center gap-2.5 rounded-2xl rounded-tl-md px-4 py-3 ${GLASS}`}>
        <span className="sr-only">Looking it up…</span>
        <span aria-hidden="true" className="flex items-center gap-1">
          {[0, 160, 320].map((delay) => (
            <span key={delay} className="dxa-dot h-2 w-2 rounded-full bg-cyan-500 shadow-[0_0_6px_rgba(34,211,238,0.8)]
              dark:bg-cyan-300" style={{ animationDelay: `${delay}ms` }} />
          ))}
        </span>
        <span aria-hidden="true"
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
          Processing
        </span>
      </div>
    </div>
  );
}
