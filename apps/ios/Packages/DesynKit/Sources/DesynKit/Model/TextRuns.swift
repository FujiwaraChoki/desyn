import Foundation

/// Editing the `runs` of a text node by UTF-16 ranges (the offsets UIKit's `UITextInput` and the engine use),
/// keeping per-run styles: inserted text takes the style of the run it is typed into (or the previous run at a
/// boundary), deleted ranges may span runs, adjacent runs with identical styles merge, and empty runs disappear
/// (one empty run stays so the node keeps its style when all text is deleted).
public enum TextRuns {
    /// The concatenated text.
    public static func text(of runs: [TextRun]) -> String {
        runs.map(\.text).joined()
    }

    /// Total length in UTF-16 code units.
    public static func length(of runs: [TextRun]) -> Int {
        runs.reduce(0) { $0 + $1.utf16Count }
    }

    /// Replaces UTF-16 `range` (clamped to the text) with `replacement`.
    public static func replace(in runs: [TextRun], range: Range<Int>, with replacement: String) -> [TextRun] {
        let total = length(of: runs)
        let lower = min(max(0, range.lowerBound), total)
        let upper = min(max(lower, range.upperBound), total)
        let source = runs.isEmpty ? [TextRun(text: "")] : runs

        // Style for inserted text: the run containing `lower`, preferring the run that ends at `lower` (typing at
        // the end of a bold word continues bold), else the first run.
        var insertionStyle = source.first?.style
        var offset = 0
        for run in source {
            let end = offset + run.utf16Count
            if lower > offset && lower <= end || (lower == 0 && offset == 0) {
                insertionStyle = run.style
                break
            }
            offset = end
        }

        var result: [TextRun] = []
        var inserted = replacement.isEmpty
        offset = 0
        for run in source {
            let units = Array(run.text.utf16)
            let start = offset
            let end = offset + units.count
            offset = end
            // Part before the replaced range.
            if lower > start {
                let cut = min(units.count, lower - start)
                result.append(TextRun(text: string(units[0..<cut]), style: run.style))
            }
            // Insert at the first run touching `lower`.
            if !inserted && lower >= start && lower <= end {
                result.append(TextRun(text: replacement, style: insertionStyle))
                inserted = true
            }
            // Part after the replaced range.
            if upper < end {
                let from = max(0, upper - start)
                result.append(TextRun(text: string(units[from..<units.count]), style: run.style))
            }
        }
        if !inserted {
            result.append(TextRun(text: replacement, style: insertionStyle))
        }
        return normalize(result, fallbackStyle: source.first?.style)
    }

    /// Merges neighbors with equal styles and drops empty runs (keeping one when everything is empty).
    public static func normalize(_ runs: [TextRun], fallbackStyle: [String: JSONValue]? = nil) -> [TextRun] {
        var merged: [TextRun] = []
        for run in runs where !run.text.isEmpty {
            if let last = merged.last, last.style == run.style {
                merged[merged.count - 1] = TextRun(text: last.text + run.text, style: last.style)
            } else {
                merged.append(run)
            }
        }
        if merged.isEmpty {
            return [TextRun(text: "", style: fallbackStyle)]
        }
        return merged
    }

    /// The text of a UTF-16 range (clamped).
    public static func substring(of runs: [TextRun], range: Range<Int>) -> String {
        let units = Array(text(of: runs).utf16)
        let lower = min(max(0, range.lowerBound), units.count)
        let upper = min(max(lower, range.upperBound), units.count)
        return string(units[lower..<upper])
    }

    private static func string(_ units: ArraySlice<UInt16>) -> String {
        String(decoding: units, as: UTF16.self)
    }
}
