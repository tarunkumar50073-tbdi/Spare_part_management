import React from "react";
import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import { storeHome, useStores } from "../context/StoreContext.jsx";
import { can } from "../utils/permissions.js";

// Route-level gate. The sidebar already hides screens a user may not view, but
// the address bar is not a menu — typing /parts must be refused too. Admin
// passes everything; an ungated route (no `mod`) is open to any signed-in user.
export default function RequirePermission({ mod, action = "view", children }) {
  const { user } = useAuth();
  const { activeCode } = useStores();

  if (can(user, mod, action)) return children;

  return (
    <div className="max-w-md mx-auto mt-16 text-center">
      <div className="card p-8">
        <ShieldAlert className="mx-auto mb-4 text-toyotared" size={40} />
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Access restricted</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          You don’t have permission to open this screen. Ask an administrator to grant it under
          User Management.
        </p>
        <Link
          to={storeHome(activeCode)}
          className="inline-block mt-5 rounded-lg bg-toyotared px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Back to store
        </Link>
      </div>
    </div>
  );
}
