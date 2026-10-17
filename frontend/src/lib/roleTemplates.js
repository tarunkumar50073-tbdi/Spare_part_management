import TEMPLATES from "./roleTemplates.json";

// Role templates for User Management (store's request of 17 Oct 2026: "template
// bana de"). Making a login used to mean ticking a dozen View / Edit boxes and
// the store access by hand; now the admin picks a type — Store Staff, Store
// Supervisor, Line User, Kiosk device, Manager, Live Board — and its rights and
// store access fall into place, and can still be changed box by box after.
//
// A front-end convenience only: the user is saved exactly as before (role,
// stores, per-module permissions), nothing records which template was used. The
// list screen recognises a template again by comparing the saved rights with
// each template's, and says "Custom" when they match none.
//
// The definitions live in roleTemplates.json, not here, because the backend test
// (backend/tests/test_role_templates.py) reads the same file and signs in as each
// template to prove its screens' endpoints answer and the rest are refused.

export const ROLE_TEMPLATES = TEMPLATES.templates;

export const TEMPLATE_HELP =
  "Pick a template, then set the login ID and password. You can still change single rights below.";

const copy = (obj) => JSON.parse(JSON.stringify(obj || {}));

// A rights map reduced to what it allows: { module: "view" | "edit" }, modules
// with nothing ticked left out. Edit implies view (as the grid and the server
// treat it), so { view: false, edit: true } and { view: true, edit: true } read
// the same, and an all-false entry the server kept reads as no entry.
function levels(perms) {
  const out = {};
  Object.entries(perms || {}).forEach(([key, p]) => {
    if (p?.edit) out[key] = "edit";
    else if (p?.view) out[key] = "view";
  });
  return out;
}

const sameLevels = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

const sameStores = (a, b) => {
  const sa = [...new Set(a || [])].sort();
  const sb = [...new Set(b || [])].sort();
  return sa.length === sb.length && sa.every((s, i) => s === sb[i]);
};

/** The template whose rights AND store access equal the user's (or the form's),
 *  else null. An admin matches none — an admin has everything regardless. */
export function matchTemplate({ role, stores, permissions } = {}) {
  if (role === "ADMIN") return null;
  const mine = levels(permissions);
  return ROLE_TEMPLATES.find((t) => sameStores(t.stores, stores) && sameLevels(levels(t.permissions), mine)) || null;
}

/** True when nothing is granted yet (no right, no store) — a blank new user,
 *  which reads "no template picked", not "Custom". */
export const isBlank = ({ stores, permissions } = {}) =>
  !(stores || []).length && Object.keys(levels(permissions)).length === 0;

/** The form fields a template sets — fresh copies, so ticking a box afterwards
 *  never edits the template itself. */
export function templateFields(template) {
  return {
    role: template.role,
    stores: [...template.stores],
    permissions: copy(template.permissions),
  };
}
