import api from "./api";

export const finishedGoodService = {
  list: () => api.get("/finished-goods"),
};
