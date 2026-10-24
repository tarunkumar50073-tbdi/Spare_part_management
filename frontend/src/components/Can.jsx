import { useAuth } from "../context/AuthContext.jsx";
import { can } from "../utils/permissions.js";

// The one place a screen asks "may this user do X?" — so gating reads the same
// everywhere. Actions are CRUD (24 Oct 2026): "view" R, "create" C, "update" E,
// "delete" D — `const mayIssue = useCan("scan_part", "create")`.
export function useCan(mod, action = "view") {
  const { user } = useAuth();
  return can(user, mod, action);
}

// Declarative gate around a control: renders its children only when the user
// holds the right, else `fallback` (nothing by default). `edit` is shorthand
// for action="update" (E — change what exists).
//   <Can mod="part_master" action="delete"><button>Delete</button></Can>
export default function Can({ mod, action, edit = false, children, fallback = null }) {
  const allowed = useCan(mod, edit ? "update" : action || "view");
  return allowed ? children : fallback;
}
