#!/usr/bin/env python3
"""Document-role, rich DOCX extraction and deterministic question splitting."""

from __future__ import annotations

import re
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


SECTION_RE = re.compile(r"^\s*[一二三四五六七八九十]+\s*[、.．]\s*(.+)$")
QUESTION_RE = re.compile(r"^\s*([1-9]\d?)\s*[.．、](?![0-9])\s*(.+)$")
SUBQUESTION_RE = re.compile(r"(?:^|\n)\s*[（(]\s*(\d+)\s*[）)]")
OPTION_RE = re.compile(r"(?<![A-Za-z])([A-D])\s*[.．、]\s*")
MEDIA_RE = re.compile(r"\[\[MEDIA:(.+?)\]\]")
ANSWER_MARKER_RE = re.compile(r"【\s*答案\s*】")
SOLUTION_MARKER_RE = re.compile(r"【\s*(?:解析|详解|分析|点睛)\s*】")
ANSWER_BOUNDARY_RE = re.compile(
    r"(?m)^\s*(?:参考答案|答案与解析|试题解析|【\s*\d{1,2}\s*题答案\s*】)"
)
ADMIN_TEXT_RE = re.compile(
    r"^(?:答卷前|答题前|考生注意|注意事项|选择题的作答|回答选择题时|"
    r"填空题和解答题的作答|非选择题必须|考试结束后|本试卷共|本考试分设)"
)
QUESTION_ACTION_RE = re.compile(
    r"求|证明|判断|计算|讨论|比较|说明|写出|选择|填写|解方程|解不等式|"
    r"取值范围|最大值|最小值|是否|正确的是|错误的是|个数|概率|面积|体积|"
    r"\((?:[ivx]+)\)|[（(]\s*\d+\s*[）)]"
)
SECTION_COUNT_RE = re.compile(r"(?:本题共|本大题共(?:有)?)\s*(\d+)\s*(?:小)?题")
SPLIT_RULE_VERSION = 3

TOPIC_KEYWORDS = [
    ("集合", ["集合", "交集", "并集", "补集"]),
    ("函数", ["函数", "定义域", "值域", "奇偶性", "单调性"]),
    ("三角函数", ["三角", "正弦", "余弦", "正切", "解三角形"]),
    ("数列", ["数列", "等差", "等比", "通项", "前n项和"]),
    ("立体几何", ["立体几何", "棱柱", "棱锥", "球", "体积", "线面角"]),
    ("解析几何", ["椭圆", "双曲线", "抛物线", "圆锥曲线", "直线与圆"]),
    ("概率统计", ["概率", "统计", "随机变量", "分布列", "期望"]),
    ("导数", ["导数", "极值", "切线", "单调区间"]),
    ("平面向量", ["向量", "数量积", "坐标运算"]),
    ("复数", ["复数", "虚部", "实部"]),
]


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value or "")).strip()


def correct_role(filename: str, text: str = "") -> tuple[str, float, str]:
    """Return role, confidence, evidence with filename markers taking precedence."""

    name = unicodedata.normalize("NFKC", filename or "")
    body = unicodedata.normalize("NFKC", (text or "")[:20000])
    if re.search(r"原卷版|原卷(?:\.docx|$)|（原卷）|\(原卷\)", name):
        return "question", 0.98, "filename:原卷版"
    if re.search(r"解析版|（解析）|\(解析\)|答案与解析", name):
        return "solution", 0.96, "filename:解析版"
    if re.search(r"纯答案版|答案版|参考答案|（答案）|\(答案\)", name):
        return "answer", 0.95, "filename:答案版"
    has_exam_marker = bool(re.search(r"试题|试卷|数学.*(?:真题|考试)|考试数学", name))
    if has_exam_marker and not re.search(r"解析|答案", name):
        return "question", 0.88, "filename:试卷/试题"
    if re.search(r"评分标准|评分细则|答案要点", name):
        return "rubric", 0.85, "filename:评分标准"
    if re.search(r"参考答案|答案与解析", body[:3000]):
        if re.search(r"一、选择题|二、选择题|解答题|填空题", body[:10000]):
            return "mixed", 0.62, "content:题目和答案标记并存"
        return "answer", 0.68, "content:参考答案"
    if has_exam_marker or re.search(r"(?:绝密.{0,5}启用前|本试卷共|考试用时)", body[:3000]):
        return "question", 0.82, "content:试卷结构"
    if re.search(r"解析|详解", name):
        return "solution", 0.72, "filename:解析"
    if re.search(r"答案", name):
        return "answer", 0.72, "filename:答案"
    return "unknown", 0.25, "no reliable cue"


W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
V_NS = "{urn:schemas-microsoft-com:vml}"
A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def extract_docx_rich(path: Path) -> dict[str, Any]:
    """Extract paragraphs while preserving MathType previews and inline images."""

    try:
        with zipfile.ZipFile(path) as archive:
            document_xml = archive.read("word/document.xml")
            rel_xml = archive.read("word/_rels/document.xml.rels")
            root = ET.fromstring(document_xml)
            rel_root = ET.fromstring(rel_xml)
            relationships: dict[str, str] = {}
            for rel in rel_root.findall(f"{REL_NS}Relationship"):
                rel_type = rel.attrib.get("Type", "")
                if rel_type.endswith("/image"):
                    relationships[rel.attrib.get("Id", "")] = rel.attrib.get("Target", "")

            assets: list[str] = []
            available = set(archive.namelist())
            paragraphs: list[str] = []
            for paragraph in root.iter(f"{W_NS}p"):
                pieces: list[str] = []
                for node in paragraph.iter():
                    if node.tag in {f"{W_NS}t", f"{M_NS}t"} and node.text:
                        pieces.append(node.text)
                    elif node.tag == f"{W_NS}tab":
                        pieces.append("\t")
                    elif node.tag == f"{W_NS}br":
                        pieces.append("\n")
                    elif node.tag in {f"{V_NS}imagedata", f"{A_NS}blip"}:
                        rel_id = node.attrib.get(f"{R_NS}id") or node.attrib.get(f"{R_NS}embed")
                        if not rel_id:
                            continue
                        target = relationships.get(rel_id, "")
                        if not target or target.startswith(("http://", "https://")):
                            continue
                        package_path = (
                            target.lstrip("/")
                            if target.startswith("/")
                            else f"word/{target.lstrip('../')}"
                        )
                        if package_path not in available:
                            package_path = f"word/{target}"
                        if package_path not in available:
                            continue
                        if package_path not in assets:
                            assets.append(package_path)
                        pieces.append(f"[[MEDIA:{package_path}]]")
                text = normalize("".join(pieces))
                if text:
                    paragraphs.append(text)
            return {
                "status": "ok" if paragraphs else "needs_ocr",
                "text": "\n".join(paragraphs),
                "assets": assets,
                "requires_visual_review": bool(assets),
                "page_count": None,
                "message": "包含公式或图形，已保留媒体标记" if assets else "",
            }
    except Exception as exc:
        return {
            "status": "extract_error",
            "text": "",
            "assets": [],
            "requires_visual_review": True,
            "page_count": None,
            "message": f"DOCX 提取失败：{exc}",
        }


def infer_topics(text: str) -> list[str]:
    found = [label for label, keys in TOPIC_KEYWORDS if any(key in text for key in keys)]
    return found or ["未分类"]


def section_type(line: str) -> str | None:
    match = SECTION_RE.match(line)
    if not match:
        return None
    heading = normalize(match.group(1))
    if (
        "多项选择" in heading
        or ("选择题" in heading and any(word in heading for word in ("多个", "多项", "至少两项")))
    ):
        return "multiple_choice"
    if "选择题" in heading:
        return "single_choice"
    if "填空" in heading:
        return "fill_blank"
    if any(word in heading for word in ("解答", "计算", "证明")):
        return "solution"
    return None


def section_question_count(line: str) -> int | None:
    match = SECTION_COUNT_RE.search(normalize(line))
    return int(match.group(1)) if match else None


def score_from_section(line: str) -> float | None:
    match = re.search(r"每小题\s*(\d+(?:\.\d+)?)\s*分", line)
    return float(match.group(1)) if match else None


def extract_options(block: str) -> tuple[str, list[str]]:
    matches = list(OPTION_RE.finditer(block))
    if len(matches) < 2:
        return block, []
    stem = block[: matches[0].start()].strip()
    options: list[str] = []
    seen: set[str] = set()
    for index, match in enumerate(matches):
        label = match.group(1)
        if label in seen:
            continue
        seen.add(label)
        end = matches[index + 1].start() if index + 1 < len(matches) else len(block)
        value = normalize(block[match.end() : end])
        if value:
            options.append(value)
    return stem, options


def provisional_band(qtype: str, number: int, warnings: list[str]) -> str:
    if qtype == "single_choice":
        return "L1" if number <= 4 else "L2"
    if qtype == "multiple_choice":
        return "L3"
    if qtype == "fill_blank":
        return "L2" if number <= 14 else "L3"
    if number <= 17:
        return "L3"
    return "L4"


def is_administrative_text(text: str) -> bool:
    body = normalize(re.sub(r"^\s*\d{1,2}\s*[.．、]\s*", "", text or ""))
    return bool(ADMIN_TEXT_RE.search(body))


def looks_like_answer_only(text: str) -> bool:
    body = normalize(re.sub(r"^\s*\d{1,2}\s*[.．、]\s*", "", text or ""))
    if not body:
        return False
    if re.match(r"^\(\s*\d+\s*\)\s*(?:由已知|因为|所以|故选|证明\s*[:：]?|解\s*[:：]?)", body):
        return True
    if re.match(r"^(?:由已知|因为|所以|故选|解析\s*[:：]|详解\s*[:：])", body):
        return True
    return False


def question_has_request(text: str, question_type: str, options: list[str]) -> bool:
    if question_type in {"single_choice", "multiple_choice"}:
        return len(options) >= 2
    if question_type == "fill_blank":
        return bool(re.search(r"_{3,}|＿{3,}|\\underline", text))
    plain = normalize(MEDIA_RE.sub(" ", text))
    if not plain:
        return False
    if len(plain) < 4:
        return False
    return bool(
        QUESTION_ACTION_RE.search(plain)
        or re.search(r"已知|若|设|如图|定义|函数|集合|向量|数列|曲线|方程", plain)
    )


def split_question_paper(text: str, source_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    lines = [normalize(line) for line in (text or "").replace("\r", "").split("\n")]
    metadata = source_manifest.get("metadata", {})
    source_id = source_manifest.get("source_id", "")
    current_type: str | None = None
    current_score: float | None = None
    auto_mode = False
    blocks: list[dict[str, Any]] = []
    active_number: int | None = None
    active_lines: list[str] = []
    active_answer_started = False
    saw_real_question = False
    last_question_no = 0
    expected_first: int | None = None
    expected_last: int | None = None

    def finish_active() -> None:
        nonlocal active_number, active_lines, active_answer_started, saw_real_question
        if active_number is None:
            active_lines = []
            active_answer_started = False
            return
        block = "\n".join(active_lines).strip()
        if len(normalize(MEDIA_RE.sub("", block))) < 4:
            active_lines = []
            active_number = None
            active_answer_started = False
            return
        inferred_type = current_type
        stem, options = extract_options(block)
        if inferred_type is None:
            if len(options) >= 4:
                inferred_type = "single_choice"
            elif re.search(r"_{3,}|＿{3,}|（\s*）|\(\s*\)", block):
                inferred_type = "fill_blank"
                options = []
            else:
                inferred_type = "solution"
                options = []
        if is_administrative_text(stem):
            active_lines = []
            active_number = None
            active_answer_started = False
            return
        if looks_like_answer_only(stem):
            active_lines = []
            active_number = None
            active_answer_started = False
            return
        if not question_has_request(stem, inferred_type, options) and not MEDIA_RE.search(stem):
            active_lines = []
            active_number = None
            active_answer_started = False
            return
        if inferred_type not in {"single_choice", "multiple_choice"}:
            options = []
        warnings: list[str] = []
        if MEDIA_RE.search(block):
            warnings.append("包含公式或图形媒体，需要检查位置")
        if inferred_type in {"single_choice", "multiple_choice"} and len(options) != 4:
            warnings.append(f"选择题识别到 {len(options)} 个选项")
        if not current_score:
            warnings.append("未识别到明确分值")
        subparts = list(SUBQUESTION_RE.finditer(stem))
        parts = [stem]
        if subparts and inferred_type == "solution":
            prefix = stem[: subparts[0].start()].strip()
            parts = []
            for index, match in enumerate(subparts):
                end = subparts[index + 1].start() if index + 1 < len(subparts) else len(stem)
                target = stem[match.start() : end].strip()
                parts.append(f"{prefix}\n\n{target}".strip())
        for part_index, part_stem in enumerate(parts, 1):
            part_warnings = list(warnings)
            confidence = 0.55
            if inferred_type in {"single_choice", "multiple_choice"}:
                confidence += 0.25 if len(options) == 4 else -0.15
            if len(normalize(MEDIA_RE.sub("", part_stem))) >= 15:
                confidence += 0.12
            if current_score:
                confidence += 0.05
            if MEDIA_RE.search(part_stem):
                confidence -= 0.12
            if part_warnings:
                confidence -= min(0.2, 0.045 * len(part_warnings))
            confidence = round(max(0.1, min(0.96, confidence)), 3)
            blocks.append(
                {
                    "source_id": source_id,
                    "question_no": active_number,
                    "subquestion_no": str(part_index) if len(parts) > 1 else None,
                    "question_type": inferred_type,
                    "stem_markdown": part_stem,
                    "options": options,
                    "score": current_score or (10 if current_type == "solution" else 5),
                    "grade": metadata.get("grade") or "未知",
                    "paper_type": metadata.get("paper_type") or "未知",
                    "source_authority": metadata.get("source_authority") or "unknown",
                    "curriculum_version": metadata.get("curriculum_version") or "new-gaokao-national",
                    "topic_codes": infer_topics(part_stem),
                    "primary_band": provisional_band(inferred_type, active_number, part_warnings),
                    "split_confidence": confidence,
                    "split_status": "draft" if confidence >= 0.72 else "needs_review",
                    "parse_warnings": part_warnings,
                    "split_rule_version": SPLIT_RULE_VERSION,
                    "source_segment": "question",
                    "source_location": {
                        "source_id": source_id,
                        "question_no": active_number,
                        "subquestion_no": str(part_index) if len(parts) > 1 else None,
                    },
                }
            )
        active_lines = []
        active_number = None
        active_answer_started = False
        saw_real_question = True

    for line in lines:
        if not line:
            if active_lines:
                active_lines.append("")
            continue
        qtype = section_type(line)
        if qtype:
            finish_active()
            current_type = qtype
            auto_mode = False
            current_score = score_from_section(line)
            count = section_question_count(line)
            expected_first = (
                expected_last + 1
                if count and expected_last is not None
                else last_question_no + 1
                if count
                else None
            )
            expected_last = expected_first + count - 1 if count and expected_first else None
            continue
        if ANSWER_BOUNDARY_RE.match(line):
            finish_active()
            break
        if saw_real_question and re.search(r"绝密\s*[★☆]?\s*启用前", line):
            finish_active()
            break
        question = QUESTION_RE.match(line)
        no_section_start = (
            current_type is None
            and not auto_mode
            and active_number is None
            and int(question.group(1)) == 1
            and re.search(r"（\s*）|\(\s*\)|_{3,}|＿{3,}|已知|若|设|函数|集合|向量|数列", line)
        ) if question else False
        if question and (current_type or auto_mode or no_section_start):
            question_no = int(question.group(1))
            if (
                current_type
                and expected_first is not None
                and expected_last is not None
                and not expected_first <= question_no <= expected_last
            ):
                continue
            if question_no <= last_question_no and saw_real_question:
                continue
            finish_active()
            if no_section_start:
                auto_mode = True
            active_number = question_no
            active_lines = [line]
            active_answer_started = False
            last_question_no = question_no
            inline_score = re.search(r"[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]", line)
            if inline_score:
                current_score = float(inline_score.group(1))
            continue
        if active_number is not None:
            if active_answer_started:
                continue
            marker = min(
                [
                    match.start()
                    for match in (
                        ANSWER_MARKER_RE.search(line),
                        SOLUTION_MARKER_RE.search(line),
                    )
                    if match
                ],
                default=None,
            )
            if marker is not None:
                prefix = line[:marker].strip()
                if prefix:
                    active_lines.append(prefix)
                active_answer_started = True
                continue
            active_lines.append(line)
    finish_active()
    return blocks


def parse_answer_text(text: str) -> dict[str, dict[str, str]]:
    """Parse both compact answer tables and full solution documents.

    The previous implementation returned after finding the first eight compact
    choice answers, so multiple-choice, fill-in and solution questions after
    that point were permanently treated as missing.
    """

    normalized_text = unicodedata.normalize("NFKC", (text or "").replace("\r", "\n"))
    result: dict[str, dict[str, str]] = {}

    compact_pattern = re.compile(
        r"(?<!\d)([1-9]\d?)\s*[.．、]\s*([A-D]{1,4})(?=[\s,，;；]|$)"
    )
    for match in compact_pattern.finditer(normalized_text):
        number = str(int(match.group(1)))
        result[number] = {
            "answer": match.group(2),
            "solution": "",
            "raw": match.group(2),
        }

    headings = list(
        re.finditer(
            r"(?m)^\s*([1-9]\d?)\s*[.．、]\s*([^\n]*)$",
            normalized_text,
        )
    )
    seen_headings: set[str] = set()
    for index, match in enumerate(headings):
        number = str(int(match.group(1)))
        if number in seen_headings:
            # Lines such as "6.635" inside a statistical solution are not a
            # second question 6.
            continue
        seen_headings.add(number)
        line_value = match.group(2).strip()
        if re.fullmatch(
            r"(?:\s*[1-9]\d?\s*[.．、]\s*[A-D]{1,4}\s*)+",
            match.group(0).strip(),
        ):
            # A compact answer row such as "1.A 2.C 3.D" is handled above.
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(normalized_text)
        block = normalized_text[match.end() : end].strip()
        combined = f"{line_value}\n{block}".strip()
        if not combined:
            continue

        answer_match = ANSWER_MARKER_RE.search(combined)
        solution_match = SOLUTION_MARKER_RE.search(combined)
        answer = ""
        solution = ""

        if answer_match:
            answer_end_candidates = [
                marker.start()
                for marker in (
                    SOLUTION_MARKER_RE.search(combined, answer_match.end()),
                    re.search(r"【[^】]+】", combined[answer_match.end() :]),
                )
                if marker
            ]
            if answer_end_candidates:
                # The second marker search returns a relative offset.
                absolute = [
                    marker.start()
                    if marker.re is SOLUTION_MARKER_RE
                    else answer_match.end() + marker.start()
                    for marker in (
                        SOLUTION_MARKER_RE.search(combined, answer_match.end()),
                        re.search(r"【[^】]+】", combined[answer_match.end() :]),
                    )
                    if marker
                ]
                answer = combined[answer_match.end() : min(absolute)].strip()
            else:
                answer = combined[answer_match.end() :].strip()

        if solution_match:
            solution = combined[solution_match.end() :].strip()
        elif answer_match:
            after_answer = combined[answer_match.end() :].strip()
            if answer and after_answer.startswith(answer):
                after_answer = after_answer[len(answer) :].strip()
            solution = after_answer
        elif compact_pattern.fullmatch(combined) or re.fullmatch(r"[A-D]{1,4}", combined):
            answer = combined
        else:
            # Answer-only documents often put a fill-in result or solution on
            # the line immediately following the question number.
            first_line, _, remaining = combined.partition("\n")
            answer = first_line.strip()
            solution = remaining.strip()

        existing = result.get(number, {})
        if not answer:
            answer = existing.get("answer", "")
        if not solution:
            solution = existing.get("solution", "")
        result[number] = {
            "answer": answer.strip(),
            "solution": solution.strip(),
            "raw": combined,
        }

    return result


def split_answer_text(text: str) -> dict[str, str]:
    """Return a best-effort answer label used by legacy callers and tests."""

    parsed = parse_answer_text(text)
    return {
        number: details.get("answer") or details.get("solution") or details.get("raw", "")
        for number, details in parsed.items()
        if details.get("answer") or details.get("solution") or details.get("raw")
    }
