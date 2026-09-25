import React, { Suspense, createContext, lazy, useContext, useMemo, useState } from "react";

// One part drawer for the whole app. Any screen calls `openPart(partId)` — the
// dashboard's drills, the stock list, the part ledger, Ctrl+K — and gets the
// same view of the part. The drawer's code (charts included) loads the first
// time a part is opened, not with the app.
const PartDrawer = lazy(() => import("../components/spare/PartDrawer.jsx"));

const PartDrawerContext = createContext(null);

export function PartDrawerProvider({ children }) {
  const [partId, setPartId] = useState(null);
  const api = useMemo(() => ({
    openPart: (id) => setPartId(id ?? null),
    closePart: () => setPartId(null),
  }), []);
  return (
    <PartDrawerContext.Provider value={api}>
      {children}
      {partId != null && (
        <Suspense fallback={null}>
          <PartDrawer partId={partId} onClose={api.closePart} />
        </Suspense>
      )}
    </PartDrawerContext.Provider>
  );
}

// Outside the provider (e.g. the full-screen wallboard) opening is a no-op.
const NOOP = { openPart: () => {}, closePart: () => {} };
export const usePartDrawer = () => useContext(PartDrawerContext) || NOOP;
