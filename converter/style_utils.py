from __future__ import annotations

import re
from dataclasses import dataclass
from openpyxl.cell.cell import Cell

# White / black / transparent RGBs that do not count as highlight colors
_NEUTRAL_FILL_RGBS = {"", "00000000", "FFFFFFFF", "FF000000"}
_NEUTRAL_FONT_RGBS = {"", "00000000", "FF000000", "FFFFFFFF"}

_PLUS_MARKER_RE = re.compile(
    r"(?:^\s*\+|^\s*(?:[A-Za-zА-Яа-яЁё]|\d{1,2})\s*[.)]\s*\+|\+\s*(?:1)?\s*$)"
)
_STAR_MARKER_RE = re.compile(
    r"(?:^\s*\*|^\s*(?:[A-Za-zА-Яа-яЁё]|\d{1,2})\s*[.)]\s*\*|\*\s*$)"
)


@dataclass
class CellSignals:
    has_fill: bool = False
    fill_key: str | None = None
    has_colored_font: bool = False
    font_key: str | None = None
    is_bold: bool = False
    has_plus: bool = False
    has_star: bool = False


def get_rgb_hex(color_obj) -> str | None:
    """Safely extract 8-char ARGB hex string only when color.type == 'rgb'."""
    if color_obj is None:
        return None
    if getattr(color_obj, "type", None) == "rgb":
        rgb = getattr(color_obj, "rgb", None)
        if isinstance(rgb, str):
            return rgb.upper()
    return None


def inspect_cell(cell: Cell, adjacent_marker_val: str | None = None) -> CellSignals:
    """Extract visual and textual correctness signals from an Excel cell."""
    signals = CellSignals()

    # 1. Fill highlight (e.g., yellow FFFFFF00, green, etc.)
    if cell.fill and cell.fill.fill_type and cell.fill.fill_type != "none":
        fg = cell.fill.fgColor
        rgb = get_rgb_hex(fg)
        if rgb and rgb not in _NEUTRAL_FILL_RGBS:
            signals.has_fill = True
            signals.fill_key = f"rgb:{rgb}"
        elif getattr(fg, "type", None) == "theme" and fg.theme not in (None, 0):
            # Theme 0 is typically background/white; non-zero theme fills can be highlights
            signals.has_fill = True
            signals.fill_key = f"theme:{fg.theme}"

    # 2. Font color & bold
    if cell.font:
        signals.is_bold = bool(cell.font.bold)
        fc = cell.font.color
        rgb = get_rgb_hex(fc)
        if rgb and rgb not in _NEUTRAL_FONT_RGBS:
            signals.has_colored_font = True
            signals.font_key = f"rgb:{rgb}"

    # 3. Text markers (+, *)
    raw = str(cell.value or "").replace("\xa0", " ").strip()
    if raw:
        if _PLUS_MARKER_RE.search(raw):
            signals.has_plus = True
        if _STAR_MARKER_RE.search(raw):
            signals.has_star = True

    if adjacent_marker_val is not None:
        adj = str(adjacent_marker_val).replace("\xa0", " ").strip()
        if adj == "+" or adj.startswith("+"):
            signals.has_plus = True

    return signals
