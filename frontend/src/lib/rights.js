// The four rights a screen can grant, CRUD since 24 Oct 2026 (the store:
// "proper crud bna — E matlab kewal edit/modify, create matlab new create aur
// insert data, read matlab kewal view no any action, delete matlab kewal
// delete"). Keys as the server stores them (backend/app/models/user.py); each
// screen lists the ones it has in `actions` (GET /admin/modules).
export const CRUD = [
  { key: "view", short: "R", label: "Read", hint: "open and read only — no action" },
  { key: "create", short: "C", label: "Create", hint: "add new / insert data" },
  { key: "update", short: "E", label: "Edit", hint: "change what already exists" },
  { key: "delete", short: "D", label: "Delete", hint: "remove / cancel" },
];

export const BLANK_RIGHTS = { view: false, create: false, update: false, delete: false };

/** The CRUD columns a module has (its `actions`), in R C E D order. */
export const crudOf = (module) => CRUD.filter((c) => (module?.actions || ["view"]).includes(c.key));

/** One module's rights after ticking `action`: any write brings Read, and
 *  taking Read away takes every write with it. */
export function withRight(entry, action, value) {
  const next = { ...BLANK_RIGHTS, ...(entry || {}), [action]: value };
  delete next.edit;                                   // a pre-CRUD key
  if (action !== "view" && value) next.view = true;
  if (action === "view" && !value) { next.create = false; next.update = false; next.delete = false; }
  return next;
}

/** Every right a module has, or Read only. */
export const fullRights = (module, readOnly = false) => {
  const out = { ...BLANK_RIGHTS };
  crudOf(module).forEach((c) => { out[c.key] = readOnly ? c.key === "view" : true; });
  return out;
};

export const anyRight = (p) => Boolean(p && (p.view || p.create || p.update || p.delete));
