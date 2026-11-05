"""Collectors for the approved sources. Every request goes through net.Client."""
import calendar
import json
import re
from urllib.parse import urljoin

from .xlsx import read_sheet

WORLD_BANK_PAGE = "https://www.worldbank.org/en/research/commodity-markets"
# column title in the "Monthly Prices" sheet -> key used in data/market/worldbank.csv
WORLD_BANK_COLUMNS = {
    "Copper": "copper",
    "Aluminum": "aluminum",
    "Zinc": "zinc",
    "Nickel": "nickel",
    "Iron ore, cfr spot": "iron_ore",
}

BCB_URL = ("https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados"
           "?formato=json&dataInicial={start}&dataFinal={end}")
BCB_SERIES = {"usd_brl": 3698, "igpm_pct": 189}


def worldbank_file_url(client):
    page = client.get(WORLD_BANK_PAGE, "worldbank-pinksheet").decode("utf-8", "replace")
    match = re.search(r'href="([^"]*CMO-Historical-Data-Monthly\.xlsx)"', page)
    if not match:
        raise LookupError(f"monthly data link not found on {WORLD_BANK_PAGE}")
    return urljoin(WORLD_BANK_PAGE, match.group(1))


def parse_pink_sheet(rows, since):
    """Rows of the 'Monthly Prices' sheet -> {"YYYY-MM": {key: USD value}}."""
    header_at = next(i for i, row in enumerate(rows) if "Copper" in row)
    header = rows[header_at]
    columns = {key: header.index(title) for title, key in WORLD_BANK_COLUMNS.items() if title in header}
    out = {}
    for row in rows[header_at + 1:]:
        m = re.fullmatch(r"(\d{4})M(\d{2})", row[0].strip() if row else "")
        if not m:
            continue
        month = f"{m.group(1)}-{m.group(2)}"
        if month < since:
            continue
        values = {}
        for key, col in columns.items():
            try:
                values[key] = float(row[col])
            except (IndexError, ValueError):
                pass  # the sheet marks missing months with an ellipsis
        if values:
            out[month] = values
    return out


def worldbank_monthly(client, since):
    data = client.get(worldbank_file_url(client), "worldbank-pinksheet")
    return parse_pink_sheet(read_sheet(data, "Monthly Prices"), since)


def parse_bcb(points):
    """SGS JSON for a monthly series -> {"YYYY-MM": float}."""
    out = {}
    for point in points:
        _, month, year = point["data"].split("/")
        out[f"{year}-{month}"] = float(point["valor"])
    return out


def bcb_series(client, code, since, until):
    year, month = map(int, until.split("-"))
    last_day = calendar.monthrange(year, month)[1]
    url = BCB_URL.format(code=code, start=f"01/{since[5:]}/{since[:4]}", end=f"{last_day:02d}/{month:02d}/{year}")
    return parse_bcb(json.loads(client.get(url, "bcb-sgs")))


def bcb_monthly(client, since, until):
    out = {}
    for key, code in BCB_SERIES.items():
        for month, value in bcb_series(client, code, since, until).items():
            out.setdefault(month, {})[key] = value
    return out
