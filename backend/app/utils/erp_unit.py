"""The ERP unit this app's plant is (the store, 5 Nov 2026: "plant-1 me
unit-10001 ka stock hi dikhana chahiye and app me bhi unit-code 10001 k
according stock update hona chahiye").

ERP keeps several units in one database: Plant 1 is unit 10001, Plant 2 is
10002, and so on. Its current stock carries the unit code (unit_cd). A GRN or
gate entry number carries the unit in its middle part: IN2627/001/1069 and
2627/001/13971 are unit 10001; IN2627/002/163 and 2627/002/288 are Plant 2.
ERP_UNIT_CD in .env picks the unit (default 10001).
"""
from flask import current_app, has_app_context

DEFAULT_UNIT = "10001"


def plant_unit():
    """The plant's ERP unit code, e.g. "10001"."""
    unit = current_app.config.get("ERP_UNIT_CD") if has_app_context() else None
    return str(unit or DEFAULT_UNIT).strip()


def unit_segment(unit=None):
    """The unit as ERP writes it inside a document number: 10001 -> "001"."""
    return (unit or plant_unit())[-3:]


def is_plant_doc(doc_no):
    """True when an ERP GRN / gate entry number is this plant's. A number with
    no unit part in it (not ERP's YYYY/UUU/NNN form) is taken as the plant's."""
    parts = [p.strip() for p in str(doc_no or "").split("/")]
    if len(parts) < 3 or not parts[1].isdigit():
        return True
    return parts[1].zfill(3) == unit_segment()


def is_plant_unit(unit_cd):
    """True when a current stock row's unit code is this plant's. A row with no
    unit code is kept."""
    code = str(unit_cd or "").strip()
    return not code or code == plant_unit()
