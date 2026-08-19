import api from "./api";

// Receiving Register — a part's GRN receiving history (read-only ERP mirror,
// filled by the ERP sync connector from termsdb.srv_report).
export const receivingRegisterService = {
  list: (params) => api.get("/receiving-register", { params }),
  history: (itemCd) => api.get("/receiving-register/history", { params: { item_cd: itemCd } }),
};
