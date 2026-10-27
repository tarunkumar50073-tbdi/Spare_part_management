"""Barcode resolve / label / mapping / scan-audit — the shared backend service.

Camera, scanner gun and manual entry all resolve through ONE method here
(``resolve``), so every scan is validated, store-scoped and audited the same
way. The internal QR payload is only the stable Part No.; all part detail is
fetched from the DB (and, later, ERP) after resolving — never encoded in the
code. Nothing here fakes ERP data: stock is reported as MANUAL until an ERP
Current-Stock source lands (see the erp-integration plan), and the label
printer is reported REACHABLE only after a real network connect to it.
"""
import socket
import threading
import time
from datetime import timezone

from app.models.base import utcnow
from app.models.erp_stock import ERPStock
from app.models.label_print_audit import PRINT_SOURCES
from app.models.part_barcode import SYMBOLOGIES
from app.models.scan_audit import SCAN_MODES, SCAN_SOURCES
from app.repositories.barcode_repository import (
    LabelPrintAuditRepository, PartBarcodeRepository, ScanAuditRepository,
)
from app.repositories.part_repository import PartRepository
from app.repositories.spare_stock_repository import SpareStockRepository
from app.repositories.supplier_repository import SupplierRepository
from app.services.spare_stock_service import SpareStockService
from app.utils.bin_location import strip_scan_description
from app.utils.db_tx import atomic
from app.utils.exceptions import (
    BadRequestError, ConflictError, NotFoundError, ValidationError,
)

# An ERP stock snapshot older than this reads as STALE rather than SYNCED.
# 24h suits the hourly ERP poller; a missed sync then shows honestly as stale.
STALE_AFTER_HOURS = 24

def scan_fields(code):
    """The fields of a multi-field read, in order and without repeats: split on
    | , ; # tab / newline and spaces; a field under 3 characters (a qty, a
    unit) is dropped. A read with no separator is its one field. A supplier QR "CNTR3200|LOT-77|10" -> ["CNTR3200", "LOT-77"]."""
    import re
    out = []
    for f in re.split(r"[|,;#\t\r\n ]+", code or ""):
        f = f.strip()
        if len(f) >= 3 and f not in out:
            out.append(f)
    return out


# The longest code that can identify a part: the width of part_barcodes.code
# (a mapped supplier barcode or the internal Part No.) and of
# scan_audit.scanned_code. A Part No. itself is shorter still.
SCAN_CODE_MAX = 80

# The label template. 100mm x 50mm is only the starting default because the
# label-roll size may change; the frontend reads these values rather than
# hardcoding a size. An admin edits them on the Settings page — the override is
# stored under LABEL_SETTING_KEY in app_settings and merged over these below, so
# a roll change is a setting change, not a code change.
#
# The label is QR + Part No. + description + location (spec 3 / 29) and nothing
# else. The QR is the default because the whole traceability flow scans it from
# a tablet camera as well as a gun; Code-128 / Code-39 stay selectable for a
# store whose guns only read linear codes. The payload is the Part No. either way.
LABEL_DEFAULTS = {
    "width_mm": 100,
    "height_mm": 50,
    "symbology": "QR",
    "show_part_no": True,
    "show_description": True,
    "show_location": True,
    "description_max_chars": 48,
    # (No lot tag size any more: the 150 x 100 mm gate-entry lot tag was taken
    # out on 17 Oct 2026 — management said it wastes paper. A saved template
    # that still holds lot_width_mm / lot_height_mm has them ignored, as any
    # key not listed here.)
    # Bin location sheet (the permanent, laminated rack tag): one sheet per bin,
    # a row per part, printed at this face size. The default is the store's bin
    # face (130 x 90 mm); the frontend groups parts by rack location and
    # auto-fits the rows to this size.
    "bin_width_mm": 130,
    "bin_height_mm": 90,
}
LABEL_SETTING_KEY = "barcode_label"

# What the label renderer can print for the internal code. EAN-13 was dropped:
# it carries 12 digits + a check digit only, so it cannot encode an alphanumeric
# Part No. such as CNTR2025. A template saved with it before falls back to the
# default (see label_config) instead of rendering a label that cannot scan.
LABEL_SYMBOLOGIES = ("QR", "CODE128", "CODE39")

# The store's label printer. Printing goes through the browser print dialog, and
# a browser cannot tell whether a USB / driver printer is on — so the default
# (BROWSER) never claims a status. An admin may register a NETWORK printer
# (host + raw-print port, 9100 by convention); only then is there something the
# server can really check, with a TCP connect (printer_status).
PRINTER_SETTING_KEY = "label_printer"
PRINTER_CONNECTIONS = ("BROWSER", "NETWORK")
PRINTER_DEFAULTS = {
    "name": "Spare Parts Store Label Printer",
    "connection": "BROWSER",
    "host": None,
    "port": 9100,
}
# Kept short: the status check runs inside a request the print dialog waits on.
# Each TCP connect gets at most PRINTER_CONNECT_TIMEOUT_S, and the whole check —
# the host-name lookup included — answers within PRINTER_CHECK_DEADLINE_S (see
# BarcodeService._probe_printer for why the lookup needs its own bound).
PRINTER_CONNECT_TIMEOUT_S = 2
PRINTER_CHECK_DEADLINE_S = 2.5

# Workstation sources (spec 8): the operator has material in hand and has just
# identified it, so the label is for those pieces — new material of a part that
# was labelled before still gets a new label, not a "reprint", and no reason is
# asked. REPRINT is the explicit reprint action (reason required); PART_MASTER /
# STORE_STOCK and legacy callers with no source keep the old rule (a part printed
# before is a reprint).
FRESH_LABEL_SOURCES = ("SUPPLIER_BARCODE", "ERP_SEARCH", "MANUAL_ENTRY", "QR_SCAN")

# Print history is read on the part drawer / print dialog; this caps what one
# request can pull back.
PRINT_HISTORY_MAX = 200


class BarcodeService:
    def __init__(self):
        self.pb_repo = PartBarcodeRepository()
        self.scan_repo = ScanAuditRepository()
        self.print_repo = LabelPrintAuditRepository()
        self.part_repo = PartRepository()
        self.stock_repo = SpareStockRepository()
        self.supplier_repo = SupplierRepository()
        self.spare_service = SpareStockService()

    # ---- scan resolution (the single shared entry point) ----

    def _audit(self, code, result, scan_source, scan_mode, user, store_code, part_id=None):
        """Record the scan outcome. Committed on its own so a failed scan is
        still traceable even though the request then raises."""
        return self.scan_repo.create(
            scanned_code=code, part_id=part_id, scan_source=scan_source,
            scan_mode=scan_mode, result=result, user=user, store_code=store_code,
        )

    @staticmethod
    def _scan_failure(exc_class, message, result, code):
        """A failed resolve, with the outcome in ``errors`` so the Scan Part
        screen can branch on it — only UNKNOWN_BARCODE offers "Map to Part"
        (spec 5); an inactive / other-store / blank / over-long scan must not.

        ``result`` is finer than the audit row's: OTHER_STORE, CODE_TOO_LONG and
        INACTIVE_PART are audited as UNKNOWN_BARCODE / UNKNOWN_BARCODE /
        INACTIVE_BARCODE because the scan_audit CHECK constraint only knows
        SCAN_RESULTS."""
        return exc_class(message, errors={"result": result, "code": code})

    def resolve(self, store_code, code, scan_source="MANUAL_ENTRY",
                scan_mode="LOOKUP", user=None):
        """Resolve a scanned value to a spare part in this store and audit it.

        Order (spec §17): active barcode mapping first, then a direct Part No. /
        Part.barcode fallback. Supplier barcodes live in the mapping table so
        they resolve here too. Every outcome is written to the scan audit, and
        a success carries that audit row's id (``scan_id``) so the action that
        follows can point back at the scan that identified the part.

        A failure raises with ``errors = {"result", "code"}``; result is one of
        UNKNOWN_BARCODE, INACTIVE_BARCODE, OTHER_STORE, INACTIVE_PART,
        CODE_TOO_LONG, FAILED. ``code`` is the value as scanned (trimmed; a bin
        sheet QR's " | description" cut off).
        """
        if scan_source not in SCAN_SOURCES:
            scan_source = "MANUAL_ENTRY"
        if scan_mode not in SCAN_MODES:
            scan_mode = "LOOKUP"
        # Trim harmless surrounding whitespace only; the value is otherwise used
        # exactly as scanned (a supplier code is never rewritten before lookup).
        code = (code or "").strip()
        if not code:
            self._audit("", "FAILED", scan_source, scan_mode, user, store_code)
            raise self._scan_failure(BadRequestError, "No code scanned", "FAILED", "")

        # A packet / individual-unit QR (spare_packet.py, 27 Oct 2026) names one
        # packet: its part, plus the packet — Scan Part's Issue then issues it
        # whole, once, oldest receipt first.
        from app.services.spare_packet_service import is_packet_code, normalize_code
        if is_packet_code(code):
            return self._resolve_packet(store_code, normalize_code(code), scan_source, scan_mode, user)

        # A bin sheet QR ends in " | description" since 17 Oct 2026 (the store: a
        # scan should say what the part is); only the text before it names the
        # part (utils/bin_location.strip_scan_description). It is cut off before
        # the length check — the description can take a long Part No. + location
        # past SCAN_CODE_MAX — unless the whole read is itself a mapped supplier
        # code, which is used exactly as scanned, as always.
        core = strip_scan_description(code)
        if core != code and (len(code) > SCAN_CODE_MAX or self.pb_repo.get_by_code(code) is None):
            code = core

        # A supplier's QR usually carries its item code AMONG other fields — lot,
        # qty, date — so the whole read differs lot to lot and a mapping of it
        # would never match again (the store, 22 Oct 2026: "supplier k bar tag
        # and qr tag bhi aaten h to unko bhi map karenge"). When the whole read
        # names nothing, each of its fields is tried: an active mapping of the
        # field, then a Part No. / Part.barcode equal to it.
        if self.pb_repo.get_active_by_code(code) is None and self.part_repo.get_by_scan_code(code) is None:
            hit = self._field_match(code)
            if hit is not None:
                code = hit

        if len(code) > SCAN_CODE_MAX:
            # Nothing this long can name a part: a Part No. or mapped barcode is
            # at most SCAN_CODE_MAX characters — typically this is a vendor QR
            # that also carries lot and quantity. It is not UNKNOWN_BARCODE,
            # because "Map to Part" could never store it (same width), so the
            # operator is pointed to a Part No. search instead. The audit column
            # has that width too, so the audit row keeps the first
            # SCAN_CODE_MAX characters; the answer echoes the whole read.
            self._audit(code[:SCAN_CODE_MAX], "UNKNOWN_BARCODE", scan_source, scan_mode, user, store_code)
            fields = scan_fields(code)
            if fields and fields != [code] and any(len(f) <= SCAN_CODE_MAX for f in fields):
                # A multi-field supplier QR: its ITEM field can be mapped (Map to
                # Part picks the field), and then every lot's QR resolves.
                raise self._scan_failure(
                    NotFoundError,
                    "No part found for this supplier QR — map its item code to the part (Map to Part)",
                    "UNKNOWN_BARCODE", code)
            raise self._scan_failure(
                NotFoundError,
                f"This code is {len(code)} characters long — a Part No. or mapped barcode is at "
                f"most {SCAN_CODE_MAX}, so it cannot identify a part. Search the Part No. instead.",
                "CODE_TOO_LONG", code)

        mapping = self.pb_repo.get_active_by_code(code)
        part = mapping.part if mapping else self.part_repo.get_by_scan_code(code)

        if part is None:
            # A deactivated mapping for this exact code reads as INACTIVE, not
            # merely unknown — so a damaged/retired label is diagnosable.
            inactive = self.pb_repo.get_by_code(code)
            result = "INACTIVE_BARCODE" if inactive else "UNKNOWN_BARCODE"
            self._audit(code, result, scan_source, scan_mode, user, store_code)
            message = (f"Barcode '{code}' has been deactivated" if inactive
                       else f"No part found for code '{code}'")
            raise self._scan_failure(NotFoundError, message, result, code)

        if part.store_code != store_code:
            # Do not leak another store's part id through this store's scanner:
            # the audit row carries no part, and the error names no part either.
            self._audit(code, "UNKNOWN_BARCODE", scan_source, scan_mode, user, store_code)
            raise self._scan_failure(
                NotFoundError, f"No part in this store for code '{code}'", "OTHER_STORE", code)

        if not part.is_active:
            self._audit(code, "INACTIVE_BARCODE", scan_source, scan_mode, user, store_code, part_id=part.id)
            raise self._scan_failure(
                NotFoundError, f"Part '{part.part_no}' is inactive", "INACTIVE_PART", code)

        audit = self._audit(code, "SUCCESS", scan_source, scan_mode, user, store_code, part_id=part.id)

        payload = self.spare_service.get_for_part(part.id)
        payload["scanned_code"] = code
        payload["resolved_by"] = mapping.source if mapping else "PART_NO"
        payload["scan_mode"] = scan_mode
        payload["scan_id"] = audit.id
        payload.update(self._data_status(part))
        return payload

    def _resolve_packet(self, store_code, code, scan_source, scan_mode, user):
        """A packet QR: the packet's part as any scan returns it, plus `packet`
        (its quantity, receipt, status and FIFO standing). An unknown packet
        code is FAILED, not UNKNOWN_BARCODE — it must never be offered "Map to
        Part"."""
        from app.models.spare_packet import SparePacket
        from app.services.spare_packet_service import SparePacketService
        packet = SparePacket.query.filter_by(code=code).first()
        if packet is None:
            self._audit(code, "FAILED", scan_source, scan_mode, user, store_code)
            raise self._scan_failure(NotFoundError, f"No packet found for '{code}'", "FAILED", code)
        part = packet.part
        if part.store_code != store_code:
            self._audit(code, "UNKNOWN_BARCODE", scan_source, scan_mode, user, store_code)
            raise self._scan_failure(
                NotFoundError, f"No part in this store for code '{code}'", "OTHER_STORE", code)
        if not part.is_active:
            self._audit(code, "INACTIVE_BARCODE", scan_source, scan_mode, user, store_code, part_id=part.id)
            raise self._scan_failure(
                NotFoundError, f"Part '{part.part_no}' is inactive", "INACTIVE_PART", code)
        audit = self._audit(code, "SUCCESS", scan_source, scan_mode, user, store_code, part_id=part.id)
        payload = self.spare_service.get_for_part(part.id)
        payload["scanned_code"] = code
        payload["resolved_by"] = "PACKET"
        payload["scan_mode"] = scan_mode
        payload["scan_id"] = audit.id
        payload.update(self._data_status(part))
        payload["packet"] = SparePacketService().get(code)
        return payload

    def _field_match(self, code):
        """The one field of a multi-field read (a supplier QR: "ITEM|LOT|QTY",
        "ITEM,QTY", tab- or space-separated) that names a part — an active
        mapping first, then a Part No. / Part.barcode — or None. Two fields
        naming DIFFERENT parts is no answer: guessing between them could pick
        the wrong part."""
        fields = scan_fields(code)
        if not fields or fields == [code.strip()]:
            return None                       # one field only: the whole read, already tried
        found = {}
        for f in fields:
            mapping = self.pb_repo.get_active_by_code(f)
            part = mapping.part if mapping else self.part_repo.get_by_scan_code(f)
            if part is not None:
                found.setdefault(part.id, f)
        return next(iter(found.values())) if len(found) == 1 else None

    def _data_status(self, part):
        """Honest freshness of the stock figure shown — never fakes ERP data:
        - MANUAL: no ERP feed for this part; the store's physical figure is shown.
        - SYNCED: an ERP snapshot exists and was refreshed within STALE_AFTER_HOURS.
        - STALE:  an ERP snapshot exists but is older than that window.
        (LIVE is reserved for a real-time ERP query, which does not exist yet.)
        Also carries the ERP stock-WRITE status so the UI can say whether an
        issue/receive will reflect back in ERP."""
        erp = ERPStock.query.filter_by(part_id=part.id).first()
        last_sync = erp.synced_at if erp else None
        if last_sync is None:
            source, warning = "MANUAL", "ERP live stock not available yet — showing the store's physical figure."
        else:
            aware = last_sync if last_sync.tzinfo else last_sync.replace(tzinfo=timezone.utc)
            age_h = (utcnow() - aware).total_seconds() / 3600.0
            if age_h > STALE_AFTER_HOURS:
                source, warning = "STALE", f"ERP stock is stale — last synced over {STALE_AFTER_HOURS}h ago."
            else:
                source, warning = "SYNCED", None
        return {
            "data_status": {
                "stock_source": source,          # LIVE / SYNCED / MANUAL / STALE
                "erp_available": erp is not None,
                "erp_qty": float(erp.qty_on_hand) if erp and erp.qty_on_hand is not None else None,
                "erp_last_sync": last_sync.isoformat() if last_sync else None,
                "warning": warning,
                "write": self.spare_service.erp_write_status(),
            }
        }

    # ---- internal barcode allocation ----

    def ensure_internal_barcode(self, part, user=None, symbology=None):
        """Guarantee a primary INTERNAL barcode exists for the part, with the
        Part No. as its payload, recorded in the symbology the label template
        prints (QR by default, or a linear code an admin chose). Idempotent.

        A template change re-stamps the existing row's symbology on the next
        print: the payload is unchanged, so labels printed earlier in the other
        symbology still resolve; each print's own symbology stays in
        label_print_audit."""
        symbology = symbology or self.label_config()["symbology"]
        existing = self.pb_repo.primary_internal(part.id)
        if existing:
            changes = {}
            if not existing.is_active:
                changes["is_active"] = True
            if existing.symbology != symbology:
                changes["symbology"] = symbology
            if changes:
                self.pb_repo.update(existing, **changes)
            return existing

        clash = self.pb_repo.get_by_code(part.part_no)
        if clash and clash.part_id != part.id:
            raise ConflictError(
                f"Barcode '{part.part_no}' is already mapped to another part"
            )
        if clash and clash.part_id == part.id:
            return self.pb_repo.update(
                clash, source="INTERNAL", is_primary=True, is_active=True,
                symbology=symbology, created_by=clash.created_by or user,
            )
        return self.pb_repo.create(
            part_id=part.id, code=part.part_no, symbology=symbology,
            source="INTERNAL", is_primary=True, is_active=True, created_by=user,
        )

    # ---- label template + printer ----

    def label_config(self):
        """The effective label template: the built-in defaults with any
        admin-saved override merged over them (only known keys are honoured).
        A symbology the renderer no longer offers (EAN13 from an older saved
        template) falls back to the default rather than printing a label that
        cannot carry the Part No."""
        from app.models.app_setting import AppSetting
        cfg = dict(LABEL_DEFAULTS)
        override = AppSetting.get_value(LABEL_SETTING_KEY) or {}
        if isinstance(override, dict):
            cfg.update({k: v for k, v in override.items() if k in LABEL_DEFAULTS})
        if cfg.get("symbology") not in LABEL_SYMBOLOGIES:
            cfg["symbology"] = LABEL_DEFAULTS["symbology"]
        return cfg

    def printer_config(self):
        """The label printer an admin set in Settings, over PRINTER_DEFAULTS
        (only known keys honoured; an unknown connection reads as BROWSER, the
        one mode that claims nothing)."""
        from app.models.app_setting import AppSetting
        cfg = dict(PRINTER_DEFAULTS)
        override = AppSetting.get_value(PRINTER_SETTING_KEY) or {}
        if isinstance(override, dict):
            cfg.update({k: v for k, v in override.items() if k in PRINTER_DEFAULTS})
        if cfg.get("connection") not in PRINTER_CONNECTIONS:
            cfg["connection"] = "BROWSER"
        return cfg

    def printer_status(self):
        """What the print dialog may honestly say about the printer (spec 8 —
        no fake Online / Offline):

        - NOT_DETECTABLE: printing goes through the browser print dialog, which
          cannot report the printer's state; nothing is checked (checked_at null).
        - REACHABLE / UNREACHABLE: a NETWORK printer, checked right now by a real
          TCP connect from this server to host:port. Reachable means the printer
          answered on its port — not that it has labels loaded.

        The host itself is not echoed: any signed-in user may ask for the status,
        and only an admin needs the printer's address (admin label-printer API)."""
        cfg = self.printer_config()
        out = {"name": cfg["name"], "connection": cfg["connection"]}
        if cfg["connection"] != "NETWORK":
            return {**out, "status": "NOT_DETECTABLE", "checked_at": None,
                    "detail": "Status can't be detected — printing uses the browser print dialog"}
        host, port = cfg.get("host"), cfg.get("port")
        if not host or not port:
            return {**out, "status": "NOT_DETECTABLE", "checked_at": None,
                    "detail": "No network address is set for this printer — printing uses the browser print dialog"}

        failure = self._probe_printer(host, port)
        if failure is not None:
            return {**out, "status": "UNREACHABLE", "checked_at": utcnow().isoformat(),
                    "detail": f"Not reachable on the network ({self._connect_failure(failure)}) — "
                              "check the printer is switched on and connected"}
        return {**out, "status": "REACHABLE", "checked_at": utcnow().isoformat(),
                "detail": "Printer answered on the network"}

    @staticmethod
    def _probe_printer(host, port):
        """One real reachability check of host:port — None when a TCP connect
        succeeded, else the exception that says why not.

        Bounded in total by PRINTER_CHECK_DEADLINE_S. socket.create_connection
        would not be: its timeout covers each connect but not the host-name
        lookup (getaddrinfo can block for several seconds on a Windows domain
        network while LLMNR / NetBIOS fall back), and it restarts that timeout
        for every address the name resolves to. So the name is looked up once
        and the resolved addresses are tried in order, each connect limited to
        PRINTER_CONNECT_TIMEOUT_S or the time left, whichever is less — a name
        with an IPv6 and an IPv4 address still reaches a printer that only
        listens on IPv4. All of it runs in a daemon worker the request waits on
        until the deadline only: a lookup still running then is abandoned (it
        ends on its own and holds no request thread) and reported as no answer.
        REACHABLE still needs a connect that really succeeded."""
        deadline = time.monotonic() + PRINTER_CHECK_DEADLINE_S
        # Fails closed: only the worker's successful connect replaces this.
        outcome = {"failure": TimeoutError()}

        def probe():
            try:
                addresses = socket.getaddrinfo(host, int(port), type=socket.SOCK_STREAM)
                failure = None
                for family, socktype, proto, _canon, address in addresses:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        failure = TimeoutError()
                        break
                    try:
                        with socket.socket(family, socktype, proto) as sock:
                            sock.settimeout(min(PRINTER_CONNECT_TIMEOUT_S, left))
                            sock.connect(address)
                        outcome["failure"] = None
                        return
                    except OSError as exc:
                        failure = exc
                outcome["failure"] = failure or TimeoutError()
            except Exception as exc:  # noqa: BLE001 — any error is a failed check
                # Caught broadly on purpose: an error left to escape would end
                # the worker silently and read as a timeout below.
                outcome["failure"] = exc

        worker = threading.Thread(target=probe, name="label-printer-check", daemon=True)
        worker.start()
        worker.join(max(0.0, deadline - time.monotonic()))
        if worker.is_alive():
            return TimeoutError()
        return outcome["failure"]

    @staticmethod
    def _connect_failure(exc):
        """A short, operator-readable reason for a failed connect (no address)."""
        if isinstance(exc, (socket.timeout, TimeoutError)):
            return f"no answer within {PRINTER_CONNECT_TIMEOUT_S} s"
        if isinstance(exc, ConnectionRefusedError):
            return "connection refused"
        if isinstance(exc, socket.gaierror):
            return "host name not found"
        if isinstance(exc, ValueError):
            return "invalid printer address"
        return "network error"

    # ---- label print / reprint ----

    def record_bulk_print(self, part_ids, copies=1, user=None, reason=None,
                          source="STORE_STOCK", printer_name=None):
        """Print labels for many parts at once (the stock list's bulk action).

        Each part goes through record_print, so the same rules hold: an inactive
        part is refused and a REPRINT needs a reason. Without a reason, parts that
        already have a label are skipped and named — never silently reprinted."""
        printed, skipped = [], []
        for pid in dict.fromkeys(part_ids):          # de-duplicated, order kept
            try:
                printed.append(self.record_print(pid, copies=copies, user=user,
                                                 is_reprint=False, reason=reason,
                                                 source=source, printer_name=printer_name))
            except (ValidationError, NotFoundError, BadRequestError) as exc:
                part = self.part_repo.get_by_id(pid)
                skipped.append({"part_id": pid, "part_no": part.part_no if part else None,
                                "why": str(getattr(exc, "message", exc))})
        return {"printed": printed, "skipped": skipped}

    def record_print(self, part_id, copies=1, user=None, is_reprint=False, reason=None,
                     source=None, printer_name=None):
        """Record a label print/reprint and return the data the label needs.

        The print dialog calls this only after the operator confirms the label
        came out (the browser cannot know), so the audit is what was printed.
        Printing touches no receipt and no stock: a label adds nothing,
        completes no GRN and clears no quality (spec 9).

        Blocks printing for an inactive part (an admin must reactivate it first,
        per spec). Whether it is a reprint (which needs a reason) follows the
        source — see FRESH_LABEL_SOURCES:
          REPRINT                                  -> reprint, reason required
          SUPPLIER_BARCODE / ERP_SEARCH /
          MANUAL_ENTRY / QR_SCAN                   -> a label for material in hand, never a reprint
          PART_MASTER / STORE_STOCK / no source    -> reprint if the part was printed before
        The printed location is kept as a snapshot: a later move makes that
        label's location stale, which the scan result can then point out.
        """
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        if not part.is_active:
            raise ValidationError(
                "Cannot print a label for an inactive part — reactivate it first"
            )
        try:
            copies = int(copies or 1)
        except (TypeError, ValueError):
            raise BadRequestError("copies must be a whole number")
        if copies < 1:
            raise BadRequestError("copies must be at least 1")
        if source is not None and source not in PRINT_SOURCES:
            raise BadRequestError(f"Unknown label print source '{source}'")

        if source == "REPRINT":
            effective_reprint = True
        elif source in FRESH_LABEL_SOURCES:
            effective_reprint = False
        else:
            effective_reprint = bool(is_reprint) or self.print_repo.has_any_for_part(part_id)
        reason = (reason or "").strip() or None
        if effective_reprint and not reason:
            raise ValidationError("A reprint reason is required")

        # Unknown stays None: a caller that doesn't say which printer it used is
        # not credited with the configured one.
        printer_name = (printer_name or "").strip()[:80] or None
        location = (part.location or "").strip() or None
        symbology = self.label_config()["symbology"]

        with atomic():
            barcode = self.ensure_internal_barcode(part, user=user, symbology=symbology)
            audit = self.print_repo.create(
                part_id=part.id, barcode_value=barcode.code, copies=copies,
                printed_by=user, is_reprint=effective_reprint, reason=reason,
                source=source, printer_name=printer_name,
                symbology=barcode.symbology, location_printed=location,
            )

        return {
            "print_id": audit.id,
            "part_id": part.id,
            "part_no": part.part_no,
            "part_name": part.part_name,
            "location": location,
            "barcode_value": barcode.code,
            "symbology": barcode.symbology,
            "copies": copies,
            "is_reprint": effective_reprint,
            "reason": reason,
            "source": source,
            "printer_name": printer_name,
            "printed_by": user,
            "printed_at": audit.created_at.isoformat() if audit.created_at else None,
        }

    def print_history(self, part_id, limit=50):
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        limit = max(1, min(int(limit or 50), PRINT_HISTORY_MAX))
        return [{
            "id": r.id,
            "barcode_value": r.barcode_value,
            "copies": r.copies,
            "printed_by": r.printed_by,
            "is_reprint": r.is_reprint,
            "reason": r.reason,
            "source": r.source,
            "printer_name": r.printer_name,
            "symbology": r.symbology,
            "location_printed": r.location_printed,
            "printed_at": r.created_at.isoformat() if r.created_at else None,
        } for r in self.print_repo.list_for_part(part_id, limit=limit)]

    # ---- scan audit (admin view) ----

    def list_scan_audit(self, store_code=None, result=None, scan_mode=None,
                        scan_source=None, part_id=None, limit=200):
        rows = self.scan_repo.list_filtered(
            store_code=store_code, result=result, scan_mode=scan_mode,
            scan_source=scan_source, part_id=part_id, limit=limit,
        )
        return [{
            "id": r.id,
            "scanned_code": r.scanned_code,
            "part_id": r.part_id,
            "part_no": r.part.part_no if r.part else None,
            "part_name": r.part.part_name if r.part else None,
            "scan_source": r.scan_source,
            "scan_mode": r.scan_mode,
            "result": r.result,
            "user": r.user,
            "store_code": r.store_code,
            "at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]

    # ---- barcode listing + supplier mapping ----

    def list_part_barcodes(self, part_id):
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        return [{
            "id": b.id,
            "code": b.code,
            "symbology": b.symbology,
            "source": b.source,
            "supplier_id": b.supplier_id,
            "supplier_name": b.supplier.supplier_name if b.supplier else None,
            "is_primary": b.is_primary,
            "is_active": b.is_active,
            "created_by": b.created_by,
            "created_at": b.created_at.isoformat() if b.created_at else None,
        } for b in self.pb_repo.list_for_part(part_id)]

    def map_supplier_barcode(self, part_id, code, supplier_id=None,
                             symbology="CODE128", user=None):
        """Admin maps a vendor's barcode to an internal part. One code value maps
        to one part only — a duplicate is blocked (409). The internal Part No. is
        never replaced; this is an additional way to reach the same part."""
        part = self.part_repo.get_by_id(part_id)
        if not part:
            raise NotFoundError(f"Part {part_id} not found")
        code = (code or "").strip()
        if not code:
            raise BadRequestError("Supplier barcode value is required")
        if symbology not in SYMBOLOGIES:
            symbology = "OTHER"

        clash = self.pb_repo.get_by_code(code)
        if clash:
            if clash.part_id == part_id and not clash.is_active:
                # Reactivate a previously-deactivated mapping for THIS part so the
                # code resolves again — before this it was a silent no-op that
                # still reported success (finding #2).
                self.pb_repo.update(clash, is_active=True, supplier_id=supplier_id, symbology=symbology)
                return self.list_part_barcodes(part_id)
            # Already mapped (to this part while active, or to any other part).
            raise ConflictError(
                f"Barcode '{code}' is already mapped"
                + ("" if clash.part_id == part_id else " to another part")
            )

        # A supplier code must not collide with another part's internal Part No.
        # (or that part's own barcode) — scanning it would otherwise silently
        # resolve to the wrong part. Equal to THIS part's own number is a
        # harmless alias and allowed.
        owner = self.part_repo.get_by_scan_code(code)
        if owner and owner.id != part_id:
            raise ConflictError(f"Barcode '{code}' is the internal Part No. of another part")

        if supplier_id is not None and not self.supplier_repo.get_by_id(supplier_id):
            raise NotFoundError(f"Supplier {supplier_id} not found")

        self.pb_repo.create(
            part_id=part_id, code=code, symbology=symbology, source="SUPPLIER",
            supplier_id=supplier_id, is_primary=False, is_active=True, created_by=user,
        )
        return self.list_part_barcodes(part_id)

    def set_mapping_active(self, mapping_id, active, user=None):
        mapping = self.pb_repo.get_by_id(mapping_id)
        if not mapping:
            raise NotFoundError(f"Barcode mapping {mapping_id} not found")
        if mapping.source == "INTERNAL" and not active:
            raise ValidationError("The internal barcode cannot be deactivated")
        self.pb_repo.update(mapping, is_active=bool(active))
        return self.list_part_barcodes(mapping.part_id)
