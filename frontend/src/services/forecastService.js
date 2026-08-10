import api from "./api";

export const forecastService = {
  upload: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/forecast/upload", formData, { headers: { "Content-Type": "multipart/form-data" } });
  },
  summary: () => api.get("/forecast/summary"),
  peakAll: () => api.get("/forecast/peak"),
  peak: (partId) => api.get(`/forecast/peak/${partId}`),
};
