"""Build the small serif subset used by the web embed (docs/EMBED.md).

The embed only shows Aliya's local lines, so instead of the 2.7MB common-glyph subset it ships
the characters that actually appear in ui/assets/dialogue/ plus ASCII and CJK punctuation,
pinned to the 400 weight the bubble uses. Run after build:embed (npm run build:embed does it):

    python scripts/subset-embed-font.py ui/dist-embed

It writes <out>/fonts/aliya-embed.woff2, removes the larger font files from <out>/fonts and
rewrites the @font-face rules in the built CSS to point at the subset.
"""
import glob
import json
import os
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, 'ui')
FULL = os.path.join(UI, 'assets', 'fonts', 'NotoSerifSC-var.ttf')


def dialogue_text() -> str:
    parts = []
    for path in glob.glob(os.path.join(UI, 'assets', 'dialogue', '**', '*.json'), recursive=True):
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
        parts.extend(str(e.get('text', '')) for e in doc.get('entries', []))
    return ''.join(parts)


def main() -> None:
    out = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(UI, 'dist-embed')
    fonts = os.path.join(out, 'fonts')
    chars = set(dialogue_text())
    chars |= {chr(c) for c in range(0x20, 0x7F)}
    chars |= set('，。、：；！？「」『』“”‘’（）《》·—…～')
    # Variable placeholders ({aliya_year} etc.) resolve to digits, already covered by ASCII.

    font = TTFont(FULL)
    font = instancer.instantiateVariableFont(font, {'wght': 400})
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes={ord(c) for c in chars})
    sub.subset(font)
    os.makedirs(fonts, exist_ok=True)
    target = os.path.join(fonts, 'aliya-embed.woff2')
    font.flavor = 'woff2'
    font.save(target)

    for name in os.listdir(fonts):
        if name not in ('aliya-embed.woff2', 'OFL.txt'):
            os.remove(os.path.join(fonts, name))

    face = re.compile(r"@font-face\{font-family:\s*['\"]?Aliya Serif['\"]?[^}]*\}")
    for css in glob.glob(os.path.join(out, 'assets', '*.css')):
        with open(css, encoding='utf-8') as f:
            text = f.read()
        if 'Aliya Serif' not in text:
            continue
        # Keep a single face; the build minifies the generated serif-font.css rules.
        rule = f"@font-face{{font-family:'Aliya Serif';src:url(../fonts/aliya-embed.woff2) format('woff2');font-weight:100 900;font-display:swap}}"
        text, n = face.subn('', text)
        with open(css, 'w', encoding='utf-8') as f:
            f.write(rule + text if n else text)
        print(f'{os.path.basename(css)}: replaced {n} font-face rule(s)')

    print(f'{target}: {os.path.getsize(target) // 1024} KB, {len(chars)} chars')


if __name__ == '__main__':
    main()
