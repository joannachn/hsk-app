"""Builds data/hsk30.js from the HSK 3.0 word list plus the TSV files in src/
(HSK 1: collocations/sentences from de_*.tsv plus translations from en_*.tsv;
 HSK 2+: ex_*.tsv with word, collocations, sentence, English translation).

Usage: python3 -I build_data.py <complete.json>
"""
import glob
import json
import os
import sys

from pypinyin import Style, pinyin

HERE = os.path.dirname(os.path.abspath(__file__))


def load_tsv(pattern, columns):
    rows = {}
    for path in sorted(glob.glob(os.path.join(HERE, "src", pattern))):
        with open(path, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.rstrip("\n")
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) != columns:
                    sys.exit(f"{path}:{n}: expected {columns} columns, got {len(parts)}")
                rows[parts[0]] = parts[1:]
    return rows


PUNCT = {"，": ",", "。": ".", "？": "?", "！": "!", "、": ","}


def sentence_pinyin(text, lexicon):
    if "——" in text:  # dialogue lines: ——A——B
        return " ".join("– " + sentence_pinyin(part, lexicon) for part in text.split("——") if part)
    """Longest-match segmentation over the HSK lexicon (it has neutral tones right),
    pypinyin only for characters the lexicon does not cover."""
    out, i = [], 0
    while i < len(text):
        for n in range(min(6, len(text) - i), 0, -1):
            chunk = text[i:i + n]
            if chunk in lexicon:
                out.append(lexicon[chunk].replace(" ", ""))
                i += n
                break
        else:
            ch = text[i]
            if ch in PUNCT:
                if not (out and out[-1] == PUNCT[ch]):
                    out.append(PUNCT[ch])
            else:
                out.append(pinyin(ch, style=Style.TONE)[0][0])
            i += 1
    s = ""
    for tok in out:
        s = s + tok if tok in PUNCT.values() and s else (s + " " + tok if s else tok)
    return s[:1].upper() + s[1:]


def main(src):
    words = json.load(open(src, encoding="utf-8"))
    german = load_tsv("de_*.tsv", 5)
    english = load_tsv("en_*.tsv", 2)
    if set(german) != set(english):
        sys.exit(f"de/en TSV mismatch: {sorted(set(german) ^ set(english))}")
    extra = load_tsv("ex_*.tsv", 4)
    for k, v in extra.items():
        if k in german:
            sys.exit(f"{k} is in both de_*.tsv and ex_*.tsv")
    lexicon = {}
    for w in words:
        for form in w["forms"]:
            py = form["transcriptions"]["pinyin"]
            # prefer the common-noun reading over a surname/place-name reading (书 shū, not Shū)
            if w["simplified"] not in lexicon or (lexicon[w["simplified"]][:1].isupper() and not py[:1].isupper()):
                lexicon[w["simplified"]] = py
    entries = []
    for w in words:
        levels = [int(l.split("-")[1]) for l in w["level"] if l.startswith("new-")]
        if not levels:
            continue
        form = w["forms"][0]
        en = "; ".join(form["meanings"][:3])
        row = [w["simplified"], form["transcriptions"]["pinyin"], en, min(levels), w.get("frequency", 99999)]
        de = german.get(w["simplified"])
        if de:
            row += [de[1], de[2], sentence_pinyin(de[2], lexicon), english[w["simplified"]][0]]
        elif w["simplified"] in extra and min(levels) <= 6:
            coll, zh, tr = extra[w["simplified"]]
            row += [coll, zh, sentence_pinyin(zh, lexicon), tr]
        entries.append(row)
    entries.sort(key=lambda r: (r[3], r[4]))
    missing = (set(german) | set(extra)) - {e[0] for e in entries}
    if missing:
        sys.exit(f"TSV rows without HSK entry: {sorted(missing)}")
    out = os.path.join(HERE, "data", "hsk30.js")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("// HSK 3.0 Wortliste. Generiert von build_data.py, nicht von Hand bearbeiten.\n")
        f.write("// Felder: Zeichen, Pinyin, Englisch, Stufe (7 = HSK 7–9), Häufigkeitsrang,\n")
        f.write("//         [Wortverbindungen, Satz, Satz-Pinyin, Satz Englisch]\n")
        f.write("window.HSK_WORDS=")
        json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    with_de = sum(1 for e in entries if len(e) > 5)
    for lv in range(1, 7):
        gap = [e[0] for e in entries if e[3] == lv and len(e) <= 5]
        if gap:
            print(f"HSK {lv}: {len(gap)} ohne Beispiel" + (f": {' '.join(gap[:40])}" if len(gap) < 40 else ""))
    print(f"{len(entries)} Wörter, davon {with_de} mit Beispielsatz -> {out} ({os.path.getsize(out)//1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
