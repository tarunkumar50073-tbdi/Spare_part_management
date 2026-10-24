// Per-module rights, read off the signed-in user's `permissions` map (which the
// server puts in to_public_dict). Admin bypasses everything; an ungated item
// (no module key) is always allowed; "edit" implies "view".
// The Spare Store screens that show stock, rates or movements — the same list
// as the server's SPARE_STOCK_VIEW (backend/app/utils/authz.py). A login needs
// a right on one of them to read the spare stock (security audit, 24 Oct 2026).
export const SPARE_STOCK_VIEW = [
  "spare_store", "live_dashboard", "action_tracker", "notifications", "store_stock",
  "inventory_control", "put_away_check", "scan_part", "work_queue", "consumption",
  "receiving", "short_rejection", "part_ledger", "erp_gap", "erp_control", "part_master",
  "data_quality", "supplier_barcodes", "reports", "challan_register",
];

export const seesSpareStock = (user) => SPARE_STOCK_VIEW.some((m) => can(user, m));

export function can(user, mod, action = "view") {
  if (!user) return false;
  if (user.is_admin) return true;
  if (!mod) return true;
  const p = (user.permissions || {})[mod] || {};
  return action === "edit" ? Boolean(p.edit) : Boolean(p.view || p.edit);
}
