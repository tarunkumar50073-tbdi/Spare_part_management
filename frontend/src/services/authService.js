import api from "./api";

export const authService = {
  login: (username, password) => api.post("/auth/login", { username, password }),
  logout: () => api.post("/auth/logout"),
  // Returns { data: null } rather than 401 when signed out, so the app can ask
  // this on boot without a failed request every time.
  me: () => api.get("/auth/me"),
};
