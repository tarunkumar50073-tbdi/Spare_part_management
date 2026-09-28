import api from "./api";

// Line / Machine / Die master — the pick-lists for the install screen. The
// install form reads a kind's list and may add a value that is missing; the
// master screen keeps them correct. Global, not store-scoped.
export const equipmentService = {
  // params: { kind?: 'LINE'|'MACHINE'|'DIE', active?, q?, limit? }
  list: (params) => api.get("/equipment", { params }),
  // { kind, name, code? }. `config` passes axios options (e.g. { silent: true }
  // where the form shows its own message on the counter quick-add).
  create: (payload, config = {}) => api.post("/equipment", payload, config),
  update: (id, payload) => api.put(`/equipment/${id}`, payload),
  // Fill the master from the distinct values already on past installations.
  seed: () => api.post("/equipment/seed"),
  import: (file) => {
    const form = new FormData();
    form.append("file", file);
    return api.post("/equipment/import", form, { headers: { "Content-Type": "multipart/form-data" } });
  },
};

export const EQUIPMENT_KINDS = [
  { key: "LINE", label: "Line", plural: "Lines" },
  { key: "MACHINE", label: "Machine", plural: "Machines" },
  { key: "DIE", label: "Die", plural: "Dies" },
];
