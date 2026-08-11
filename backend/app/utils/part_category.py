"""Derive a spare's component type from its description text.

A keyword pass, ordered specific-component first so the component beats the
assembly/product word (a "DIE#3 PILOT PIN" is a Pilot Pin, not a Die; a
"LOWER RAIL PUNCH" is a Punch, not a Rail). It reliably tags most of a
tool-room/spare list; the leftover is a small set of pure catalog codes with
no descriptive noun (e.g. "APEL13-80-P8.8"), which stay uncategorised for a
human to look at.

Result goes into Part.sub_category (free text), NOT Part.category — the latter
is CHECK-constrained to the business categories (BOP / Import / …).
"""

# (component_type, [keywords]) — FIRST match wins, so order encodes priority.
COMPONENT_RULES = [
    ("Pilot Pin",      ["PILOT PIN", "PILOTPIN"]),
    ("Gas Spring",     ["GAS SPRING"]),
    ("Cylinder",       ["CYLINDER"]),
    ("Sensor",         ["SENSOR", "PROXIMITY", "PHOTO"]),
    ("Stripper Plate", ["STRIPPER"]),
    ("Punch",          ["PUNCH"]),
    ("Guide",          ["GUIDE POST", "GUIDE PIN", "GUIDE BUSH", "GUIDE"]),
    ("Housing",        ["HOUSING"]),
    ("Retainer",       ["RETAINER"]),
    ("Ball Cage",      ["BALL CAGE", "CAGE"]),
    ("Bush/Bearing",   ["BUSH", "BUSHING", "BEARING"]),
    ("Block",          ["BLOCK"]),
    ("Plate",          ["PLATE"]),
    ("Spring",         ["SPRING"]),
    ("Fastener",       ["BOLT", "SCREW", " NUT ", "WASHER"]),
    ("Rod",            ["ROD"]),
    ("Pin",            ["PIN"]),
    ("Die component",  ["DIE"]),
]


def derive_component_type(description):
    """Return the component type for a description, or None if nothing matches."""
    if not description:
        return None
    text = " " + str(description).upper() + " "
    for component, keywords in COMPONENT_RULES:
        if any(kw in text for kw in keywords):
            return component
    return None
