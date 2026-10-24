import React, { Suspense, createContext, lazy, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// One part drawer for the whole app. Any screen calls `openPart(partId)` — the
// dashboard's drills, the stock list, the part ledger, Ctrl+K — and gets the
// same view of the part. The drawer's code (charts included) loads the first
// time a part is opened, not with the app.
//
// `openPart(id, { back: "Excess Parts" })` opens it OVER the list it came from:
// the list stays open underneath and the drawer gets a "← Excess Parts" arrow
// back to it (the store, 23 Oct 2026: "ye pic mujhe excess capital se bahar
// nikal deti h … back button se wapis usi screen par aani chahiye"). The drawer
// goes to the end of <body> so it sits above a full-screen drill there.
const PartDrawer = lazy(() => import("../components/spare/PartDrawer.jsx"));

const PartDrawerContext = createContext(null);

export function PartDrawerProvider({ children }) {
  const [open, setOpen] = useState(null);           // { partId, back }
  const api = useMemo(() => ({
    openPart: (id, how) => setOpen(id == null ? null : { partId: id, back: how?.back || null }),
    closePart: () => setOpen(null),
  }), []);
  return (
    <PartDrawerContext.Provider value={api}>
      {children}
      {open && createPortal(
        <Suspense fallback={null}>
          <PartDrawer partId={open.partId} back={open.back} onClose={api.closePart} />
        </Suspense>,
        document.body,
      )}
    </PartDrawerContext.Provider>
  );
}

// Outside the provider (e.g. the full-screen wallboard) opening is a no-op.
const NOOP = { openPart: () => {}, closePart: () => {} };
export const usePartDrawer = () => useContext(PartDrawerContext) || NOOP;
