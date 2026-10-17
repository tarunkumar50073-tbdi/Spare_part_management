"""Schemas for admin-editable settings."""
import ipaddress
import re

from marshmallow import Schema, ValidationError, fields, validate

# One list each, owned by the barcode service next to the defaults they go with,
# so the editor can't accept a value the label renderer / status check can't use.
from app.services.barcode_service import LABEL_SYMBOLOGIES, PRINTER_CONNECTIONS


class LabelConfigSchema(Schema):
    """The label template an admin can edit from Settings. All fields
    optional on update — only what is sent is changed, the rest keeps its
    current value (merged over the defaults in BarcodeService).

    Symbology: QR (default), CODE128 or CODE39. EAN13 is no longer offered — it
    is numeric-only and cannot carry an alphanumeric Part No."""
    width_mm = fields.Integer(validate=validate.Range(min=20, max=300))
    height_mm = fields.Integer(validate=validate.Range(min=10, max=300))
    symbology = fields.String(validate=validate.OneOf(list(LABEL_SYMBOLOGIES)))
    show_part_no = fields.Boolean()
    show_description = fields.Boolean()
    show_location = fields.Boolean()
    description_max_chars = fields.Integer(validate=validate.Range(min=8, max=120))


# RFC 1123 host name: dot-separated labels of letters / digits / hyphens, each
# 1-63 long and not starting or ending with a hyphen.
_HOST_LABEL = r"(?!-)[A-Za-z0-9-]{1,63}(?<!-)"
_HOSTNAME = re.compile(rf"^{_HOST_LABEL}(\.{_HOST_LABEL})*$")


def _ip_or_hostname(value):
    """A printer address is an IP or a host name — never a URL, a path or
    host:port (the port has its own field). Blank means "not set"; whether a
    NETWORK printer then lacks one is checked after the merge (SettingsService)."""
    host = (value or "").strip()
    if not host:
        return
    try:
        ipaddress.ip_address(host)
        return
    except ValueError:
        pass
    # All digits and dots is an attempted IPv4 (e.g. 10.0.0.300), not a name.
    if re.fullmatch(r"[\d.]+", host) or len(host) > 253 or not _HOSTNAME.match(host):
        raise ValidationError("Enter the printer's IP address (e.g. 10.20.30.40) or host name")


class LabelPrinterSchema(Schema):
    """The store label printer (Settings). BROWSER = the browser print dialog,
    whose printer state can't be read; NETWORK = a printer the server can reach
    at host:port (9100 = raw printing), so its reachability can really be
    checked. Fields optional on update, merged over the saved value."""
    name = fields.String(validate=validate.Length(min=1, max=80))
    connection = fields.String(validate=validate.OneOf(list(PRINTER_CONNECTIONS)))
    host = fields.String(allow_none=True, validate=_ip_or_hostname)
    port = fields.Integer(validate=validate.Range(min=1, max=65535))


class SmtpConfigSchema(Schema):
    """The outgoing-mail server (Settings). Non-secret fields only — the password
    is never sent/stored here; when auth is required it stays in .env. All fields
    optional on save, merged over the saved value."""
    host = fields.String(validate=validate.Length(max=255))
    port = fields.Integer(validate=validate.Range(min=1, max=65535))
    from_email = fields.Email(allow_none=True)
    from_display = fields.String(allow_none=True, validate=validate.Length(max=120))
    use_tls = fields.Boolean()
    use_ssl = fields.Boolean()
    requires_auth = fields.Boolean()
    username = fields.String(allow_none=True, validate=validate.Length(max=255))


class SmtpTestSchema(Schema):
    to = fields.Email(required=True)
