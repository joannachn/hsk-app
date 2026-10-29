"""Builds the standalone web app in docs/ (for GitHub Pages or any static host).

The Claude artifact page (index.html) has no <head>; the artifact host adds one.
This script wraps it in a full document so it also runs in a plain browser,
including older iOS Safari, and adds what a home-screen app needs.
"""
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "docs")

HEAD = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="字表">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#f5f7f4">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" href="icon-180.png">
<link rel="manifest" href="manifest.webmanifest">
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
</head>
<body>
"""

MANIFEST = """{
  "name": "字表 HSK 3.0",
  "short_name": "字表",
  "start_url": "./",
  "display": "standalone",
  "background_color": "#f5f7f4",
  "theme_color": "#f5f7f4",
  "icons": [{"src": "icon-180.png", "sizes": "180x180", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}]
}
"""


def main():
    os.makedirs(os.path.join(OUT, "data"), exist_ok=True)
    page = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(HEAD + page + "\n</body>\n</html>\n")
    shutil.copy(os.path.join(HERE, "app.js"), os.path.join(OUT, "app.js"))
    shutil.copy(os.path.join(HERE, "data", "hsk30.js"), os.path.join(OUT, "data", "hsk30.js"))
    for name in ("icon-180.png", "icon-512.png"):
        shutil.copy(os.path.join(HERE, "assets", name), os.path.join(OUT, name))
    with open(os.path.join(OUT, "manifest.webmanifest"), "w", encoding="utf-8") as f:
        f.write(MANIFEST)
    open(os.path.join(OUT, ".nojekyll"), "w").close()
    print("docs/ gebaut:", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
