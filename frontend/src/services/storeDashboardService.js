import api from "./api";

export const storeDashboardService = {
  summary: () => api.get("/store/dashboard/summary"),
  pendingRgp: () => api.get("/store/dashboard/pending-rgp"),
  partSummary: () => api.get("/store/dashboard/part-summary"),
  pipeline: () => api.get("/store/dashboard/pipeline"),
  criticalParts: () => api.get("/store/dashboard/critical-parts"),
  shortParts: () => api.get("/store/dashboard/short-parts"),
  productionCriticalParts: () => api.get("/store/dashboard/production-critical-parts"),
  analytics: () => api.get("/store/dashboard/analytics"),
  erpStatus: () => api.get("/store/dashboard/erp-status"),
  dailyReceiving: () => api.get("/store/dashboard/charts/daily-receiving"),
  dailyStockMovement: () => api.get("/store/dashboard/charts/daily-stock-movement"),
  supplierReceivingTrend: () => api.get("/store/dashboard/charts/supplier-receiving-trend"),
  rackUtilization: () => api.get("/store/dashboard/charts/rack-utilization"),
  alerts: () => api.get("/store/dashboard/alerts"),
  todaysIssues: () => api.get("/store/dashboard/todays-issues"),
  todaysReceipts: () => api.get("/store/dashboard/todays-receipts"),
  pendingSrv: () => api.get("/store/dashboard/pending-srv"),
  partConsumptionHistory: (partId) => api.get(`/store/dashboard/parts/${partId}/consumption-history`),
  partSourceBreakdownMonthly: (partId) => api.get(`/store/dashboard/parts/${partId}/source-breakdown-monthly`),
};
