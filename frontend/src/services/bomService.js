import api from "./api";

export const bomService = {
  list: () => api.get("/bom"),
  create: (payload) => api.post("/bom", payload),
  update: (id, payload) => api.put(`/bom/${id}`, payload),
  remove: (id) => api.delete(`/bom/${id}`),
  import: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/bom/import", formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
};
