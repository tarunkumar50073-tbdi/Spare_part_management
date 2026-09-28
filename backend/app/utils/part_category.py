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
    ("Cylinder",       ["CYLINDER", "CYLENDER"]),
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
    # Broader spare/maintenance part-types (pneumatics, electricals, tool-room
    # tools, motion parts…) for the Thin-Rec / Bin-Washing / Maintenance sections.
    # Specific-before-general within each family; all sit before the fastener block.
    ("Hose Clamp",        ["HOSE CLAMP"]),
    ("Solenoid Valve",    ["SOLENOID VALVE", "SOLENOID"]),
    ("Speed Controller",  ["SPEED CONTROL", "FLOW CONTROL"]),
    ("Valve",             ["VALVE"]),
    ("Pneumatic Fitting", ["FITTING", "NIPPLE", "ELBOW", "ONE TOUCH", "PUSH-IN", "MALE CONNECTOR", "REDUCER"]),
    ("Pipe/Hose/Tube",    ["HOSE", "TUBE", "TUBING", "PIPE"]),
    ("Regulator",         ["REGULATOR"]),
    ("Nozzle",            ["NOZZLE"]),
    ("Pump",              ["PUMP"]),
    ("Filter",            ["FILTER", "STRAINER"]),
    ("Heater",            ["HEATER"]),
    ("Oil Seal",          ["OIL SEAL"]),
    ("O-Ring",            ["O-RING", "O RING", "ORING"]),
    ("Packing/Gasket",    ["PACKING", "GASKET"]),
    ("Seal",              ["SEAL"]),
    ("Push Button",       ["PUSH BUTTON", "PUSHBUTTON", "PUSH-BUTTON"]),
    ("Limit Switch",      ["LIMIT SWITCH"]),
    ("Switch",            ["SWITCH", "SELECTOR"]),
    ("Relay",             ["RELAY"]),
    ("Contactor",         ["CONTACTOR"]),
    ("MCB/Breaker",       ["MCB", "MCCB", "BREAKER"]),
    ("Fuse",              ["FUSE"]),
    ("PLC/Module",        ["PLC", "MODULE", "CPU", "EXPANSION UNIT"]),
    ("Power Supply",      ["POWER SUPPLY", "SMPS", "TRANSFORMER"]),
    ("Cable",             ["CABLE", " WIRE"]),
    ("Connector",         ["CONNECTOR", "TERMINAL"]),
    ("Controller/Drive",  ["CONTROLLER", "AMPLIFIER", "SERVO PACK", "SERVO DRIVE", "DRIVE UNIT", "INVERTER"]),
    ("Battery",           ["BATTERY"]),
    ("Servo Motor",       ["SERVO MOTOR"]),
    ("Motor",             ["MOTOR"]),
    ("Slide Unit",        ["SLIDE UNIT", "SLIDE GUIDE", "SLIDE TABLE", "LINEAR SLIDE", "SLIDE"]),
    ("Gear",              ["GEAR"]),
    ("Belt",              ["V-BELT", "TIMING BELT", "BELT"]),
    ("Chain",             ["CHAIN"]),
    ("Coupling",          ["COUPLING"]),
    ("Joint",             ["FLOATING JOINT", "BALL JOINT", "ROD END", "JOINT"]),
    ("Shaft",             ["SHAFT"]),
    ("Spline",            ["SPLINE"]),
    ("Shock Absorber",    ["SHOCK ABSORBER", "SHOCK ABSORBOR", "SHOCK"]),
    ("Shim",              ["SHIM"]),
    ("Cover",             ["COVER"]),
    ("Holder",            ["HOLDER"]),
    ("Bracket",           ["BRACKET"]),
    ("Manifold",          ["MANIFOLD"]),
    ("Magnet",            ["MAGNET"]),
    ("Ring/Circlip",      [" RING ", "CIRCLIP", "RETAINING RING", "SNAP RING"]),
    ("Rotary",            ["ROTARY"]),
    ("Plug",              ["PLUG"]),
    ("Thimble",           ["THIMBLE"]),
    ("Drill",             ["DRILL"]),
    ("Reamer",            ["REAMER"]),
    ("End Mill/Cutter",   ["END MILL", "ENDMILL", "CUTTER", "MILLING CUTTER"]),
    ("Chuck/Collet",      ["CHUCK", "COLLET"]),
    ("Jig/Fixture",       ["JIG", "FIXTURE"]),
    ("Robot Part",        ["ROBOT"]),
    ("Table/Bolster",     ["BOLSTER", "MACHINE TABLE"]),
    ("Cam",               ["CAM "]),
    ("Tap",               ["TAP SET", "TAP-", "TAP "]),
    ("HSS/Carbide Tool",  ["HSS", "CARBIDE"]),
    # Fastener family — split into real types (for the Nut-Bolt section etc.).
    # These sit BEFORE the generic "Spring"/"Fastener" so a "SPRING WASHER" is a
    # Washer (not a Spring) and an "ALLEN BOLT" gets its own type, not one blob.
    ("Grub Screw",        ["GRUB SCREW", "GRUB"]),
    ("Countersunk (CSK)", ["CSK", "CKS"]),
    ("Allen Bolt",        ["ALLEN BOLT", "ALLEN"]),
    ("Hex Bolt",          ["HEX BOLT", "HEXAGON BOLT", "HEX HEAD"]),
    ("Nut",               ["HEX NUT", "FLY NUT", "NYLOCK", "LOCK NUT", " NUT "]),
    ("Spring Washer",     ["SPRING WASHER"]),
    ("Washer",            ["PLANE WASHER", "PLAIN WASHER", "PLAN WASHER", "WASHER"]),
    ("Hose Clamp",        ["HOSE CLAMP"]),
    ("Stud",              ["STUD"]),
    ("Screw",             ["GRAVE SCREW", "MACHINE SCREW", "SCREW"]),
    ("Chisel",            ["CHISEL"]),
    ("Wrench/Spanner",    ["SOCKET WRENCH", "WRENCH", "SPANNER"]),
    ("Spring",         ["SPRING"]),
    ("Fastener",       ["BOLT", "SCREW", " NUT ", "WASHER"]),
    ("Grinding Wheel", ["GRIND STONE", "MOUNTED WHEEL", "GRINDER WHEEL", "GRINDER WHELL", "WHEEL", "GRIND", "STONE"]),
    ("File",           ["DIAMOND FILE", "FILE"]),
    ("Hammer",         ["HAMMER"]),
    ("Ball Plunger",   ["PLUNGER"]),
    ("Tap",            ["TAP SET"]),
    ("Feed Unit",      ["FEED UNIT"]),
    ("Gauge",          ["GAUGE"]),
    # 2026-09-28: electrical / control / pneumatic / consumable spares from the
    # Maintenance, Thin-Rec and Bin-Washing sections that carried no matched noun
    # (LED indicators, tower lights, relays, sockets, silencers, grease, etc.).
    # Sit above the coarse Rod/Pin/Die tail so these specific types win; only
    # applied to parts that had NO category, so nothing already tagged changed.
    ("Controller/Drive",   ["CONTOROLLER", "CONTROLER", "AMPLIFIRE"]),  # typo variants
    ("Carbon Brush",       ["CARBON BRUSH"]),
    ("MCB/Breaker",        ["MPCB", "MOTOR PROTECTION"]),
    ("Light Curtain",      ["LIGHT CURTAIN", "SAFETY CURTAIN", "AREA SENSOR"]),
    ("Touch Panel/HMI",    ["TOUCH PANEL", "HMI", "GT2104", "GOT "]),
    ("PLC I/O Unit",       ["CC-LINK", "INPUT UNIT", "OUTPUT UNIT", "SIMPLE MOTION UNIT",
                            "INTERFACE UNIT", "MOTION UNIT"]),
    ("Indicator/Lamp",     ["TOWER LIGHT", "TOWER LAMP", "SIGNAL TOWER", "PATLITE", "INDICATOR",
                            "INDICATIOR", "PILOT LAMP", "LED LAMP", "BULB", "LAMP", " LED "]),
    ("Relay",              ["REALY"]),  # typo of RELAY (the correct-spelling rule is above)
    ("Fitting/Union",      ["UNION", "QUICK COUPL", "QUICK COUPLER", "COUPLER", "QRC"]),
    ("Socket",             ["SOCKET"]),
    ("Capacitor",          ["CAPACITOR"]),
    ("Timer",              ["TIMER"]),
    ("Counter",            ["COUNTER"]),
    ("Cooling Fan",        ["COOLING FAN", "PANEL FAN", "FAN"]),
    ("Voltage Stabilizer", ["STABILIZER", "STABILISER"]),
    ("Encoder",            ["ENCODER"]),
    ("Scanner",            ["SCANNER", "BARCODE READER"]),
    ("Meter",              ["MULTIMETER", "PANEL METER", "FLOW METER", "ENERGY METER"]),
    ("Terminal/Lug",       ["TERMINAL BLOCK", "TERMINAL", "TERMINASH", "FERRUL", "FERRULE",
                            "THIMBLE", "THIBLE"]),
    ("Silencer/Muffler",   ["SILENCER", "MUFFLER", "EXHAUST CLEANER"]),
    ("Sleeve",             ["SLEEVE"]),
    ("Spacer",             ["SPACER"]),
    ("Roller",             ["ROLLER"]),
    ("Ejector",            ["EJECTOR"]),
    ("Pad",                ["MID PAD", "PAD"]),
    ("Jaw",                ["JAW"]),
    ("Jack",               ["JACK"]),
    ("Grease/Lubricant",   ["GREASE", "LUBRICANT"]),
    ("Adhesive/Sealant",   ["LOCTITE", "ADHESIVE", "SEALANT", "THREE BOND", "THREEBOND"]),
    ("Gloves/PPE",         ["GLOVES", "GLOVE", "APRON", "GOGGLE", "FACE SHIELD"]),
    ("Software",           ["SOFTWARE", "LICENSE", "LICENCE"]),
    ("Welding Part",       ["WELDING", "WELD TIP", "WELD CAP", "ELECTRODE"]),
    ("Copper/Conductor",   ["COPPER", "SHUNT", "BUS BAR", "BUSBAR"]),
    ("Machine Key",        ["WOODRUFF", "WOOD RUFF", "PARALLEL KEY", "MACHINE KEY", "KEYWAY", "KEY WAY"]),
    ("Memory Card",        ["MEMORY CARD", "COMPACT FLASH", "SD CARD"]),
    ("Buzzer/Siren",       ["BUZZER", "SIREN", "HOOTER"]),
    ("Tape",               ["PVC TAPE", "INSULATION TAPE", "TEFLON TAPE", " TAPE "]),
    ("Rod",            ["ROD"]),
    ("Pin",            ["PIN"]),
    ("Die component",  ["DIE"]),
    # Product-led rail-die parts ('UPPER/LOWER RAIL …') carry no component noun,
    # so they land here as a coarse Die group rather than staying unlabelled —
    # their natural split is the die-family axis (Upper/Lower Rail), not type.
    ("Rail Die part",  ["UPPER RAIL", "LOWER RAIL", "UPPER", "LOWER"]),
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
