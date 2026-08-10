import api from "./api";

export const supplierVehicleService = {
  list: (params) => api.get("/supplier-vehicles", { params }),
  create: (payload) => api.post("/supplier-vehicles", payload),
  update: (id, payload) => api.put(`/supplier-vehicles/${id}`, payload),
  remove: (id) => api.delete(`/supplier-vehicles/${id}`),
};
