from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


DOCX = Path(r"C:\Users\igorc\Downloads\Turmas 2026.docx")
OUT = Path(__file__).resolve().parents[1] / "seed-extra.js"
SUMMARY = Path(__file__).resolve().parents[1] / "data" / "turmas-2026-summary.json"

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

METADATA = [
    ("Berçário", "Lidiane", "Ana"),
    ("Infantil 2A", "Léia", "Daiane R."),
    ("Infantil 1A", "Edinéia", ""),
    ("Infantil 2B", "Evelyn", "Thais"),
    ("Infantil 1B", "Jaqueline", "Fátima"),
    ("Infantil 2C", "Tatiane", "Daiane S."),
    ("Infantil 1C", "Barbara", "Vitória"),
    ("Infantil 2D", "Dirlei", "Ana Vitória"),
    ("Infantil 3C", "Ana Karina", "Loreni"),
    ("Infantil 3A", "Rafaella", "Dione"),
    ("Infantil 4A", "Loreni", "Dirlei"),
    ("Infantil 3B", "Gabriele Braz", "Monica"),
    ("Infantil 4B", "Ana Carolina", "Beatriz"),
    ("Infantil 5B", "Janaine", "Maria"),
    ("Infantil 4C", "Gabrieli Cruz", ""),
    ("Infantil 5A", "Francielle", "Solange"),
    ("1º Ano A", "Paola", "Janaina"),
    ("2º Ano A", "Cristiane", "Elisangela"),
    ("1º Ano B", "Janaina Vargas", "Vanessa"),
    ("2º Ano B", "Paula", "Rafaella"),
    ("1º Ano C", "Sheila", "Luciana"),
    ("4º Ano", "Aline", "Carine"),
    ("3º Ano A", "Flávia", "Elisabeth"),
    ("3º Ano B", "Luci", "Salete"),
    ("5º Ano", "Priscila", "Carine"),
]

DATE_RE = re.compile(r"^\d{2}/\d{2}/(?:\d{2}|\d{4})$")
DATE_MISSING_SLASH_RE = re.compile(r"^(\d{2})/(\d{2})(\d{2})$")
TIPOS = {"M", "I", "In"}

NAME_FIXES = {
    "Victo ria Maria Vogt": "Victoria Maria Vogt",
}


def extract_unique_text_boxes() -> list[list[str]]:
    root = ET.fromstring(zipfile.ZipFile(DOCX).read("word/document.xml"))
    boxes: list[list[str]] = []
    for tx in root.findall(".//w:txbxContent", NS):
        lines = []
        for node in tx.findall(".//w:t", NS):
            text = re.sub(r"\s+", " ", node.text or "").strip()
            if text:
                lines.append(text)
        if lines:
            boxes.append(lines)

    unique: list[list[str]] = []
    seen: set[str] = set()
    for lines in boxes:
        key = "\n".join(lines)
        if key not in seen:
            unique.append(lines)
            seen.add(key)
    return unique


def is_date(value: str) -> bool:
    value = normalize_date(value)
    return bool(DATE_RE.match(value))


def normalize_date(value: str) -> str:
    value = value.strip()
    match = DATE_MISSING_SLASH_RE.match(value)
    if match:
        return f"{match.group(1)}/{match.group(2)}/{match.group(3)}"
    return value


def is_boundary(value: str) -> bool:
    return value in TIPOS or value.isdigit() or is_date(value)


def clean_name(parts: list[str]) -> str:
    kept: list[str] = []
    for raw in parts:
        value = raw.strip()
        lower = value.lower()
        if not value or value.isdigit() or value in TIPOS or is_date(value):
            continue
        if re.match(r"^\d{1,2}/\d{1,2}$", value):
            continue
        if value in {"–", "-", "°", "º"}:
            continue
        if lower.startswith("(") or lower == ")" or "início" in lower or "inicio" in lower:
            continue
        if "professora" in lower or lower.startswith("atend") or lower in {"inf.", "i", "nf."}:
            continue
        if re.search(r"\banos?\b", lower) or lower.startswith("de ") or " a " in lower:
            continue
        kept.append(value)

    name = re.sub(r"\s+", " ", " ".join(kept)).strip(" -–")
    name = NAME_FIXES.get(name, name)
    return name


def parse_students(lines: list[str]) -> list[list[str]]:
    students: list[list[str]] = []
    seen: set[tuple[str, str]] = set()

    for i, value in enumerate(lines):
        date = normalize_date(value)
        if not is_date(date):
            continue

        j = i - 1
        while j >= 0 and not is_boundary(lines[j]):
            j -= 1
        name = clean_name(lines[j + 1 : i])
        if not name:
            continue
        if re.search(r"\b(berçário|infantil|ano|professora|atend)\b", name, re.I):
            continue

        tipo = "I"
        if i + 1 < len(lines) and lines[i + 1] in TIPOS:
            tipo = lines[i + 1]

        key = (name.casefold(), date)
        if key not in seen:
            students.append([name, date, tipo])
            seen.add(key)

    return students


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def main() -> None:
    boxes = extract_unique_text_boxes()
    if len(boxes) != len(METADATA):
        raise SystemExit(f"Esperava {len(METADATA)} turmas, encontrei {len(boxes)} blocos unicos.")

    turmas = []
    for meta, lines in zip(METADATA, boxes):
        nome, professora, auxiliar = meta
        alunos = parse_students(lines)
        turmas.append({
            "nome": nome,
            "professora": professora,
            "auxiliar": auxiliar,
            "alunos": alunos,
        })

    OUT.write_text(render_seed(turmas), encoding="utf-8", newline="\n")
    SUMMARY.parent.mkdir(exist_ok=True)
    SUMMARY.write_text(json.dumps(turmas, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(len(t["alunos"]) for t in turmas)
    print(f"Turmas: {len(turmas)}")
    print(f"Alunos: {total}")
    for turma in turmas:
        counts = {tipo: sum(1 for aluno in turma["alunos"] if aluno[2] == tipo) for tipo in ("M", "I", "In")}
        print(f"{turma['nome']}: {len(turma['alunos'])} alunos (M={counts['M']}, I={counts['I']}, In={counts['In']})")


def render_seed(turmas: list[dict]) -> str:
    lines = [
        "'use strict';",
        "",
        "// Gerado de C:\\Users\\igorc\\Downloads\\Turmas 2026.docx.",
        "// Classificacao: M = Meio periodo, I = Integral, In = Intermediario.",
        "module.exports = [",
    ]
    for turma in turmas:
        lines.extend([
            "  {",
            f"    nome: {js_string(turma['nome'])},",
            f"    professora: {js_string(turma['professora'])},",
            f"    auxiliar: {js_string(turma['auxiliar'])},",
            "    alunos: [",
        ])
        for nome, nascimento, tipo in turma["alunos"]:
            lines.append(f"      [{js_string(nome)}, {js_string(nascimento)}, {js_string(tipo)}],")
        lines.extend([
            "    ],",
            "  },",
        ])
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
