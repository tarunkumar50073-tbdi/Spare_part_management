import { useQuery } from "@tanstack/react-query";
import { barcodeService } from "../../services/barcodeService";

// The store label printer and its status: {name, connection BROWSER|NETWORK,
// status NOT_DETECTABLE|REACHABLE|UNREACHABLE, checked_at, detail}. Only a
// network printer gets a real answer (a TCP connect made by the server); a
// browser-dialog printer is "not detectable" — never a made-up Online/Offline.
export const printerStatusKey = ["label-printer", "status"];

// Shared by every chip and printer picker on screen — one check, one cache.
// Kept for 30 s: opening the print dialog again does not re-dial the printer;
// "Check again" (refetch) does. The chip shows the error itself, hence silent.
export function usePrinterStatus({ enabled = true } = {}) {
  return useQuery({
    queryKey: printerStatusKey,
    queryFn: () => barcodeService.printerStatus({ silent: true }).then((r) => r.data.data),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}
