import api from "./api";

// Inventory Control (/api/v1/inventory-control): the Critical / Short / Reorder /
// Excess lists and the excess aging in one call, so the four tabs are counted
// from the same stock list. sectionId is optional (omitted = whole store).
export const inventoryControlService = {
  overview: (storeCode, sectionId) =>
    api.get("/inventory-control", { params: { store_code: storeCode, section_id: sectionId } }),
};
