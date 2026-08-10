import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { PackageSearch, CheckCircle2, AlertTriangle, MapPin } from "lucide-react";
import Table from "../components/Table.jsx";
import BarcodeScanInput from "../components/BarcodeScanInput.jsx";
import { putAwayService } from "../services/putAwayService.js";
import { rackBinService } from "../services/rackBinService.js";

export default function PutAway() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rackBins, setRackBins] = useState([]);
  const [active, setActive] = useState(null); // srv row being allocated
  const [scannedRack, setScannedRack] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [pending, racks] = await Promise.all([putAwayService.listPending(), rackBinService.list()]);
      setRows(pending.data.data);
      setRackBins(racks.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openPutAway = (row) => {
    setActive(row);
    setScannedRack(null);
  };

  const handleScanRack = (code) => {
    const clean = code.trim().toUpperCase();
    const match = rackBins.find(
      (r) => r.part_id === active.part_id && (`${r.location}-${r.rack_no}`.toUpperCase() === clean || r.rack_no.toUpperCase() === clean)
    );
    if (!match) {
      toast.error(`No rack "${code}" allocated to ${active.part_no}`);
      return;
    }
    setScannedRack(match);
    if (match.is_blocked || match.available_bins <= 0) {
      toast(`Rack ${match.location}/${match.rack_no} has no space — will be sent to Holding Area if confirmed`, { icon: "⚠️" });
    } else {
      toast.success(`Rack ${match.location}/${match.rack_no} matched — ${match.available_bins} bin(s) available`);
    }
  };

  const handleScanPart = async (code) => {
    try {
      const res = await putAwayService.confirm(active.id, scannedRack.id, code.trim());
      const status = res.data.data.put_away_status;
      if (status === "HOLDING") {
        toast(`${active.part_no}: rack full — moved to Holding Area`, { icon: "📦" });
      } else {
        toast.success(`${active.part_no} allocated to ${scannedRack.location}/${scannedRack.rack_no}`);
      }
      setActive(null);
      setScannedRack(null);
      load();
    } catch (_) {
      /* handled globally — wrong part / already completed */
    }
  };

  const columns = [
    { key: "part_no", label: "Part No" },
    { key: "part_name", label: "Part Name" },
    { key: "qty_received", label: "Qty", render: (r) => r.qty_received ?? r.qty_invoiced },
    { key: "srv_no", label: "SRV No", render: (r) => r.srv_no || "—" },
    {
      key: "actions", label: "Actions",
      render: (r) => (
        <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => openPutAway(r)}>
          <MapPin size={14} /> Allocate Rack
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <PackageSearch size={18} className="text-toyotared" /> Pending Rack Allocation
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Material that has reached Store Stock (directly, or after RQC approval) and needs a rack location. If the
          assigned rack has no space, it's automatically moved to the Holding Area instead.
        </p>
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="Nothing pending rack allocation" />
      </div>

      {active && (
        <div className="card space-y-4">
          <h3 className="font-semibold text-slate-800 dark:text-white">
            Rack Allocation — {active.part_no} ({active.part_name})
          </h3>

          {!scannedRack ? (
            <div>
              <p className="text-xs text-slate-400 mb-2">Step 1: Scan the rack (e.g. A1-R2)</p>
              <BarcodeScanInput onScan={handleScanRack} placeholder="Scan rack location" />
            </div>
          ) : (
            <div>
              {scannedRack.is_blocked || scannedRack.available_bins <= 0 ? (
                <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1.5 mb-2">
                  <AlertTriangle size={15} /> Rack {scannedRack.location}/{scannedRack.rack_no} has no available space
                </p>
              ) : (
                <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 mb-2">
                  <CheckCircle2 size={15} /> Rack {scannedRack.location}/{scannedRack.rack_no} matched — {scannedRack.available_bins} bin(s) available
                </p>
              )}
              <p className="text-xs text-slate-400 mb-2">Step 2: Scan the part to confirm</p>
              <BarcodeScanInput onScan={handleScanPart} placeholder="Scan part barcode" />
            </div>
          )}

          <button className="btn-secondary" onClick={() => { setActive(null); setScannedRack(null); }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
