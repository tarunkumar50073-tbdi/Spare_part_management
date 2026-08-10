import { srvService } from "./srvService";

export const putAwayService = {
  listPending: () => srvService.putAwayPending(),
  confirm: (id, rackBinId, scannedPartCode) => srvService.putAwayConfirm(id, rackBinId, scannedPartCode),
};
