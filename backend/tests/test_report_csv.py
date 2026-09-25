"""Reports CSV export (end-cleanup)."""
from app.services.report_service import ReportService


def test_report_csv_has_bom_and_header():
    buf = ReportService().export_csv("srv")
    data = buf.getvalue()
    assert data[:3] == b"\xef\xbb\xbf"  # UTF-8 BOM so Excel opens it in the right encoding
    header = data.decode("utf-8-sig").splitlines()[0]
    assert "SRV No" in header and "Part No" in header  # column labels from REPORTS["srv"]


def test_report_csv_unknown_type_rejected():
    import pytest
    from app.utils.exceptions import BadRequestError
    with pytest.raises(BadRequestError):
        ReportService().export_csv("does_not_exist")
