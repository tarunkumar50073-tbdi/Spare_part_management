import { useStores } from "../context/StoreContext.jsx";

// Part categories, and which store each one belongs to.
//
// Every screen used to keep its own copy of the same five-item list, so a
// Child Parts user picked "Maintenance/Tool Room" from a Live Stock filter
// that could only ever return nothing. The split lives here once and the
// screens read it, so the two stores stay apart in one place rather than six.
export const ALL_CATEGORIES = [
  "BOP",
  "Import",
  "Maintenance/Tool Room",
  "Consumable",
  "In-Parts",
];

export const CATEGORIES_BY_STORE = {
  CHILD_PART: ["BOP", "Import", "In-Parts"],
  // Consumable sits here until it gets a store of its own — it is certainly
  // not a child part, and leaving it out entirely would strand any part
  // already filed under it.
  MAINTENANCE: ["Maintenance/Tool Room", "Consumable"],
};

// A store added later is usable before anyone writes a list for it, rather
// than showing an empty dropdown.
export const categoriesFor = (storeCode) => CATEGORIES_BY_STORE[storeCode] || ALL_CATEGORIES;

/** Categories for whichever store the sidebar is currently scoped to. */
export function useStoreCategories() {
  const { activeCode } = useStores();
  return categoriesFor(activeCode);
}
