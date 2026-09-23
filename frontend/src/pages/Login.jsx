import React, { useMemo, useState } from "react";
import { LogIn, Eye, EyeOff, RefreshCw, Mail, Phone, Wrench } from "lucide-react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext.jsx";

// Support contacts shown at the foot of the sign-in card. Update these to your
// store's real support address / number.
const SUPPORT = {
  email: "dx.support@toyota-boshoku.com",
  phone: "+91 00000 00000",
  team: "TBDI Digital Store · DX Support",
};

// A small client-side security check (2 letters + 2 digits) — a light bot /
// mis-type deterrent that mirrors the QMP portal's login. It is a UI gate, not
// a replacement for the server's own auth.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O — they read as 1/0
const DIGITS = "23456789";                  // no 0/1 — same reason
const randOf = (s) => s[Math.floor(Math.random() * s.length)];
const makeCode = () => `${randOf(LETTERS)}${randOf(LETTERS)}${randOf(DIGITS)}${randOf(DIGITS)}`;

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [captcha, setCaptcha] = useState(makeCode);
  const [captchaInput, setCaptchaInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const newCaptcha = () => { setCaptcha(makeCode()); setCaptchaInput(""); };

  // Each glyph tilted and coloured so the code doesn't read as plain text.
  const glyphs = useMemo(
    () => captcha.split("").map((ch, i) => ({
      ch,
      style: {
        transform: `rotate(${[-9, 7, -6, 10][i] || 0}deg) translateY(${[2, -2, 1, -1][i] || 0}px)`,
        color: i % 2 ? "#eb0a1e" : "#1f2937",
      },
    })),
    [captcha],
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (captchaInput.trim().toUpperCase() !== captcha) {
      setError("Security check failed — please type the code exactly.");
      newCaptcha();
      return;
    }
    setError("");
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
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
      { icon: "🔑", duration: 5000 });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-navy-950 via-navy-900 to-navy-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Branded header */}
        <div className="flex items-center gap-4 px-6 pt-6 pb-5">
          <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-12 w-auto shrink-0" draggable={false} />
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">TBDI Digital Store</h1>
            <p className="text-[13px] text-slate-500">Toyota Boshoku Device India Pvt. Ltd.</p>
          </div>
        </div>
        <div className="border-t border-slate-100" />

        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Sign in</h2>
            <p className="text-[13px] text-slate-500">Use the username and password given by your store admin.</p>
          </div>

          <label className="block">
            <span className="text-sm font-semibold text-slate-700">Username</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-[15px] focus:outline-none focus:ring-2 focus:ring-navy-900/20 focus:border-navy-800"
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
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 pr-11 text-[15px] focus:outline-none focus:ring-2 focus:ring-navy-900/20 focus:border-navy-800"
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

          {/* Security check (client-side CAPTCHA) */}
          <div>
            <span className="text-sm font-semibold text-slate-700">
              Security Check <span className="font-normal text-slate-400">(type the 2 letters + 2 numbers)</span>
            </span>
            <div className="mt-1 flex items-stretch gap-2">
              <div
                aria-hidden="true"
                className="flex w-28 shrink-0 items-center justify-center rounded-lg border border-slate-300"
                style={{ backgroundImage: "repeating-linear-gradient(45deg,#f1f5f9 0 6px,#e2e8f0 6px 12px)" }}
              >
                <div className="relative px-1">
                  {glyphs.map((g, i) => (
                    <span key={i} className="inline-block font-mono text-2xl font-extrabold" style={g.style}>{g.ch}</span>
                  ))}
                  <span className="pointer-events-none absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-slate-500/50" />
                </div>
              </div>
              <input
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3.5 py-2.5 text-[15px] uppercase tracking-widest placeholder:tracking-normal placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-navy-900/20 focus:border-navy-800"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                placeholder="Enter code"
                autoComplete="off"
                required
              />
              <button
                type="button"
                onClick={newCaptcha}
                aria-label="New code"
                title="New code"
                className="shrink-0 rounded-lg border border-slate-300 px-3 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-600">{error}</p>
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

        {/* Contact */}
        <div className="border-t border-slate-100 bg-slate-50/70 px-6 py-4">
          <p className="text-[13px] font-bold text-slate-700">Need help? Contact us</p>
          <div className="mt-1.5 space-y-1 text-[13px]">
            <a href={`mailto:${SUPPORT.email}`} className="flex items-center gap-2 text-navy-800 hover:text-toyotared">
              <Mail size={14} /> {SUPPORT.email}
            </a>
            <a href={`tel:${SUPPORT.phone.replace(/\s/g, "")}`} className="flex items-center gap-2 text-navy-800 hover:text-toyotared">
              <Phone size={14} /> {SUPPORT.phone}
            </a>
            <p className="flex items-center gap-2 text-slate-500">
              <Wrench size={14} /> {SUPPORT.team}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
