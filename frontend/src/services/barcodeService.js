import api from "./api";

// Barcode module — resolve (shared by camera/gun/manual), label print/reprint,
// admin supplier-barcode mapping + scan audit. Store-scoped like spareStock.
export const barcodeService = {
  labelConfig: () => api.get("/barcode/label-config"),
  // One shared resolver for every scan source.
  resolve: (storeCode, code, { scanSource = "MANUAL_ENTRY", scanMode = "LOOKUP" } = {}) =>
    api.post("/barcode/resolve", {
      store_code: storeCode, code, scan_source: scanSource, scan_mode: scanMode,
    }),
  print: (payload) => api.post("/barcode/print", payload), // {part_id, copies, is_reprint, reason}
  printHistory: (partId, limit) =>
    api.get("/barcode/print-history", { params: { part_id: partId, limit } }),
  partBarcodes: (partId) => api.get(`/barcode/part/${partId}/barcodes`),
  scanAudit: (params) => api.get("/barcode/scan-audit", { params }),
  createMapping: (payload) => api.post("/barcode/mapping", payload),
  setMappingActive: (mappingId, active) =>
    api.put(`/barcode/mapping/${mappingId}/active`, { active }),
};
