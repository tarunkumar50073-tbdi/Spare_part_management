import axios from "axios";
import toast from "react-hot-toast";

// Relative default so a checkout without a frontend/.env still routes through
// the Vite proxy instead of a wrong absolute port (audit finding M-2).
const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api/v1";
const API_KEY = import.meta.env.VITE_API_KEY;

const api = axios.create({
  baseURL: BASE_URL,
  // The session cookie is the credential for a signed-in person; without this
  // the browser would drop it and every call would come back 401.
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
    ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
  },
});

// Set by AuthProvider so a session that ends mid-use lands the operator back
// on the login screen instead of on a page quietly full of empty tables.
let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url || "";
    // 401 is a state, not an error to shout about: the app reacts by showing
    // the login screen. Toasting it as well would stack a red box on top of
    // the very screen that explains what to do. /auth/login is exempt — there
    // a 401 really is the answer to what the user just typed.
    if (status === 401 && !url.includes("/auth/login")) {
      onUnauthorized?.();
      return Promise.reject(error);
    }
    const message =
      error?.response?.data?.message || error?.message || "Something went wrong";
    toast.error(message);
    return Promise.reject(error);
  }
);

export default api;
