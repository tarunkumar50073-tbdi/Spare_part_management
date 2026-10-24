import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogIn, Eye, EyeOff, RotateCw, Mail, Phone, Wrench, Clock, MapPin, ArrowUpRight, KeyRound } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext.jsx";
import { authService } from "../services/authService.js";
// Support contacts shown at the foot of the sign-in card (and in the app's
// Support / Help dialog) — kept in one place.
import { SUPPORT } from "../lib/appInfo.js";

// The Security Check, the QMP portal's way (the store, 23 Oct 2026): the SERVER
// draws a code of 2 letters + 2 numbers as a picture and checks what is typed —
// one try per code, so every failed sign-in shows a new one. Five wrong
// username / password tries block the account for 15 minutes; the server's
// message says how many tries are left.

export default function Login() {
  const { login, logoutReason } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [captchaSvg, setCaptchaSvg] = useState("");
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [captchaInput, setCaptchaInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const newCaptcha = useCallback(() => {
    setCaptchaInput("");
    setCaptchaFailed(false);
    authService.captcha()
      .then((r) => setCaptchaSvg(r.data?.data?.svg || ""))
      .catch(() => { setCaptchaSvg(""); setCaptchaFailed(true); });
  }, []);
  useEffect(() => { newCaptcha(); }, [newCaptcha]);

  // Fit the card to the screen's height: on a screen shorter than the card
  // (a 1366×768 laptop leaves ~657px), zoom the whole card down rather than
  // make the page scroll. Its natural height is read back through the zoom in
  // force, so re-fitting never compounds; never below 0.7, where a phone
  // scrolls instead. Re-fitted when a message makes the card taller.
  const cardRef = useRef(null);
  const zoomRef = useRef(1);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const fit = () => {
      const card = cardRef.current;
      if (!card) return;
      // Read through the zoom the card is drawn at NOW (not the one last asked
      // for, which React may not have applied yet when this runs).
      const drawn = parseFloat(card.style.zoom) || 1;
      const natural = card.getBoundingClientRect().height / drawn;
      // 24px of page padding (py-3) plus a little room for rounding.
      const next = Math.min(1, Math.max(0.7, (window.innerHeight - 30) / natural));
      if (Math.abs(next - zoomRef.current) > 0.005) {
        zoomRef.current = next;
        setZoom(next);
      }
    };
    fit();
    // The card grows after the first paint (the web font arrives, a message
    // appears): watch its size as well as the window's. A zoom it set itself
    // re-reads the same natural height, so this never loops.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (ro && cardRef.current) ro.observe(cardRef.current);
    document.fonts?.ready?.then(fit).catch(() => {});
    window.addEventListener("resize", fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [error, logoutReason]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username, password, captchaInput.trim());
    } catch (err) {
      // The server's own words: a wrong code, how many tries are left, or how
      // long the account stays blocked.
      setError(err?.response?.data?.message || "Could not sign in. Please try again.");
      setPassword("");
      newCaptcha();
    } finally {
      setBusy(false);
    }
  };

  const forgot = (e) => {
    e.preventDefault();
    toast("Ask your store administrator to reset it — User Management → reset password.",
      { icon: <KeyRound size={18} className="text-amber-500 shrink-0" />, duration: 5000 });
  };

  // One screen, no scrolling (the store, 22 Oct 2026: "login page scroll ho
  // rha h" — the card was 770px tall on a 657px laptop screen). The same
  // single card, a little tighter, and on a screen still too short for it the
  // whole card is zoomed down to fit (see useLayoutEffect above).
  return (
    <div className="min-h-screen bg-gradient-to-br from-navy-950 via-navy-900 to-navy-950 flex items-center justify-center px-4 py-3">
      <div ref={cardRef} style={{ zoom }} className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Branded header */}
        <div className="flex items-center gap-4 px-8 pt-5 pb-4">
          <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-14 w-auto shrink-0" draggable={false} />
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">TBDI Digital SMP</h1>
          </div>
        </div>
        <div className="border-t border-slate-100" />

        <form onSubmit={handleSubmit} className="px-8 py-5 space-y-3.5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Sign in</h2>
            <p className="text-[13px] text-slate-500">Use the username and password given by your store admin.</p>
          </div>

          {logoutReason === "inactivity" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
              <Clock size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <span>You were signed out after 30 minutes of inactivity. Please sign in again.</span>
            </div>
          )}

          <label className="block">
            <span className="text-sm font-semibold text-slate-700">Username</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-[15px] text-slate-900 caret-toyotared focus:outline-none focus:ring-2 focus:ring-navy-900/20 focus:border-navy-800"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-slate-700">Password</span>
            <div className="relative mt-1">
              <input
                type={showPw ? "text" : "password"}
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 pr-11 text-[15px] text-slate-900 caret-toyotared focus:outline-none focus:ring-2 focus:ring-navy-900/20 focus:border-navy-800"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 hover:text-slate-700"
              >
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          {/* Security Check — the QMP portal's: the code's picture, the box to
              type it in, and a button for a new code. */}
          <div>
            <span className="text-sm font-semibold text-slate-700">
              Security Check <span className="font-normal text-slate-500">(type the 2 letters + 2 numbers)</span>
            </span>
            <div className="mt-1 flex items-stretch gap-2">
              <div
                className="flex h-[52px] w-[38%] shrink-0 select-none items-center justify-center overflow-hidden rounded-xl border border-slate-300 bg-slate-200"
              >
                {captchaSvg ? (
                  <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(captchaSvg)}`}
                    alt="Security code — 2 letters and 2 numbers" draggable={false} className="h-full w-full object-contain" />
                ) : (
                  <span className="px-2 text-center text-[11px] leading-tight text-slate-500">
                    {captchaFailed ? "Code did not load — tap ↻" : "Loading…"}
                  </span>
                )}
              </div>
              <input
                className="min-w-0 flex-1 rounded-xl border-2 border-slate-600 bg-white px-3.5 text-lg font-semibold uppercase tracking-[0.25em] text-slate-900 caret-toyotared placeholder:text-[15px] placeholder:font-normal placeholder:tracking-[0.18em] placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-navy-900/25 focus:border-navy-800"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                placeholder="ENTER CODE"
                aria-label="Security code"
                autoComplete="off"
                maxLength={6}
                required
              />
              <button
                type="button"
                onClick={newCaptcha}
                aria-label="New code"
                title="New code"
                className="shrink-0 rounded-xl border border-slate-300 px-3.5 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              >
                <RotateCw size={18} />
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-[14px] leading-snug text-rose-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-[#ff2a3c] to-toyotared py-3 text-[15px] font-semibold text-white shadow-[0_8px_20px_rgba(235,10,30,0.35)] hover:brightness-110 disabled:opacity-60"
          >
            <LogIn size={17} /> {busy ? "Signing in…" : "Sign In"}
          </button>

          <div className="text-center">
            <a href="#forgot" onClick={forgot} className="text-[13px] font-medium text-navy-800 underline underline-offset-2 hover:text-toyotared">
              Forgot username or password?
            </a>
          </div>
        </form>

        {/* Contact — one to a line, top to bottom (the store, 23 Oct 2026: "agal
            bagal me nhi pura ek line me uper se niche"). */}
        <div className="border-t border-slate-100 bg-slate-50/70 px-8 py-4">
          <p className="text-[13px] font-bold text-slate-700">Need help? Contact us</p>
          <div className="mt-1.5 grid gap-y-1 text-[13px]">
            <a href={`mailto:${SUPPORT.email}`} className="flex items-center gap-2 text-navy-800 hover:text-toyotared">
              <Mail size={14} /> {SUPPORT.email}
            </a>
            <a href={`tel:${SUPPORT.phone.replace(/\s/g, "")}`} className="flex items-center gap-2 text-navy-800 hover:text-toyotared">
              <Phone size={14} /> {SUPPORT.phone}
            </a>
            <p className="flex items-center gap-2 text-slate-500">
              <Clock size={14} /> {SUPPORT.hours}
            </p>
            <p className="flex items-center gap-2 text-slate-500">
              <Wrench size={14} /> {SUPPORT.team}
            </p>
            <p className="flex items-center gap-2 text-slate-500">
              <MapPin size={14} />
              <span className="flex items-center gap-1.5">
                {SUPPORT.plants.map((p, i) => (
                  <React.Fragment key={p.label}>
                    {i > 0 && <span className="text-slate-300">·</span>}
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-navy-800 hover:text-toyotared">
                      {p.label} <ArrowUpRight size={12} />
                    </a>
                  </React.Fragment>
                ))}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
