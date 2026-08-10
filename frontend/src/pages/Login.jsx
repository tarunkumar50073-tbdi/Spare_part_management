import React, { useState } from "react";
import { LogIn, Lock, User as UserIcon } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      // Shown in the form rather than as a toast — the message belongs next
      // to the fields it is about.
      setError(err?.response?.data?.message || "Could not sign in. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-navy-950 flex items-center justify-center lg:justify-start px-4 lg:px-20 py-10 overflow-hidden">
      {/* The artwork is a 1005x228 banner, not a wallpaper. Stretched to cover
          a whole screen it would be blown up nearly 5x — soft, and cropped
          right through its own wordmark. Kept at its own proportions as a
          band across the top instead, fading into the page so it reads as
          part of the background rather than a picture stuck on it. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 select-none">
        <img
          src="/banner-innovation_at_tb-01.png"
          alt=""
          aria-hidden="true"
          className="w-full object-cover object-center opacity-60"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-navy-950/40 via-navy-950/70 to-navy-950" />
      </div>

      {/* Left-aligned on a wide screen so the banner's artwork stays visible
          to the right of the form; still centred on narrow screens, where
          there is no room beside it. */}
      <div className="relative w-full max-w-sm">
        {/* Centred within the panel, not against the page — the panel sits
            left, but the logo and title stay squarely over the form. */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="bg-white rounded-xl2 px-4 py-3 shadow-card mb-3">
            <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="w-28 h-auto" draggable={false} />
          </div>
          <h1 className="text-xl font-bold text-white">Part Store</h1>
          <p className="text-xs text-slate-400 mt-1">Part Process Flow Management</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-navy-900 rounded-xl2 shadow-card p-5 space-y-4 border border-white/10"
        >
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Username</label>
            <div className="relative">
              <UserIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                className="input-field pl-9"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Password</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                className="input-field pl-9"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-500/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
            <LogIn size={16} /> {busy ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <p className="text-[11px] text-slate-500 text-center mt-4">
          Toyota Boshoku Device India · Store Control Tower
        </p>
      </div>
    </div>
  );
}
