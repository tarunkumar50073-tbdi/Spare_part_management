import api from "./api";

// The in-app assistant + the service catalogue behind the All Services page.
// Everything is answered from this app's own data — no external service.
export const assistantService = {
  ask: (query) => api.post("/assistant/ask", { query }),
  services: () => api.get("/assistant/services"),
};
