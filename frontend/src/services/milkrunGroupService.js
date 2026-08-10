import api from "./api";

export const milkrunGroupService = {
  list: (params) => api.get("/milkrun-groups", { params }),
  create: (payload) => api.post("/milkrun-groups", payload),
  update: (id, payload) => api.put(`/milkrun-groups/${id}`, payload),
  remove: (id) => api.delete(`/milkrun-groups/${id}`),
  assignSupplier: (payload) => api.post("/milkrun-groups/assign-supplier", payload),
  unassignSupplier: (vendorCode) => api.delete(`/milkrun-groups/unassign-supplier/${vendorCode}`),
};
