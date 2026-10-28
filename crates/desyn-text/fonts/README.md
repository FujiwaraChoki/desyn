# Bundled fonts

Every file here is licensed under the **SIL Open Font License 1.1** (license texts in `licenses/`). None of the
families declares a Reserved Font Name. Files are byte-identical copies of the upstream releases in the Google Fonts
repository (`https://github.com/google/fonts/tree/main/ofl/<family>`), downloaded 2026-10-20 and renamed
(`[axes]` suffixes replaced by `-VF`). They are compiled into the crate only through cargo features:

| feature | file | family | version | source path | bytes |
|---|---|---|---|---|---|
| `bundled` | `Inter-VF.ttf` | Inter (opsz 14-32, wght 100-900) | 4.001 | `ofl/inter/Inter[opsz,wght].ttf` | 876 576 |
| `bundled` | `Inter-Italic-VF.ttf` | Inter Italic | 4.001 | `ofl/inter/Inter-Italic[opsz,wght].ttf` | 906 596 |
| `bundled` | `InstrumentSans-VF.ttf` | Instrument Sans (wdth 75-100, wght 400-700) | 1.000 | `ofl/instrumentsans/InstrumentSans[wdth,wght].ttf` | 194 336 |
| `bundled` | `InstrumentSans-Italic-VF.ttf` | Instrument Sans Italic | 1.000 | `ofl/instrumentsans/InstrumentSans-Italic[wdth,wght].ttf` | 202 128 |
| `bundled` | `InstrumentSerif-Regular.ttf` | Instrument Serif (same bytes as `assets/fonts/`) | 1.000 | `ofl/instrumentserif/InstrumentSerif-Regular.ttf` | 70 012 |
| `bundled` | `InstrumentSerif-Italic.ttf` | Instrument Serif Italic | 1.000 | `ofl/instrumentserif/InstrumentSerif-Italic.ttf` | 71 592 |
| `bundled` | `JetBrainsMono-VF.ttf` | JetBrains Mono (wght 100-800) | 2.211 | `ofl/jetbrainsmono/JetBrainsMono[wght].ttf` | 187 208 |
| `bundled` | `JetBrainsMono-Italic-VF.ttf` | JetBrains Mono Italic | 2.211 | `ofl/jetbrainsmono/JetBrainsMono-Italic[wght].ttf` | 191 556 |
| `bundled-noto` | `NotoSansArabic-VF.ttf` | Noto Sans Arabic (wdth, wght) | 2.012 | `ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf` | 844 676 |
| `bundled-noto` | `NotoSansHebrew-VF.ttf` | Noto Sans Hebrew (wdth, wght) | 3.001 | `ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf` | 112 640 |
| `bundled-emoji` | `NotoEmoji-VF.ttf` | Noto Emoji, monochrome outlines (wght 300-700) | 3.002 | `ofl/notoemoji/NotoEmoji[wght].ttf` | 1 982 596 |

Size budget: `bundled` adds 2.7 MB, `bundled-noto` 0.96 MB, `bundled-emoji` 1.98 MB to the binary. Hosts that load
fonts at runtime (the web app streams them from the CDN) leave the features off.

Not bundled, fetched on demand through `FontProvider` / `TextEngine::take_font_requests` (all OFL on Google Fonts):

* **Noto Color Emoji** (COLRv1). The upstream file is 25 MB (with its `SVG ` table) and still 5 MB as COLR only, too
  large for the repository and the wasm bundle. The engine renders its COLRv1 layers (`TextEngine::color_glyph`).
* **CJK** (Noto Sans SC / TC / JP / KR, 10-17 MB each) and the other Noto scripts named in
  `FallbackConfig::default()`.

## Test fixtures (`tests/fonts/`, never compiled into the library)

| file | made from | how |
|---|---|---|
| `NotoSansSC-subset.ttf` | `ofl/notosanssc/NotoSansSC[wght].ttf` 2.004 | `pyftsubset` (fontTools 4.60.1) to ASCII, CJK punctuation, fullwidth forms and the Han / kana used by the tests; all names kept |
| `NotoColorEmoji-subset.ttf` | `ofl/notocoloremoji/NotoColorEmoji-Regular.ttf` 2.055 | `pyftsubset` to a few emoji, ZWJ / VS16, `SVG ` dropped (COLRv1 kept) |
| `NotoColorEmoji-CBDT-subset.ttf` | Arch `noto-fonts-emoji` `NotoColorEmoji.ttf` 2.051 (CBDT / CBLC bitmap build, same OFL license as above) | `pyftsubset --unicodes=U+1F600,U+2764` (fontTools 4.60.1); bitmap-glyph tests |
| `InstrumentSerif-ascii.woff`, `.woff2` | `InstrumentSerif-Regular.ttf` | `pyftsubset --flavor woff / woff2` to ASCII |

Subsetting is a modification permitted by the OFL; the family names stay unchanged because none is reserved. Noto Sans
SC's license reserves the name "Source", which the subset does not use.
