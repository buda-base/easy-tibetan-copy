"""Python mirror of the scoring helpers embedded in web/worker.js.

The worker ships its Python as a JS template string, so it cannot be imported.
Both test modules import THIS file instead of each carrying their own copy, so
the mirror lives in exactly one place. When web/worker.js changes its scoring,
change this file in the same commit.

Junk is deliberately narrow: only codepoints that cannot come from legitimate
text. Sanskrit diacritics, curly quotes, em-dashes, accented Latin and CJK are
all legitimate in a Tibetan Buddhist PDF and must NOT be counted.
"""

import re

_CTRL_PICS = re.compile("[\u2400-\u2422\u2424]")
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")


def is_hard_junk(cp):
    """True only for codepoints that can only come from a broken legacy map."""
    return (
        0xE000 <= cp <= 0xF8FF      # Private Use Area
        or 0x0E00 <= cp <= 0x0E7F   # Thai block — the issue #16 signature
        or cp == 0xFFFD             # replacement character
    )


def clean(s):
    """Legacy fonts map their space glyph to U+2423 OPEN BOX; the /ToUnicode
    carries it straight through. Turn it back into a space before scoring."""
    return _CTRL_PICS.sub("", s.replace("\u2423", " "))


def score_pdf(path):
    """Return (tibetan_chars, junk_chars, sample)."""
    import fitz

    doc = fitz.open(path)
    tib = junk = 0
    sample = []
    for page in doc:
        for line in clean(page.get_text()).split("\n"):
            has_tib = False
            for ch in line:
                cp = ord(ch)
                if 0x0F00 <= cp <= 0x0FFF:
                    tib += 1
                    has_tib = True
                elif is_hard_junk(cp):
                    junk += 1
            if has_tib and len(sample) < 3 and line.strip():
                sample.append(line.strip())
    doc.close()
    return tib, junk, "\n".join(sample)[:200]


def junk_fonts(path):
    """Font names responsible for hard junk. Heavier than score_pdf (needs the
    dict extraction), so callers run it only when junk was actually found."""
    import fitz

    doc = fitz.open(path)
    names = set()
    for page in doc:
        for blk in page.get_text("dict").get("blocks", []):
            if blk.get("type", 0) != 0:
                continue
            for line in blk.get("lines", []):
                for span in line.get("spans", []):
                    if any(is_hard_junk(ord(c)) for c in clean(span.get("text", ""))):
                        names.add(_SUBSET_PREFIX.sub("", span.get("font") or "?"))
    doc.close()
    return sorted(names)


def pua_free_dir():
    """Directory of the wheel's PUA-free GID lookup tree -- the escalation
    target when the default gid tree still leaves hard junk (issue #16)."""
    import pdf_cmap_fix

    return pdf_cmap_fix.FONT_LOOKUP_DIR.parent / "font_lookup_gid_pua_free"
