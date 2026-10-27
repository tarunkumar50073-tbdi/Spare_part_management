// Per-module rights, read off the signed-in user's `permissions` map (which the
// server puts in to_public_dict). Admin bypasses everything; an ungated item
// (no module key) is always allowed.
//
// CRUD since 24 Oct 2026 (the store: "proper crud bna"), as on the server
// (backend/app/models/user.py): "view" = R, read only · "create" = C, add new ·
// "update" = E, change what exists · "delete" = D, remove / cancel. Any write
// brings view; an array of actions = all of them; "edit" is the old name of
// "update". A map saved before the split ({view, edit}) reads its edit as
// every write.
const WRITES = ["create", "update", "delete"];
// The Spare Store screens that show stock, rates or movements — the same list
// as the server's SPARE_STOCK_VIEW (backend/app/utils/authz.py). A login needs
// a right on one of them to read the spare stock (security audit, 24 Oct 2026).
export const SPARE_STOCK_VIEW = [
  "spare_store", "live_dashboard", "action_tracker", "notifications", "store_stock",
  "inventory_control", "scan_part", "work_queue", "consumption",
  "receiving", "short_rejection", "part_ledger", "erp_gap", "erp_control", "part_master",
  "data_quality", "supplier_barcodes", "reports", "challan_register",
];

export const seesSpareStock = (user) => SPARE_STOCK_VIEW.some((m) => can(user, m));

export function can(user, mod, action = "view") {
  if (Array.isArray(action)) return action.every((a) => can(user, mod, a));
  if (!user) return false;
  if (user.is_admin) return true;
  if (!mod) return true;
  const p = (user.permissions || {})[mod] || {};
  const legacy = Boolean(p.edit);
  const has = (a) => Boolean(p[a] ?? legacy);
  if (action === "view") return Boolean(p.view) || WRITES.some(has);
  return has(action === "edit" ? "update" : action);
}
