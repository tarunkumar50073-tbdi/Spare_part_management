"""One catalogue of every screen a user can open — the single source of truth
for the "All Services" launcher and the in-app assistant's page suggestions.

Keep it to the screens that are actually reachable in the Spare-store build;
each entry carries search keywords (English + common Hinglish) so both the
launcher search and the assistant can find a screen by what a person calls it.

`mod` is the per-module permission key (see user.PERMISSION_MODULES) for screens
that are route-guarded — the launcher and suggestions hide a screen a user may
not open, exactly like the sidebar does. Entries with no `mod` are open to any
signed-in user; `admin: True` marks admin-only screens.
"""

SERVICES = [
    # --- Overview ---
    {"key": "spare_dashboard", "title": "Spare Parts Store", "route": "/store/MAINTENANCE",
     "category": "Overview", "icon": "🔧", "mod": "spare_store",
     "keywords": ["dashboard", "overview", "spare", "store", "home", "kpi", "coverage", "summary"]},
    {"key": "live_dashboard", "title": "Live Dashboard", "route": "/live-dashboard",
     "category": "Overview", "icon": "🖥️", "mod": "live_dashboard",
     "keywords": ["live", "wallboard", "tv", "led", "alerts", "real time", "monitor"]},

    # --- Inventory ---
    {"key": "scan_part", "title": "Scan Part", "route": "/scan-part",
     "category": "Inventory", "icon": "📷", "mod": "scan_part",
     "keywords": ["scan", "barcode", "qr", "gun", "camera", "issue", "receive", "return",
                  "location", "confirm", "installation"]},
    {"key": "store_stock", "title": "Store Stock", "route": "/store-stock-spare",
     "category": "Inventory", "icon": "📦", "mod": "store_stock",
     "keywords": ["stock", "count", "counting", "opening", "quantity", "qty", "in stock",
                  "on hand", "upload", "below min", "reorder", "excess", "above max",
                  "zero stock", "out of stock", "never counted", "stock value", "kitna stock",
                  "kam stock", "bin"]},
    {"key": "part_ledger", "title": "Part Ledger", "route": "/spare-part-history",
     "category": "Inventory", "icon": "📜", "mod": "part_ledger",
     "keywords": ["ledger", "history", "timeline", "movements", "transactions", "traceability",
                  "kab issue", "kisko diya"]},
    {"key": "erp_gap", "title": "ERP vs Physical Gap", "route": "/spare-erp-gap",
     "category": "Inventory", "icon": "⚖️", "mod": "erp_gap",
     "keywords": ["erp", "gap", "physical", "reconcile", "difference", "variance", "antar"]},

    # --- Masters ---
    {"key": "part_master", "title": "Part Master", "route": "/parts",
     "category": "Masters", "icon": "🔩", "mod": "part_master",
     "keywords": ["part", "master", "min", "max", "reorder level", "rate", "price", "category",
                  "add part", "edit part", "import parts", "part list"]},
    {"key": "supplier_barcodes", "title": "Supplier Barcodes", "route": "/supplier-barcodes",
     "category": "Masters", "icon": "🏷️", "mod": "supplier_barcodes",
     "keywords": ["supplier", "barcode", "mapping", "map"]},
    {"key": "scan_audit", "title": "Scan Audit", "route": "/scan-audit",
     "category": "Masters", "icon": "🧾", "mod": "scan_audit",
     "keywords": ["scan", "audit", "log", "scan history", "who scanned"]},
    {"key": "departments", "title": "Department Emails", "route": "/departments",
     "category": "Masters", "icon": "✉️", "mod": "departments",
     "keywords": ["department", "email", "reorder mail", "notification", "recipient", "dept"]},
    {"key": "suppliers", "title": "Supplier Master", "route": "/suppliers",
     "category": "Masters", "icon": "🏭",
     "keywords": ["supplier", "vendor", "master", "supplier list"]},
    {"key": "report_recipients", "title": "Report Recipients", "route": "/report-recipients",
     "category": "Masters", "icon": "📧",
     "keywords": ["report", "recipient", "email", "window time", "to", "cc", "mail list"]},

    # --- Receiving ---
    {"key": "gate_entry", "title": "Gate Entry", "route": "/gate-entry",
     "category": "Receiving", "icon": "🚚", "mod": "gate_entry",
     "keywords": ["gate", "entry", "receiving", "arrival", "inward", "vehicle"]},
    {"key": "vehicle_in_out", "title": "Vehicle In / Out", "route": "/vehicle-in-out",
     "category": "Receiving", "icon": "🚦", "mod": "vehicle_in_out",
     "keywords": ["vehicle", "in", "out", "gate", "truck", "gaadi"]},
    {"key": "window_time", "title": "Window Time", "route": "/window-time",
     "category": "Receiving", "icon": "🕒",
     "keywords": ["window", "time", "supplier schedule", "late", "on time", "arrival time"]},

    # --- Reports ---
    {"key": "reports", "title": "Reports", "route": "/reports",
     "category": "Reports", "icon": "📑",
     "keywords": ["report", "export", "excel", "download", "print"]},

    # --- System (admin) ---
    {"key": "admin", "title": "User Management", "route": "/admin",
     "category": "System", "icon": "🛡️", "admin": True,
     "keywords": ["user", "admin", "password", "rights", "permission", "role", "add user"]},
    {"key": "settings", "title": "Settings", "route": "/settings",
     "category": "System", "icon": "⚙️", "admin": True,
     "keywords": ["settings", "config", "label", "barcode label", "store visibility",
                  "system status", "gear"]},
]

# The order categories appear in the launcher's tab strip.
CATEGORY_ORDER = ["Overview", "Inventory", "Masters", "Receiving", "Reports", "System"]
