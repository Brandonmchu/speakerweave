"""Upload validation — the byte-level gate on portal uploads.

The declared filename and content-type are attacker-controlled, so the contract
under test is: the extension must be on the allowlist AND the leading bytes must
match the format that extension claims, all under a size cap.
"""

from __future__ import annotations

import pytest

from security.upload_validation import (
    MAX_IMAGE_BYTES,
    UploadValidationError,
    validate_upload,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
PDF = b"%PDF-1.7\n" + b"body"
DOCX = b"PK\x03\x04" + b"\x00" * 16  # OOXML is a zip container


def test_accepts_a_png_headshot():
    assert validate_upload("me.png", PNG, category="image") == (".png", "image/png")


def test_accepts_a_jpeg_headshot():
    ext, mime = validate_upload("me.JPG", JPEG, category="image")
    assert (ext, mime) == (".jpg", "image/jpeg")


def test_accepts_pdf_and_docx_documents():
    assert validate_upload("deck.pdf", PDF, category="document")[0] == ".pdf"
    assert validate_upload("agreement.docx", DOCX, category="document")[0] == ".docx"


def test_rejects_extension_off_the_allowlist():
    with pytest.raises(UploadValidationError):
        validate_upload("logo.svg", b"<svg/>", category="image")


def test_rejects_a_content_type_mismatch():
    # .png extension, but the bytes are a PDF — sniffing catches the lie.
    with pytest.raises(UploadValidationError):
        validate_upload("sneaky.png", PDF, category="image")


def test_rejects_a_pdf_where_an_image_is_expected():
    with pytest.raises(UploadValidationError):
        validate_upload("deck.pdf", PDF, category="image")


def test_rejects_empty_and_oversized():
    with pytest.raises(UploadValidationError):
        validate_upload("me.png", b"", category="image")
    with pytest.raises(UploadValidationError):
        validate_upload("me.png", PNG[:8] + b"\x00" * (MAX_IMAGE_BYTES + 1), category="image")
