import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import Modal from "./Modal";
import BarcodeLabel from "./BarcodeLabel";
import { barcodeService } from "../services/barcodeService";
import { buildLabelHtml, printLabels } from "../utils/barcodeRender";

// Print / reprint a spare part's Code-128 label. Records the print (audit) on the
// server first, then prints at true size. A reprint (part already printed once)
// requires a reason. The internal barcode payload is only the Part No.
export default function PrintBarcodeModal({ open, onClose, part, config }) {
  const [copies, setCopies] = useState(1);
  const [reason, setReason] = useState("");
  const [alreadyPrinted, setAlreadyPrinted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && part) {
      setCopies(1);
      setReason("");
      setAlreadyPrinted(false);
      barcodeService
        .printHistory(part.id, 1)
        .then((r) => setAlreadyPrinted((r.data.data || []).length > 0))
        .catch(() => setAlreadyPrinted(false));
    }
  }, [open, part]);

  if (!part) return null;
  const isReprint = alreadyPrinted;
  const barcodeValue = part.part_no; // internal barcode = the stable Part No.

  const doPrint = async () => {
    if (isReprint && !reason.trim()) {
      toast.error("A reprint reason is required");
      return;
    }
    setBusy(true);
    try {
      const res = await barcodeService.print({
        part_id: part.id,
        copies: Number(copies) || 1,
        is_reprint: isReprint,
        reason: reason.trim() || undefined,
      });
      const d = res.data.data;
      printLabels(
        buildLabelHtml({
          barcodeValue: d.barcode_value,
          partNo: d.part_no,
          description: d.part_name,
          config,
          copies: d.copies,
        }),
      );
      toast.success(isReprint ? "Reprint sent to printer" : "Label sent to printer");
      onClose?.();
    } catch {
      /* api interceptor already toasts the server message */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Print Barcode — ${part.part_no}`}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={doPrint} disabled={busy}>
            {busy ? "Printing…" : isReprint ? "Reprint" : "Print"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex justify-center rounded-lg bg-slate-50 py-4 dark:bg-navy-800">
          <BarcodeLabel value={barcodeValue} partNo={part.part_no} description={part.part_name} config={config} />
        </div>
        <p className="text-center text-xs text-slate-500 dark:text-slate-400">
          Label {Number(config?.width_mm) || 100}mm × {Number(config?.height_mm) || 50}mm ·
          barcode encodes only the Part No.
        </p>
        <div className="flex items-center gap-3">
          <label className="w-28 text-sm text-slate-600 dark:text-slate-300">Copies</label>
          <input
            type="number" min={1} max={100} value={copies}
            onChange={(e) => setCopies(e.target.value)}
            className="input-field w-24"
          />
        </div>
        {isReprint && (
          <div className="flex items-start gap-3">
            <label className="w-28 pt-2 text-sm text-slate-600 dark:text-slate-300">Reprint reason</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. label torn / faded"
              className="input-field flex-1"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
