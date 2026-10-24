import api from "./api";

// Barcode module — resolve (shared by camera/gun/manual), label print/reprint,
// the label printer, supplier-barcode mapping (Scan Part's Barcodes panel and
// "Map to Part" on an unknown code) + scan audit. Store-scoped like spareStock.
export const barcodeService = {
  labelConfig: () => api.get("/barcode/label-config"),
  // One shared resolver for every scan source.
  resolve: (storeCode, code, { scanSource = "MANUAL_ENTRY", scanMode = "LOOKUP" } = {}) =>
    api.post("/barcode/resolve", {
      store_code: storeCode, code, scan_source: scanSource, scan_mode: scanMode,
    }),

  // Record a label print — called only AFTER the operator confirms the label
  // actually came out of the printer (the browser cannot know), so the history
  // is what was printed, not what was attempted. Printing adds no stock and
  // completes no GRN / quality step.
  // payload: { part_id, copies, source (PRINT_SOURCE key), printer_name, reason? }
  // A REPRINT needs a reason (<= 255 chars). `config` is the axios config.
  print: (payload, config) => api.post("/barcode/print", payload, config),
  // Up to 300 parts' labels at once, recorded after the operator confirms they
  // printed. Parts that already have a label are skipped by the server unless
  // a reason is given.
  printBulk: (partIds, { copies = 1, reason, source = "STORE_STOCK", printerName } = {}, config) =>
    api.post("/barcode/print-bulk", {
      part_ids: partIds, copies, reason: reason || undefined, source,
      printer_name: printerName || undefined,
    }, config),
  // `config` is the axios config — pass { silent: true } when the screen shows
  // the error itself.
  printHistory: (partId, limit, config) =>
    api.get("/barcode/print-history", { params: { part_id: partId, limit }, ...config }),

  // (No gate-entry lot tags any more — /gate-labels is gone since the store had
  // them taken out on 17 Oct 2026: "lot tag bhi kah rhe h ki paper wastage h use
  // hta do".)

  // The store label printer: {name, connection BROWSER|NETWORK, status
  // NOT_DETECTABLE|REACHABLE|UNREACHABLE, checked_at, detail}. REACHABLE only
  // ever comes from a real TCP connect made by the server; a browser-dialog
  // printer is NOT_DETECTABLE — never a made-up Online / Offline.
  printerStatus: (config) => api.get("/barcode/printer-status", config),
  // Admin: which printer, and how it is reached ({name, connection, host, port}).
  labelPrinter: () => api.get("/admin/label-printer"),
  saveLabelPrinter: (cfg) => api.put("/admin/label-printer", cfg),

  partBarcodes: (partId, config) => api.get(`/barcode/part/${partId}/barcodes`, config),
  scanAudit: (params) => api.get("/barcode/scan-audit", { params }),
  // payload: { part_id, code, supplier_id?, symbology? }. Both writes answer
  // with the part's fresh barcode list (internal first). Needs the
  // supplier_barcodes edit right; a code already mapped is refused (409).
  createMapping: (payload, config) => api.post("/barcode/mapping", payload, config),
  setMappingActive: (mappingId, active, config) =>
    api.put(`/barcode/mapping/${mappingId}/active`, { active }, config),
};
