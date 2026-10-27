import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { spareFlowService } from "../services/spareFlowService.js";

// The Scan Part workstation's identification state: which part is on screen,
// how it was identified, why a code failed — and the part's scan result.
//
// Every way of naming a part (gun, camera, search, manual entry) goes through
// the ONE server resolve (/barcode/resolve: audited, store-scoped, supplier
// mappings first), so a part is identified the same however it was named. The
// scan result is then read under ["stock", "scan-result", id]: a write here
// or a stock push from another terminal refreshes it like every stock screen.

// How the part was identified, in the vocabulary of the label print audit
// (lib/scanStatus PRINT_SOURCE): a supplier's barcode, our own QR, a Part No.
// search or a typed code. A gun / camera read counts as SUPPLIER_BARCODE only
// when the server matched it through a supplier mapping.
export function identSource(via, resolvedBy) {
  if (via === "SEARCH") return "ERP_SEARCH";
  if (via === "MANUAL") return "MANUAL_ENTRY";
  return resolvedBy === "SUPPLIER" ? "SUPPLIER_BARCODE" : "QR_SCAN";
}

export const scanResultKey = (partId) => ["stock", "scan-result", partId];

// A failed resolve -> what the failure panel shows. The server names the reason
// in errors.result (UNKNOWN_BARCODE, INACTIVE_BARCODE, OTHER_STORE,
// INACTIVE_PART, FAILED, CODE_TOO_LONG); with no answer at all it is the network.
function failureOf(err, code) {
  const resp = err?.response;
  if (!resp) return { code, result: "NETWORK", message: null };
  const errors = resp.data?.errors;
  const result = errors?.result || (resp.status === 404 ? "NOT_FOUND" : "ERROR");
  return { code: errors?.code || code, result, message: resp.data?.message || null };
}

export default function useScanWorkstation(storeCode) {
  const qc = useQueryClient();
  // { partId, source, via, code, resolvedBy, origin, dataStatus }
  const [ident, setIdent] = useState(null);
  // { code, result, message, via, scanSource }
  const [failure, setFailure] = useState(null);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const seqRef = useRef(0); // a clear / link / newer read makes an in-flight resolve stale

  /**
   * Resolve a code to a part. via: SCAN | SEARCH | MANUAL; scanSource: the
   * audit source (USB_SCANNER / TABLET_CAMERA / MANUAL_ENTRY). Resolves to
   * true when a part was identified. One at a time — a read arriving while one
   * is in flight is dropped (the scan box is disabled meanwhile anyway).
   */
  const resolve = useCallback(async (code, { via, scanSource, scanMode = "LOOKUP" }) => {
    if (resolvingRef.current) return false;
    resolvingRef.current = true;
    const seq = ++seqRef.current;
    setResolving(true);
    try {
      // silent: the failure panel explains the error itself, so the global
      // interceptor must not toast it on top.
      const res = await api.post("/barcode/resolve", {
        store_code: storeCode, code, scan_source: scanSource, scan_mode: scanMode,
      }, { silent: true });
      if (seq !== seqRef.current) return false;
      const d = res.data.data;
      setFailure(null);
      setIdent({
        partId: d.part_id, via, source: identSource(via, d.resolved_by),
        code: d.scanned_code ?? code, resolvedBy: d.resolved_by, origin: "SCAN",
        dataStatus: d.data_status || null,
        // A packet / unit QR (27 Oct 2026): the packet itself — Issue then
        // issues it whole (forms/PacketIssueForm).
        packet: d.packet || null,
      });
      // Re-scanning the part already on screen must show it as it is NOW.
      qc.invalidateQueries({ queryKey: scanResultKey(d.part_id) });
      return true;
    } catch (err) {
      if (seq !== seqRef.current) return false;
      setIdent(null);
      setFailure({ ...failureOf(err, code), via, scanSource });
      return false;
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  }, [storeCode, qc]);

  // A deep link (/scan-part?part=<id>) names the part by id: nothing to
  // resolve, so nothing is audited as a scan; for a label print it counts as a
  // Part No. search (contract).
  const openById = useCallback((partId) => {
    seqRef.current++;
    setFailure(null);
    setIdent({ partId, via: "LINK", source: "ERP_SEARCH", code: null, resolvedBy: null, origin: "LINK", dataStatus: null });
  }, []);

  const clear = useCallback(() => {
    seqRef.current++;
    setIdent(null);
    setFailure(null);
  }, []);

  const clearFailure = useCallback(() => setFailure(null), []);

  const partId = ident?.partId ?? null;
  const scanQuery = useQuery({
    queryKey: scanResultKey(partId),
    queryFn: () => spareFlowService.scanResult(partId).then((r) => r.data.data),
    enabled: partId != null,
    // Always re-read on (re)identification — a cached copy of this part from
    // an earlier scan is only a first paint, never the answer.
    staleTime: 0,
    // A refused part (403 / 404) will not change on a retry, and every failed
    // request is toasted; the card offers its own Retry.
    retry: false,
  });

  return { ident, failure, resolving, resolve, openById, clear, clearFailure, scanQuery };
}
