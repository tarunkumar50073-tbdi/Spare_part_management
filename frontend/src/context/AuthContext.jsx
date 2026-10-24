import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { authService } from "../services/authService.js";
import { setTabUser, setUnauthorizedHandler } from "../services/api.js";

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

// A login belongs to the tab it was made in (the store, 24 Oct 2026: "address
// daalte hi bina login k khul rha h" → a new login every time; "agar 1 me khula
// h to dusre me bina login na khule kyunki 1 website par alag alag user
// kholenge"). The server's cookie is one per browser and outlives a closed tab
// (12 h), so:
// - the app opened in a tab — the address typed, a favourite, a new tab, the
//   browser reopened — always asks for a login. The old login also ends on the
//   server, unless another tab of the app is still working on it;
// - a refresh (or Back) of a tab that was in use in the last 30 minutes keeps
//   its login (the tab's mark in sessionStorage: its user, its last activity);
// - when someone signs in in one tab, every tab signed in as another user drops
//   to the login screen (told on the channel; the server also refuses such a
//   tab's calls, see setTabUser in services/api.js);
// - the Live Board TV login is spared (boardOnly): the TV must come back by
//   itself after a restart.
const TAB_KEY = "dx_tab_login";
const CHANNEL = "dx_login";
// This page's own name on the channel, so it never answers or follows itself.
const TAB_ID = Math.random().toString(36).slice(2);
const markTab = (id) => {
  try { sessionStorage.setItem(TAB_KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* read below */ }
};
const unmarkTab = () => { try { sessionStorage.removeItem(TAB_KEY); } catch { /* nothing to clear */ } };
// The tab's mark; undefined when the storage cannot be read at all.
const readMark = () => {
  let raw;
  try {
    raw = sessionStorage.getItem(TAB_KEY);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw || "null");
  } catch {
    return null;
  }
};
// This page is a refresh / Back of a tab that signed in as `me` and was in use
// within the idle limit. A browser whose storage cannot be read keeps the login
// on a refresh as before (it cannot be told apart).
const tabInUse = (me) => {
  const nav = performance.getEntriesByType?.("navigation")?.[0]?.type;
  if (nav === "navigate" || nav === "prerender") return false;   // the address typed, a favourite, a new tab
  const mark = readMark();
  if (mark === undefined) return true;
  return Boolean(mark) && mark.id === me.id && Date.now() - mark.at < IDLE_LIMIT_MS;
};
// Tells the other tabs of the app (a login, a sign-out).
const tell = (msg) => {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ ...msg, from: TAB_ID });
    ch.close();
  } catch {
    // an old browser: the server's check still holds
  }
};
// Whether another tab of the app is open and signed in — as user `id`, or as
// anyone when `id` is not given.
const anotherTabOpen = (id = null) => new Promise((resolve) => {
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
  ch.onmessage = ({ data }) => { if (data?.type === "here" && (id == null || data.id === id)) done(true); };
  ch.postMessage({ type: "anyone", from: TAB_ID });
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
      if (me && !tabInUse(me) && !boardOnly(me)) {
        // Opened afresh on an old login: this tab asks for its own. The old
        // login ends too, unless another tab is still working on it.
        if (!(await anotherTabOpen())) {
          try { await authService.logout(); } catch (_) { /* the login screen follows anyway */ }
        }
        unmarkTab();
        setUser(null);
        return;
      }
      if (me) {
        setTabUser(me.id);
        markTab(me.id);
      }
      setUser(me);
    } catch (_) {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  // The signed-in user, for the callbacks below (they are made once).
  const meRef = useRef(null);
  meRef.current = user;

  // This tab is done with its login; the server's is left alone (it may be
  // another person's, made in another tab). A reason, when given, is shown on
  // the login screen; without one the one already there stays (a late 401
  // after an idle sign-out must not wipe "30 minutes of inactivity").
  const dropTab = useCallback((reason = null) => {
    setTabUser(null);
    unmarkTab();
    setUser(null);
    setFreshLogin(false);
    if (reason) setLogoutReason(reason);
  }, []);

  useEffect(() => {
    // Any 401 from anywhere — an expired session, an account disabled while
    // someone was working, someone else signed in in another tab — drops
    // straight back to the login screen.
    setUnauthorizedHandler((reason) => dropTab(reason));
    refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh, dropTab]);

  const login = useCallback(async (username, password, captcha) => {
    const res = await authService.login(username, password, captcha);
    const me = res.data.data;
    setTabUser(me.id);
    markTab(me.id);
    tell({ type: "login", id: me.id });
    setUser(me);
    setLogoutReason(null);
    setFreshLogin(true);
    return me;
  }, []);

  const logout = useCallback(async (reason = null) => {
    const id = meRef.current?.id;
    try {
      await authService.logout();
    } finally {
      // Clear locally even if the call failed — whatever the server thinks,
      // this browser is done with the session. `reason` is a string only when
      // called in code (e.g. "inactivity"); a click handler passes its event,
      // which we ignore.
      if (id != null) tell({ type: "logout", id });
      dropTab(typeof reason === "string" ? reason : null);
    }
  }, [dropTab]);

  // 30 idle minutes in this tab. When the same person is still working in
  // another tab, only this tab is closed off — their login there carries on.
  const idleOut = useCallback(async () => {
    const id = meRef.current?.id;
    if (id != null && (await anotherTabOpen(id))) dropTab("inactivity");
    else logout("inactivity");
  }, [dropTab, logout]);

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
      markTab(user.id);          // the tab's last activity, read on a refresh
      clearTimeout(timer);
      timer = setTimeout(idleOut, IDLE_LIMIT_MS);
    };
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, idleOut]);

  // While signed in: answer a newly opened tab that asks whether one is open
  // (so it does not end this login on the server), drop to the login screen
  // when someone else signs in in another tab, and follow a sign-out made in
  // another tab of the same login.
  useEffect(() => {
    if (!user) return undefined;
    let ch;
    try {
      ch = new BroadcastChannel(CHANNEL);
    } catch {
      return undefined;
    }
    ch.onmessage = ({ data }) => {
      if (!data || data.from === TAB_ID) return;
      if (data.type === "anyone") ch.postMessage({ type: "here", id: user.id, from: TAB_ID });
      else if (data.type === "login" && data.id !== user.id) dropTab("other-user");
      else if (data.type === "logout" && data.id === user.id) dropTab(null);
    };
    return () => ch.close();
  }, [user, dropTab]);

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
