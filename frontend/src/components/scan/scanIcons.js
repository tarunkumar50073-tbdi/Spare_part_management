import {
  ArrowDownToLine, ArrowUpFromLine, Ban, Boxes, Circle, ClipboardCheck, Factory, FileCheck2, History,
  MapPin, PackageCheck, PackagePlus, Printer, Scale, ShieldCheck, ShieldX, Truck, Undo2, Warehouse, Wrench,
} from "lucide-react";

// lib/scanStatus.js names its icons by their Lucide name (it is plain data and
// imports no React). This is the one place those names become components, so
// the workstation, the part timeline and the part drawer draw the same glyph for
// the same action or event. A name missing here falls back to a plain circle
// rather than breaking the screen.
const ICONS = {
  ArrowDownToLine, ArrowUpFromLine, Ban, Boxes, Circle, ClipboardCheck, FileCheck2, History, MapPin,
  PackageCheck, PackagePlus, Printer, Scale, ShieldCheck, ShieldX, Truck, Undo2, Wrench,
};

export const scanIcon = (name) => ICONS[name] || Circle;

// scan_result.locations[].kind -> glyph. Where a quantity of the part sits.
export const LOCATION_ICON = {
  STORE: Warehouse,
  QUALITY: ShieldCheck,
  LINE: Factory,
  RETURN_HOLD: ClipboardCheck,
  SUPPLIER: Truck,
};

// Tone -> the tinted chip every scan card uses for an icon (same tints as
// CardHead, so a status reads the same colour everywhere).
export const TONE_CHIP = {
  success: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  info: "bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
  warning: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  danger: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  neutral: "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-300",
};
