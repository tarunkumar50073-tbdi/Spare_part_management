import api from "./api";

export const auditLogService = {
  list: (params) => api.get("/audit-logs", { params }),
};
