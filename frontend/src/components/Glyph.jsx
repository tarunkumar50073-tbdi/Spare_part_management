import React from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, Armchair, Bell, Bolt, BookOpen, Boxes, Calculator,
  CalendarDays, CalendarRange, ChartColumn, ChartPie, Circle, CircleCheck, CircleHelp,
  ClipboardList, Clock3, Database, Download, Factory, FileChartColumn, FilePen, Flame,
  Flashlight, FlaskConical, Gem, Hammer, HeartPulse, History, Hourglass, Inbox, IndianRupee,
  KeyRound, Layers, LayoutGrid, Link, Mail, Mails, MapPin, Monitor, Package, PaintRoller,
  Pencil, ReceiptText, Repeat2, Scale, ScanBarcode, ScanLine, ScrollText, Search, Settings,
  ShieldCheck, ShoppingCart, ShowerHead, Siren, Star, Store, SwitchCamera, Tag, ToolCase,
  Toolbox, TrafficCone, TrendingUp, TriangleAlert, Truck, Undo2, Wrench, Zap,
} from "lucide-react";

// One icon set for the whole app. Some icons still arrive as the emoji they were
// first written as — the server's services catalogue, `stores.icon`, a caller
// not yet moved over — so the swap to line icons happens here, in one map,
// rather than in every caller. Keys are stored without the U+FE0F variation
// selector, so "⚙️" and "⚙" both resolve. An emoji with no entry still renders
// as itself instead of vanishing.
const EMOJI_ICONS = {
  // stores, sections, part families
  "🔧": Wrench, "🔨": Hammer, "🔩": Bolt, "💺": Armchair, "🚿": ShowerHead, "🛠": ToolCase,
  "🔥": Flame, "🎨": PaintRoller, "⚡": Zap, "🧰": Toolbox, "🏬": Store, "📦": Package,
  "🏭": Factory,
  // movements
  "📥": ArrowDownToLine, "📤": ArrowUpFromLine, "↩": Undo2, "✏": Pencil, "🔁": Repeat2,
  "🚚": Truck, "🚛": Truck, "🚦": TrafficCone, "📍": MapPin,
  // documents
  "📋": ClipboardList, "📝": FilePen, "🧾": ReceiptText, "📜": ScrollText, "📑": FileChartColumn,
  "📚": BookOpen, "🏷": Tag, "✉": Mail, "📧": Mails, "📭": Inbox,
  // status and alerts
  "✅": CircleCheck, "⚠": TriangleAlert, "🚨": Siren, "❓": CircleHelp, "⏳": Hourglass,
  "🩺": HeartPulse, "🧪": FlaskConical, "🛒": ShoppingCart,
  // analytics
  "📊": ChartColumn, "📈": TrendingUp, "🍩": ChartPie, "💰": IndianRupee, "💎": Gem,
  "🧮": Calculator, "⚖": Scale, "🗃": Boxes, "🗄": Database, "🗂": Layers,
  // time
  "🕒": Clock3, "🕘": History, "📅": CalendarDays, "🗓": CalendarRange,
  // tools and system
  "🔍": Search, "🔎": Search, "📷": ScanBarcode, "📠": ScanLine, "🔗": Link, "⚙": Settings,
  "🛡": ShieldCheck, "🖥": Monitor, "🧩": LayoutGrid, "▫": Circle, "🔑": KeyRound,
  "🔔": Bell, "⬇": Download, "★": Star, "🔦": Flashlight, "🔄": SwitchCamera,
};

// A glyph per store section, matched on its name so a section added later
// still gets one without a code change. Shared by the sidebar and the store's
// section table so a section reads the same everywhere.
const SECTION_ICONS = [
  [/press|stamp|misumi|die/i, Hammer],
  [/nut|bolt|fasten/i, Bolt],
  [/thin|recliner|rec\b/i, Armchair],
  [/bin|wash/i, ShowerHead],
  [/maint/i, Wrench],
  [/tool/i, ToolCase],
  [/seat|slider/i, Armchair],
  [/weld/i, Flame],
  [/paint|coat/i, PaintRoller],
  [/electric|electr/i, Zap],
];
export const sectionIcon = (name) =>
  (SECTION_ICONS.find(([re]) => re.test(name || "")) || [null, Toolbox])[1];

/** The line icon behind an emoji, or null when it has none. */
export const iconForEmoji = (emoji) =>
  (typeof emoji === "string" ? EMOJI_ICONS[emoji.replace(/️/g, "").trim()] : null) || null;

const isComponent = (v) =>
  typeof v === "function" || (typeof v === "object" && v !== null && !React.isValidElement(v) && "$$typeof" in v);

/**
 * Renders whatever a caller hands over as an icon: a Lucide component
 * (`icon={Truck}`), a ready element (`icon={<Truck />}`) or an emoji string,
 * which is swapped for its line icon. Always decorative (aria-hidden) — the
 * label beside it carries the meaning.
 */
export default function Glyph({ icon, size = 16, strokeWidth = 2, className = "" }) {
  if (icon == null || icon === false || icon === "") return null;
  if (React.isValidElement(icon)) return icon;
  const Icon = isComponent(icon) ? icon : iconForEmoji(icon);
  if (Icon) return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />;
  return <span className={className} aria-hidden="true">{icon}</span>;
}
