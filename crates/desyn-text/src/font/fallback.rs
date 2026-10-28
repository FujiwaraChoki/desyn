//! Fallback chains: generic families, per-script defaults and emoji.
//!
//! Family names are the Google Fonts / Noto names so a [`FontProvider`](super::FontProvider) can fetch whatever is
//! missing; any registered font covering a character is used as a last resort.

use std::collections::HashMap;

use unicode_properties::{EmojiStatus, UnicodeEmoji};
use unicode_script::Script;

/// Configurable fallback chains.
#[derive(Debug, Clone, PartialEq)]
pub struct FallbackConfig {
    /// Families tried when the requested families are missing or do not cover a character (and before per-script
    /// fallbacks for Latin, Greek and Cyrillic).
    pub default_families: Vec<String>,
    /// Families for emoji presentation, color fonts first.
    pub emoji_families: Vec<String>,
    /// Per-script fallback families keyed by ISO 15924 code (`"Arab"`, `"Hani"`, ...).
    pub script_families: HashMap<String, Vec<String>>,
    /// CSS generic families (`"sans-serif"`, `"serif"`, `"monospace"`, ...) to concrete families.
    pub generic_families: HashMap<String, Vec<String>>,
}

fn list(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

impl Default for FallbackConfig {
    fn default() -> Self {
        let sans = list(&["Inter", "Instrument Sans", "Noto Sans"]);
        let mut scripts: HashMap<String, Vec<String>> = HashMap::new();
        let mut add = |codes: &[&str], fams: &[&str]| {
            for c in codes {
                scripts.insert((*c).to_string(), list(fams));
            }
        };
        add(&["Latn", "Grek", "Cyrl"], &["Inter", "Noto Sans"]);
        add(&["Arab"], &["Noto Sans Arabic", "Noto Naskh Arabic"]);
        add(&["Hebr"], &["Noto Sans Hebrew"]);
        add(
            &["Hani", "Bopo"],
            &[
                "Noto Sans SC",
                "Noto Sans TC",
                "Noto Sans JP",
                "Noto Sans KR",
            ],
        );
        add(&["Hira", "Kana"], &["Noto Sans JP", "Noto Sans SC"]);
        add(&["Hang"], &["Noto Sans KR"]);
        add(&["Thai"], &["Noto Sans Thai"]);
        add(&["Laoo"], &["Noto Sans Lao"]);
        add(&["Khmr"], &["Noto Sans Khmer"]);
        add(&["Mymr"], &["Noto Sans Myanmar"]);
        add(&["Deva"], &["Noto Sans Devanagari"]);
        add(&["Beng"], &["Noto Sans Bengali"]);
        add(&["Guru"], &["Noto Sans Gurmukhi"]);
        add(&["Gujr"], &["Noto Sans Gujarati"]);
        add(&["Orya"], &["Noto Sans Oriya"]);
        add(&["Taml"], &["Noto Sans Tamil"]);
        add(&["Telu"], &["Noto Sans Telugu"]);
        add(&["Knda"], &["Noto Sans Kannada"]);
        add(&["Mlym"], &["Noto Sans Malayalam"]);
        add(&["Sinh"], &["Noto Sans Sinhala"]);
        add(&["Tibt"], &["Noto Serif Tibetan"]);
        add(&["Ethi"], &["Noto Sans Ethiopic"]);
        add(&["Geor"], &["Noto Sans Georgian"]);
        add(&["Armn"], &["Noto Sans Armenian"]);
        add(&["Syrc"], &["Noto Sans Syriac"]);
        add(&["Thaa"], &["Noto Sans Thaana"]);
        add(&["Mong"], &["Noto Sans Mongolian"]);
        add(&["Tfng"], &["Noto Sans Tifinagh"]);
        add(&["Cher"], &["Noto Sans Cherokee"]);
        add(
            &["Zyyy", "Zinh"],
            &["Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math"],
        );
        let mut generic = HashMap::new();
        generic.insert("sans-serif".to_string(), sans.clone());
        generic.insert("system-ui".to_string(), sans.clone());
        generic.insert("ui-sans-serif".to_string(), sans.clone());
        generic.insert("cursive".to_string(), sans.clone());
        generic.insert("fantasy".to_string(), sans.clone());
        generic.insert(
            "serif".to_string(),
            list(&["Instrument Serif", "Noto Serif"]),
        );
        generic.insert(
            "ui-serif".to_string(),
            list(&["Instrument Serif", "Noto Serif"]),
        );
        generic.insert(
            "monospace".to_string(),
            list(&["JetBrains Mono", "Noto Sans Mono"]),
        );
        generic.insert(
            "ui-monospace".to_string(),
            list(&["JetBrains Mono", "Noto Sans Mono"]),
        );
        let emoji = list(&[
            "Noto Color Emoji",
            "Apple Color Emoji",
            "Segoe UI Emoji",
            "Twemoji Mozilla",
            "Noto Emoji",
        ]);
        generic.insert("emoji".to_string(), emoji.clone());
        FallbackConfig {
            default_families: sans,
            emoji_families: emoji,
            script_families: scripts,
            generic_families: generic,
        }
    }
}

impl FallbackConfig {
    /// Fallback families for a script, honoring a language hint for Han (`ja` -> Japanese, `ko` -> Korean,
    /// `zh-Hant` / `zh-TW` / `zh-HK` -> Traditional Chinese).
    pub fn for_script(&self, script: Script, language: Option<&str>) -> Vec<String> {
        let code = script.short_name();
        let mut fams = self.script_families.get(code).cloned().unwrap_or_default();
        if code == "Hani"
            && let Some(lang) = language
        {
            {
                let lang = lang.to_ascii_lowercase();
                let preferred = if lang.starts_with("ja") {
                    Some("Noto Sans JP")
                } else if lang.starts_with("ko") {
                    Some("Noto Sans KR")
                } else if lang.starts_with("zh")
                    && (lang.contains("hant") || lang.contains("tw") || lang.contains("hk"))
                {
                    Some("Noto Sans TC")
                } else {
                    None
                };
                if let Some(p) = preferred
                    && let Some(pos) = fams.iter().position(|f| f == p)
                {
                    let f = fams.remove(pos);
                    fams.insert(0, f);
                }
            }
        }
        fams
    }
}

/// Characters that never need a glyph of their own when choosing a font (joiners, selectors, bidi controls,
/// soft hyphen, tags).
pub fn is_ignorable(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}'
        | '\u{E0000}'..='\u{E0FFF}')
}

/// True when a grapheme cluster should be presented as emoji (color) rather than text.
pub fn is_emoji_cluster(cluster: &str) -> bool {
    let mut chars = cluster.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if cluster.contains('\u{FE0E}') {
        return false;
    }
    if cluster.contains('\u{FE0F}') || cluster.contains('\u{20E3}') {
        return first.is_emoji_char_or_emoji_component();
    }
    if matches!(first, '\u{1F1E6}'..='\u{1F1FF}') {
        return true;
    }
    match first.emoji_status() {
        EmojiStatus::EmojiPresentation
        | EmojiStatus::EmojiPresentationAndModifierBase
        | EmojiStatus::EmojiPresentationAndEmojiComponent
        | EmojiStatus::EmojiPresentationAndModifierAndEmojiComponent => true,
        // Text-default emoji become emoji when joined / modified.
        EmojiStatus::EmojiModifierBase | EmojiStatus::EmojiOther => {
            cluster.contains('\u{200D}')
                || cluster
                    .chars()
                    .any(|c| matches!(c, '\u{1F3FB}'..='\u{1F3FF}'))
        }
        _ => false,
    }
}

/// Script of a character with `Common` / `Inherited` reported as such (callers resolve them from context).
pub fn char_script(c: char) -> Script {
    use unicode_script::UnicodeScript;
    c.script()
}

/// True for scripts that are written without spaces and justify between characters.
pub fn is_inter_character_script(script: Script) -> bool {
    matches!(
        script,
        Script::Han
            | Script::Hiragana
            | Script::Katakana
            | Script::Bopomofo
            | Script::Hangul
            | Script::Thai
            | Script::Lao
            | Script::Khmer
            | Script::Myanmar
            | Script::Tibetan
    )
}

/// Cursive scripts where letter spacing would break joining.
pub fn is_cursive_script(script: Script) -> bool {
    matches!(
        script,
        Script::Arabic
            | Script::Syriac
            | Script::Mongolian
            | Script::Nko
            | Script::Mandaic
            | Script::Phags_Pa
            | Script::Adlam
            | Script::Hanifi_Rohingya
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_detection() {
        assert!(is_emoji_cluster("😀"));
        assert!(is_emoji_cluster("❤\u{FE0F}"));
        assert!(!is_emoji_cluster("❤"));
        assert!(!is_emoji_cluster("😀\u{FE0E}"));
        assert!(is_emoji_cluster("🇩🇪"));
        assert!(is_emoji_cluster("👨\u{200D}👩\u{200D}👧"));
        assert!(is_emoji_cluster("1\u{FE0F}\u{20E3}"));
        assert!(!is_emoji_cluster("1"));
        assert!(!is_emoji_cluster("a"));
    }

    #[test]
    fn han_language_preference() {
        let cfg = FallbackConfig::default();
        assert_eq!(
            cfg.for_script(Script::Han, Some("ja-JP"))[0],
            "Noto Sans JP"
        );
        assert_eq!(
            cfg.for_script(Script::Han, Some("zh-Hant"))[0],
            "Noto Sans TC"
        );
        assert_eq!(cfg.for_script(Script::Han, None)[0], "Noto Sans SC");
        assert_eq!(cfg.for_script(Script::Arabic, None)[0], "Noto Sans Arabic");
    }
}
