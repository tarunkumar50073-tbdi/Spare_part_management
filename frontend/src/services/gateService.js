import api from "./api";

// Gate Entry / Gate Exit — vehicle in/out + material arrival (read-only ERP
// mirror, filled by the ERP sync connector).
export const gateService = {
  entries: (params) => api.get("/gate/entries", { params }),
  arrivals: (itemCode) => api.get("/gate/entries/arrivals", { params: { item_code: itemCode } }),
  exits: (params) => api.get("/gate/exits", { params }),
};
