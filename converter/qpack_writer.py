from __future__ import annotations

import json
import zipfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .models import Category, PackageManifest, Question
from .text_utils import make_slug


def build_manifest(
    title: str,
    categories: list[Category],
    questions: list[Question],
    package_id: str | None = None,
) -> PackageManifest:
    """Create a PackageManifest matching qpack.md schema v1.0."""
    return PackageManifest(
        format_version="1.0",
        package_id=package_id or make_slug(title, fallback="test_package"),
        title=title,
        created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        categories=categories,
        questions=questions,
    )


def write_qpack(
    output_path: str | Path,
    manifest: PackageManifest,
    image_files: dict[str, bytes],
) -> Path:
    """Package manifest.json and images/ into a .qpack ZIP archive."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    manifest_json = json.dumps(asdict(manifest), ensure_ascii=False, indent=2)

    with zipfile.ZipFile(out, mode="w") as zf:
        zf.writestr("manifest.json", manifest_json.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
        for rel_path, data in image_files.items():
            # qpack.md: store images without compression for fast mobile decoding
            zf.writestr(rel_path, data, compress_type=zipfile.ZIP_STORED)

    return out
