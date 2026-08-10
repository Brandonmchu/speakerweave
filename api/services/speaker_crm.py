"""Pure helpers for the organizer speaker CRM.

The DB work (org-scoped reads and writes) stays in ``routes/admin_routes.py``,
where the service-role client is already installed and test-patched. What lives
here is the part worth testing on its own: turning a pasted/uploaded CSV into
clean, de-duplicated rows, and deciding — from data alone — what counts as a
valid row, a bad row, or a duplicate. No Supabase import on purpose, so this
module is a plain function library with no I/O to stub.
"""

from __future__ import annotations

import csv
import io
import re

# The columns an organizer's export/import speaks. Aliases fold onto these so a
# spreadsheet exported from anywhere still lands in the right place.
CANONICAL_COLUMNS = ("first_name", "last_name", "email", "company", "title", "bio", "notes")

# A whole-name column ("name", "Full Name", "Speaker") is NOT canonical: it is
# split into first/last at parse time, so the row shape downstream never has to
# know the sheet had one column where ours has two.
NAME_COLUMN = "name"

# Per-field length caps, mirroring the structured-row Pydantic model so a CSV
# cannot smuggle in an oversized value that the `rows` path would reject.
MAX_LENGTHS: dict[str, int] = {
    "first_name": 200,
    "last_name": 200,
    "email": 320,
    "company": 300,
    "title": 300,
    "bio": 5_000,
    "notes": 2_000,
}

# A generous per-cell ceiling. Python's csv module raises csv.Error the moment a
# single field exceeds field_size_limit (131_072 bytes by default) — which, left
# alone, would abort the WHOLE import on one fat cell. We lift the limit so the
# reader parses such a cell instead, then the length caps above turn an oversized
# value into a row-level error. Anything past even this ceiling is caught per-row.
_CSV_FIELD_CEILING = 1_000_000


def _ensure_field_limit() -> None:
    """Raise the process-wide csv field-size limit to a safe bound (idempotent)."""
    try:
        if csv.field_size_limit() < _CSV_FIELD_CEILING:
            csv.field_size_limit(_CSV_FIELD_CEILING)
    except (OverflowError, ValueError):  # pragma: no cover - platform dependent
        pass


_ensure_field_limit()

# Header keys below are in NORMALIZED form (see `_header_key`): lower-cased,
# with underscores/hyphens/dots folded to single spaces. So one entry covers
# "First Name", "first_name", "FIRST-NAME" and "  first name  " at once.
_HEADER_ALIASES: dict[str, str] = {
    # whole-name columns — split into first/last at parse time
    "name": NAME_COLUMN,
    "full name": NAME_COLUMN,
    "fullname": NAME_COLUMN,
    "display name": NAME_COLUMN,
    "speaker": NAME_COLUMN,
    "speaker name": NAME_COLUMN,
    "contact name": NAME_COLUMN,
    "person": NAME_COLUMN,
    # given / family name
    "first name": "first_name",
    "firstname": "first_name",
    "first": "first_name",
    "given name": "first_name",
    "forename": "first_name",
    "last name": "last_name",
    "lastname": "last_name",
    "last": "last_name",
    "surname": "last_name",
    "family name": "last_name",
    # email — the one column an import cannot do without
    "email": "email",
    "e mail": "email",
    "email address": "email",
    "emailaddress": "email",
    "work email": "email",
    "contact email": "email",
    "mail": "email",
    # company
    "company": "company",
    "company name": "company",
    "organization": "company",
    "organisation": "company",
    "org": "company",
    "employer": "company",
    "affiliation": "company",
    # job title
    "title": "title",
    "job title": "title",
    "jobtitle": "title",
    "role": "title",
    "position": "title",
    # biography → contacts.about
    "bio": "bio",
    "biography": "bio",
    "about": "bio",
    "speaker bio": "bio",
    "short bio": "bio",
    "profile": "bio",
    # free-form organizer notes → contacts.logistics_notes
    "notes": "notes",
    "note": "notes",
    "internal notes": "notes",
    "logistics": "notes",
    "logistics notes": "notes",
    "travel notes": "notes",
}

# Separators a spreadsheet might use inside a header word.
_HEADER_SEPARATORS = re.compile(r"[\s_\-.]+")


def _header_key(cell: object) -> str:
    """A header cell folded to its lookup form: no BOM, no quotes, one space.

    "First_Name" / "FIRST NAME" / "first-name" all land on "first name", so the
    alias table needs one entry per concept instead of one per spelling.
    """
    text = _clean(cell).lstrip("\ufeff").strip().strip('"').strip("'").lower()
    return _HEADER_SEPARATORS.sub(" ", text).strip()


def split_full_name(value: str) -> tuple[str, str]:
    """Split a whole-name cell into ``(first, last)``.

    Two shapes are understood, because those are the two spreadsheets people
    actually have: ``"Priya Raman"`` splits on the LAST space (so multi-word
    given names stay intact), and ``"Raman, Priya"`` splits on the comma. A
    single word is a first name with no surname — never a dropped value.
    """
    text = (value or "").strip()
    if not text:
        return "", ""
    if "," in text:
        last, _, first = text.partition(",")
        last, first = last.strip(), first.strip()
        if last and first:
            return first, last
        return (first or last), ""
    parts = text.split()
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def looks_like_email(value: str) -> bool:
    """The same forgiving check the manual-submission route uses.

    Not RFC-complete on purpose: it rejects the mistakes people actually make in
    a spreadsheet (blank, no ``@``, a trailing ``@``) without bouncing valid but
    unusual addresses a stricter regex would.
    """
    value = (value or "").strip()
    if "@" not in value or value.startswith("@") or value.endswith("@"):
        return False
    local, _, domain = value.partition("@")
    return bool(local) and "." in domain and not domain.endswith(".")


def normalize_email(value: str) -> str:
    """Lower-cased and trimmed — the shape stored so ``(event_id, email)`` is one key."""
    return (value or "").strip().lower()


def full_name(first: str | None, last: str | None, email: str | None) -> str:
    """A human label, falling back to the email so a nameless row still reads."""
    name = " ".join(part.strip() for part in (first or "", last or "") if part.strip())
    return name or (email or "").strip() or "Speaker"


def _clean(value: object) -> str:
    return str(value).strip() if value is not None else ""


def parse_speaker_csv(text: str) -> tuple[list[dict], str | None, list[dict], list[str]]:
    """Parse pasted/uploaded CSV into normalized row dicts.

    Returns ``(rows, header_error, parse_errors, ignored_columns)``. Each row
    carries the canonical fields plus a 1-based ``line`` (counting the header)
    for error reporting.

    Three header outcomes, and only one of them is silent:

    * **Recognized** columns map onto the canonical fields. A whole-name column
      ("name", "Full Name") is split into first/last, so a sheet with one name
      column keeps its names instead of falling back to the email address.
    * **Unrecognized** columns are ignored — but never silently: their original
      headings come back in ``ignored_columns`` so the UI can say exactly what
      it dropped. A partly-understood file must not read as a clean success.
    * **No email column** is a header-level error. It dooms every row, so it is
      reported once, as a hard failure, rather than as N bad rows or (worse) an
      import that "succeeds" with nothing usable in it.

    Resilience is the point of ``parse_errors``: a single malformed record (a
    stray NUL, a cell past the ceiling) raises ``csv.Error`` for that row only.
    It is caught, recorded, and parsing continues — one bad row never aborts the
    batch, and nothing bubbles up as a 500.
    """
    _ensure_field_limit()
    text = (text or "").strip()
    if not text:
        return [], "The file is empty.", [], []

    reader = csv.reader(io.StringIO(text))
    try:
        raw_header = next(reader)
    except StopIteration:
        return [], "The file is empty.", [], []
    except csv.Error as exc:
        return [], f"Could not read the CSV header ({exc}).", [], []

    mapping: dict[int, str] = {}
    ignored_columns: list[str] = []
    for index, cell in enumerate(raw_header):
        label = _clean(cell).lstrip("\ufeff").strip()
        key = _HEADER_ALIASES.get(_header_key(cell))
        if key and key not in mapping.values():
            mapping[index] = key
        elif label:
            # Unknown, or a second column claiming a slot already taken.
            ignored_columns.append(label)

    if "email" not in mapping.values():
        found = ", ".join(_clean(cell) for cell in raw_header if _clean(cell)) or "none"
        detail = (
            "No 'email' column found — every speaker row needs an email address to "
            f"import. Columns read: {found}. Use a header named 'email' (or 'e-mail', "
            "'email address'), plus 'name' (or 'first_name' and 'last_name'), "
            "'company', 'title', 'bio'."
        )
        return [], detail, [], ignored_columns

    rows: list[dict] = []
    parse_errors: list[dict] = []
    while True:
        try:
            raw_row = next(reader)
        except StopIteration:
            break
        except csv.Error as exc:
            # `reader.line_num` is the physical line the reader choked on.
            parse_errors.append(
                {"line": reader.line_num, "email": "", "message": f"Could not parse this row ({exc})."}
            )
            continue
        if not any(_clean(cell) for cell in raw_row):
            continue  # a blank spacer line is not a bad row
        row = {column: "" for column in CANONICAL_COLUMNS}
        whole_name = ""
        for index, key in mapping.items():
            if index >= len(raw_row):
                continue
            value = _clean(raw_row[index])
            if key == NAME_COLUMN:
                whole_name = value
            else:
                row[key] = value
        # A whole-name column only fills what explicit first/last columns left
        # empty, so "name" and "first_name" in the same sheet never fight.
        if whole_name and not row["first_name"] and not row["last_name"]:
            row["first_name"], row["last_name"] = split_full_name(whole_name)
        row["line"] = reader.line_num
        rows.append(row)
    return rows, None, parse_errors, ignored_columns


def collect_import(rows: list[dict]) -> tuple[list[dict], list[dict], int]:
    """Validate + de-duplicate parsed rows, from data alone (no DB).

    Returns ``(valid, errors, duplicate_skips)``:

    * ``valid``   — one clean row per distinct email, first occurrence winning,
      email normalized. Ready for the route to upsert.
    * ``errors``  — ``{line, email, message}`` for each row with a bad/missing
      email. One bad row never aborts the rest.
    * ``duplicate_skips`` — rows dropped because their email repeated earlier in
      the same file.
    """
    valid: list[dict] = []
    errors: list[dict] = []
    duplicate_skips = 0
    seen: set[str] = set()

    for row in rows:
        line = row.get("line")
        raw_email = _clean(row.get("email"))
        # A truncated echo — the offending value may itself be enormous.
        email_preview = raw_email[: MAX_LENGTHS["email"]]

        # Same length caps the structured `rows` path enforces via Pydantic, so a
        # CSV cannot smuggle an oversized value past validation. An over-limit row
        # is recorded and dropped, never a reason to abort the good rows.
        oversize = [
            column for column in CANONICAL_COLUMNS if len(_clean(row.get(column))) > MAX_LENGTHS[column]
        ]
        if oversize:
            errors.append(
                {
                    "line": line,
                    "email": email_preview,
                    "message": f"Value too long in column(s): {', '.join(oversize)}.",
                }
            )
            continue

        if not looks_like_email(raw_email):
            errors.append(
                {
                    "line": line,
                    "email": email_preview,
                    "message": "Missing or invalid email address.",
                }
            )
            continue
        email = normalize_email(raw_email)
        if email in seen:
            duplicate_skips += 1
            continue
        seen.add(email)
        valid.append(
            {
                "email": email,
                "first_name": _clean(row.get("first_name")),
                "last_name": _clean(row.get("last_name")),
                "company": _clean(row.get("company")),
                "title": _clean(row.get("title")),
                "bio": _clean(row.get("bio")),
                "notes": _clean(row.get("notes")),
                "line": line,
            }
        )
    return valid, errors, duplicate_skips


def contact_patch(row: dict, existing: dict) -> dict:
    """Fields to write onto an existing contact for an import row.

    A CSV import is an authoritative bulk update: a provided, non-empty value
    overwrites when it differs. An empty cell never blanks a richer stored value
    — importing a name-only sheet must not wipe everyone's company.
    """
    patch: dict = {}
    field_map = {
        "first_name": "first_name",
        "last_name": "last_name",
        "company": "company_name",
        "title": "title",
        "bio": "about",
        "notes": "logistics_notes",
    }
    for row_key, column in field_map.items():
        value = _clean(row.get(row_key))
        if value and value != _clean(existing.get(column)):
            patch[column] = value
    return patch


def contact_insert(org_id: str, event_id: str, row: dict) -> dict:
    """A brand-new contact record for an import row.

    ``about``/``logistics_notes`` are added only when the CSV actually carried
    them, so an import never writes a column a pre-migration database may not
    have yet — and never inserts an explicit null where "unset" is meant.
    """
    record = {
        "org_id": org_id,
        "event_id": event_id,
        "email": row["email"],
        "first_name": _clean(row.get("first_name")),
        "last_name": _clean(row.get("last_name")),
        "company_name": _clean(row.get("company")) or None,
        "title": _clean(row.get("title")) or None,
    }
    if _clean(row.get("bio")):
        record["about"] = _clean(row.get("bio"))
    if _clean(row.get("notes")):
        record["logistics_notes"] = _clean(row.get("notes"))
    return record
