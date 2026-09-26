import { useQuery } from "@tanstack/react-query";
import { barcodeService } from "../../services/barcodeService";

// The effective label template (size, symbology, what shows) from the backend.
// Same ["label-config"] cache the stock list and the part drawer read, so the
// template is fetched once per session; Settings invalidates it on save.
// A caller that already holds the config passes it and nothing is fetched.
// `ready` turns true once a print can use it — on a failed fetch the renderer's
// defaults (QR, 100 x 50 mm) apply, as they always did.
export function useLabelConfig({ enabled = true, config = null } = {}) {
  const q = useQuery({
    queryKey: ["label-config"],
    staleTime: 10 * 60_000,
    enabled: enabled && !config,
    queryFn: () => barcodeService.labelConfig().then((r) => r.data.data),
  });
  const effective = config || q.data || null;
  return { config: effective, ready: Boolean(effective) || q.isError };
}
