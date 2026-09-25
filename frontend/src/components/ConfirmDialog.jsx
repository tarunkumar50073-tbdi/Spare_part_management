import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import Modal from "./Modal.jsx";

/**
 * Promise-based confirm dialog — a styled, accessible replacement for the
 * native window.confirm(). Mount <ConfirmProvider> once near the app root, then
 * in any component:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, message, confirmText, danger }))) return;
 *
 * It resolves true on confirm and false on cancel / backdrop / Escape.
 */
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [opts, setOpts] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((options = {}) => new Promise((resolve) => {
    resolver.current = resolve;
    setOpts({
      title: options.title || "Please confirm",
      message: options.message || "Are you sure?",
      confirmText: options.confirmText || "Confirm",
      cancelText: options.cancelText || "Cancel",
      danger: options.danger !== false, // most confirms are destructive → red by default
    });
  }), []);

  const settle = (result) => {
    setOpts(null);
    if (resolver.current) { resolver.current(result); resolver.current = null; }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => settle(false)}
        title={opts?.title}
        footer={opts && (
          <>
            <button type="button" className="btn-secondary" onClick={() => settle(false)}>{opts.cancelText}</button>
            <button type="button" className={opts.danger ? "btn-danger" : "btn-primary"} onClick={() => settle(true)}>{opts.confirmText}</button>
          </>
        )}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">{opts?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
