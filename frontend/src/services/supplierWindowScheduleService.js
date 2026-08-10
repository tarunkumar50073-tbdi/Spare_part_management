import api from "./api";

export const supplierWindowScheduleService = {
  list: (params) => api.get("/supplier-window-schedules", { params }),
  todayStatus: () => api.get("/supplier-window-schedules/today-status"),
  create: (payload) => api.post("/supplier-window-schedules", payload),
  update: (id, payload) => api.put(`/supplier-window-schedules/${id}`, payload),
  remove: (id) => api.delete(`/supplier-window-schedules/${id}`),
};
