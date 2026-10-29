from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image


SKILL_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL_ROOT / "scripts"


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


paperbank = load_module("paperbank_test_module", "paperbank.py")
document_renderer = load_module("document_renderer_test_module", "document_renderer.py")


class TempSkill:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gm-paper-test-")
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "gui" / "config").mkdir(parents=True)
        (self.root / "assets" / "blueprints").mkdir(parents=True)
        shutil.copy2(SKILL_ROOT / "scripts" / "item.schema.json", self.root / "scripts" / "item.schema.json")
        shutil.copy2(
            SKILL_ROOT / "gui" / "config" / "models.json",
            self.root / "gui" / "config" / "models.json",
        )
        for source in (SKILL_ROOT / "assets" / "blueprints").glob("*.json"):
            shutil.copy2(source, self.root / "assets" / "blueprints" / source.name)
        self.configure()

    def configure(self):
        paperbank.ROOT = self.root
        paperbank.BANK = self.root / "bank"
        paperbank.SOURCES = paperbank.BANK / "sources"
        paperbank.PACKETS = paperbank.BANK / "packets"
        paperbank.ARCHIVES = paperbank.BANK / "archives"
        paperbank.ITEMS = paperbank.BANK / "items"
        paperbank.STAGING = paperbank.BANK / "staging"
        paperbank.BACKUPS = paperbank.BANK / "backups"
        paperbank.CACHE = paperbank.BANK / "cache"
        paperbank.REVIEW = paperbank.BANK / "review"
        paperbank.INDEX_CSV = paperbank.BANK / "index.csv"
        paperbank.INDEX_JSON = paperbank.BANK / "index.json"
        paperbank.BLUEPRINTS = self.root / "assets" / "blueprints"
        paperbank.SCHEMA_PATH = self.root / "scripts" / "item.schema.json"
        paperbank.MODELS_PATH = self.root / "gui" / "config" / "models.json"
        paperbank.OUTPUTS = self.root / "outputs"
        paperbank.BAND_DIR = {
            "L1": paperbank.ITEMS / "L1_30",
            "L2": paperbank.ITEMS / "L2_60",
            "L3": paperbank.ITEMS / "L3_90",
            "L4": paperbank.ITEMS / "L4_120",
            "L5": paperbank.ITEMS / "L5_120plus",
        }
        paperbank.ensure_directories()
        document_renderer.ROOT = self.root

    def close(self):
        paperbank.ROOT = SKILL_ROOT
        document_renderer.ROOT = SKILL_ROOT
        self.temp.cleanup()


def make_item(
    suffix: str,
    band: str,
    question_type: str,
    answer: str = "参考答案为唯一答案。",
) -> dict:
    options = ["选项甲", "选项乙", "选项丙", "选项丁"] if "choice" in question_type else []
    return {
        "id": f"TEST-{suffix}",
        "schema_version": 1,
        "packet_id": None,
        "question_no": suffix,
        "stem_markdown": f"测试数列题 {suffix}：已知 $a_n=n$，求第 $n$ 项。",
        "options": options,
        "figures": [],
        "topic_codes": ["数列"],
        "question_type": question_type,
        "score": 5,
        "estimated_minutes": 4,
        "grade": "高三",
        "term": "一轮复习",
        "paper_type": "新高考模拟",
        "scope": ["数列"],
        "curriculum_version": "new-gaokao-national",
        "new_gaokao_alignment": "aligned",
        "source_authority": "school_exam",
        "primary_band": band,
        "support_bands": [band],
        "difficulty_evidence": {"knowledge_span": 1, "transformation_depth": 1},
        "answer": answer,
        "solution": "由通项公式可得结果。",
        "rubric": ["写出通项公式"],
        "answer_provenance": "official",
        "answer_status": "matched",
        "answer_links": [],
        "validity_status": "valid",
        "review_status": "verified",
        "variant_family": f"family-{suffix}",
        "adaptation_of": [],
        "source_item_ids": [],
        "tags": [],
        "created_at": "2026-10-29T00:00:00+08:00",
        "updated_at": "2026-10-29T00:00:00+08:00",
    }


class PaperbankTests(unittest.TestCase):
    def setUp(self):
        self.env = TempSkill()

    def tearDown(self):
        self.env.close()

    def test_safe_zip_and_path_traversal(self):
        good = self.env.root / "good.zip"
        with zipfile.ZipFile(good, "w") as archive:
            archive.writestr("目录/试卷.txt", "2026 新高考 高三数学模拟试卷")
            archive.writestr("__MACOSX/ignored", "x")
        destination = self.env.root / "unpacked"
        result = paperbank.safe_extract_zip(good, destination)
        self.assertTrue((destination / "目录" / "试卷.txt").exists())
        self.assertEqual(len(result["extracted"]), 1)

        bad = self.env.root / "bad.zip"
        with zipfile.ZipFile(bad, "w") as archive:
            archive.writestr("../escape.txt", "bad")
        with self.assertRaises(paperbank.PaperbankError):
            paperbank.safe_extract_zip(bad, self.env.root / "bad-out")

    def test_source_deduplication_and_pairing(self):
        question = self.env.root / "2026高三数学模拟试卷.txt"
        answer = self.env.root / "2026高三数学模拟试卷参考答案.txt"
        question.write_text("2026 新高考 高三数学模拟试卷\n1. 数列题", encoding="utf-8")
        answer.write_text("参考答案\n1. A", encoding="utf-8")
        q = paperbank.register_source(question, "question", "PKT-DEMO")
        a = paperbank.register_source(answer, "answer", "PKT-DEMO")
        duplicate = paperbank.register_source(question, "question", "PKT-DEMO")
        self.assertEqual(q["source_id"], duplicate["source_id"])
        self.assertNotEqual(q["source_id"], a["source_id"])
        packet = paperbank.suggest_packet_pairings("PKT-DEMO")
        self.assertTrue(packet["pairings"])
        packet = paperbank.confirm_pairing("PKT-DEMO", q["source_id"], a["source_id"])
        self.assertEqual(packet["pairing_status"], "confirmed")

    def test_markdown_source_upload_and_extraction(self):
        markdown = self.env.root / "函数专题.md"
        markdown.write_text(
            """# 函数专题

一、选择题：本题共1小题，每小题5分，共5分。

1. 已知 $f(x)=x^2$，则 $f(1)$ 为（ ）

A. 0 B. 1 C. 2 D. 3
""",
            encoding="utf-8",
        )
        manifest = paperbank.register_source(
            markdown, role="question", packet_id="PKT-MARKDOWN"
        )
        self.assertEqual(manifest["stored_file"], "original.md")
        self.assertEqual(manifest["extraction"]["status"], "ok")
        parsed = paperbank.parse_source_questions(manifest["source_id"])
        self.assertEqual(len(parsed["imported"]), 1)
        item = next(iter(paperbank.iter_items()))
        self.assertEqual(item["question_type"], "single_choice")
        self.assertIn("f(x)=x^2", item["stem_markdown"])

    def _seed_teaching_items(self):
        items = []
        media_dir = self.env.root / "bank" / "sources" / "SRC-TEST" / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (100, 36), "white").save(media_dir / "formula.png")
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
            ("F2", "fill_blank", "L2"),
            ("Q1", "solution", "L2"),
            ("Q2", "solution", "L2"),
        ]
        for suffix, qtype, band in order:
            items.append(make_item(suffix, band, qtype))
        items[0]["stem_markdown"] += (
            "\n\n![公式](bank/sources/SRC-TEST/media/formula.png)"
        )
        path = self.env.root / "items.json"
        path.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        result = paperbank.import_items(path)
        self.assertEqual(len(result["imported"]), 12, result)
        return result

    def test_plan_render_and_student_answer_isolation(self):
        self._seed_teaching_items()
        request = {
            "delivery_type": "tutoring",
            "blueprint_id": "tutoring_75",
            "current_score": 30,
            "target_score": 60,
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
        request_path = self.env.root / "request.json"
        selection_path = self.env.root / "selection.json"
        request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        selection = paperbank.make_plan(request_path, selection_path)
        self.assertEqual(selection["total_score"], 75)
        self.assertEqual(selection["question_count"], 12)
        self.assertEqual(selection["request"]["current_band"], "L1")
        self.assertEqual(selection["request"]["target_band"], "L2")
        output = self.env.root / "outputs" / "render-test"
        result = document_renderer.render_selection(selection_path, output)
        self.assertTrue(result["validation"]["ok"])
        for filename in ["学生卷.docx", "教师卷.docx", "学生卷.pdf", "教师卷.pdf", "source.md"]:
            self.assertTrue((output / filename).exists(), filename)
        with zipfile.ZipFile(output / "学生卷.docx") as archive:
            student_xml = archive.read("word/document.xml").decode("utf-8")
        with zipfile.ZipFile(output / "教师卷.docx") as archive:
            teacher_xml = archive.read("word/document.xml").decode("utf-8")
        self.assertNotIn("参考答案为唯一答案", student_xml)
        self.assertIn("参考答案为唯一答案", teacher_xml)
        package = paperbank.check_package(output)
        self.assertTrue(package["ok"], package)

    def test_snapshot_and_restore(self):
        self._seed_teaching_items()
        snapshot = paperbank.create_snapshot(reason="unit-test")
        self.assertTrue(snapshot.exists())
        an_item = next(paperbank.iter_items())
        path = paperbank.find_item_path(an_item["id"])
        original = json.loads(path.read_text(encoding="utf-8"))
        changed = dict(original)
        changed["stem_markdown"] = "被修改的题干"
        paperbank.save_item(changed)
        extra = make_item("EXTRA", "L1", "fill_blank")
        paperbank.save_item(extra)
        paperbank.restore_snapshot(snapshot)
        restored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(restored["stem_markdown"], original["stem_markdown"])
        self.assertIsNone(paperbank.find_item_path("TEST-EXTRA"))

    def test_invalid_verified_item_is_rejected(self):
        item = make_item("BAD", "L1", "solution")
        item["answer"] = ""
        item["answer_status"] = "missing"
        normalized = paperbank.normalize_item(item)
        errors = paperbank.validate_item(normalized)
        self.assertTrue(any("verified" in error for error in errors))

    def test_blueprint_score_allocation(self):
        classroom = paperbank.allocate_scores(
            {"single_choice": 4, "multiple_choice": 2, "fill_blank": 2, "solution": 1},
            50,
        )
        self.assertEqual(sum(score for _, score in classroom), 50)
        full = paperbank.allocate_scores(
            {"single_choice": 8, "multiple_choice": 3, "fill_blank": 3, "solution": 5},
            150,
        )
        self.assertEqual(sum(score for _, score in full), 150)
        self.assertEqual(sum(1 for qtype, _ in full if qtype == "solution"), 5)
        with self.assertRaises(paperbank.PaperbankError):
            paperbank.allocate_scores({"single_choice": 6}, 75)

    def test_prepare_job_from_archive(self):
        archive_path = self.env.root / "bundle.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr(
                "2026高三数学月考/月考数学试卷.txt",
                "2026 高三数学月考\n考试时间：120分钟 满分：150分\n1. 等差数列题",
            )
            archive.writestr(
                "2026高三数学月考/月考数学试卷参考答案.txt",
                "2026 高三数学月考参考答案\n1. A",
            )
        request_path = self.env.root / "job-request.json"
        output_path = self.env.root / "prepared.json"
        request_path.write_text(
            json.dumps(
                {
                    "job_id": "JOB-UNIT",
                    "packet_id": "PKT-UNIT",
                    "files": [str(archive_path)],
                    "file_roles": {"bundle.zip": "unknown"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        prepared = paperbank.prepare_job(request_path, output_path)
        self.assertEqual(len(prepared["sources"]), 2)
        self.assertTrue(prepared["requires_review"])
        packet = json.loads(
            (self.env.root / "bank" / "packets" / "PKT-UNIT" / "manifest.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertTrue(packet["question_source_ids"])
        self.assertTrue(packet["solution_source_ids"] or packet["answer_source_ids"])

    def test_import_upload_batch_persists_and_splits(self):
        archive_path = self.env.root / "2026高三数学模拟.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr(
                "2026高三数学模拟试卷.txt",
                """2026 高三数学模拟试卷
考试时间：120分钟 满分：150分
一、选择题：本题共2小题，每小题5分，共10分。
1. 已知集合A，则结果为（ ）
A. 1 B. 2 C. 3 D. 4
2. 已知数列a_n，则a_2=（ ）
A. 1 B. 2 C. 3 D. 4
""",
            )
            archive.writestr(
                "2026高三数学模拟参考答案.txt",
                "参考答案\n1.C 2.B",
            )
        request_path = self.env.root / "import-request.json"
        output_path = self.env.root / "import-result.json"
        request_path.write_text(
            json.dumps(
                {
                    "batch_id": "BATCH-UNIT",
                    "files": [str(archive_path)],
                    "roles": {"2026高三数学模拟.zip": "unknown"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        result = paperbank.import_upload_batch(request_path, output_path)
        self.assertEqual(len(result["packets"]), 1)
        state = paperbank.library_snapshot()
        self.assertEqual(state["summary"]["sources"], 2)
        self.assertEqual(state["summary"]["packets"], 1)
        self.assertGreaterEqual(state["summary"]["draft_items"], 2)
        self.assertTrue((self.env.root / "bank" / "archives").glob("ARC-*"))
        self.assertGreaterEqual(state["navigation"]["review"]["missing_answers"], 2)
        self.assertEqual(state["navigation"]["pairing"]["pending_packets"], 1)
        self.assertTrue(state["navigation"]["generate"]["blocked"])
        packet = paperbank.load_packet_manifest(result["packets"][0]["packet_id"])
        self.assertTrue(packet["pairings"])
        confirmed = paperbank.confirm_pairing(
            packet["packet_id"],
            packet["question_source_ids"][0],
            packet["pairings"][0]["answer_source_id"],
        )
        self.assertEqual(confirmed["pairing_status"], "confirmed")
        before_process = len(list(paperbank.iter_items()))
        processed = paperbank.process_packet(packet["packet_id"])
        self.assertIn("split_cleanup", processed)
        self.assertEqual(len(list(paperbank.iter_items())), before_process)
        self.assertTrue(processed["answers"]["updated"])
        self.assertEqual(
            paperbank.load_packet_manifest(packet["packet_id"])["pairing_status"],
            "confirmed",
        )
        matched = [item for item in paperbank.iter_items() if item.get("answer_status") == "matched"]
        self.assertTrue(matched)
        self.assertTrue(any(item.get("review_status") == "verified" for item in matched))
        self.assertGreaterEqual(processed["auto_review"]["auto_approved"], 1)
        post_navigation = paperbank.library_snapshot()["navigation"]
        self.assertEqual(post_navigation["pairing"]["pending_packets"], 0)
        self.assertEqual(post_navigation["review"]["human_required"], 0)
        self.assertEqual(post_navigation["review"]["sample_required"], 0)
        self.assertFalse(post_navigation["generate"]["blocked"])

        split_result = paperbank.split_packet(
            packet["packet_id"],
            [packet["question_source_ids"][0]],
            title="拆分后的题卷",
        )
        self.assertEqual(len(paperbank.library_snapshot()["packets"]), 2)
        merged = paperbank.merge_packets(
            [split_result["new_packet"]["packet_id"], packet["packet_id"]],
            title="重新合并",
        )
        self.assertEqual(merged["pairing_status"], "needs_review")
        self.assertEqual(paperbank.library_snapshot()["summary"]["sources"], 2)

    def test_score_boundaries_and_preflight_scope(self):
        for score, expected in [
            (0, "L1"),
            (44, "L1"),
            (45, "L2"),
            (74, "L2"),
            (75, "L3"),
            (104, "L3"),
            (105, "L4"),
            (127, "L4"),
            (128, "L5"),
            (150, "L5"),
        ]:
            self.assertEqual(paperbank.band_for_score(score), expected)
        self._seed_teaching_items()
        request = {
            "delivery_type": "tutoring",
            "blueprint_id": "tutoring_75",
            "current_score": 30,
            "target_score": 60,
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
            "source_scope": "items",
            "item_ids": ["TEST-DOES-NOT-EXIST"],
        }
        result = paperbank.preflight_request(request)
        self.assertFalse(result["ok"])
        self.assertEqual(result["current_band"], "L1")
        self.assertEqual(result["target_band"], "L2")
        self.assertEqual(result["available_total"], 0)

    def test_answer_repair_escalates_disagreement_to_human(self):
        item = make_item("REPAIR", "L1", "fill_blank")
        item.update(
            {
                "answer": "",
                "solution": "",
                "answer_status": "missing",
                "answer_provenance": "missing",
                "review_status": "needs_review",
            }
        )
        paperbank.save_item(item)
        result_path = self.env.root / "answer-results.json"
        result_path.write_text(
            json.dumps(
                [
                    {
                        "id": "TEST-REPAIR",
                        "answer": "1",
                        "solution": "推导",
                        "agreement": False,
                        "independent_passes": 2,
                    }
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        applied = paperbank.apply_answer_repair_results(result_path)
        self.assertEqual(applied["excluded"], [])
        self.assertEqual(applied["human_required"], ["TEST-REPAIR"])
        saved = paperbank.load_json(paperbank.find_item_path("TEST-REPAIR"))
        self.assertEqual(saved["validity_status"], "suspect")
        self.assertEqual(saved["review_status"], "needs_review")
        self.assertEqual(saved["quality_audit"]["status"], "human")

    def test_scheduled_audit_candidates_prioritize_unresolved_and_skip_fresh(self):
        fresh = make_item("AUDIT-FRESH", "L2", "single_choice")
        fresh["split_rule_version"] = paperbank.SPLIT_RULE_VERSION
        fresh["split_confidence"] = 0.95
        fresh["answer_provenance"] = "ai_verified"
        fresh["quality_audit"] = {
            "status": "local_passed",
            "checked_at": paperbank.now_iso(),
        }
        paperbank.save_item(fresh)
        missing = make_item("AUDIT-MISSING", "L1", "fill_blank")
        missing.update(
            {
                "answer": "",
                "answer_status": "missing",
                "answer_provenance": "missing",
                "review_status": "needs_review",
            }
        )
        paperbank.save_item(missing)
        candidates = paperbank.quality_audit_candidates(limit=10, recheck_days=7)
        self.assertEqual(candidates[0]["id"], "TEST-AUDIT-MISSING")
        self.assertIn("missing_or_unverified_answer", candidates[0]["audit_reasons"])
        self.assertNotIn("TEST-AUDIT-FRESH", {entry["id"] for entry in candidates})

    def test_local_model_unavailable_escalates_without_blocking(self):
        item = make_item("AUDIT-LOCAL-FAIL", "L2", "fill_blank")
        item["split_rule_version"] = paperbank.SPLIT_RULE_VERSION
        item["split_confidence"] = 0.95
        paperbank.save_item(item)
        config = paperbank.load_json(paperbank.MODELS_PATH)
        config["ollama"]["base_url"] = "http://127.0.0.1:1"
        paperbank.MODELS_PATH.write_text(
            json.dumps(config, ensure_ascii=False),
            encoding="utf-8",
        )
        candidate = paperbank.quality_audit_candidates(
            limit=1,
            recheck_days=7,
        )[0]
        result = paperbank.run_local_quality_audit([candidate], timeout=1)
        self.assertEqual(result["local_passed"], [])
        self.assertEqual(result["needs_online"][0]["id"], "TEST-AUDIT-LOCAL-FAIL")
        self.assertIn(
            "local_unavailable",
            result["needs_online"][0]["audit_reasons"],
        )

    def test_two_pass_cloud_audit_repairs_missing_answer(self):
        item = make_item("AUDIT-REPAIR", "L2", "fill_blank")
        item.update(
            {
                "answer": "",
                "solution": "",
                "answer_status": "missing",
                "answer_provenance": "missing",
                "review_status": "needs_review",
                "review_mode": "pending",
                "split_rule_version": paperbank.SPLIT_RULE_VERSION,
                "split_confidence": 0.95,
            }
        )
        paperbank.save_item(item)
        candidate = paperbank.quality_audit_candidates(limit=1, recheck_days=7)[0]
        local_path = self.env.root / "quality-local.json"
        local_path.write_text(
            json.dumps(
                {
                    "checked": 1,
                    "local_passed": [],
                    "needs_online": [
                        {
                            **candidate,
                            "audit_reasons": [
                                "missing_or_unverified_answer",
                                "independent_answer_verification_required",
                            ],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        decision = {
            "id": "TEST-AUDIT-REPAIR",
            "decision": "resolve",
            "answer": "2",
            "solution": "由题意可直接得到结果为 2。",
            "rubric": ["代入并得出结果"],
            "question_type": "fill_blank",
            "primary_band": "L2",
            "topic_codes": ["数列"],
        }
        online_a = self.env.root / "quality-online-a.json"
        online_b = self.env.root / "quality-online-b.json"
        online_a.write_text(
            json.dumps({"results": [decision]}, ensure_ascii=False),
            encoding="utf-8",
        )
        online_b.write_text(
            json.dumps({"results": [decision]}, ensure_ascii=False),
            encoding="utf-8",
        )
        applied = paperbank.apply_quality_audit_results(
            local_path,
            online_a,
            online_b,
        )
        self.assertEqual(applied["verified"], ["TEST-AUDIT-REPAIR"])
        saved = paperbank.load_json(paperbank.find_item_path("TEST-AUDIT-REPAIR"))
        self.assertEqual(saved["answer"], "2")
        self.assertEqual(saved["review_status"], "verified")
        self.assertEqual(saved["verification"]["independent_passes"], 2)

    def test_cloud_audit_conflict_goes_to_human_instead_of_deletion(self):
        item = make_item("AUDIT-CONFLICT", "L3", "fill_blank")
        item.update(
            {
                "answer": "",
                "solution": "",
                "answer_status": "missing",
                "answer_provenance": "missing",
                "review_status": "needs_review",
                "split_rule_version": paperbank.SPLIT_RULE_VERSION,
                "split_confidence": 0.95,
            }
        )
        paperbank.save_item(item)
        candidate = paperbank.quality_audit_candidates(limit=1, recheck_days=7)[0]
        local_path = self.env.root / "quality-local-conflict.json"
        local_path.write_text(
            json.dumps(
                {"checked": 1, "local_passed": [], "needs_online": [candidate]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        base = {
            "id": "TEST-AUDIT-CONFLICT",
            "decision": "resolve",
            "question_type": "fill_blank",
            "primary_band": "L3",
            "solution": "推导",
        }
        online_a = self.env.root / "quality-online-a-conflict.json"
        online_b = self.env.root / "quality-online-b-conflict.json"
        online_a.write_text(
            json.dumps(
                {"results": [{**base, "answer": "1"}]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        online_b.write_text(
            json.dumps(
                {"results": [{**base, "answer": "2"}]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        applied = paperbank.apply_quality_audit_results(
            local_path,
            online_a,
            online_b,
        )
        self.assertEqual(applied["human_required"], ["TEST-AUDIT-CONFLICT"])
        saved = paperbank.load_json(
            paperbank.find_item_path("TEST-AUDIT-CONFLICT")
        )
        self.assertEqual(saved["review_status"], "needs_review")
        self.assertNotEqual(saved["review_status"], "deprecated")

    def test_bulk_approval_scans_all_items_and_returns_options(self):
        for index in range(55):
            item = make_item(f"BULK{index:03d}", "L1", "single_choice")
            item["review_status"] = "needs_review"
            item["review_mode"] = "pending"
            item["split_confidence"] = 0.95
            paperbank.save_item(item)
        queue = paperbank.review_queue("human")
        self.assertEqual(len(queue), 55)
        self.assertEqual(len(queue[0]["options"]), 4)
        result = paperbank.approve_all_qualified("human")
        self.assertEqual(result["scanned"], 55)
        self.assertEqual(len(result["approved"]), 55)
        self.assertEqual(paperbank.review_counts()["human"], 0)

    def test_inline_answers_are_applied_from_question_source(self):
        source = self.env.root / "mixed-question-answer.txt"
        source.write_text(
            """2026 高三数学模拟
一、选择题：本题共1小题，每小题5分，共5分。
1. 已知集合A={1,2}，则A中元素个数为（ ）
A. 1 B. 2 C. 3 D. 4
【答案】B
【解析】
【详解】集合中有两个元素。
""",
            encoding="utf-8",
        )
        manifest = paperbank.register_source(
            source, role="question", packet_id="PKT-INLINE"
        )
        parsed = paperbank.parse_source_questions(manifest["source_id"])
        self.assertEqual(len(parsed["imported"]), 1)
        applied = paperbank.apply_inline_answers("PKT-INLINE")
        self.assertEqual(len(applied["updated"]), 1)
        item = next(iter(paperbank.iter_items()))
        self.assertEqual(item["answer"], "B")
        self.assertEqual(item["answer_status"], "matched")
        self.assertNotIn("【答案】", item["stem_markdown"])

    def test_split_cleanup_classifies_answer_admin_container_and_child(self):
        source_location = {"source_id": "SRC-SPLIT", "question_no": "1"}
        parent = make_item("PARENT", "L3", "solution")
        parent["packet_id"] = "PKT-SPLIT"
        parent["question_no"] = "1"
        parent["source_location"] = source_location
        child = make_item("CHILD", "L3", "solution")
        child["packet_id"] = "PKT-SPLIT"
        child["question_no"] = "1"
        child["subquestion_no"] = "1"
        child["parent_item_id"] = parent["id"]
        child["source_location"] = {
            "source_id": "SRC-SPLIT",
            "question_no": "1",
            "subquestion_no": "1",
        }
        admin = make_item("ADMIN", "L3", "solution")
        admin["packet_id"] = "PKT-SPLIT"
        admin["question_no"] = "2"
        admin["stem_markdown"] = "2.答卷前，考生必须填写姓名和准考证号。"
        admin["source_location"] = {
            "source_id": "SRC-SPLIT",
            "question_no": "2",
        }
        answer_only = make_item("ANSWER", "L3", "solution")
        answer_only["packet_id"] = "PKT-SPLIT"
        answer_only["question_no"] = "3"
        answer_only["stem_markdown"] = "3. (1)由已知可得，所以结论成立。"
        answer_only["source_location"] = {
            "source_id": "SRC-SPLIT",
            "question_no": "3",
        }
        for item in [parent, child, admin, answer_only]:
            paperbank.save_item(item)
        result = paperbank.apply_split_cleanup()
        codes = {
            item["id"]: item["exclusion_code"]
            for item in paperbank.iter_items()
            if item["id"] in {parent["id"], admin["id"], answer_only["id"]}
        }
        self.assertEqual(codes[parent["id"]], "container_parent")
        self.assertEqual(codes[admin["id"]], "administrative_text")
        self.assertEqual(codes[answer_only["id"]], "answer_only")
        self.assertTrue(result["excluded"])

    def test_prepare_job_without_uploads_uses_existing_library(self):
        request_path = self.env.root / "existing-library-job.json"
        output_path = self.env.root / "existing-library-prepared.json"
        request_path.write_text(
            json.dumps(
                {
                    "job_id": "JOB-EXISTING",
                    "source_scope": "all",
                    "files": [],
                    "file_roles": {},
                }
            ),
            encoding="utf-8",
        )
        prepared = paperbank.prepare_job(request_path, output_path)
        self.assertFalse(prepared["requires_review"])
        self.assertIsNone(prepared["packet_id"])
        self.assertEqual(prepared["sources"], [])

    def test_zero_touch_review_approves_or_excludes_without_manual_queue(self):
        low = make_item("ZERO-LOW", "L1", "single_choice")
        low["review_status"] = "needs_review"
        low["review_mode"] = "pending"
        low["split_confidence"] = 0.95
        high = make_item("ZERO-HIGH", "L5", "solution")
        high["review_status"] = "needs_review"
        high["review_mode"] = "pending"
        high["split_confidence"] = 0.95
        sample = make_item("ZERO-SAMPLE", "L1", "fill_blank")
        sample["sample_review_required"] = True
        for item in [low, high, sample]:
            paperbank.save_item(item)
        result = paperbank.auto_triage_review()
        self.assertIn("TEST-ZERO-LOW", result["approved"])
        self.assertIn("TEST-ZERO-SAMPLE", result["sample_cleared"])
        self.assertTrue(any(row["id"] == "TEST-ZERO-HIGH" for row in result["excluded"]))
        counts = paperbank.review_counts()
        self.assertEqual(counts["human"], 0)
        self.assertEqual(counts["sample"], 0)
        high_saved = paperbank.load_json(paperbank.find_item_path("TEST-ZERO-HIGH"))
        self.assertEqual(high_saved["exclusion_code"], "auto_unverified")

    def test_plan_uses_adjacent_band_to_fill_shortage(self):
        for index in range(4):
            paperbank.save_item(make_item(f"FALL-S{index}", "L2", "single_choice"))
        for index in range(2):
            paperbank.save_item(make_item(f"FALL-F{index}", "L2", "fill_blank"))
        for index in range(2):
            paperbank.save_item(make_item(f"FALL-Q{index}", "L2", "solution"))
        request = {
            "delivery_type": "tutoring",
            "blueprint_id": "tutoring_75",
            "current_score": 30,
            "target_score": 30,
            "grade": "高三",
            "term": "一轮复习",
            "paper_type": "新高考模拟",
            "weak_topics": ["数列"],
            "question_count": 8,
            "type_counts": {
                "single_choice": 4,
                "multiple_choice": 0,
                "fill_blank": 2,
                "solution": 2,
            },
            "comprehensive": False,
            "allow_other_grades": False,
            "allow_adaptable": False,
            "auto_relax_bands": True,
            "source_scope": "all",
            "seed": 42,
        }
        request_path = self.env.root / "fallback-request.json"
        selection_path = self.env.root / "fallback-selection.json"
        request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        selection = paperbank.make_plan(request_path, selection_path)
        self.assertEqual(selection["question_count"], 8)
        self.assertTrue(any(item["band_fallback"] for item in selection["selected"]))

    def test_generated_multiple_choice_is_validated_and_reusable(self):
        request = {
            "grade": "高三",
            "term": "一轮复习",
            "paper_type": "新高考模拟",
            "weak_topics": ["函数"],
        }
        spec = {
            "slot": 1,
            "question_type": "multiple_choice",
            "target_band": "L1",
            "score": 5,
        }
        payload = {
            "stem_markdown": "已知函数 $f(x)=x^2$，下列说法正确的是（ ）",
            "options": ["$f(x)$ 是偶函数", "$f(x)$ 是奇函数", "$f(1)=1$", "$f(-1)=-1$"],
            "answer": "AC",
            "solution": "$f(-x)=f(x)$，且 $f(1)=1$，所以 A、C 正确。",
            "rubric": ["判断奇偶性", "计算函数值"],
            "topic_codes": ["函数"],
        }
        valid, errors = paperbank.validate_generated_question(payload, spec, request)
        self.assertTrue(valid, errors)
        item_id = paperbank.save_generated_supplement(
            payload,
            spec,
            request,
            ["generator", "verifier"],
            "verifier",
            "CA",
        )
        item = paperbank.load_json(paperbank.find_item_path(item_id))
        self.assertEqual(item["question_type"], "multiple_choice")
        self.assertEqual(item["primary_band"], "L1")
        self.assertEqual(item["answer_status"], "verified")
        self.assertEqual(item["review_status"], "verified")
        self.assertEqual(item["source_authority"], "ai_generated")

    def test_online_supplement_requires_independent_answer_match(self):
        request = {
            "delivery_type": "tutoring",
            "blueprint_id": "tutoring_75",
            "current_score": 30,
            "target_score": 60,
            "grade": "高三",
            "term": "一轮复习",
            "paper_type": "新高考模拟",
            "weak_topics": ["函数"],
            "question_count": 8,
            "type_counts": {
                "single_choice": 4,
                "multiple_choice": 2,
                "fill_blank": 1,
                "solution": 1,
            },
            "comprehensive": False,
            "source_scope": "all",
        }
        generated = {
            "questions": [
                {
                    "slot": 5,
                    "stem_markdown": "已知函数 $f(x)=x^2$，下列说法正确的是（ ）",
                    "options": [
                        "$f(x)$ 是偶函数",
                        "$f(x)$ 是奇函数",
                        "$f(1)=1$",
                        "$f(-1)=-1$",
                    ],
                    "answer": "AC",
                    "solution": "$f(-x)=f(x)$，且 $f(1)=1$。",
                    "rubric": ["判断奇偶性", "计算函数值"],
                    "topic_codes": ["函数"],
                }
            ]
        }
        verification = {"answers": [{"slot": 5, "answer": "AC", "solution": "复算略"}]}
        preflight = {
            "shortages": [
                {
                    "slot": 5,
                    "question_type": "multiple_choice",
                    "target_band": "L1",
                    "score": 7,
                }
            ]
        }
        paths = {}
        for name, value in {
            "request": request,
            "generated": generated,
            "verification": verification,
            "preflight": preflight,
        }.items():
            path = self.env.root / f"online-{name}.json"
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            paths[name] = path
        result = paperbank.import_online_supplements(
            paths["request"],
            paths["generated"],
            paths["verification"],
            paths["preflight"],
            "test-online",
        )
        self.assertEqual(len(result["saved"]), 1)
        self.assertEqual(result["rejected"], [])
        item = paperbank.load_json(paperbank.find_item_path(result["saved"][0]))
        self.assertEqual(item["answer"], "AC")
        self.assertEqual(item["verification"]["independent_passes"], 2)


if __name__ == "__main__":
    unittest.main()
