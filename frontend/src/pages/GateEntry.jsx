import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Printer, Truck, Radio } from "lucide-react";
import Table from "../components/Table.jsx";
import { useCan } from "../components/Can.jsx";
import { useStores } from "../context/StoreContext.jsx";
import { srvService } from "../services/srvService.js";
import { barcodeService } from "../services/barcodeService.js";
import { normGateNo } from "../lib/scanStatus.js";

// The widest window Scan Part's gate panel offers — a pending-unload entry is
// recent, so it is well inside it.
const LABEL_DAYS = 90;

export default function GateEntry() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  // "Print QR labels" goes to Scan Part, so only its users see it.
  const canScan = useCan("scan_part", "view");

  const load = async () => {
    setLoading(true);
    try {
      const res = await srvService.list({ status: "PENDING_UNLOAD", per_page: 50 });
      setRows(res.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  // Which gate entries carry Spare Parts Store items (the same ERP read as
  // Scan Part's gate panel) — only those get a "Print QR labels" link. A
  // failed read just shows no links; the table is unaffected.
  const gateQ = useQuery({
    queryKey: ["stock", "gate-labels", storeCode, LABEL_DAYS, ""],
    queryFn: () => barcodeService.gateLabels(storeCode, { days: LABEL_DAYS }, { silent: true }).then((r) => r.data.data),
    enabled: canScan,
    staleTime: 60_000,
    retry: false,
  });
  const labelNos = useMemo(
    () => new Set((gateQ.data?.entries || []).map((e) => normGateNo(e.gate_entry_no))), [gateQ.data]);

  const columns = [
    { key: "vendor_code", label: "Vendor" },
    { key: "supplier_name", label: "Supplier" },
    { key: "invoice_no", label: "Invoice / Challan" },
    { key: "part_no", label: "Part No" },
    { key: "part_name", label: "Part Name" },
    { key: "qty_invoiced", label: "Qty Invoiced" },
    {
      key: "gate_entry_time",
      label: "Gate Entry Time",
      render: (r) => (r.gate_entry_time ? new Date(r.gate_entry_time).toLocaleString() : "—"),
    },
  ];
  if (canScan) {
    columns.push({
      key: "qr_labels",
      label: "QR Labels",
      render: (r) => (r.gate_entry_no && labelNos.has(normGateNo(r.gate_entry_no)) ? (
        <Link to={`/scan-part?mode=label&gate=${encodeURIComponent(r.gate_entry_no)}`}
          className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-toyotared hover:underline"
          title={`Print the Spare Parts Store QR labels of gate entry ${r.gate_entry_no}`}>
          <Printer size={13} aria-hidden="true" /> Print QR labels
        </Link>
      ) : null),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Truck size={18} className="text-toyotared" /> Gate Entries — Pending Unload
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Monitoring only. Gate entry, unloading and material verification all come from ERP's own API — there
            are no manual actions on this page.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <Radio size={14} className="animate-pulse" /> Live from ERP API
        </span>
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="No pending gate entries" />
      </div>
    </div>
  );
}
