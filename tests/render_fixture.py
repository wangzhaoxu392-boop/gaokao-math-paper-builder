"""Render a deterministic synthetic paper for layout QA.

Usage:
    .venv\\Scripts\\python.exe tests\\render_fixture.py <empty-output-directory>
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from test_paperbank import TempSkill, make_item, paperbank, document_renderer


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: render_fixture.py <empty-output-directory>")
        return 2
    target = Path(sys.argv[1]).resolve()
    if target.exists() and any(target.iterdir()):
        print("target must be empty")
        return 2
    env = TempSkill()
    try:
        order = [
            ("S1", "single_choice", "L1"),
            ("S2", "single_choice", "L1"),
            ("S3", "single_choice", "L1"),
            ("S4", "single_choice", "L1"),
            ("S5", "single_choice", "L1"),
            ("S6", "single_choice", "L1"),
            ("M1", "multiple_choice", "L1"),
            ("M2", "multiple_choice", "L1"),
            ("F1", "fill_blank", "L1"),
            ("F2", "fill_blank", "L1"),
            ("Q1", "solution", "L1"),
            ("Q2", "solution", "L2"),
        ]
        items = [make_item(suffix, band, qtype) for suffix, qtype, band in order]
        item_file = env.root / "fixture-items.json"
        item_file.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        paperbank.import_items(item_file)
        request = {
            "delivery_type": "tutoring",
            "blueprint_id": "tutoring_75",
            "current_band": "L1",
            "target_band": "L2",
            "grade": "高三",
            "term": "一轮复习",
            "paper_type": "新高考模拟",
            "weak_topics": ["数列"],
            "question_count": 12,
            "type_counts": {
                "single_choice": 6,
                "multiple_choice": 2,
                "fill_blank": 2,
                "solution": 2,
            },
            "comprehensive": True,
            "allow_other_grades": False,
            "allow_adaptable": False,
            "seed": 20261029,
        }
        request_file = env.root / "fixture-request.json"
        selection_file = env.root / "fixture-selection.json"
        request_file.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        paperbank.make_plan(request_file, selection_file)
        rendered = env.root / "fixture-output"
        document_renderer.render_selection(selection_file, rendered)
        target.mkdir(parents=True, exist_ok=True)
        for source in rendered.iterdir():
            destination = target / source.name
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
        print(target)
        return 0
    finally:
        env.close()


if __name__ == "__main__":
    raise SystemExit(main())
