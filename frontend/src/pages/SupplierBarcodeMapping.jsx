import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useStores } from "../context/StoreContext.jsx";
import { barcodeService } from "../services/barcodeService.js";
import { supplierService } from "../services/supplierService.js";
import Can, { useCan } from "../components/Can.jsx";

// Admin-only: map a supplier's barcode to an internal spare part. Both the
// internal barcode and any mapped supplier barcode resolve to the same part;
// the internal Part No. is never replaced. Duplicate values are blocked
// server-side (409). Deactivated mappings stay as history.
export default function SupplierBarcodeMapping() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const canEdit = useCan("supplier_barcodes", "edit");

  const [query, setQuery] = useState("");
  const [part, setPart] = useState(null);
  const [barcodes, setBarcodes] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supplierService.list({ per_page: 500 }).then((r) => setSuppliers(r.data.data || [])).catch(() => {});
  }, []);

  const loadBarcodes = async (partId) => {
    try {
      const r = await barcodeService.partBarcodes(partId);
      setBarcodes(r.data.data || []);
    } catch { /* interceptor toasts */ }
  };

  const findPart = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    try {
      const r = await barcodeService.resolve(storeCode, q, { scanMode: "MAPPING" });
      const p = r.data.data;
      setPart(p);
      await loadBarcodes(p.part_id);
    } catch {
      setPart(null); setBarcodes([]);
    } finally {
      setBusy(false);
    }
  };

  const addMapping = async () => {
    if (!part) return;
    if (!code.trim()) return toast.error("Scan or enter the supplier barcode");
    setBusy(true);
    try {
      await barcodeService.createMapping({
        part_id: part.part_id, code: code.trim(),
        supplier_id: supplierId ? Number(supplierId) : undefined,
      });
      toast.success("Supplier barcode mapped");
      setCode(""); setSupplierId("");
      await loadBarcodes(part.part_id);
    } catch { /* 409/other toasted */ } finally { setBusy(false); }
  };

  const toggleActive = async (m) => {
    setBusy(true);
    try {
      await barcodeService.setMappingActive(m.id, !m.is_active);
      await loadBarcodes(part.part_id);
    } catch { /* toasted */ } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Supplier Barcode Mapping</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Map a supplier's barcode to an internal Part No. Both resolve to the same part.
        </p>
      </div>

      {!canEdit && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Read-only — you don’t have edit rights for supplier barcode mapping.
        </div>
      )}

      {/* find the internal part */}
      <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
        <span className="text-sm text-slate-600 dark:text-slate-300">Internal Part (scan or type Part No.)</span>
        <div className="mt-1 flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findPart(); } }}
            placeholder="e.g. CNTR2025" className="input-field flex-1 text-lg" />
          <button type="button" onClick={findPart} disabled={busy} className="btn-primary px-6">Find</button>
        </div>
      </div>

      {part && (
        <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
          <div className="mb-3 border-b border-slate-100 pb-3 dark:border-navy-800">
            <div className="text-lg font-bold text-slate-900 dark:text-white">{part.part_no}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400">{part.part_name}</div>
          </div>

          {/* existing barcodes */}
          <div className="mb-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400">
                <tr><th className="py-1">Code</th><th>Type</th><th>Supplier</th><th>Primary</th><th>Active</th><th></th></tr>
              </thead>
              <tbody>
                {barcodes.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 dark:border-navy-800">
                    <td className="py-1 font-mono">{b.code}</td>
                    <td>{b.source}</td>
                    <td>{b.supplier_name || "—"}</td>
                    <td>{b.is_primary ? "★" : ""}</td>
                    <td>{b.is_active ? "Active" : "Inactive"}</td>
                    <td className="text-right">
                      {b.source === "SUPPLIER" && (
                        <Can mod="supplier_barcodes" edit>
                          <button type="button" onClick={() => toggleActive(b)} disabled={busy}
                            className="text-xs font-semibold text-toyotared hover:underline">
                            {b.is_active ? "Deactivate" : "Reactivate"}
                          </button>
                        </Can>
                      )}
                    </td>
                  </tr>
                ))}
                {barcodes.length === 0 && (
                  <tr><td colSpan={6} className="py-3 text-center text-slate-400">No barcodes yet</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* add a supplier mapping */}
          <Can mod="supplier_barcodes" edit>
            <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 dark:border-navy-800 sm:grid-cols-3">
              <label className="block sm:col-span-1"><span className="text-sm text-slate-600 dark:text-slate-300">Supplier</span>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="input-field mt-1 w-full">
                  <option value="">Select…</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.supplier_name}</option>)}
                </select></label>
              <label className="block sm:col-span-1"><span className="text-sm text-slate-600 dark:text-slate-300">Supplier barcode *</span>
                <input value={code} onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMapping(); } }}
                  placeholder="Scan or type" className="input-field mt-1 w-full" /></label>
              <div className="flex items-end">
                <button type="button" onClick={addMapping} disabled={busy} className="btn-primary w-full py-2">Map barcode</button>
              </div>
            </div>
          </Can>
        </div>
      )}
    </div>
  );
}
