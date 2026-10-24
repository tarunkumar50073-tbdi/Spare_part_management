"""A part's photo — one per part, asked for on the Part Master on 21 Oct 2026
("part ko select karen and uski pic click karne par wah pic add ho jaaye uske
saamne").

The photo is a FILE, never a database row: 5,000 parts with a photo each would
otherwise turn a 17 MB database into a gigabyte one and slow every backup. The
folder is PART_IMAGE_DIR, else "<database name>_part_images" beside the database
file (for the plant: C:/dx_store_data/dx_store_part_images). Named after the
database because the TEST copy (dx_store_TEST.db) sits in the same folder as
the plant's: it keeps dx_store_TEST_part_images, so a photo changed or removed
while testing never touches the plant's, and the test suite keeps its own. The nightly backup copies
the folder too (backup_service.mirror_part_images).

Whatever is uploaded is opened and saved again as a JPEG by Pillow — a file that
is not a picture is refused, the phone's EXIF (GPS and all) is dropped, the
picture is turned upright, and it is cut down to PHOTO_MAX px on its long side.
A small copy (THUMB_MAX px) is saved beside it for the list. A new photo gets a
new name (<part id>-<random>.jpg), so the URL carrying it is never served stale
from a browser's cache; the old files are removed once the new name is saved.
"""
import logging
import os
import secrets

from flask import current_app

from app.extensions import db
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

logger = logging.getLogger(__name__)

FOLDER_SUFFIX = "_part_images"
PHOTO_MAX = 1600
THUMB_MAX = 240
THUMB_SUFFIX = "_t"


def image_folder():
    """PART_IMAGE_DIR, else <database name>_part_images beside the database
    file; None when the database is not a file (an in-memory test database has
    nowhere to put one)."""
    configured = (current_app.config.get("PART_IMAGE_DIR") or "").strip()
    if configured:
        return os.path.normpath(os.path.abspath(configured))
    from app.services.backup_service import database_file
    path = database_file()
    if not path:
        return None
    stem = os.path.splitext(os.path.basename(path))[0]
    return os.path.join(os.path.dirname(path), stem + FOLDER_SUFFIX)


def _thumb_name(name):
    stem, ext = os.path.splitext(name)
    return f"{stem}{THUMB_SUFFIX}{ext}"


def _remove(folder, name):
    for n in (name, _thumb_name(name)):
        try:
            os.remove(os.path.join(folder, n))
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("part photo: could not remove %s", n, exc_info=True)


def _open_picture(stream):
    """The upload as an upright RGB picture, or BadRequestError."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        img = Image.open(stream)
        img.load()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise BadRequestError("That file is not a photo the app can read — use a JPG or PNG picture") from None
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        # A transparent PNG goes on white, not on black.
        base = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        base.paste(rgba, mask=rgba.split()[-1])
        img = base
    return img.convert("RGB")


class PartImageService:
    def _part(self, part_id):
        from app.models.part import Part
        part = db.session.get(Part, part_id)
        if part is None:
            raise NotFoundError(f"Part {part_id} not found")
        return part

    def path(self, part_id, thumb=False):
        """The file to send for a part's photo (or its small copy)."""
        part = self._part(part_id)
        folder = image_folder()
        if not part.image_file or not folder:
            raise NotFoundError(f"Part {part.part_no} has no photo")
        name = _thumb_name(part.image_file) if thumb else part.image_file
        full = os.path.join(folder, name)
        if thumb and not os.path.isfile(full):
            full = os.path.join(folder, part.image_file)       # no small copy: the photo itself
        if not os.path.isfile(full):
            raise NotFoundError(f"The photo of part {part.part_no} is missing from the photo folder")
        return full

    def save(self, part_id, stream, user=None):
        """Store a new photo for the part (replacing its old one). Returns the part."""
        part = self._part(part_id)
        folder = image_folder()
        if not folder:
            raise BadRequestError("This database is not a file — there is no folder to keep photos in")
        img = _open_picture(stream)
        os.makedirs(folder, exist_ok=True)
        name = f"{part.id}-{secrets.token_hex(4)}.jpg"
        photo, thumb = img.copy(), img.copy()
        photo.thumbnail((PHOTO_MAX, PHOTO_MAX))
        thumb.thumbnail((THUMB_MAX, THUMB_MAX))
        # Written under a temp name and renamed, so a half-written file is never served.
        for picture, final in ((photo, name), (thumb, _thumb_name(name))):
            partial = os.path.join(folder, final + ".partial")
            picture.save(partial, "JPEG", quality=84, optimize=True)
            os.replace(partial, os.path.join(folder, final))
        old = part.image_file
        try:
            with atomic():
                part.image_file = name
                self._audit(part, "photo replaced" if old else "photo added", user)
        except Exception:
            _remove(folder, name)
            raise
        if old:
            _remove(folder, old)
        return part

    def delete(self, part_id, user=None):
        part = self._part(part_id)
        old = part.image_file
        if not old:
            return part
        with atomic():
            part.image_file = None
            self._audit(part, "photo removed", user)
        folder = image_folder()
        if folder:
            _remove(folder, old)
        return part

    @staticmethod
    def forget(image_file):
        """Remove a deleted part's photo files (best effort)."""
        folder = image_folder()
        if image_file and folder:
            _remove(folder, image_file)

    @staticmethod
    def _audit(part, what, user):
        from app.services.audit_log_service import AuditLogService
        name = getattr(user, "username", None) or "system"
        AuditLogService().log(action="PART_UPDATED", entity_type="PART", entity_id=part.id,
                              user="STORE" if user is not None else "SYSTEM",
                              remarks=f"{part.part_no} by {name}: {what}"[:255])
