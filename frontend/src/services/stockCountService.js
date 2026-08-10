import api from "./api";

export const stockCountService = {
  sheet: (date) => api.get("/stock-count/sheet", { params: date ? { date } : {} }),
  submit: (payload) => api.post("/stock-count/submit", payload),
  // `sheet` is only needed for a workbook that keeps several months side by
  // side — the server refuses to guess and hands back the candidate names.
  import: (file, date, sheet) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.post("/stock-count/import", formData, {
      params: { ...(date ? { date } : {}), ...(sheet ? { sheet } : {}) },
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
};
