import api from "./api";

export const notificationService = {
  list: (params) => api.get("/notifications", { params }),
  resolve: (id) => api.post(`/notifications/${id}/resolve`),
};
