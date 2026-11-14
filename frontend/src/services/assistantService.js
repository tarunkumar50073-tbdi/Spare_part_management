import api from "./api";

// The in-app assistant + the service catalogue behind the All Services page.
// Everything is answered from this app's own data — no external service.
export const assistantService = {
  // previous: the question asked before, so "ye galat hai" alone can re-check it.
  ask: (query, previous) => api.post("/assistant/ask", { query, previous }),
  services: () => api.get("/assistant/services"),
};
