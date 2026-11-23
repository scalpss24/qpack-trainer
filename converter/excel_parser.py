from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Any

import openpyxl
from openpyxl.worksheet.worksheet import Worksheet

from .models import Category, Option, Question, SheetReport
from .style_utils import CellSignals, inspect_cell
from .text_utils import (
    clean_option_text,
    clean_question_text,
    has_leading_question_number,
    make_question_id,
    normalize_whitespace,
)

_HEADER_SKIP_PATTERNS = re.compile(
    r"^(?:тест(?:\s+нцнэ)?|п/н|id|№|вопросы(?:\s+на\s+русском\s+языке)?|"
    r"эти\s+вопросы\s+точно\s+будут.*)$",
    re.IGNORECASE,
)

# Strictly option-like prefixes that shouldn't be mistaken for a bold question
_STRICT_OPT_PREFIX_RE = re.compile(
    r"^(?:[+*]\s*|[A-Za-zА-Яа-яЁё]\s*[.)]|\d{1,2}\s*\))"
)


@dataclass
class _RawRow:
    row_idx: int
    id_val: str | None
    text: str
    signals: CellSignals


@dataclass
class _ExtractedImage:
    row_idx: int  # 1-based row
    ext: str
    data: bytes
    filename: str = ""


def _extract_sheet_images(ws: Worksheet, cat_id: str) -> list[_ExtractedImage]:
    """Extract embedded images from a worksheet with their 1-based anchor row."""
    images: list[_ExtractedImage] = []
    raw_images = getattr(ws, "_images", []) or []
    for idx, img in enumerate(raw_images, start=1):
        anchor = getattr(img, "anchor", None)
        row_idx = 1
        if hasattr(anchor, "_from") and anchor._from is not None:
            row_idx = int(anchor._from.row) + 1
        elif hasattr(anchor, "row"):
            row_idx = int(anchor.row) + 1

        ext = (getattr(img, "format", None) or "png").lower()
        if ext == "jpeg":
            ext = "jpg"

        data_bytes: bytes | None = None
        if hasattr(img, "_data") and callable(img._data):
            data_bytes = img._data()
        elif hasattr(img, "ref") and isinstance(img.ref, io.BytesIO):
            data_bytes = img.ref.getvalue()

        if data_bytes:
            images.append(
                _ExtractedImage(
                    row_idx=row_idx,
                    ext=ext,
                    data=data_bytes,
                    filename=f"images/{cat_id}_img{idx}.{ext}",
                )
            )
    return images


def _detect_columns(ws: Worksheet) -> tuple[int | None, int]:
    """Return (id_col, text_col) 1-based indices for vertical sheets."""
    c1_non_empty = 0
    c2_non_empty = 0
    c1_short_num = 0
    limit = min(ws.max_row, 80)
    for r in range(1, limit + 1):
        v1 = ws.cell(r, 1).value
        v2 = ws.cell(r, 2).value if ws.max_column >= 2 else None
        if v1 is not None and str(v1).strip():
            c1_non_empty += 1
            s1 = str(v1).strip()
            if s1.isdigit() or s1 in ("+", "п/н", "ID", "№"):
                c1_short_num += 1
        if v2 is not None and str(v2).strip():
            c2_non_empty += 1

    if c2_non_empty > 0 and (c1_non_empty == 0 or c1_short_num >= max(1, c1_non_empty // 3)):
        id_col = 1 if c1_non_empty > 0 else None
        return id_col, 2
    return None, 1


def _is_horizontal_table(ws: Worksheet) -> bool:
    """Detect if row 1 is a horizontal table header (№ | Вопросы | Вариант 1 | ...)."""
    if ws.max_column < 3:
        return False
    headers = [str(ws.cell(1, c).value or "").strip().lower() for c in range(1, min(ws.max_column + 1, 12))]
    has_q = any("вопрос" in h for h in headers)
    has_var = any("вариант" in h or "ответ" in h for h in headers)
    return has_q and has_var


def _resolve_correct_indices(options_signals: list[CellSignals]) -> list[int]:
    """Determine which option indices are marked correct using priority signals."""
    n = len(options_signals)
    if n == 0:
        return []

    # 1. Cell fill highlight
    filled = [i for i, s in enumerate(options_signals) if s.has_fill]
    if filled:
        return filled

    # 2. Explicit '+' marker
    plused = [i for i, s in enumerate(options_signals) if s.has_plus]
    if plused:
        return plused

    # 3. '*' marker (only if NOT used as a bullet on every option)
    starred = [i for i, s in enumerate(options_signals) if s.has_star]
    if 0 < len(starred) < n:
        return starred

    # 4. Colored font (e.g. red text)
    colored = [i for i, s in enumerate(options_signals) if s.has_colored_font]
    if 0 < len(colored) < n:
        return colored

    # 5. Bold font on option(s)
    bolded = [i for i, s in enumerate(options_signals) if s.is_bold]
    if 0 < len(bolded) < n:
        return bolded

    return []


def _parse_horizontal_sheet(
    ws: Worksheet, cat_id: str
) -> tuple[list[tuple[int, Question]], list[str]]:
    headers = [str(ws.cell(1, c).value or "").strip().lower() for c in range(1, ws.max_column + 1)]
    q_col = next((i + 1 for i, h in enumerate(headers) if "вопрос" in h), 2)
    opt_cols = [i + 1 for i, h in enumerate(headers) if "вариант" in h or "ответ" in h]
    is_flashcard_sheet = len(opt_cols) == 1 and "ответ" in headers[opt_cols[0] - 1]

    results: list[tuple[int, Question]] = []
    warnings: list[str] = []

    for r in range(2, ws.max_row + 1):
        q_val = ws.cell(r, q_col).value
        if q_val is None or not str(q_val).strip():
            continue
        q_text = clean_question_text(str(q_val))
        if not q_text:
            continue

        if is_flashcard_sheet:
            ans_val = ws.cell(r, opt_cols[0]).value
            ans_text = normalize_whitespace(str(ans_val or ""))
            q = Question(
                id=make_question_id(q_text),
                category_id=cat_id,
                type="flashcard",
                text=q_text,
                options=[Option(id="opt_1", text=ans_text, is_correct=True)] if ans_text else [],
            )
            results.append((r, q))
            continue

        opts_raw: list[tuple[str, CellSignals]] = []
        for c in opt_cols:
            cell = ws.cell(r, c)
            if cell.value is not None and str(cell.value).strip():
                opts_raw.append((clean_option_text(str(cell.value)), inspect_cell(cell)))

        correct_idxs = set(_resolve_correct_indices([s for _, s in opts_raw]))
        if not correct_idxs:
            warnings.append(f"Row {r}: no correct answer detected for '{q_text[:50]}...'")

        options = [
            Option(id=f"opt_{i + 1}", text=txt, is_correct=(i in correct_idxs))
            for i, (txt, _) in enumerate(opts_raw)
        ]
        q_type = "multiple_choice" if len(correct_idxs) > 1 else "single_choice"
        results.append(
            (
                r,
                Question(
                    id=make_question_id(q_text),
                    category_id=cat_id,
                    type=q_type,
                    text=q_text,
                    options=options,
                ),
            )
        )
    return results, warnings


def _is_question_start(
    row: _RawRow,
    current_q: _RawRow | None,
    current_opts: list[_RawRow],
    saw_blank: bool,
) -> bool:
    """Decide whether `row` starts a new question block."""
    if current_q is None:
        return True

    # Explicit numeric ID in ID column (e.g. '1', '2', '3')
    if row.id_val is not None and row.id_val.isdigit():
        return True

    # If text starts with an obvious option marker like 'A)', '1)', '*', '+'
    # it's an option, not a question (even if bold!).
    if _STRICT_OPT_PREFIX_RE.match(row.text):
        return False

    # Bold text after a blank row or after collecting at least 1 option
    if row.signals.is_bold and (saw_blank or len(current_opts) >= 1):
        # Guard against a bold correct option using "1. ..." when no blank row intervened
        if saw_blank or has_leading_question_number(row.text) and len(current_opts) >= 2:
            return True
        if not re.match(r"^\d+\s*[.)]", row.text):
            return True

    # Fallback: unbolded numbered question after a blank row or >= 2 options
    if saw_blank and has_leading_question_number(row.text) and len(current_opts) >= 2:
        return True

    return False


def _finalize_vertical_block(
    q_row: _RawRow,
    opt_rows: list[_RawRow],
    cat_id: str,
    is_flashcard_mode: bool,
) -> tuple[int, Question, str | None]:
    q_text = clean_question_text(q_row.text)
    qid = make_question_id(q_text)

    if is_flashcard_mode or len(opt_rows) == 1:
        ans_text = normalize_whitespace(opt_rows[0].text) if opt_rows else ""
        q = Question(
            id=qid,
            category_id=cat_id,
            type="flashcard",
            text=q_text,
            options=[Option(id="opt_1", text=ans_text, is_correct=True)] if ans_text else [],
        )
        return q_row.row_idx, q, None

    correct_idxs = set(_resolve_correct_indices([o.signals for o in opt_rows]))
    warning = None
    if not correct_idxs:
        warning = f"Row {q_row.row_idx}: no correct answer detected for '{q_text[:50]}...'"

    options = [
        Option(
            id=f"opt_{i + 1}",
            text=clean_option_text(o.text),
            is_correct=(i in correct_idxs),
        )
        for i, o in enumerate(opt_rows)
    ]
    q_type = "multiple_choice" if len(correct_idxs) > 1 else "single_choice"
    q = Question(
        id=qid,
        category_id=cat_id,
        type=q_type,
        text=q_text,
        options=options,
    )
    return q_row.row_idx, q, warning


def _parse_vertical_sheet(
    ws: Worksheet, cat_id: str, sheet_name: str
) -> tuple[list[tuple[int, Question]], list[str]]:
    id_col, text_col = _detect_columns(ws)
    is_flashcard_sheet = "62 вопр" in sheet_name.lower()

    blocks: list[tuple[_RawRow, list[_RawRow]]] = []
    current_q: _RawRow | None = None
    current_opts: list[_RawRow] = []
    saw_blank = False

    for r in range(1, ws.max_row + 1):
        cell = ws.cell(r, text_col)
        raw_val = cell.value
        id_raw = ws.cell(r, id_col).value if id_col is not None else None
        id_str = str(id_raw).replace("\xa0", " ").strip() if id_raw is not None else None
        if id_str == "":
            id_str = None

        text_str = normalize_whitespace(str(raw_val)) if raw_val is not None else ""
        if not text_str:
            saw_blank = True
            continue

        if r <= 2 and _HEADER_SKIP_PATTERNS.match(text_str):
            continue

        signals = inspect_cell(cell, adjacent_marker_val=id_str if id_str == "+" else None)
        row = _RawRow(row_idx=r, id_val=id_str, text=text_str, signals=signals)

        if _is_question_start(row, current_q, current_opts, saw_blank):
            if current_q is not None and current_opts:
                blocks.append((current_q, current_opts))
            current_q = row
            current_opts = []
        else:
            if current_q is not None:
                current_opts.append(row)
        saw_blank = False

    if current_q is not None and current_opts:
        blocks.append((current_q, current_opts))

    results: list[tuple[int, Question]] = []
    warnings: list[str] = []
    for q_row, opt_rows in blocks:
        row_idx, q, warn = _finalize_vertical_block(q_row, opt_rows, cat_id, is_flashcard_sheet)
        results.append((row_idx, q))
        if warn:
            warnings.append(warn)

    return results, warnings


def parse_workbook(
    xlsx_path: str,
) -> tuple[list[Category], list[Question], dict[str, bytes], list[SheetReport]]:
    """Parse all sheets of an Excel workbook into categories, questions, images, and reports."""
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    categories: list[Category] = []
    all_questions: list[Question] = []
    image_files: dict[str, bytes] = {}
    reports: list[SheetReport] = []

    for idx, sheet_name in enumerate(wb.sheetnames, start=1):
        ws = wb[sheet_name]
        cat_id = f"cat_{idx:02d}"
        title = sheet_name.strip()

        if _is_horizontal_table(ws):
            q_rows, warnings = _parse_horizontal_sheet(ws, cat_id)
        else:
            q_rows, warnings = _parse_vertical_sheet(ws, cat_id, sheet_name)

        # Attach embedded images to the nearest preceding (or enclosing) question
        extracted_imgs = _extract_sheet_images(ws, cat_id)
        if extracted_imgs and q_rows:
            for img in extracted_imgs:
                image_files[img.filename] = img.data
                # Find last question whose start row <= img.row_idx
                target_q = q_rows[0][1]
                for q_start_row, q_obj in q_rows:
                    if q_start_row <= img.row_idx:
                        target_q = q_obj
                    else:
                        break
                target_q.images.append(img.filename)

        questions = [q for _, q in q_rows]
        categories.append(Category(id=cat_id, title=title, question_count=len(questions)))
        all_questions.extend(questions)

        reports.append(
            SheetReport(
                sheet_name=title,
                category_id=cat_id,
                question_count=len(questions),
                single_choice_count=sum(1 for q in questions if q.type == "single_choice"),
                multiple_choice_count=sum(1 for q in questions if q.type == "multiple_choice"),
                flashcard_count=sum(1 for q in questions if q.type == "flashcard"),
                images_count=len(extracted_imgs),
                no_correct_warnings=warnings,
            )
        )

    return categories, all_questions, image_files, reports
