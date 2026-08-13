"""Outbound call to the plant ERP for SRV submission (Steps 5-6: SRV
Creation / short-material branch). Same swap pattern as ForecastService's
Excel-now/API-later ingestion: one method, one caller (SRVService), so
pointing ERP_API_BASE_URL at the real endpoint later is a drop-in change —
no caller-side rework.

Until the ERP endpoint exists, submit_srv() mocks the response locally in
the same srv_no/short-note-no format the real ERP is expected to return.
"""
import requests
from flask import current_app


class ERPNotConfigured(Exception):
    """Raised when ERP_API_BASE_URL is unset, so an outbound push cannot go
    through — the movement stays pending until the endpoint is live."""


class ERPClient:
    def push_stock_movement(self, part_no, qty_delta, reason, reference=None):
        """Push a spare stock movement to ERP so ERP's on-hand tracks the store's.
        Returns True on success; raises ERPNotConfigured when ERP_API_BASE_URL is
        unset (the movement then stays pending until the endpoint is live)."""
        base_url = current_app.config.get("ERP_API_BASE_URL")
        if not base_url:
            raise ERPNotConfigured()
        resp = requests.post(
            f"{base_url.rstrip('/')}/stock/movement",
            json={"part_no": part_no, "qty_delta": qty_delta, "reason": reason, "reference": reference},
            timeout=current_app.config.get("ERP_API_TIMEOUT", 10),
        )
        resp.raise_for_status()
        return True

    def get_pending_rgp(self):
        """Pending Returnable Gate Passes, read from ERP — material sent out on a
        returnable basis that has not yet come back. Returns the count when ERP
        is live; raises ERPNotConfigured until ERP_API_BASE_URL is set, so the
        dashboard shows "—" rather than a made-up number. RGP lives only in ERP,
        so there is no local fallback."""
        base_url = current_app.config.get("ERP_API_BASE_URL")
        if not base_url:
            raise ERPNotConfigured()
        resp = requests.get(
            f"{base_url.rstrip('/')}/rgp/pending",
            timeout=current_app.config.get("ERP_API_TIMEOUT", 10),
        )
        resp.raise_for_status()
        return int(resp.json().get("pending", 0))

    def submit_srv(self, srv, is_short):
        """Submit a verified SRV line to ERP. Returns {"srv_no": str,
        "short_note_no": str | None}. ERP is the source of truth for both
        numbers once live — we no longer mint srv_no ourselves in that mode."""
        base_url = current_app.config.get("ERP_API_BASE_URL")
        if base_url:
            return self._submit_via_api(base_url, srv, is_short)
        return self._submit_mock(srv, is_short)

    def _submit_via_api(self, base_url, srv, is_short):
        payload = {
            "vendor_code": srv.vendor_code,
            "invoice_no": srv.invoice_no,
            "part_no": srv.part_no,
            "qty_invoiced": float(srv.qty_invoiced or 0),
            "qty_received": float(srv.qty_received or 0),
            "is_short": is_short,
        }
        resp = requests.post(
            f"{base_url.rstrip('/')}/srv/submit",
            json=payload,
            timeout=current_app.config.get("ERP_API_TIMEOUT", 10),
        )
        resp.raise_for_status()
        data = resp.json()
        return {"srv_no": data["srv_no"], "short_note_no": data.get("short_note_no")}

    @staticmethod
    def _submit_mock(srv, is_short):
        srv_no = f"SRV{srv.created_at.strftime('%y%m%d')}-{srv.id:04d}"
        short_note_no = f"SN{srv.created_at.strftime('%y%m%d')}-{srv.id:04d}" if is_short else None
        return {"srv_no": srv_no, "short_note_no": short_note_no}
