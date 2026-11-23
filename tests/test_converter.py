from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Font, PatternFill
from PIL import Image as PILImage

from converter.excel_parser import parse_workbook
from converter.qpack_writer import build_manifest, write_qpack
from converter.text_utils import clean_option_text, clean_question_text, make_question_id


class TestTextUtils(unittest.TestCase):
    def test_clean_option_text(self):
        self.assertEqual(clean_option_text("A)* контроль соблюдения"), "контроль соблюдения")
        self.assertEqual(clean_option_text("+2. Журналға тіркеу"), "Журналға тіркеу")
        self.assertEqual(clean_option_text("1.\xa0\xa0 +Мейіргер бекетінде"), "Мейіргер бекетінде")
        self.assertEqual(clean_option_text("Г. соблюдать интервалы+1"), "соблюдать интервалы")
        self.assertEqual(clean_option_text("1) задаче наставника;+"), "задаче наставника")

    def test_deterministic_question_id(self):
        q1 = clean_question_text("1.  Укажите   норму:")
        q2 = clean_question_text("25. Укажите норму:")
        self.assertEqual(make_question_id(q1), make_question_id(q2))


class TestEndToEndQpack(unittest.TestCase):
    def test_synthetic_workbook_with_image_and_types(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            xlsx_path = tmp_dir / "test.xlsx"
            qpack_path = tmp_dir / "test.qpack"
            img_path = tmp_dir / "dot.png"

            PILImage.new("RGB", (32, 32), color=(255, 0, 0)).save(img_path, format="PNG")

            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = "Тесты"

            yellow = PatternFill(start_color="FFFFFF00", end_color="FFFFFF00", fill_type="solid")
            bold = Font(bold=True)

            # Single choice with yellow fill + embedded image
            ws["A1"] = "1. Какой цвет на картинке?"
            ws["A1"].font = bold
            ws["A2"] = "A. Красный"
            ws["A2"].fill = yellow
            ws["A3"] = "B. Синий"
            ws["A4"] = "C. Зеленый"
            ws.add_image(XLImage(str(img_path)), "B1")

            # Multiple choice with '+' markers
            ws["A6"] = "2. Выберите два правильных:"
            ws["A6"].font = bold
            ws["A7"] = "1) +Первый"
            ws["A8"] = "2) Второй"
            ws["A9"] = "3) Третий+"

            # Flashcard sheet
            ws_fc = wb.create_sheet("62 вопр")
            ws_fc["A1"] = "1"
            ws_fc["B1"] = "1. Что такое ЗОЖ?"
            ws_fc["B1"].font = bold
            ws_fc["B2"] = "Система разумного поведения человека."

            wb.save(xlsx_path)

            cats, questions, imgs, reports = parse_workbook(str(xlsx_path))
            manifest = build_manifest("Test Package", cats, questions)
            write_qpack(qpack_path, manifest, imgs)

            self.assertEqual(len(cats), 2)
            self.assertEqual(len(questions), 3)
            self.assertEqual(questions[0].type, "single_choice")
            self.assertEqual(len(questions[0].images), 1)
            self.assertTrue(questions[0].options[0].is_correct)
            self.assertEqual(questions[1].type, "multiple_choice")
            self.assertEqual([o.is_correct for o in questions[1].options], [True, False, True])
            self.assertEqual(questions[2].type, "flashcard")

            with zipfile.ZipFile(qpack_path, "r") as zf:
                names = zf.namelist()
                self.assertIn("manifest.json", names)
                img_name = questions[0].images[0]
                self.assertIn(img_name, names)
                self.assertEqual(zf.getinfo(img_name).compress_type, zipfile.ZIP_STORED)
                data = json.loads(zf.read("manifest.json").decode("utf-8"))
                self.assertEqual(data["format_version"], "1.0")
                self.assertEqual(len(data["questions"]), 3)


if __name__ == "__main__":
    unittest.main()
