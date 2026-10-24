import api from "./api";

export const authService = {
  // The sign-in page shows its own message under the form (the QMP portal's
  // way), so neither call raises a toast as well.
  login: (username, password, captcha) =>
    api.post("/auth/login", { username, password, captcha }, { silent: true }),
  // A new Security Check code (2 letters + 2 numbers) as an SVG picture; the
  // server keeps it and checks it.
  captcha: () => api.get("/auth/captcha", { silent: true }),
  logout: () => api.post("/auth/logout"),
  // Returns { data: null } rather than 401 when signed out, so the app can ask
  // this on boot without a failed request every time.
  me: () => api.get("/auth/me"),
};
