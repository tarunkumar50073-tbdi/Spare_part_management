import api from "./api";

// Employee master — the people spare parts are issued to. The issue counter
// looks a person up by mobile number (and may add one that is missing); the
// master screen keeps it correct. Global, not store-scoped.
export const employeeService = {
  // -> { mobile, found, active?, employee }. `config` passes axios options
  // (e.g. { silent: true } where the form shows its own message).
  lookup: (mobile, config = {}) => api.get("/employees/lookup", { params: { mobile }, ...config }),
  list: (params, config = {}) => api.get("/employees", { params, ...config }),
  // Today's people from the Maintenance and Tool Room rosters, each with his
  // shift badge: { rows, date, rosters: [{ source, department, ok, error, on_duty, marked }] }.
  // refresh: read the rosters again now (else at most once a minute).
  onDuty: ({ q, refresh } = {}, config = {}) =>
    api.get("/employees/on-duty", { params: { q: q || undefined, refresh: refresh ? 1 : undefined }, ...config }),
  // { mobile, name, employee_code?, department, designation?, company? }.
  // `config` as for lookup — the counter's quick-add shows its own message.
  create: (payload, config = {}) => api.post("/employees", payload, config),
  update: (id, payload) => api.put(`/employees/${id}`, payload),
  import: (file) => {
    const form = new FormData();
    form.append("file", file);
    return api.post("/employees/import", form, { headers: { "Content-Type": "multipart/form-data" } });
  },
};

// Same normalisation as the server (models/employee.normalise_mobile), so the
// form can tell "not 10 digits yet" from "look this number up".
export function normaliseMobile(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
