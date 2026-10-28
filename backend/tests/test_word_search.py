"""Finding a part by the words someone knows (the store, 28 Oct 2026: "bearing,
bolt, nut, spring … kisi ko exact part no ya model ya spec na pta ho"): each
word anywhere — Part No., description, category, spec, model — in any order,
and a plural finds its singular."""
from app.extensions import db
from app.models.part import Part
from app.repositories.part_repository import PartRepository
from app.services.part_kiosk_service import PartKioskService
from app.utils.word_search import word_variants

STORE = "MAINTENANCE"


def _parts():
    tag = f"WS{Part.query.count()}"
    rows = {
        "cat_only": Part(part_no=f"{tag}-1", part_name="6204 ZZ", sub_category="Bearing", uom="NOS",
                         part_type="OTHER", store_code=STORE),
        "named": Part(part_no=f"{tag}-2", part_name="BALL BEARING 6205 2RS", sub_category="Bearing", uom="NOS",
                      part_type="OTHER", store_code=STORE),
        "bolt": Part(part_no=f"{tag}-3", part_name="ALLEN BOLT M8 X 25", sub_category="Allen Bolt", uom="NOS",
                     part_type="OTHER", store_code=STORE, specification="SS 304"),
        "spring": Part(part_no=f"{tag}-4", part_name="COMPRESSION SPRING", sub_category="Spring", uom="NOS",
                       part_type="OTHER", store_code=STORE, model_no="CS-12"),
    }
    db.session.add_all(rows.values())
    db.session.commit()
    return tag, rows


def _found(keyword, tag):
    return {p.part_no for p in PartRepository().search(keyword=keyword, store_code=STORE).all()
            if p.part_no.startswith(tag)}


def test_a_word_finds_parts_by_category_as_well_as_description():
    tag, p = _parts()
    assert _found("bearing", tag) == {p["cat_only"].part_no, p["named"].part_no}   # 6204 ZZ by its category
    assert _found("BEARING", tag) == _found("bearing", tag)


def test_words_in_any_order_and_plurals():
    tag, p = _parts()
    assert _found("6205 bearing", tag) == {p["named"].part_no}
    assert _found("bearing 6204", tag) == {p["cat_only"].part_no}
    assert _found("bolts m8", tag) == {p["bolt"].part_no}                 # plural typed
    assert _found("springs", tag) == {p["spring"].part_no}
    assert _found("allen 304", tag) == {p["bolt"].part_no}                # spec
    assert _found("cs-12", tag) == {p["spring"].part_no}                  # model
    assert _found("bearing m8", tag) == set()                             # every word must match


def test_the_kiosk_searches_the_same_way():
    tag, p = _parts()
    rows = PartKioskService().search(STORE, "bearing", per_page=100)["rows"]
    assert {p["cat_only"].part_no, p["named"].part_no} <= {r["part_no"] for r in rows}
    rows = PartKioskService().search(STORE, "springs compression", per_page=100)["rows"]
    assert p["spring"].part_no in {r["part_no"] for r in rows}


def test_word_variants():
    assert word_variants("bolts") == ["bolts", "bolt"]
    assert word_variants("bushes") == ["bushes", "bush", "bushe"]
    assert word_variants("glass") == ["glass"]
    assert word_variants("nut") == ["nut"]
