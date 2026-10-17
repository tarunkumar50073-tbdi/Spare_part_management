import React, { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Plus } from "lucide-react";
import { equipmentService } from "../services/equipmentService.js";
import { useCan } from "./Can.jsx";

// A pick-or-type box for a Line / Machine / Die (install screen). It shows the
// master list for the kind as the operator types; picking one fills the field
// (and, for a LINE, hands back the line no. through onPick). A value not on the
// master can still be typed so the floor is never blocked, and — with the right
// — added to the master on the spot, the same quick-add idea as the employee
// counter lookup.
//
// Props: kind ('LINE'|'MACHINE'|'DIE'), value (text), onChange(text),
//        onPick(entity) — the picked/added master row, id, placeholder,
//        maxLength, disabled.
export default function EquipmentSelect({
  kind, value, onChange, onPick, id, placeholder, maxLength = 60, disabled,
}) {
  const qc = useQueryClient();
  // Rules of hooks: call both, then combine — never `useCan(a) || useCan(b)`.
  const canScan = useCan("scan_part", "edit");
  const canMaster = useCan("equipment", "edit");
  const canAdd = canScan || canMaster;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const closeTimer = useRef(null);

  const list = useQuery({
    queryKey: ["equipment", kind],
    queryFn: () => equipmentService.list({ kind, active: 1 }).then((r) => r.data.data || []),
    staleTime: 5 * 60_000,
  });
  const items = list.data || [];

  const typed = String(value || "").trim();
  const matches = useMemo(() => {
    const q = typed.toLowerCase();
    const base = q
      ? items.filter((e) => e.name.toLowerCase().includes(q) || (e.code || "").toLowerCase().includes(q))
      : items;
    return base.slice(0, 8);
  }, [items, typed]);
  const exact = items.some((e) => e.name.toLowerCase() === typed.toLowerCase());
  const showAdd = typed && !exact && canAdd;

  const pick = (e) => {
    onChange(e.name);
    onPick?.(e);
    setOpen(false);
  };

  const addToMaster = async () => {
    if (!typed || adding) return;
    setAdding(true);
    try {
      const res = await equipmentService.create({ kind, name: typed }, { silent: true });
      onPick?.(res.data.data);
      toast.success(`${typed} added to the ${kind.toLowerCase()} list`);
    } catch {
      // Someone may have added it meanwhile (409) — the refresh below picks it up.
    } finally {
      qc.invalidateQueries({ queryKey: ["equipment", kind] });
      setAdding(false);
      setOpen(false);
    }
  };

  // Leaving the box (Tab, a click elsewhere) closes the list a moment later.
  const onBlur = () => { closeTimer.current = setTimeout(() => setOpen(false), 150); };
  // A press inside the list must not take the focus from the box: the box would
  // blur, the list close, and the click never land on the suggestion (a slow
  // tap on the tablet lost every pick).
  const keepFocus = (e) => {
    e.preventDefault();
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  return (
    <div className="relative">
      <input id={id} value={value || ""} maxLength={maxLength} disabled={disabled} autoComplete="off"
        className="input-field" placeholder={placeholder} role="combobox" aria-expanded={open}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={onBlur} />
      {open && (matches.length > 0 || showAdd) && (
        <ul onMouseDown={keepFocus}
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-navy-700 dark:bg-navy-900">
          {matches.map((e) => (
            <li key={e.id}>
              <button type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-navy-800"
                onClick={() => pick(e)}>
                <span className="text-slate-800 dark:text-white">{e.name}</span>
                {e.code && <span className="tabular text-xs text-slate-400">{e.code}</span>}
              </button>
            </li>
          ))}
          {showAdd && (
            <li className="border-t border-slate-100 dark:border-navy-800">
              <button type="button" disabled={adding}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-toyotared hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-navy-800"
                onClick={addToMaster}>
                <Plus size={14} aria-hidden="true" /> Add “{typed}” to the {kind.toLowerCase()} list
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
