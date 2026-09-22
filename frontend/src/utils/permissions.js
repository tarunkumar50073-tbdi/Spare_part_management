// Per-module rights, read off the signed-in user's `permissions` map (which the
// server puts in to_public_dict). Admin bypasses everything; an ungated item
// (no module key) is always allowed; "edit" implies "view".
export function can(user, mod, action = "view") {
  if (!user) return false;
  if (user.is_admin) return true;
  if (!mod) return true;
  const p = (user.permissions || {})[mod] || {};
  return action === "edit" ? Boolean(p.edit) : Boolean(p.view || p.edit);
}
