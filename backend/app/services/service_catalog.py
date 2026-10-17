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
    # Every open point of the store on one page, with who must act and by when.
    # No "issues" keyword: the assistant matches by substring, and that would put
    # this screen ahead of Scan Part for anyone asking how to issue a part.
    {"key": "action_tracker", "title": "Action Tracker", "route": "/action-tracker",
     "category": "Overview", "icon": "📋", "mod": "spare_store",
     "keywords": ["action", "tracker", "owner", "action by", "target", "overdue",
                  "open points", "summary", "kaun karega", "kab tak"]},

    # --- Inventory ---
    # Also the home of supplier barcodes (mapping) and receive-and-label — there
    # is no separate Supplier Barcodes screen any more.
    {"key": "scan_part", "title": "Scan Part", "route": "/scan-part",
     "category": "Inventory", "icon": "📷", "mod": "scan_part",
     "keywords": ["scan", "barcode", "qr", "gun", "camera", "issue", "receive", "return",
                  "location", "confirm", "installation", "rgp", "rework", "inspection",
                  "supplier barcode", "mapping", "label"]},
    {"key": "work_queue", "title": "Work Queue", "route": "/work-queue",
     "category": "Inventory", "icon": "📋", "mod": "scan_part",
     "keywords": ["queue", "grn", "quality", "inspection", "return", "rgp", "rework",
                  "supplier", "pending", "confirmation"]},
    # Line user's focused Stage-2 screen — see the parts already issued and fill
    # in the line / machine / die they were fitted on. No scanner (no per-part
    # QR); the right is install_confirm, granted on its own.
    {"key": "confirm_installation", "title": "Confirm Installation", "route": "/confirm-installation",
     "category": "Inventory", "icon": "🔧", "mod": "install_confirm",
     "keywords": ["confirm", "installation", "install", "line", "machine", "die", "fitted",
                  "fitter", "issued to me", "where used", "lagaya", "line machine bharo"]},
    # Put-away check: scan the part/lot tag then the bin's location QR -> Right /
    # Wrong Location, so a part is never shelved in the wrong bin (no mixing).
    {"key": "put_away_check", "title": "Put-away Check", "route": "/put-away-check",
     "category": "Inventory", "icon": "📍", "mod": "store_stock",
     "keywords": ["put away", "putaway", "put-away", "location", "bin", "shelf", "rack",
                  "wrong location", "right location", "mixing", "verify", "check", "rakhna",
                  "sahi jagah", "galat location", "bin check"]},
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
    {"key": "scan_audit", "title": "Scan Audit", "route": "/scan-audit",
     "category": "Masters", "icon": "🧾", "mod": "scan_audit",
     "keywords": ["scan", "audit", "log", "scan history", "who scanned"]},
    {"key": "departments", "title": "Department Emails", "route": "/departments",
     "category": "Email & Notifications", "icon": "✉️", "mod": "departments",
     "keywords": ["department", "email", "reorder mail", "notification", "recipient", "dept"]},
    {"key": "employees", "title": "Employee Master", "route": "/employees",
     "category": "Masters", "icon": "👥", "mod": "employees",
     "keywords": ["employee", "person", "mobile", "phone", "issued to", "code", "worker", "contractor"]},
    {"key": "suppliers", "title": "Supplier Master", "route": "/suppliers",
     "category": "Masters", "icon": "🏭",
     "keywords": ["supplier", "vendor", "master", "supplier list"]},
    {"key": "report_recipients", "title": "Report Recipients", "route": "/report-recipients",
     "category": "Email & Notifications", "icon": "📧",
     "keywords": ["report", "recipient", "email", "window time", "to", "cc", "mail list"]},

    {"key": "inventory_control", "title": "Critical · Reorder · Excess", "route": "/inventory-control",
     "category": "Inventory", "icon": "🚨", "mod": "store_stock",
     "keywords": ["critical", "short", "zero", "reorder", "excess", "aging", "order qty"]},
    # Two reports since 17 Oct 2026 ("issuance and consumption ki report alag
    # alag chahiye"): what left the store and to whom, and what each department
    # really used — the same right as the one screen they were.
    {"key": "issuance", "title": "Issuance Report", "route": "/issuance",
     "category": "Inventory", "icon": "📤", "mod": "spare_store",
     "keywords": ["issuance", "issue list", "issued", "issue report", "kisko diya", "kitna diya",
                  "issued to", "person", "department", "yesterday", "last month", "financial year",
                  "full pack"]},
    {"key": "consumption", "title": "Consumption Report", "route": "/consumption",
     "category": "Inventory", "icon": "📈", "mod": "spare_store",
     "keywords": ["consumption", "usage", "consumed", "net", "returned", "trend", "top parts",
                  "department", "machine", "category", "yesterday", "last month", "financial year",
                  "full pack"]},
    {"key": "data_quality", "title": "Data Quality", "route": "/data-quality",
     "category": "Masters", "icon": "🛡️", "mod": "part_master",
     "keywords": ["data quality", "missing", "min", "max", "rate", "location", "completeness"]},
    {"key": "erp_control", "title": "ERP Control Center", "route": "/erp-control",
     "category": "Reports", "icon": "⚙️", "mod": "erp_gap",
     "keywords": ["erp", "sync", "status", "error", "pending", "reconciliation"]},
    {"key": "notifications", "title": "Notification Center", "route": "/notifications",
     "category": "Email & Notifications", "icon": "🔔",
     "keywords": ["alerts", "notification", "critical", "warning"]},

    # --- Receiving ---
    {"key": "receiving", "title": "Receiving & GRN", "route": "/receiving",
     "category": "Receiving", "icon": "📥", "mod": "spare_store",
     "keywords": ["grn", "srv", "receipt", "receiving", "inward", "aging"]},
    # What suppliers sent short and quality rejected, since how many days and
    # against which lot (the store, 17 Oct 2026) — the same right as Receiving & GRN.
    {"key": "short_rejection", "title": "Short & Rejection", "route": "/short-rejection",
     "category": "Receiving", "icon": "⚠️", "mod": "spare_store",
     "keywords": ["rejection", "rejected", "reject", "short receipt", "short supply", "short received",
                  "supplier rejection", "debit note", "replacement", "lot", "days pending",
                  "kam aaya", "maal kam", "rejection kitne din"]},
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
     "category": "Reports", "icon": "📑", "mod": "reports",
     "keywords": ["report", "export", "excel", "download", "print"]},

    # --- System (admin) ---
    # Email & Notifications — the mail engine's screens (administrators only).
    {"key": "email_control_center", "title": "Control Center", "route": "/email/control-center",
     "category": "Email & Notifications", "icon": "📊", "admin": True,
     "keywords": ["mail", "email", "engine", "status", "health", "control center"]},
    {"key": "email_workflows", "title": "Workflow Center", "route": "/email/workflows",
     "category": "Email & Notifications", "icon": "🔁", "admin": True,
     "keywords": ["mail", "workflow", "automation", "schedule", "run now"]},
    {"key": "email_configuration", "title": "Email Configuration", "route": "/email/configuration",
     "category": "Email & Notifications", "icon": "⚙️", "admin": True,
     "keywords": ["smtp", "mail server", "email setup", "host", "port", "test mail"]},
    {"key": "email_templates", "title": "Email Templates", "route": "/email/templates",
     "category": "Email & Notifications", "icon": "📝", "admin": True,
     "keywords": ["template", "subject", "signature", "mail body"]},
    {"key": "email_send", "title": "Send Email Alert", "route": "/email/send",
     "category": "Email & Notifications", "icon": "📤", "admin": True,
     "keywords": ["send mail", "alert", "compose", "message"]},
    {"key": "email_queue", "title": "Email Queue", "route": "/email/queue",
     "category": "Email & Notifications", "icon": "📭", "admin": True,
     "keywords": ["queue", "pending mail", "retry", "failed mail"]},
    {"key": "email_logs", "title": "Email Logs", "route": "/email/logs",
     "category": "Email & Notifications", "icon": "📜", "admin": True,
     "keywords": ["mail log", "sent", "history", "delivery"]},
    {"key": "email_rules", "title": "Notification Rules", "route": "/email/rules",
     "category": "Email & Notifications", "icon": "🔔", "admin": True,
     "keywords": ["rule", "notification", "who gets mail", "schedule", "recipients"]},
    {"key": "email_reminders", "title": "Reminder & Escalation", "route": "/email/reminders",
     "category": "Email & Notifications", "icon": "⏳", "admin": True,
     "keywords": ["reminder", "escalation", "overdue", "follow up"]},
    {"key": "admin", "title": "User Management", "route": "/admin",
     "category": "System", "icon": "🛡️", "admin": True,
     "keywords": ["user", "admin", "password", "rights", "permission", "role", "add user"]},
    {"key": "settings", "title": "Settings", "route": "/settings",
     "category": "System", "icon": "⚙️", "admin": True,
     "keywords": ["settings", "config", "label", "barcode label", "store visibility",
                  "system status", "gear"]},
]

# The order categories appear in the launcher's tab strip.
CATEGORY_ORDER = ["Overview", "Inventory", "Masters", "Receiving", "Reports", "Email & Notifications", "System"]
