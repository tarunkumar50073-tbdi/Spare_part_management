import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { authService } from "../services/authService.js";
import { setUnauthorizedHandler } from "../services/api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Separate from `user` being null: on the very first paint we do not yet
  // know whether there is a session, and flashing the login screen at someone
  // who is already signed in looks like being logged out.
  const [checking, setChecking] = useState(true);

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

  const login = useCallback(async (username, password) => {
    const res = await authService.login(username, password);
    setUser(res.data.data);
    return res.data.data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } finally {
      // Clear locally even if the call failed — whatever the server thinks,
      // this browser is done with the session.
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, checking, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
