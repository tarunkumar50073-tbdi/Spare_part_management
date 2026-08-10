import api from "./api";

export const rackBinService = {
  list: () => api.get("/rack-bins"),
  create: (payload) => api.post("/rack-bins", payload),
  update: (id, payload) => api.put(`/rack-bins/${id}`, payload),
  remove: (id) => api.delete(`/rack-bins/${id}`),
  import: (file) => {
    const form = new FormData();
    form.append("file", file);
    return api.post("/rack-bins/import", form, { headers: { "Content-Type": "multipart/form-data" } });
  },
};
