import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Boxes, ArrowRightCircle, History, Warehouse } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import BarcodeScanInput from "../components/BarcodeScanInput.jsx";
import { holdingService } from "../services/holdingService.js";

function holdingAge(holdingDate) {
  const days = Math.floor((Date.now() - new Date(holdingDate).getTime()) / (1000 * 60 * 60 * 24));
  return days <= 0 ? "Today" : `${days}d`;
}

export default function HoldingArea() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferQty, setTransferQty] = useState("");
  const [historyTarget, setHistoryTarget] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [rackInfoTarget, setRackInfoTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await holdingService.list();
      setRows(res.data.data.filter((e) => e.holding_status !== "COMPLETED"));
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openTransfer = (entry) => {
    setTransferTarget(entry);
    setTransferQty(entry.remaining_qty);
  };

  const handleTransferScan = async (code) => {
    try {
      const res = await holdingService.transfer(transferTarget.id, {
        rack_bin_id: transferTarget.assigned_rack_id,
        transfer_qty: Number(transferQty),
        scanned_part_code: code.trim(),
      });
      toast.success(res.data.message);
      setTransferTarget(null);
      load();
    } catch (_) {
      /* handled globally — FIFO violation / not enough space / wrong part */
    }
  };

  const openHistory = async (entry) => {
    setHistoryTarget(entry);
    try {
      const res = await holdingService.history(entry.id);
      setHistoryRows(res.data.data);
    } catch (_) {
      setHistoryRows([]);
    }
  };

  const columns = [
    { key: "fifo_priority", label: "FIFO #", render: (r) => <span className="font-semibold">{r.fifo_priority ?? "—"}</span> },
    { key: "part_no", label: "Part No" },
    { key: "part_name", label: "Part Name" },
    { key: "invoice_no", label: "Invoice No", render: (r) => r.invoice_no || "—" },
    { key: "temporary_location", label: "Temp Location" },
    { key: "remaining_qty", label: "Holding Qty" },
    { key: "holding_date", label: "Holding Date", render: (r) => new Date(r.holding_date).toLocaleString() },
    { key: "holding_age", label: "Holding Age", render: (r) => holdingAge(r.holding_date) },
    { key: "assigned_rack_label", label: "Assigned Rack", render: (r) => r.assigned_rack_label || "—" },
    { key: "available_rack_space", label: "Available Rack Space", render: (r) => r.available_rack_space ?? "—" },
    { key: "holding_status", label: "Status", render: (r) => <Badge status={r.holding_status} /> },
    {
      key: "actions", label: "Actions",
      render: (r) => (
        <div className="flex gap-2">
          <button className="btn-primary px-2 py-1.5 text-xs" onClick={() => openTransfer(r)}>
            <ArrowRightCircle size={14} /> Transfer
          </button>
          <button className="btn-secondary px-2 py-1.5 text-xs" onClick={() => setRackInfoTarget(r)}>
            <Warehouse size={14} /> Rack
          </button>
          <button className="btn-secondary px-2 py-1.5 text-xs" onClick={() => openHistory(r)}>
            <History size={14} /> History
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <Boxes size={18} className="text-toyotared" /> Holding Area
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Material that couldn't be placed into its assigned rack. FIFO is mandatory — the oldest entry for a part
          must be transferred before any newer one.
        </p>
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="Holding Area is empty" />
      </div>

      <Modal
        open={!!transferTarget}
        onClose={() => setTransferTarget(null)}
        title={`Transfer to Rack — ${transferTarget?.part_no || ""}`}
      >
        {transferTarget && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Target rack: {transferTarget.assigned_rack_label || "none assigned"} — Available: {transferTarget.available_rack_space ?? "—"} bin(s)
            </p>
            <div>
              <label className="text-xs font-medium text-slate-500">Transfer Qty</label>
              <input
                type="number" step="0.01" max={transferTarget.remaining_qty}
                className="input-field mt-1"
                value={transferQty}
                onChange={(e) => setTransferQty(e.target.value)}
              />
            </div>
            <p className="text-xs text-slate-400">Scan the part to confirm and complete the transfer.</p>
            <BarcodeScanInput onScan={handleTransferScan} placeholder="Scan part barcode" />
          </div>
        )}
      </Modal>

      <Modal
        open={!!rackInfoTarget}
        onClose={() => setRackInfoTarget(null)}
        title={`Assigned Rack — ${rackInfoTarget?.part_no || ""}`}
      >
        {rackInfoTarget && (
          <div className="text-sm space-y-1.5">
            <p><span className="text-slate-500">Rack:</span> {rackInfoTarget.assigned_rack_label || "None assigned yet"}</p>
            <p><span className="text-slate-500">Available Space:</span> {rackInfoTarget.available_rack_space ?? "—"} bin(s)</p>
            <p><span className="text-slate-500">Holding Reason:</span> {rackInfoTarget.holding_reason}</p>
          </div>
        )}
      </Modal>

      <Modal
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title={`History — ${historyTarget?.part_no || ""}`}
        size="xl"
      >
        <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
              <tr>
                <th className="text-left px-2 py-2">Action</th>
                <th className="text-left px-2 py-2">User</th>
                <th className="text-left px-2 py-2">Old Location</th>
                <th className="text-left px-2 py-2">New Location</th>
                <th className="text-left px-2 py-2">Qty</th>
                <th className="text-left px-2 py-2">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {historyRows.length === 0 ? (
                <tr><td colSpan={6} className="text-center text-slate-400 py-6">No history yet</td></tr>
              ) : historyRows.map((h) => (
                <tr key={h.id}>
                  <td className="px-2 py-2">{h.action}</td>
                  <td className="px-2 py-2">{h.user}</td>
                  <td className="px-2 py-2">{h.old_location || "—"}</td>
                  <td className="px-2 py-2">{h.new_location || "—"}</td>
                  <td className="px-2 py-2">{h.quantity ?? "—"}</td>
                  <td className="px-2 py-2">{new Date(h.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
