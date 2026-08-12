import api from "./api";

// Department master — every department and the e-mail its reorder / low-stock
// notifications are sent to. Global (not store-scoped), so no store_code rides
// along. Writes are ADMIN-only server-side; the UI mirrors that.
export const departmentService = {
  list: (activeOnly) => api.get("/departments", { params: activeOnly ? { active: 1 } : {} }),
  create: (payload) => api.post("/departments", payload),
  update: (id, payload) => api.put(`/departments/${id}`, payload),
};
