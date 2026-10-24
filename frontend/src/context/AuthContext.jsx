import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { authService } from "../services/authService.js";
import { setUnauthorizedHandler } from "../services/api.js";

const AuthContext = createContext(null);

// Auto sign-out after this long with no mouse / keyboard / scroll activity, so a
// shared store terminal left unattended does not stay logged in. The login screen
// then shows why (see logoutReason).
const IDLE_LIMIT_MS = 30 * 60 * 1000;

// A login that can open only the Live Board — the HMI / TV screen on the shop
// floor, where nobody touches a mouse. The idle sign-out would leave the plant
// TV on the login screen every half hour, so it is spared (the store, 22 Oct
// 2026: "ok"). Any other right, or an administrator, keeps the timer.
const boardOnly = (u) => {
  if (!u || u.is_admin) return false;
  const granted = Object.entries(u.permissions || {}).filter(([, p]) => p && (p.view || p.edit));
  return granted.length > 0 && granted.every(([mod]) => mod === "live_dashboard");
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Why the session ended, shown on the login screen ("inactivity" after an idle
  // timeout). Null for a first visit or a manual sign-out.
  const [logoutReason, setLogoutReason] = useState(null);
  // Separate from `user` being null: on the very first paint we do not yet
  // know whether there is a session, and flashing the login screen at someone
  // who is already signed in looks like being logged out.
  const [checking, setChecking] = useState(true);
  // True from a successful sign-in until the "what needs your attention" pop-up
  // has had its turn. The pop-up also opens once per browser tab on its own (see
  // AttentionPopup); this flag makes it open again after every sign-in.
  const [freshLogin, setFreshLogin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await authService.me();
      setUser(res.data.data);
    } catch (_) {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Any 401 from anywhere — an expired session, an account disabled while
    // someone was working — drops straight back to the login screen.
    setUnauthorizedHandler(() => setUser(null));
    refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const login = useCallback(async (username, password, captcha) => {
    const res = await authService.login(username, password, captcha);
    setUser(res.data.data);
    setLogoutReason(null);
    setFreshLogin(true);
    return res.data.data;
  }, []);

  const logout = useCallback(async (reason = null) => {
    try {
      await authService.logout();
    } finally {
      // Clear locally even if the call failed — whatever the server thinks,
      // this browser is done with the session. `reason` is a string only when
      // called in code (e.g. "inactivity"); a click handler passes its event,
      // which we ignore.
      setUser(null);
      setFreshLogin(false);
      setLogoutReason(typeof reason === "string" ? reason : null);
    }
  }, []);

  // Idle auto-logout: only while signed in. Any real activity reschedules the
  // timer; IDLE_LIMIT_MS of none signs the user out with an "inactivity" reason.
  useEffect(() => {
    if (!user || boardOnly(user)) return undefined;
    let timer;
    let last = 0;
    const reset = () => {
      const now = Date.now();
      if (now - last < 1000) return; // throttle — mousemove fires constantly
      last = now;
      clearTimeout(timer);
      timer = setTimeout(() => logout("inactivity"), IDLE_LIMIT_MS);
    };
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, logout]);

  return (
    <AuthContext.Provider value={{
      user, checking, login, logout, refresh, logoutReason, clearLogoutReason: () => setLogoutReason(null),
      freshLogin, ackFreshLogin: () => setFreshLogin(false),
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
