from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .excel_parser import parse_workbook
from .qpack_writer import build_manifest, write_qpack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert an .xlsx test bank into a .qpack package."
    )
    parser.add_argument("input", help="Path to source .xlsx file")
    parser.add_argument("-o", "--output", help="Output .qpack file path")
    parser.add_argument("--title", help="Human-readable package title")
    parser.add_argument("--package-id", help="Stable package_id (auto-slugged from title if omitted)")
    parser.add_argument("--show-warnings", action="store_true", help="Print per-question warnings")
    args = parser.parse_args(argv)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: file not found: {input_path}", file=sys.stderr)
        return 1

    output_path = Path(args.output) if args.output else input_path.with_suffix(".qpack")
    title = args.title or input_path.stem

    categories, questions, image_files, reports = parse_workbook(str(input_path))
    manifest = build_manifest(
        title=title,
        categories=categories,
        questions=questions,
        package_id=args.package_id,
    )
    out = write_qpack(output_path, manifest, image_files)

    print(f"Created: {out} ({out.stat().st_size:,} bytes)")
    print(f"Package ID: {manifest.package_id} | Total questions: {len(questions)} | Images: {len(image_files)}")
    print("-" * 78)
    for rep in reports:
        warn_count = len(rep.no_correct_warnings)
        print(
            f"[{rep.category_id}] {rep.sheet_name}: {rep.question_count} q "
            f"(single={rep.single_choice_count}, multi={rep.multiple_choice_count}, "
            f"flash={rep.flashcard_count}, imgs={rep.images_count}, warnings={warn_count})"
        )
        if args.show_warnings and rep.no_correct_warnings:
            for w in rep.no_correct_warnings[:10]:
                print(f"    ! {w}")
            if warn_count > 10:
                print(f"    ... and {warn_count - 10} more")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
