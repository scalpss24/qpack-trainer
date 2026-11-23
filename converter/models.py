from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

QuestionType = Literal["single_choice", "multiple_choice", "flashcard"]


@dataclass
class Option:
    id: str
    text: str
    is_correct: bool


@dataclass
class Question:
    id: str
    category_id: str
    type: QuestionType
    text: str
    images: list[str] = field(default_factory=list)
    options: list[Option] = field(default_factory=list)
    explanation: str | None = None


@dataclass
class Category:
    id: str
    title: str
    question_count: int = 0


@dataclass
class PackageManifest:
    format_version: str
    package_id: str
    title: str
    created_at: str
    categories: list[Category] = field(default_factory=list)
    questions: list[Question] = field(default_factory=list)


@dataclass
class SheetReport:
    sheet_name: str
    category_id: str
    question_count: int
    single_choice_count: int
    multiple_choice_count: int
    flashcard_count: int
    images_count: int
    no_correct_warnings: list[str] = field(default_factory=list)
