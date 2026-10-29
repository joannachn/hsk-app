# 字表 – HSK 3.0 Vokabeltrainer

Persönlicher Vokabeltrainer für Chinesisch auf Basis der HSK-3.0-Wortliste (2021), mit Wiederholungsplan (Nochmal / Schwer / Gut / Leicht), Wortverbindungen und Beispielsätzen für HSK 1–6 sowie eigenen Notizen.

- `index.html`, `app.js`: die App
- `data/hsk30.js`: Wortliste, erzeugt mit `python3 -I build_data.py <complete.json>` aus [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) und den Satzdateien in `src/`
- `docs/`: eigenständige Webseite für GitHub Pages, erzeugt mit `python3 build_site.py`

Englische Bedeutungen aus CC-CEDICT (CC BY-SA 4.0).
