"""Upload validation: extension allowlist + magic-byte sniffing + size caps.

Portal speakers push two kinds of file through the backend service-role client:
a headshot (image) and a task deliverable (slides / documents). Neither is
behind a JWT — the portal cookie is the only credential — so every byte is
treated as hostile:

  * the declared filename is advisory (an attacker picks it),
  * the browser-supplied content-type is advisory (an attacker picks it too),
  * the real check is the *leading magic bytes*, matched against the format the
    extension claims. A ``.png`` whose body is a PE executable is rejected, and
    so is a ``.svg`` (not on the allowlist) that could carry inline script.

Kept dependency-free on purpose: sniffing four container families by their
signatures is a dozen byte comparisons, not a reason to add python-magic and its
libmagic system dependency to the deploy image.
"""

from __future__ import annotations

import os

# Generous but finite. A headshot is a photo, not a raw; slides are a deck, not
# a video. Caps are the last line before a speaker fills the bucket by accident.
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_DOCUMENT_BYTES = 30 * 1024 * 1024

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp"})
DOCUMENT_EXTENSIONS = frozenset(
    {
        # slide decks / documents
        ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".key",
        # a headshot or diagram attached to a task is fine too
        ".png", ".jpg", ".jpeg", ".gif", ".webp",
        # plain-text deliverables (speaker notes, links, transcripts)
        ".txt", ".csv", ".md",
    }
)

_MIMETYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".key": "application/vnd.apple.keynote",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".md": "text/markdown",
}

# Format family -> the byte prefixes that identify it.
_MAGIC: dict[str, tuple[bytes, ...]] = {
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpeg": (b"\xff\xd8\xff",),
    "gif": (b"GIF87a", b"GIF89a"),
    "pdf": (b"%PDF-",),
    # OOXML (docx/pptx/xlsx) and Keynote are ZIP containers.
    "zip": (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"),
    # Legacy OLE compound files (doc/ppt/xls).
    "ole": (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",),
}

# ``webp`` and ``text`` are checked specially (see _sniff_ok), so they name no
# entry in _MAGIC.
_EXT_TO_FORMATS: dict[str, tuple[str, ...]] = {
    ".png": ("png",),
    ".jpg": ("jpeg",),
    ".jpeg": ("jpeg",),
    ".gif": ("gif",),
    ".webp": ("webp",),
    ".pdf": ("pdf",),
    ".docx": ("zip",),
    ".pptx": ("zip",),
    ".xlsx": ("zip",),
    ".key": ("zip",),
    ".doc": ("ole",),
    ".ppt": ("ole",),
    ".xls": ("ole",),
    ".txt": ("text",),
    ".csv": ("text",),
    ".md": ("text",),
}


class UploadValidationError(ValueError):
    """The upload is rejected. Routes translate this to a 400 with the message."""


def _sniff_ok(content: bytes, formats: tuple[str, ...]) -> bool:
    """True when ``content`` looks like any of the accepted ``formats``."""
    for fmt in formats:
        if fmt == "webp":
            # RIFF....WEBP — the size word between the two tags is skipped.
            if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
                return True
        elif fmt == "text":
            # No signature exists for plain text; a NUL byte in the head is the
            # cheap, reliable "this is actually binary" tell.
            if b"\x00" not in content[:8192]:
                return True
        else:
            for signature in _MAGIC.get(fmt, ()):
                if content.startswith(signature):
                    return True
    return False


def extension_of(filename: str | None) -> str:
    return os.path.splitext(filename or "")[1].lower()


def validate_upload(filename: str | None, content: bytes, *, category: str) -> tuple[str, str]:
    """Validate one upload and return ``(extension, mimetype)``.

    ``category`` is ``"image"`` (headshots) or ``"document"`` (task files).
    Raises :class:`UploadValidationError` — never returns — on any failure.
    """
    if category == "image":
        allowed, cap = IMAGE_EXTENSIONS, MAX_IMAGE_BYTES
    elif category == "document":
        allowed, cap = DOCUMENT_EXTENSIONS, MAX_DOCUMENT_BYTES
    else:  # a caller bug, not a bad upload
        raise UploadValidationError("Unknown upload category")

    if not content:
        raise UploadValidationError("The file is empty.")
    if len(content) > cap:
        raise UploadValidationError(f"That file is too large (max {cap // (1024 * 1024)} MB).")

    ext = extension_of(filename)
    if ext not in allowed:
        pretty = ext or "unknown"
        raise UploadValidationError(f"Files of type '{pretty}' aren't allowed here.")

    if not _sniff_ok(content, _EXT_TO_FORMATS.get(ext, ())):
        raise UploadValidationError("That file's contents don't match its extension.")

    return ext, _MIMETYPES.get(ext, "application/octet-stream")
