# Supplier price tracker

Compares supplier quotes with each other and with the market price of the raw material inside each item.
It answers three questions a buyer asks every month: who is cheapest right now, who raised prices faster
than the metal moved, and which quotes are too old to trust.

![Demo](docs/demo.gif)

Open `site/index.html` in a browser. No server or install needed.

## Data

| File | Content | Source |
| --- | --- | --- |
| `data/market/worldbank.csv` | Monthly copper, aluminum, zinc, nickel and iron ore, USD/t | World Bank Commodity Price Data (The Pink Sheet), CC BY 4.0 |
| `data/market/bcb.csv` | USD/BRL monthly average (SGS 3698), IGP-M % per month (SGS 189) | Banco Central do Brasil, ODbL |
| `data/items.csv` | Items, material basis, planned volume, current supplier | invented |
| `data/quotes.csv` | Quote log: price, lead time, payment terms, MOQ | invented |

## Only approved sources

Every request goes through `pricetracker/net.py`, which refuses it unless:

1. the source is in `sources.json` with status `approved`. License and terms are checked by hand and the date
   is recorded there;
2. the host, and the host after any redirect, belongs to that source;
3. the host's robots.txt allows the path. No robots.txt (404) allows everything; 401, 403, 5xx or no answer
   blocks everything;
4. the previous request to the same host was at least 1 s ago, or the Crawl-delay if that is longer.

The BLS API is listed as `rejected`: its robots.txt disallows every path.

## Commands

```bash
python -m pricetracker sources --check   # registry plus a live robots.txt check
python -m pricetracker fetch             # refresh data/market/*.csv
python -m pricetracker report            # comparison and flags in the terminal
python -m pricetracker build             # write site/data.js for the page
python -m unittest discover -s tests
```

Python 3.10 or later, standard library only.

## How the numbers are worked out

- Material cost of one unit = kg per unit × Σ(tonnes of commodity per tonne of product × USD/t) / 1000 × USD/BRL.
- A quote stays in force until the next one. Changes compare the quote in force now with the one 6 months ago.
- Gap = supplier change minus material change, in percentage points. Over 5 pp is flagged.
- Quotes older than 3 months are stale: listed and flagged, but never the best price.
- The saving flag compares the current supplier with the best valid quote, times the planned annual volume,
  and shows lead time and payment terms of both, since the cheapest offer is not always the better one.

The World Bank monthly file has no steel price, so galvanized sheet uses iron ore and zinc as a rough proxy.

## License

Code under the MIT license. The market data files keep the license of their source, listed above.
