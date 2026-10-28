"""The Store Bot reads a question however it is asked, in English or the
Hinglish a keeper types, and answers in that language (the store, 18 Oct 2026:
"assistant par puch kar jawab lenge hindiglish ya jis bhasha me"; "store bot
aise design ho ki data kisi bhi tarike se pucha jaaye answer turant mile" —
after "top 10 excess part max value" got no figures). Run against a fixed stock
list built with the app's own row builder (SpareStockService._row_dict), so
every status and figure is the app's, and no store's data is needed."""
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.services import spare_report_service
from app.services.assistant_service import AssistantService, _inr, _is_code, _is_place, _money, _tokens
from app.services.spare_stock_service import SpareStockService

SECTIONS = [(1, "Press Tool Room", "Tool Room"), (5, "Maintenance", None), (6, "General Tool Room", "Tool Room")]
_COLS = ("part_no", "part_name", "qty", "min_stock_level", "max_stock_level", "unit_price", "section_id",
         "sub_category", "location", "rework_location", "old_part_no")
PARTS = [
    ("CNTR3200", "BENDING INSERT", 5, 2, 4, 8548, 1, "Bending Insert", "R4-S6-B33(1)", "R9-S1-B2", "OLD-77"),
    ("CNTR32001", "CUTTER HOLDER", 0, 1, 4, None, 1, "Std Part", "R4-S6-B34", None, None),
    ("CGMM0006", "FIBER UNIT PHOTO ELECTRIC SENSOR", None, 1, 3, 1200.5, 5, "Sensor", "R4-S6-B33", None, None),
    ("CNMM0026", "SWITCH MAGNETIC", 20, 2, 4, 33443, 5, "Electric Item", "R2-S1-B5", None, None),
    ("CNMM1313", "SPRING WASHER", 10885, 100, 200, None, 5, "Washer", "R1-S1-B1", None, None),
    ("CNMM0313", "SENSOR BRACKET", 0, 20, 40, 150, 5, "Sensor", "R3-S2-B9", None, None),
    ("CNMM1774", "BEARING 6205", 1, 20, 30, 250, 6, "Bearing", "R5-S1-B1", None, None),
    ("CNTR0581", "BEARING 6305", 3, 2, 5, 3054, 6, "Bearing", "R5-S1-B2", None, None),
    ("CNMM5000", "SOLENOID VALVE 24V", 4, 0, None, 100, 5, "Solenoid Valve", "", None, None),
]


def _rows():
    rows = []
    for i, vals in enumerate(PARTS, start=1):
        f = dict(zip(_COLS, vals))
        part = SimpleNamespace(id=i, new_part_no=None, uom="NOS", category="Maintenance/Tool Room", specification=None,
                               reorder_level=None, **{k: v for k, v in f.items() if k != "qty"})
        stock = SimpleNamespace(qty_on_hand=f["qty"], last_counted_at=None) if f["qty"] is not None else None
        rows.append(SpareStockService._row_dict(part, stock))
    return rows


class _Stock:
    def __init__(self):
        self.rows = _rows()
        self.asked = []

    def list_stock(self, store_code):
        return self.rows

    def top_consumed(self, store_code, limit=5, days=30, date_from=None, date_to=None):
        self.asked.append((date_from, date_to))
        used = [{"part_no": "CNMM0313", "part_name": "SENSOR BRACKET", "qty": 5.0},
                {"part_no": "CNTR3200", "part_name": "BENDING INSERT", "qty": 2.0}]
        return used[:limit]


@pytest.fixture()
def bot():
    b = AssistantService()
    b.stock = _Stock()
    b._sections = lambda: SECTIONS
    return b


def _titles(d):
    return [r["title"] for r in d["results"]]


# ---- the store's own question --------------------------------------------------------------------

def test_top_10_excess_by_value_answers_with_the_figures(bot):
    d = bot.ask("top 10 excess part max value")
    assert d["answer"] == ("Excess (above max): 3 parts — ₹5.4 L excess value in all. "
                           "(1 has no rate — no value for them.) Top 2 by excess value:")
    assert [(r["rank"], r["title"], r["metric"]) for r in d["results"]] == [
        (1, "CNMM0026", "₹5,35,088"), (2, "CNTR3200", "₹8,548")]
    assert d["results"][0]["detail"] == "Stock 20 / Max 4 · 16 over · R2-S1-B5"


@pytest.mark.parametrize("q", [
    "top 10 excess value", "excess parts", "max value excess top ten", "excess me sabse jyada paisa kis part me fasa hai",
    "konsa part sabse jyada excess hai", "kitne ka maal excess me hai", "jyada pada hai kya", "overstock list",
    "what is above max"])
def test_excess_asked_many_ways(bot, q):
    d = bot.ask(q)
    assert d["answer"].startswith(("Excess (above max): 3 parts", "Excess (max se zyada): 3 part")), d["answer"]
    assert _titles(d)[0] == "CNMM0026"


def test_excess_in_hinglish_names_the_first(bot):
    # Asked for THE one: it is named; asked for five: the five are the cards.
    d = bot.ask("sabse zyada excess value kis part ki hai")
    assert d["answer"].startswith("Excess (max se zyada): 3 part — kul excess value ₹5.4 L.")
    assert "Sabse upar: CNMM0026 (SWITCH MAGNETIC) — ₹5,35,088." in d["answer"]
    d = bot.ask("sabse zyada excess value wale 5 part")
    assert "Sabse upar" not in d["answer"] and _titles(d) == ["CNMM0026", "CNTR3200"]


def test_excess_by_qty_and_by_section(bot):
    d = bot.ask("excess qty top 5")
    assert [(r["title"], r["metric"]) for r in d["results"]] == [
        ("CNMM1313", "10,685 NOS"), ("CNMM0026", "16 NOS"), ("CNTR3200", "1 NOS")]
    d = bot.ask("maintenance ka excess")
    assert d["answer"].startswith("Excess (max se zyada) — Maintenance: 2 part")
    assert _titles(d) == ["CNMM0026"]                                     # the washer has no rate


# ---- WHICH parts -----------------------------------------------------------------------------------

def test_out_of_stock_store_wide_and_in_a_section_group(bot):
    d = bot.ask("kya kya khatam hai")
    assert d["answer"] == "Stock khatam: 2 part. Sabse zyada kam wale 2:"
    assert [(r["title"], r["metric"]) for r in d["results"]] == [("CNMM0313", "20 short"), ("CNTR32001", "1 short")]
    d = bot.ask("tool room me kya khatam hai")                            # Tool Room = Press + General
    assert d["answer"].startswith("Stock khatam — Tool Room: 1 part.") and _titles(d) == ["CNTR32001"]
    assert bot.ask("what is out of stock in general tool room")["answer"] == "Out of stock — General Tool Room: none right now."


def test_critical_below_min_and_counts(bot):
    d = bot.ask("kitne part critical hain")
    assert d["answer"].startswith("Critical (zero ya min se kam): 3 part.")
    assert bot.ask("how many parts are below minimum")["answer"].startswith("Below minimum: 1 part.")


def test_order_value_is_the_reorder_lists(bot):
    d = bot.ask("order kitne ka banega")
    assert d["answer"].startswith("Reorder karne wale (min ya usse kam): 3 part — kul order value (max tak) ₹13,250.")
    assert [(r["title"], r["metric"]) for r in d["results"]] == [("CNMM1774", "₹7,250"), ("CNMM0313", "₹6,000")]


def test_missing_data_buckets(bot):
    assert _titles(bot.ask("bina rate wale part")) == ["CNMM1313", "CNTR32001"]   # by stock
    assert bot.ask("min max nahi bhara")["answer"].startswith("Bina min / max: 1 part.")
    assert _titles(bot.ask("location nahi hai")) == ["CNMM5000"]


# ---- BY WHAT, HOW MANY -----------------------------------------------------------------------------

def test_rate_rankings(bot):
    d = bot.ask("sabse mehenga part")
    assert "Sabse upar: CNMM0026 (SWITCH MAGNETIC) — ₹33,443." in d["answer"]
    assert len(bot.ask("5 costliest parts")["results"]) == 5
    assert _titles(bot.ask("sabse saste 3 part")) == ["CNMM5000", "CNMM0313", "CNMM1774"]
    assert _titles(bot.ask("top 3 mehenge bearing")) == ["CNTR0581", "CNMM1774"]


def test_stock_rankings_are_not_buckets(bot):
    assert _titles(bot.ask("sabse zyada stock wale part"))[0] == "CNMM1313"     # not "zyada stock" = excess
    assert _titles(bot.ask("sabse kam stock"))[:2] == ["CNMM0313", "CNTR32001"]  # not "kam stock" = below min


@pytest.mark.parametrize("q, n", [("top ten excess", 10), ("top das excess", 10), ("pehle 3 critical", 3),
                                  ("10 sabse mehenge part", 10), ("top5 excess", 5)])
def test_how_many_is_read(bot, q, n):
    from app.services.assistant_service import _Ask
    assert _Ask(q).n == n


# ---- sums, types, places ---------------------------------------------------------------------------

def test_value_sums(bot):
    assert bot.ask("total stock value")["answer"] == (
        "Total counted stock value is ₹7,21,412 across 6 priced parts. 8 of 9 parts are counted.")
    assert bot.ask("kitne ka stock hai")["answer"].startswith("Gine hue stock ki kul value ₹7,21,412 hai")
    assert bot.ask("maintenance ki stock value")["answer"].startswith(
        "Gine hue stock ki kul value (Maintenance) ₹6,69,260 hai — 3 part ki rate ke saath.")


def test_a_type_and_a_place_are_listed(bot):
    d = bot.ask("sensor dikhao")
    assert d["answer"] == "Sensor: 2 part:" and _titles(d) == ["CNMM0313", "CGMM0006"]
    assert _titles(bot.ask("top 5 bearing by value")) == ["CNTR0581", "CNMM1774"]
    d = bot.ask("R4 B33 me kya rakha hai")
    assert d["answer"] == "R4 B33: 2 part:" and sorted(_titles(d)) == ["CGMM0006", "CNTR3200"]


def test_a_word_beside_a_type_narrows_it(bot):
    d = bot.ask("fiber sensor dikhao")
    assert _titles(d) == ["CGMM0006"] and d["answer"].startswith("CGMM0006 (FIBER UNIT PHOTO ELECTRIC SENSOR)")


# ---- consumption -----------------------------------------------------------------------------------

def test_consumption_and_its_period(bot, monkeypatch):
    today = spare_report_service.plant_today()
    d = bot.ask("is mahine sabse zyada use")
    assert d["answer"] == ("Is mahine 2 part issue hue, kul 7 qty, value ₹17,846. "
                           "Use hui qty ke hisaab se top 2:")
    assert _titles(d) == ["CNMM0313", "CNTR3200"]
    assert bot.stock.asked[-1] == (today.replace(day=1).isoformat(), today.isoformat())
    assert _titles(bot.ask("top 10 consumption value")) == ["CNTR3200", "CNMM0313"]
    bot.ask("pichhle 90 din me kya use hua")
    assert bot.stock.asked[-1][0] == (today - timedelta(days=89)).isoformat()
    bot.ask("yesterday most used")
    assert bot.stock.asked[-1] == ((today - timedelta(days=1)).isoformat(),) * 2
    assert not bot.ask("issue kaise kare")["answer"].startswith(("Last 30", "Pichhle"))   # a how-to, not a figure


# ---- a part by number, language, greetings ---------------------------------------------------------

def test_a_part_number_in_a_hinglish_sentence_answers_in_hinglish(bot):
    d = bot.ask("bhai CNTR3200 kitna bacha hai?")
    assert d["answer"] == ("CNTR3200 (BENDING INSERT) ka stock 5 NOS hai, location new R4-S6-B33(1), "
                           "rework R9-S1-B2. Min 2, Max 4. Rate ₹8,548. Status: max se zyada (excess).")
    assert _titles(d) == ["CNTR3200"]                                     # exact: not CNTR32001 too
    assert bot.ask("where is cntr3200")["answer"].startswith("CNTR3200 (BENDING INSERT): 5 NOS in stock, at new")
    assert "Rate ₹8,548" in bot.ask("CNTR3200 kitne ka hai")["answer"]  # a part number beats "kitne ka"
    assert _titles(bot.ask("OLD-77 ka stock")) == ["CNTR3200"]
    assert bot.ask("CGMM0006 kitna hai")["answer"].startswith(
        "CGMM0006 (FIBER UNIT PHOTO ELECTRIC SENSOR) abhi tak gina nahi gaya, location R4-S6-B33.")


def test_greetings_thanks_and_nothing_found(bot):
    assert bot.ask("namaste")["answer"].startswith("Namaste!")
    assert bot.ask("hello")["answer"].startswith("Hello!")
    assert bot.ask("thank you")["answer"].startswith("You're welcome")
    assert bot.ask("shukriya bhai")["answer"].startswith("Koi baat nahi")
    assert bot.ask("zzqx kya hai")["answer"].startswith("“zzqx kya hai” se kuch nahi mila")
    assert bot.ask("show me the cutter")["answer"].startswith("CNTR32001 (CUTTER HOLDER): 0 NOS in stock")


@pytest.mark.parametrize("n, text", [
    (0, "₹0"), (999, "₹999"), (1000, "₹1,000"), (100000, "₹1,00,000"), (12345678, "₹1,23,45,678"),
    (8547.6, "₹8,548"), (-2500, "-₹2,500"), (0.4, "₹0.40")])
def test_inr(n, text):
    assert _inr(n) == text


def test_money_and_tokens():
    assert [_money(v) for v in (45600, 543636, 18_990_000, 40_000_000)] == ["₹45,600", "₹5.4 L", "₹1.90 Cr", "₹4 Cr"]
    assert _tokens("bhai, cntr3200 kitna bacha hai?") == ["bhai", "cntr3200", "kitna", "bacha", "hai"]
    assert _tokens("r4-s6-b33(1) me") == ["r4-s6-b33", "1", "me"]
    assert [t for t in ("cntr3200", "r4", "b33", "hai", "2026", "fu-77tz") if _is_code(t)] == [
        "cntr3200", "r4", "b33", "fu-77tz"]
    assert [t for t in ("r4", "b33", "s6", "r4-s6-b33", "cntr3200", "r12--s7") if _is_place(t)] == [
        "r4", "b33", "s6", "r4-s6-b33", "r12--s7"]


# ---- asked any way at all (the sweep of 21 Oct 2026: typos, shortforms, odd part numbers, bins
# written every way, figure lines, sections side by side, Devanagari, small talk) ------------------

@pytest.mark.parametrize("q, starts", [
    ("top 10 exces value", "Excess (above max): 3 parts"), ("exess part dikha", "Excess (max se zyada): 3 part"),
    ("critcal part", "Critical (zero or below min): 3 parts."), ("0 stck", "Out of stock: 2 parts."),
    ("kya mngwana h", "Reorder karne wale (min ya usse kam): 3 part."), ("order krna h kya kya", "Reorder karne wale"),
    ("po banana h kis ka", "Reorder karne wale"), ("short kya kya h", "Critical (zero ya min se kam): 3 part."),
    ("gtr me kya kam h", "Critical (zero ya min se kam) — General Tool Room: 1 part."),
    ("khatam hone wale part", "Khatam hone wale (abhi zero nahi): 1 part."),
    ("kitne part gine nhi", "Abhi tak nahi gine: 1 part."), ("jyada maal pada h kya", "Excess (max se zyada): 3 part"),
    ("mantenance stock value", "Total counted stock value in Maintenance is ₹6,69,260"),
])
def test_typos_and_shortforms(bot, q, starts):
    assert bot.ask(q)["answer"].startswith(starts), bot.ask(q)["answer"]


@pytest.mark.parametrize("q", ["CNTR-3200 ka stock", "cntr_3200", "CNTR 3200 ka rate", "cntr3200?"])
def test_a_part_number_however_typed(bot, q):
    assert _titles(bot.ask(q)) == ["CNTR3200"]


def test_two_part_numbers_and_a_short_word_beside_a_type(bot):
    d = bot.ask("CNTR3200 aur CNMM0026 ka stock")
    assert _titles(d) == ["CNTR3200", "CNMM0026"] and d["answer"].count("ka stock") == 2


@pytest.mark.parametrize("q, n", [("R4-S6-B33", 2), ("r4s6b33", 2), ("R4-S6-B33(1) me kya hai", 2),
                                  ("rack 4 me kya h", 3), ("what have we got in R4", 3)])
def test_a_bin_however_written(bot, q, n):
    assert len(bot.ask(q)["results"]) == n


def test_not_a_bucket(bot):
    assert bot.ask("jo khatam nahi hai")["answer"].startswith("Stock khatam nahi: 7 part")
    assert bot.ask("not critical parts")["answer"].startswith("Not critical (zero or below min): 6 parts")


def test_figure_lines_and_levels(bot):
    d = bot.ask("rate 500 se upar wale part")
    assert d["answer"].startswith("Rate ₹500 se upar: 4 part.")
    assert _titles(d) == ["CNMM0026", "CNTR3200", "CNTR0581", "CGMM0006"]
    d = bot.ask("stock 5 se kam wale part")
    assert d["answer"].startswith("Stock 5 se kam: 5 part.") and _titles(d)[0] == "CNMM5000"
    d = bot.ask("1 lakh se upar ka excess")
    assert d["answer"].startswith("Excess (max se zyada) — excess value ₹1 L se upar: 1 part — kul excess value ₹5.4 L.")
    assert len(bot.ask("min 20 wale part")["results"]) == 2
    assert bot.ask("5000 se mehenge part")["answer"].startswith("Rate ₹5,000 se upar: 2 part.")


def test_sections_side_by_side(bot):
    d = bot.ask("which section has the most excess")
    assert d["answer"] == ("Excess (above max), by section: Maintenance ₹5.4 L (2 parts) · Press Tool Room ₹8,548 "
                           "(1 part) · General Tool Room ₹0 (0 parts). Most: Maintenance.")
    assert [(c["title"], c["metric"]) for c in d["results"]][:2] == [("Maintenance", "₹5.4 L"),
                                                                     ("Press Tool Room", "₹8,548")]
    d = bot.ask("maintenance vs tool room excess value")
    assert [c["title"] for c in d["results"]] == ["Maintenance", "Tool Room"]


def test_devanagari_reads_as_hinglish(bot):
    assert bot.ask("क्या खत्म है")["answer"] == "Stock khatam: 2 part. Sabse zyada kam wale 2:"
    assert _titles(bot.ask("टॉप 10 एक्सेस वैल्यू"))[0] == "CNMM0026"
    assert bot.ask("स्टॉक कितना है")["answer"].startswith("Gine hue stock ki kul value ₹7,21,412 hai")
    assert bot.ask("maintenance का excess")["answer"].startswith("Excess (max se zyada) — Maintenance: 2 part")


def test_small_talk_never_hides_a_question(bot):
    assert bot.ask("ok")["answer"].startswith("Okay!")
    assert bot.ask("hello bhai kya khatam hai")["answer"].startswith("Stock khatam: 2 part.")
    assert bot.ask("thanks ab excess list dikhao")["answer"].startswith("Excess (max se zyada): 3 part")


def test_named_months_and_years(bot):
    today = spare_report_service.plant_today()
    bot.ask("september ka consumption")
    year = today.year if today.month >= 9 else today.year - 1
    assert bot.stock.asked[-1][0] == f"{year}-09-01"
    d = bot.ask(f"{today.year} me kitna issue hua")
    assert d["answer"].startswith(f"{today.year} me 2 part issue hue")
    assert bot.stock.asked[-1] == (f"{today.year}-01-01", today.isoformat())


def test_a_family_word_takes_every_type_it_ends(bot):
    # "valve" is no type here, only the end of "Solenoid Valve": its one part, answered whole.
    d = bot.ask("valve kitne hain")
    assert _titles(d) == ["CNMM5000"] and d["answer"].startswith("CNMM5000 (SOLENOID VALVE 24V) ka stock 4 NOS hai")


def _bot_with(extra, discontinued=()):
    """The fixture's store plus extra parts (PARTS' columns), some of them
    discontinued (Part No.s)."""
    b = AssistantService()
    b.stock = _Stock()
    for i, vals in enumerate(extra, start=len(PARTS) + 1):
        f = dict(zip(_COLS, vals))
        part = SimpleNamespace(id=i, new_part_no=None, uom="NOS", category="Maintenance/Tool Room", specification=None,
                               reorder_level=None, discontinued=f["part_no"] in discontinued,
                               **{k: v for k, v in f.items() if k != "qty"})
        stock = SimpleNamespace(qty_on_hand=f["qty"], last_counted_at=None) if f["qty"] is not None else None
        b.stock.rows.append(SpareStockService._row_dict(part, stock))
    b._sections = lambda: SECTIONS
    return b


def test_part_and_parts_never_name_a_type():
    """Live data, 25 Oct 2026: a type "Cylinder Parts" made "kitne parts khatam
    hai" answer for that one type — "abhi koi part nahi" — not the store."""
    b = _bot_with([("CNMM7001", "PISTON SEAL KIT", 6, 1, 8, 90, 5, "Cylinder Parts", "R6-S1-B1", None, None)])
    for q in ("kitne parts khatam hai", "kitne part khatam hai", "kya kya khatam hai"):
        assert b.ask(q)["answer"].startswith("Stock khatam: 2 part"), q
    assert b.ask("reorder wale parts kitne hai")["answer"].startswith("Reorder karne wale (min ya usse kam): 3 part")
    # The type named in full still is one.
    assert _titles(b.ask("cylinder parts dikhao")) == ["CNMM7001"]


def test_discontinued_parts_are_asked_for():
    b = _bot_with([("CNTR9001", "OLD DIE PUNCH", 4, 0, None, 500, 1, "Punch", "R12-S1-B1", None, None),
                   ("CNTR9002", "OLD DIE BUTTON", 0, 0, None, 200, 1, "Button", "R12-S1-B2", None, None)],
                  discontinued=("CNTR9001", "CNTR9002"))
    for q in ("discontinued parts", "discontinued part kitne hai", "jinki zarurat nahi"):
        d = b.ask(q)
        assert d["answer"].startswith("Discontinued (ab zarurat nahi): 2 part") or \
            d["answer"].startswith("Discontinued (not required any more): 2 parts"), (q, d["answer"])
        assert set(_titles(d)) == {"CNTR9001", "CNTR9002"}
    # A discontinued part at zero is not "out of stock".
    assert "CNTR9002" not in _titles(b.ask("kya kya khatam hai"))


# ---- a job to do names its screen (28 Oct 2026) ----------------------------------------------------

def _anyone():
    """A store person who may open every screen (the suggestions hide a screen a user may not open)."""
    return SimpleNamespace(is_admin=False, can=lambda mod, action="view": True, can_access_store=lambda code: True)


def _screens(d):
    return [s["title"] for s in d["suggestions"]]


@pytest.mark.parametrize("q", ["qr lable print karne h", "lable print karne h", "qr label print",
                               "label kaise print kare", "qr code nikalna hai", "sticker print karna hai"])
def test_a_label_job_names_packets_and_qr_labels(bot, q):
    """ "qr lable print karne h" got "stock data nahi mila" and Reports / Scan Part:
    Packets & QR Labels was not in the bot's screen list at all."""
    d = bot.ask(q, user=_anyone())
    assert "Packets & QR Labels" in _screens(d), (q, d)
    assert "Reports" not in _screens(d), (q, d)
    assert "stock data" not in d["answer"], (q, d["answer"])


@pytest.mark.parametrize("q, first", [
    ("qr lable print karne h", "Packets & QR Labels"),
    ("job work ka challan kahan milega", "Job Work & RGP"),
    ("coating ke liye part bhejna hai kaise", "Job Work & RGP"),
    ("audit trail kahan milega", "Audit Trail"),
])
def test_the_screen_asked_for_comes_first(bot, q, first):
    d = bot.ask(q, user=_anyone())
    assert d["answer"].startswith("Ye screen kaam aayegi"), (q, d["answer"])
    assert _screens(d)[0] == first, (q, _screens(d))


def test_every_sidebar_screen_is_in_the_bots_screen_list():
    """Store Saathi keeps up with the app (the store, 28 Oct 2026: "jo bhi
    update app me ho rhe h wo saath saath store bot m bhi update hote rhen"): a
    screen in the sidebar the bot cannot name fails here."""
    import pathlib
    import re
    from app.services.service_catalog import SERVICES
    side = (pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src" / "components" / "Sidebar.jsx")
    text = side.read_text(encoding="utf-8")
    # The Spare build's menus: the shared group, the Spare store's own, System
    # and Email — not the Child Part store's.
    spare = text[text.index("const SHARED_GROUPS"):text.index("CHILD_PART: [")] +         text[text.index("MAINTENANCE: ["):text.index("const navFor")]
    routes = re.findall(r'\{ to: "([^"]+)", label: "[^"]+"', spare)
    assert len(routes) > 30
    known = {s["route"].split("?")[0] for s in SERVICES}
    assert [r for r in routes if r.split("?")[0] not in known] == []
    # And the top-bar quick search (CommandPalette) finds them too.
    palette = (side.parent / "CommandPalette.jsx").read_text(encoding="utf-8")
    jumps = {r.split("?")[0] for r in re.findall(r'to: "([^"]+)"', palette)}
    assert [r for r in routes if r.split("?")[0] not in jumps] == []
