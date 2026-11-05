"""CSV files under data/: market snapshots, items and the quote log."""
import csv
from pathlib import Path

from .analysis import Item, Quote
from .registry import ROOT

DATA = ROOT / "data"
MARKET_FILES = {
    "worldbank.csv": ["copper", "aluminum", "zinc", "nickel", "iron_ore"],
    "bcb.csv": ["usd_brl", "igpm_pct"],
}


def _rows(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def save_market(series, filename, data_dir=DATA):
    keys = MARKET_FILES[filename]
    path = Path(data_dir) / "market" / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["month", *keys])
        for month in sorted(series):
            writer.writerow([month, *(series[month].get(k, "") for k in keys)])
    return path


def load_market(data_dir=DATA):
    market = {}
    for filename in MARKET_FILES:
        path = Path(data_dir) / "market" / filename
        if not path.exists():
            continue
        for row in _rows(path):
            month = row.pop("month")
            values = {k: float(v) for k, v in row.items() if v not in ("", None)}
            market.setdefault(month, {}).update(values)
    return market


def parse_basket(text):
    """'copper:0.62;zinc:0.38' -> {'copper': 0.62, 'zinc': 0.38}"""
    basket = {}
    for part in filter(None, text.split(";")):
        key, weight = part.split(":")
        basket[key.strip()] = float(weight)
    return basket


def load_items(data_dir=DATA):
    return [
        Item(
            id=row["item"],
            description=row["description"],
            unit=row["unit"],
            kg_per_unit=float(row["kg_per_unit"]),
            basket=parse_basket(row["basket"]),
            annual_volume=float(row["annual_volume"]),
            current_supplier=row["current_supplier"],
        )
        for row in _rows(Path(data_dir) / "items.csv")
    ]


def load_quotes(data_dir=DATA):
    return [
        Quote(
            month=row["month"],
            supplier=row["supplier"],
            item=row["item"],
            price=float(row["unit_price_brl"]),
            lead_time_days=int(row["lead_time_days"]),
            payment_days=int(row["payment_days"]),
            moq=float(row["moq"]),
        )
        for row in _rows(Path(data_dir) / "quotes.csv")
    ]
