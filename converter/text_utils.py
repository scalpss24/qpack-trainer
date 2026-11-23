from __future__ import annotations

import hashlib
import re

# Matches leading question numbers like "1.", "12)", "4 .", "258."
_LEADING_Q_NUM_RE = re.compile(r"^\s*\d+\s*[.)]\s*")

# Matches leading option markers like "+1.", "1. +", "A)", "A)*", "А.", "*", "·"
_LEADING_OPT_RE = re.compile(
    r"^\s*(?:[+*·•]\s*)?(?:[A-Za-zА-Яа-яЁё]|\d{1,2})\s*[.)]\s*(?:[+*]\s*)?|^\s*[+*·•]\s*"
)

# Matches trailing correctness markers like "+", "+1", "+ 1", ";+", "*+"
_TRAILING_MARKER_RE = re.compile(r"(?:\s*[;,]?\s*\+\s*(?:1)?\s*|\s*\*+\s*)$")

_MULTI_SPACE_RE = re.compile(r"[ \t]+")


def normalize_whitespace(text: str) -> str:
    """Collapse NBSP and repeated spaces, preserving meaningful newlines."""
    text = text.replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
    lines = [_MULTI_SPACE_RE.sub(" ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def make_question_id(text: str) -> str:
    """Deterministic 12-char hex ID from normalized question text."""
    norm = re.sub(r"\s+", " ", text.lower()).strip()
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]


def make_slug(text: str, fallback: str = "package") -> str:
    """Create an ASCII-safe identifier slug."""
    translit = {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
        "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
        "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    }
    lowered = text.lower()
    mapped = "".join(translit.get(ch, ch) for ch in lowered)
    slug = re.sub(r"[^a-z0-9]+", "_", mapped).strip("_")
    return slug or fallback


def clean_question_text(raw: str) -> str:
    """Remove leading numbering from a question and normalize whitespace."""
    text = normalize_whitespace(raw)
    text = _LEADING_Q_NUM_RE.sub("", text, count=1)
    return text.strip()


def clean_option_text(raw: str) -> str:
    """Remove option prefixes (A., 1), +2., *) and trailing markers (+, +1) from an option."""
    text = normalize_whitespace(raw)
    # Strip trailing + / +1 first (preserving trailing punctuation if before +)
    text = _TRAILING_MARKER_RE.sub("", text).strip()
    # Strip leading prefix (possibly twice if "+1. +" or "A)* ")
    prev = None
    while prev != text:
        prev = text
        text = _LEADING_OPT_RE.sub("", text, count=1).strip()
    # Strip trailing semicolon left over from lists like "наставник;+"
    if text.endswith(";"):
        text = text[:-1].strip()
    return text


def has_leading_question_number(raw: str) -> bool:
    """Return True if text starts with a question number like '1.' or '258.'."""
    return bool(_LEADING_Q_NUM_RE.match(raw.replace("\xa0", " ")))


def has_option_prefix(raw: str) -> bool:
    """Return True if text starts with a typical option prefix like 'A.', 'B)', '1)', '1.', '*'."""
    s = raw.replace("\xa0", " ").strip()
    return bool(
        re.match(r"^(?:\+\s*)?(?:[A-Za-zА-Яа-яЁё]\s*[.)]|\d{1,2}\s*[.)]|\*)", s)
    )
