import api from "./api";

export const supplierService = {
  list: (params) => api.get("/suppliers", { params }),
  get: (id) => api.get(`/suppliers/${id}`),
  create: (payload) => api.post("/suppliers", payload),
  update: (id, payload) => api.put(`/suppliers/${id}`, payload),
  remove: (id) => api.delete(`/suppliers/${id}`),
  import: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/suppliers/import", formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
};
