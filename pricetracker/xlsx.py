"""Just enough of the .xlsx format to read one sheet as rows of strings."""
import io
import re
import zipfile
import xml.etree.ElementTree as ET

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
DOC_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def column_index(ref):
    """'A1' -> 0, 'BM7' -> 64."""
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def _text(node):
    return "".join(t.text or "" for t in node.iter(MAIN + "t"))


def read_sheet(data, name):
    with zipfile.ZipFile(io.BytesIO(data)) as book:
        names = set(book.namelist())
        strings = []
        if "xl/sharedStrings.xml" in names:
            strings = [_text(item) for item in ET.fromstring(book.read("xl/sharedStrings.xml"))]
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        rel_id = next((s.get(DOC_REL + "id") for s in workbook.iter(MAIN + "sheet") if s.get("name") == name), None)
        if rel_id is None:
            raise KeyError(f"no sheet named {name!r}")
        rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        target = next(r.get("Target") for r in rels.iter(PKG_REL + "Relationship") if r.get("Id") == rel_id)
        path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        sheet = ET.fromstring(book.read(path))

    rows = []
    for row in sheet.iter(MAIN + "row"):
        cells = {}
        for cell in row.iter(MAIN + "c"):
            kind = cell.get("t")
            if kind == "inlineStr":
                value = _text(cell)
            else:
                v = cell.find(MAIN + "v")
                value = "" if v is None else (v.text or "")
                if kind == "s" and value:
                    value = strings[int(value)]
            cells[column_index(cell.get("r"))] = value
        width = max(cells) + 1 if cells else 0
        rows.append([cells.get(i, "") for i in range(width)])
    return rows
