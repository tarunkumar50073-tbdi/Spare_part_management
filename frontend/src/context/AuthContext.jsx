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

// A sign-in lasts while the app stays open (the store, 24 Oct 2026: "address
// daalte hi bina login k khul rha h" → a new login every time). The server's
// cookie outlives a closed tab or browser (12 h), so the app opened afresh — the
// address typed again, a favourite, the browser reopened — ends that old login
// and asks again — in the same tab too, when the address is typed or a
// favourite opened there. A refresh (or Back) of a tab that was in use keeps it
// (the tab's mark in sessionStorage, the time of its last activity), and so does
// a second tab while another one of the app is still open (it answers on the
// channel). The Live Board TV login is spared (boardOnly): the TV must come back
// by itself.
const TAB_KEY = "dx_tab_login";
const CHANNEL = "dx_login";
const markTab = () => { try { sessionStorage.setItem(TAB_KEY, String(Date.now())); } catch { /* checked below */ } };
const unmarkTab = () => { try { sessionStorage.removeItem(TAB_KEY); } catch { /* nothing to clear */ } };
// This page is a refresh / Back of a tab that signed in and was in use within
// the idle limit. A browser whose storage cannot be read keeps the login as
// before (it cannot be told apart).
const tabInUse = () => {
  try {
    const nav = performance.getEntriesByType?.("navigation")?.[0]?.type;
    if (nav === "navigate" || nav === "prerender") return false;   // the address typed, a favourite, a link
    const at = Number(sessionStorage.getItem(TAB_KEY));
    return Boolean(at) && Date.now() - at < IDLE_LIMIT_MS;
  } catch {
    return true;
  }
};
// Whether another tab of the app is open and signed in (it answers "here").
const anotherTabOpen = () => new Promise((resolve) => {
  let ch;
  try {
    ch = new BroadcastChannel(CHANNEL);
  } catch {
    resolve(false);
    return;
  }
  const done = (open) => {
    clearTimeout(timer);
    ch.close();
    resolve(open);
  };
  const timer = setTimeout(() => done(false), 400);
  ch.onmessage = (e) => { if (e.data === "here") done(true); };
  ch.postMessage("anyone");
});

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
      const me = res.data.data;
      if (!tabInUse() && !boardOnly(me) && !(await anotherTabOpen())) {
        // The app opened afresh on an old login: it ends here.
        try { await authService.logout(); } catch (_) { /* the login screen follows anyway */ }
        unmarkTab();
        setUser(null);
        return;
      }
      markTab();
      setUser(me);
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
    markTab();
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
      unmarkTab();
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
      markTab();                 // the tab's last activity, read on a refresh
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

  // While signed in, answer a newly opened tab of the app that asks whether
  // one is already open — so a second tab does not end this login.
  useEffect(() => {
    if (!user) return undefined;
    let ch;
    try {
      ch = new BroadcastChannel(CHANNEL);
    } catch {
      return undefined;
    }
    ch.onmessage = (e) => { if (e.data === "anyone") ch.postMessage("here"); };
    return () => ch.close();
  }, [user]);

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
