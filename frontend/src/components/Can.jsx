import { useAuth } from "../context/AuthContext.jsx";
import { can } from "../utils/permissions.js";

// The one place a screen asks "may this user do X?" — so gating reads the same
// everywhere. `const mayEdit = useCan("scan_part", "edit")`.
export function useCan(mod, action = "view") {
  const { user } = useAuth();
  return can(user, mod, action);
}

// Declarative gate around a control: renders its children only when the user
// holds the right, else `fallback` (nothing by default). `edit` is shorthand
// for action="edit" — the common case for a mutation button.
//   <Can mod="scan_part" edit><button>Issue</button></Can>
export default function Can({ mod, action, edit = false, children, fallback = null }) {
  const allowed = useCan(mod, edit ? "edit" : action || "view");
  return allowed ? children : fallback;
}
