import api from "./api";

// Admin-only user management. The user records come back with the readable
// password (an explicit admin-visibility choice); the API refuses non-admins.
export const adminService = {
  modules: () => api.get("/admin/modules"),
  users: () => api.get("/admin/users"),
  createUser: (payload) => api.post("/admin/users", payload),
  updateUser: (id, payload) => api.put(`/admin/users/${id}`, payload),
  resetPassword: (id, password) => api.post(`/admin/users/${id}/reset-password`, { password }),
  deleteUser: (id) => api.delete(`/admin/users/${id}`),
};
