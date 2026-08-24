import api from "./api";

// Department master — every department and the e-mail its reorder / low-stock
// notifications are sent to. Global (not store-scoped), so no store_code rides
// along. Writes are ADMIN-only server-side; the UI mirrors that.
export const departmentService = {
  list: (activeOnly) => api.get("/departments", { params: activeOnly ? { active: 1 } : {} }),
  create: (payload) => api.post("/departments", payload),
  update: (id, payload) => api.put(`/departments/${id}`, payload),
  // Person-wise recipients: a department can have several (name + email).
  addRecipient: (deptId, payload) => api.post(`/departments/${deptId}/recipients`, payload),
  updateRecipient: (recId, payload) => api.put(`/departments/recipients/${recId}`, payload),
  deleteRecipient: (recId) => api.delete(`/departments/recipients/${recId}`),
};
