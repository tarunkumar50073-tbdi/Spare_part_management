import api from "./api";

export const erpGapService = {
  list: (params = {}) => api.get("/erp-gap", { params }),
  summary: () => api.get("/erp-gap/summary"),
  import: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/erp-gap/import", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  clearPhysical: () => api.delete("/erp-gap/physical"),
};
