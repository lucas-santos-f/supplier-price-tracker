import io
import json
import unittest
import zipfile

from pricetracker import collectors
from pricetracker.xlsx import column_index, read_sheet

WORKBOOK = """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Monthly Prices" sheetId="2" r:id="rId2"/></sheets>
</workbook>"""
RELS = """<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/>
  <Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml" Type="worksheet"/>
</Relationships>"""
STRINGS = """<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Copper</t></si><si><t>Aluminum</t></si><si><t>($/mt)</t></si><si><r><t>Iron ore, </t></r><r><t>cfr spot</t></r></si>
</sst>"""
SHEET = """<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>World Bank Commodity Price Data</t></is></c></row>
  <row r="5"><c r="B5" t="s"><v>0</v></c><c r="D5" t="s"><v>1</v></c><c r="E5" t="s"><v>3</v></c></row>
  <row r="6"><c r="B6" t="s"><v>2</v></c></row>
  <row r="7"><c r="A7" t="inlineStr"><is><t>2021M12</t></is></c><c r="B7"><v>9550</v></c><c r="D7"><v>2700</v></c></row>
  <row r="8"><c r="A8" t="inlineStr"><is><t>2022M01</t></is></c><c r="B8"><v>9782</v></c><c r="D8"><v>3006</v></c><c r="E8"><v>132.5</v></c></row>
  <row r="9"><c r="A9" t="inlineStr"><is><t>2022M02</t></is></c><c r="B9"><v>9943</v></c><c r="D9" t="inlineStr"><is><t>…</t></is></c></row>
</sheetData></worksheet>"""


def make_xlsx():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", RELS)
        z.writestr("xl/sharedStrings.xml", STRINGS)
        z.writestr("xl/worksheets/sheet1.xml", SHEET.replace("Copper", "x"))
        z.writestr("xl/worksheets/sheet2.xml", SHEET)
    return buf.getvalue()


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, source_id):
        self.calls.append((url, source_id))
        for prefix, body in self.responses.items():
            if url.startswith(prefix):
                return body
        raise AssertionError(f"unexpected URL {url}")


class XlsxTest(unittest.TestCase):
    def test_column_index(self):
        self.assertEqual([column_index(r) for r in ("A1", "Z9", "AA1", "BM7")], [0, 25, 26, 64])

    def test_reads_named_sheet_with_gaps_and_rich_text(self):
        rows = read_sheet(make_xlsx(), "Monthly Prices")
        self.assertEqual(rows[1], ["", "Copper", "", "Aluminum", "Iron ore, cfr spot"])
        self.assertEqual(rows[4][:4], ["2022M01", "9782", "", "3006"])

    def test_missing_sheet(self):
        with self.assertRaises(KeyError):
            read_sheet(make_xlsx(), "Annual Prices")


class WorldBankTest(unittest.TestCase):
    def test_parse_pink_sheet(self):
        rows = read_sheet(make_xlsx(), "Monthly Prices")
        data = collectors.parse_pink_sheet(rows, since="2022-01")
        self.assertEqual(data, {
            "2022-01": {"copper": 9782.0, "aluminum": 3006.0, "iron_ore": 132.5},
            "2022-02": {"copper": 9943.0},
        })

    def test_file_url_is_read_from_the_landing_page(self):
        page = b'<a href="https://thedocs.worldbank.org/en/doc/abc-0050012026/related/CMO-Historical-Data-Monthly.xlsx">Monthly</a>'
        client = FakeClient({collectors.WORLD_BANK_PAGE: page, "https://thedocs.worldbank.org/": make_xlsx()})
        data = collectors.worldbank_monthly(client, since="2022-01")
        self.assertEqual(data["2022-01"]["copper"], 9782.0)
        self.assertEqual([source for _, source in client.calls], ["worldbank-pinksheet"] * 2)

    def test_missing_link(self):
        client = FakeClient({collectors.WORLD_BANK_PAGE: b"<html></html>"})
        with self.assertRaises(LookupError):
            collectors.worldbank_file_url(client)


class BcbTest(unittest.TestCase):
    def test_parse(self):
        points = [{"data": "01/09/2026", "valor": "5.1447"}, {"data": "01/10/2026", "valor": "-0.22"}]
        self.assertEqual(collectors.parse_bcb(points), {"2026-09": 5.1447, "2026-10": -0.22})

    def test_query_has_a_date_range(self):
        body = json.dumps([{"data": "01/02/2024", "valor": "4.97"}]).encode()
        client = FakeClient({"https://api.bcb.gov.br/": body})
        data = collectors.bcb_monthly(client, since="2024-01", until="2024-02")
        self.assertEqual(data, {"2024-02": {"usd_brl": 4.97, "igpm_pct": 4.97}})
        url, source = client.calls[0]
        self.assertEqual(source, "bcb-sgs")
        self.assertIn("bcdata.sgs.3698", url)
        self.assertIn("dataInicial=01/01/2024&dataFinal=29/02/2024", url)


if __name__ == "__main__":
    unittest.main()
