import DesynKit
import Foundation

/// Elements of the insert sheet: shapes, text presets, charts, tables, QR codes and icons, built with the
/// @desyn/schema defaults (`createChart`, `createTable`, `createQr`, `createSvg`) and sized for the page.
public enum ElementFactory {
    /// Warm-first chart palette (DESIGN_SYSTEM.md section 1, `DEFAULT_CHART_PALETTE`).
    public static let chartPalette = ["#ffb02e", "#ff6a1f", "#ffd66b", "#c4451c", "#8a5a00", "#e8e1d3", "#7a7468"]

    static func base(_ type: String, name: String, parent: String, frame: PageRect, id: String = DesynID.new()) -> [String: JSONValue] {
        [
            "id": .string(id),
            "type": .string(type),
            "name": .string(name),
            "parent": .string(parent),
            "x": .number(frame.x),
            "y": .number(frame.y),
            "width": .number(max(0, frame.width)),
            "height": .number(max(0, frame.height)),
            "rotation": 0,
            "opacity": 1,
            "blend": "normal",
            "visible": true,
            "locked": false,
            "effects": [],
        ]
    }

    // MARK: Shapes

    public enum Shape: String, CaseIterable, Sendable, Identifiable {
        case rectangle, roundedRectangle, circle, triangle, diamond, pentagon, hexagon, star, burst, line, arrow, heart, arch

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .rectangle: "Rectangle"
            case .roundedRectangle: "Rounded"
            case .circle: "Circle"
            case .triangle: "Triangle"
            case .diamond: "Diamond"
            case .pentagon: "Pentagon"
            case .hexagon: "Hexagon"
            case .star: "Star"
            case .burst: "Burst"
            case .line: "Line"
            case .arrow: "Arrow"
            case .heart: "Heart"
            case .arch: "Arch"
            }
        }

        public var systemImage: String {
            switch self {
            case .rectangle: "rectangle.fill"
            case .roundedRectangle: "app.fill"
            case .circle: "circle.fill"
            case .triangle: "triangle.fill"
            case .diamond: "diamond.fill"
            case .pentagon: "pentagon.fill"
            case .hexagon: "hexagon.fill"
            case .star: "star.fill"
            case .burst: "seal.fill"
            case .line: "line.diagonal"
            case .arrow: "arrow.right"
            case .heart: "heart.fill"
            case .arch: "door.left.hand.closed"
            }
        }
    }

    /// A shape of side `side` centered on `center`, filled with `color`.
    public static func shape(_ shape: Shape, parent: String, center: PagePoint, side: Double, color: String) -> Node {
        let box = PageRect.centered(at: center, width: side, height: side)
        switch shape {
        case .rectangle:
            return NodeFactory.rect(parent: parent, frame: box, color: color)
        case .roundedRectangle:
            var node = NodeFactory.rect(parent: parent, frame: box, color: color, cornerRadius: (side * 0.18).rounded())
            node.set("cornerSmoothing", 0.6)
            node.name = "Rounded rectangle"
            return node
        case .circle:
            return NodeFactory.ellipse(parent: parent, frame: box, color: color)
        case .triangle:
            return NodeFactory.polygon(parent: parent, frame: box, sides: 3, color: color)
        case .diamond:
            var node = NodeFactory.polygon(parent: parent, frame: box, sides: 4, color: color)
            node.name = "Diamond"
            return node
        case .pentagon:
            var node = NodeFactory.polygon(parent: parent, frame: box, sides: 5, color: color)
            node.name = "Pentagon"
            return node
        case .hexagon:
            var node = NodeFactory.polygon(parent: parent, frame: box, sides: 6, color: color)
            node.name = "Hexagon"
            return node
        case .star:
            return NodeFactory.star(parent: parent, frame: box, color: color)
        case .burst:
            var node = NodeFactory.star(parent: parent, frame: box, color: color)
            node.set("points", 12)
            node.set("innerRatio", 0.78)
            node.name = "Burst"
            return node
        case .line:
            return NodeFactory.line(parent: parent, from: PagePoint(x: center.x - side / 2, y: center.y), length: side, color: color)
        case .arrow:
            var node = NodeFactory.line(parent: parent, from: PagePoint(x: center.x - side / 2, y: center.y), length: side, color: color)
            node.set("endCap", "arrow")
            node.name = "Arrow"
            var strokes = node.strokes
            if !strokes.isEmpty {
                strokes[0].width = max(2, (side / 40).rounded())
                strokes[0].set("cap", "round")
                node.strokes = strokes
            }
            return node
        case .heart:
            let d = "M 50 88 C 22 66 4 50 4 30 C 4 14 16 4 29 4 C 39 4 46 10 50 18 C 54 10 61 4 71 4 C 84 4 96 14 96 30 C 96 50 78 66 50 88 Z"
            return NodeFactory.path(parent: parent, frame: box, d: scaledPath(d, from: 100, to: side), color: color, name: "Heart")
        case .arch:
            let d = "M 0 100 L 0 50 A 50 50 0 0 1 100 50 L 100 100 Z"
            return NodeFactory.path(parent: parent, frame: box, d: scaledPath(d, from: 100, to: side), color: color, name: "Arch")
        }
    }

    /// Scales path data authored in a `from` x `from` box to `to` x `to` (numbers only; flags of arcs keep 0/1).
    public static func scaledPath(_ d: String, from: Double, to: Double) -> String {
        let factor = to / from
        var out: [String] = []
        var arcIndex = -1
        var command: Character = "M"
        for token in d.split(separator: " ") {
            if let first = token.first, first.isLetter {
                command = first
                arcIndex = -1
                out.append(String(token))
                continue
            }
            guard let value = Double(token) else {
                out.append(String(token))
                continue
            }
            if command == "A" || command == "a" {
                arcIndex = (arcIndex + 1) % 7
                // rx ry rotation large-arc sweep x y: only radii and the end point scale.
                if arcIndex == 2 || arcIndex == 3 || arcIndex == 4 {
                    out.append(JSONValue.format(number: value))
                    continue
                }
            }
            out.append(JSONValue.format(number: (value * factor * 1000).rounded() / 1000))
        }
        return out.joined(separator: " ")
    }

    // MARK: Text presets

    public struct TextPreset: Identifiable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let sample: String
        public let fontFamily: String
        public let fontWeight: Double
        public let italic: Bool
        /// Size as a share of the page's shorter side.
        public let scale: Double
        public let minSize: Double
        public let letterSpacing: Double
        public let textCase: String
        public let role: String
        public let widthShare: Double
        public let align: String
        public let lineHeight: Double

        /// The size this preset takes on a page.
        public func fontSize(pageWidth: Double, pageHeight: Double) -> Double {
            max(minSize, (min(pageWidth, pageHeight) * scale).rounded())
        }
    }

    public static let textPresets: [TextPreset] = [
        TextPreset(id: "display", title: "Display", sample: "Make it shine", fontFamily: "Instrument Serif", fontWeight: 400, italic: false, scale: 0.11, minSize: 40, letterSpacing: -0.02, textCase: "none", role: "headline", widthShare: 0.8, align: "center", lineHeight: 100),
        TextPreset(id: "heading", title: "Heading", sample: "Add a heading", fontFamily: "Inter", fontWeight: 700, italic: false, scale: 0.07, minSize: 28, letterSpacing: -0.01, textCase: "none", role: "headline", widthShare: 0.7, align: "center", lineHeight: 110),
        TextPreset(id: "subheading", title: "Subheading", sample: "Add a subheading", fontFamily: "Inter", fontWeight: 500, italic: false, scale: 0.042, minSize: 20, letterSpacing: 0, textCase: "none", role: "subhead", widthShare: 0.65, align: "center", lineHeight: 120),
        TextPreset(id: "body", title: "Body", sample: "Add a little bit of body text", fontFamily: "Inter", fontWeight: 400, italic: false, scale: 0.028, minSize: 14, letterSpacing: 0, textCase: "none", role: "body", widthShare: 0.6, align: "left", lineHeight: 150),
        TextPreset(id: "eyebrow", title: "Eyebrow", sample: "New collection", fontFamily: "Instrument Sans", fontWeight: 600, italic: false, scale: 0.022, minSize: 11, letterSpacing: 0.3, textCase: "upper", role: "eyebrow", widthShare: 0.5, align: "center", lineHeight: 120),
        TextPreset(id: "quote", title: "Quote", sample: "\u{201C}Design is the silent ambassador of your brand.\u{201D}", fontFamily: "Instrument Serif", fontWeight: 400, italic: true, scale: 0.05, minSize: 22, letterSpacing: 0, textCase: "none", role: "quote", widthShare: 0.7, align: "center", lineHeight: 120),
        TextPreset(id: "caption", title: "Caption", sample: "Add a caption", fontFamily: "Inter", fontWeight: 400, italic: false, scale: 0.02, minSize: 11, letterSpacing: 0.01, textCase: "none", role: "caption", widthShare: 0.5, align: "center", lineHeight: 140),
        TextPreset(id: "code", title: "Mono", sample: "desyn.app", fontFamily: "JetBrains Mono", fontWeight: 400, italic: false, scale: 0.024, minSize: 12, letterSpacing: 0, textCase: "none", role: "url", widthShare: 0.5, align: "left", lineHeight: 140),
    ]

    /// A text node for `preset` on a page of `pageSize`, centered on `center`.
    public static func text(_ preset: TextPreset, parent: String, center: PagePoint, pageWidth: Double, pageHeight: Double, color: String) -> Node {
        let size = preset.fontSize(pageWidth: pageWidth, pageHeight: pageHeight)
        let width = max(120, (pageWidth * preset.widthShare).rounded())
        var node = NodeFactory.text(
            parent: parent,
            text: preset.sample,
            origin: PagePoint(x: center.x - width / 2, y: center.y - size * 0.6),
            width: width,
            fontSize: size,
            fontWeight: preset.fontWeight,
            fontFamily: preset.fontFamily,
            color: color,
            align: preset.align,
            name: preset.title,
            role: preset.role
        )
        var style = node.textStyle ?? TextStyle.standard()
        style.set("letterSpacing", .number(preset.letterSpacing))
        style.set("textCase", .string(preset.textCase))
        if preset.italic { style.set("fontStyle", "italic") }
        node.set("style", style.jsonValue)
        var paragraph = node.paragraph ?? ParagraphStyle.standard(align: preset.align)
        paragraph.set("lineHeight", ["unit": "percent", "value": .number(preset.lineHeight)])
        node.set("paragraph", paragraph.jsonValue)
        node.height = (size * preset.lineHeight / 100).rounded()
        return node
    }

    // MARK: Charts

    public enum ChartKind: String, CaseIterable, Sendable, Identifiable {
        case column, bar, line, area, pie, donut, stackedColumn = "stacked-column", scatter, radar, funnel, progress

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .column: "Column"
            case .bar: "Bar"
            case .line: "Line"
            case .area: "Area"
            case .pie: "Pie"
            case .donut: "Donut"
            case .stackedColumn: "Stacked"
            case .scatter: "Scatter"
            case .radar: "Radar"
            case .funnel: "Funnel"
            case .progress: "Progress"
            }
        }

        public var systemImage: String {
            switch self {
            case .column: "chart.bar.fill"
            case .bar: "chart.bar.xaxis"
            case .line: "chart.xyaxis.line"
            case .area: "chart.line.uptrend.xyaxis"
            case .pie: "chart.pie.fill"
            case .donut: "circle.dashed.inset.filled"
            case .stackedColumn: "square.stack.3d.up.fill"
            case .scatter: "circle.grid.cross"
            case .radar: "hexagon"
            case .funnel: "line.3.horizontal.decrease"
            case .progress: "gauge.with.dots.needle.67percent"
            }
        }

        /// Starting data the person replaces in the inspector (labeled as such: "Series 1", "A", "B", ...).
        public var starterData: (labels: [String], series: [(name: String, values: [Double])]) {
            switch self {
            case .pie, .donut:
                (["A", "B", "C", "D"], [("Share", [40, 30, 20, 10])])
            case .funnel:
                (["Step 1", "Step 2", "Step 3", "Step 4"], [("Series 1", [100, 64, 38, 17])])
            case .progress:
                (["Progress"], [("Series 1", [72])])
            case .stackedColumn:
                (["A", "B", "C", "D"], [("Series 1", [12, 18, 15, 22]), ("Series 2", [8, 6, 11, 9])])
            case .radar:
                (["A", "B", "C", "D", "E"], [("Series 1", [7, 5, 8, 6, 9])])
            case .scatter:
                (["1", "2", "3", "4", "5", "6"], [("Series 1", [3, 7, 5, 9, 6, 11])])
            default:
                (["A", "B", "C", "D"], [("Series 1", [12, 18, 15, 22])])
            }
        }
    }

    /// A chart (`createChart` defaults) with starter data, `width` wide.
    public static func chart(_ kind: ChartKind, parent: String, center: PagePoint, width: Double, textColor: String) -> Node {
        let height = kind == .pie || kind == .donut || kind == .radar ? width : (kind == .progress ? width * 0.2 : width * 2 / 3)
        var json = base("chart", name: "\(kind.title) chart", parent: parent, frame: PageRect.centered(at: center, width: width, height: height.rounded()))
        let data = kind.starterData
        json["chart"] = .string(kind.rawValue)
        json["data"] = [
            "labels": .strings(data.labels),
            "series": .array(data.series.map { ["name": .string($0.name), "values": .array($0.values.map(JSONValue.number))] }),
        ]
        json["options"] = [
            "legend": .bool(data.series.count > 1 || kind == .pie || kind == .donut),
            "grid": .bool(kind != .pie && kind != .donut && kind != .progress && kind != .funnel),
            "labels": true,
            "palette": .strings(chartPalette),
            "fontFamily": "Inter",
            "fontSize": .number(max(10, (width / 34).rounded())),
            "textColor": .string(textColor),
        ]
        json["role"] = "chart"
        return Node(json: json)
    }

    /// Chart data as editable rows (`labels` x series).
    public struct ChartData: Equatable, Sendable {
        public var labels: [String]
        public var series: [(name: String, values: [Double])]

        public init(labels: [String], series: [(name: String, values: [Double])]) {
            self.labels = labels
            self.series = series
        }

        public init(node: Node) {
            let data = node.object("data") ?? [:]
            labels = (data["labels"]?.arrayValue ?? []).compactMap(\.stringValue)
            series = (data["series"]?.arrayValue ?? []).map { item in
                (item["name"]?.stringValue ?? "Series", (item["values"]?.arrayValue ?? []).map { $0.doubleValue ?? 0 })
            }
        }

        /// JSON for the `data` key: every series padded / trimmed to the label count; colors kept by series index.
        public func jsonValue(keeping original: Node? = nil) -> JSONValue {
            let originalSeries = original?.object("data")?["series"]?.arrayValue ?? []
            return [
                "labels": .strings(labels),
                "series": .array(series.enumerated().map { index, item in
                    var values = Array(item.values.prefix(labels.count))
                    while values.count < labels.count { values.append(0) }
                    var object: [String: JSONValue] = ["name": .string(item.name), "values": .array(values.map(JSONValue.number))]
                    if let color = originalSeries[safe: index]?["color"] { object["color"] = color }
                    return .object(object)
                }),
            ]
        }

        public static func == (lhs: ChartData, rhs: ChartData) -> Bool {
            lhs.labels == rhs.labels && lhs.series.map(\.name) == rhs.series.map(\.name) && lhs.series.map(\.values) == rhs.series.map(\.values)
        }
    }

    // MARK: Tables

    /// A table (`createTable` defaults) with a header row, sized to `width`.
    public static func table(rows: Int, cols: Int, parent: String, center: PagePoint, width: Double, textColor: String, accent: String) -> Node {
        let rows = max(1, min(40, rows))
        let cols = max(1, min(12, cols))
        let colWidth = (width / Double(cols)).rounded()
        let fontSize = max(11, (colWidth / 9).rounded())
        let rowHeight = (fontSize * 2.6).rounded()
        var json = base("table", name: "Table", parent: parent, frame: PageRect.centered(at: center, width: colWidth * Double(cols), height: rowHeight * Double(rows)))
        var cells: [JSONValue] = []
        for r in 0..<rows {
            for c in 0..<cols {
                var cell: [String: JSONValue] = ["r": .int(r), "c": .int(c), "text": .string(r == 0 ? "Heading \(c + 1)" : "")]
                if r == 0 {
                    cell["fill"] = Fill.solid(.hex(accent)).jsonValue
                    cell["style"] = ["fontWeight": 600, "fills": .array([Fill.solid(.hex("#111111")).jsonValue])]
                }
                cells.append(.object(cell))
            }
        }
        json["rows"] = .int(rows)
        json["cols"] = .int(cols)
        json["colWidths"] = .array(Array(repeating: .number(colWidth), count: cols))
        json["rowHeights"] = .array(Array(repeating: .number(rowHeight), count: rows))
        json["cells"] = .array(cells)
        json["header"] = true
        json["stripe"] = true
        json["borderColor"] = "#d9d9d9"
        json["borderWidth"] = 1
        json["cellPadding"] = .number((fontSize * 0.6).rounded())
        json["defaultStyle"] = TextStyle.standard(fontFamily: "Inter", fontWeight: 400, fontSize: fontSize, color: textColor).jsonValue
        json["role"] = "table"
        return Node(json: json)
    }

    /// Table cell texts as a grid (`[row][col]`).
    public static func tableTexts(_ node: Node) -> [[String]] {
        let rows = node.json["rows"]?.intValue ?? 0
        let cols = node.json["cols"]?.intValue ?? 0
        var grid = Array(repeating: Array(repeating: "", count: cols), count: rows)
        for cell in node.json["cells"]?.arrayValue ?? [] {
            guard let r = cell["r"]?.intValue, let c = cell["c"]?.intValue, grid.indices.contains(r), grid[r].indices.contains(c) else { continue }
            grid[r][c] = cell["text"]?.stringValue ?? ""
        }
        return grid
    }

    /// Sets one cell's text (creating the cell entry when missing).
    public static func setTableCell(row: Int, col: Int, text: String, on node: Node) -> [Op] {
        var cells = node.json["cells"]?.arrayValue ?? []
        if let index = cells.firstIndex(where: { $0["r"]?.intValue == row && $0["c"]?.intValue == col }) {
            return [.patch(id: node.id, path: [.key("cells"), .index(index), .key("text")], value: .string(text))]
        }
        cells.append(["r": .int(row), "c": .int(col), "text": .string(text)])
        return [.update(id: node.id, set: ["cells": .array(cells)], unset: [])]
    }

    /// Adds or removes the last row / column, keeping cell contents and the box size per row / column.
    public static func resizeTable(rows newRows: Int, cols newCols: Int, on node: Node) -> [Op] {
        let rows = node.json["rows"]?.intValue ?? 1
        let cols = node.json["cols"]?.intValue ?? 1
        let targetRows = max(1, min(40, newRows))
        let targetCols = max(1, min(12, newCols))
        guard targetRows != rows || targetCols != cols else { return [] }
        var rowHeights = (node.json["rowHeights"]?.arrayValue ?? []).compactMap(\.doubleValue)
        var colWidths = (node.json["colWidths"]?.arrayValue ?? []).compactMap(\.doubleValue)
        let lastRow = rowHeights.last ?? 40
        let lastCol = colWidths.last ?? 120
        while rowHeights.count < targetRows { rowHeights.append(lastRow) }
        while colWidths.count < targetCols { colWidths.append(lastCol) }
        rowHeights = Array(rowHeights.prefix(targetRows))
        colWidths = Array(colWidths.prefix(targetCols))
        let cells = (node.json["cells"]?.arrayValue ?? []).filter { cell in
            (cell["r"]?.intValue ?? 0) < targetRows && (cell["c"]?.intValue ?? 0) < targetCols
        }
        return [.update(id: node.id, set: [
            "rows": .int(targetRows),
            "cols": .int(targetCols),
            "rowHeights": .array(rowHeights.map(JSONValue.number)),
            "colWidths": .array(colWidths.map(JSONValue.number)),
            "cells": .array(cells),
            "width": .number(colWidths.reduce(0, +)),
            "height": .number(rowHeights.reduce(0, +)),
        ], unset: [])]
    }

    // MARK: QR codes

    /// A QR code (`createQr` defaults) for `data`.
    public static func qr(data: String, parent: String, center: PagePoint, side: Double, foreground: String = "#000000", background: String = "#ffffff") -> Node {
        var json = base("qr", name: "QR code", parent: parent, frame: PageRect.centered(at: center, width: side, height: side))
        json["data"] = .string(data)
        json["fg"] = .string(foreground)
        json["bg"] = .string(background)
        json["errorCorrection"] = "M"
        json["rounded"] = false
        json["role"] = "qr"
        return Node(json: json)
    }

    /// Normalizes what people type into a QR payload: bare domains become https URLs, emails mailto:, phone numbers
    /// tel:; anything else stays text.
    public static func qrPayload(_ input: String) -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let lower = trimmed.lowercased()
        let schemes = ["http://", "https://", "mailto:", "tel:", "sms:", "wifi:", "geo:", "bitcoin:", "upi:"]
        if schemes.contains(where: { lower.hasPrefix($0) }) { return trimmed }
        if !trimmed.contains(" "), trimmed.contains("@"), trimmed.contains("."), !trimmed.hasPrefix("@") {
            return "mailto:\(trimmed)"
        }
        let digits = trimmed.filter { $0.isNumber }
        if digits.count >= 7, trimmed.allSatisfy({ $0.isNumber || "+-() ".contains($0) }) {
            return "tel:\(trimmed.filter { $0.isNumber || $0 == "+" })"
        }
        if !trimmed.contains(" "), trimmed.contains("."), let dot = trimmed.lastIndex(of: "."),
           trimmed.distance(from: dot, to: trimmed.endIndex) >= 3
        {
            return "https://\(trimmed)"
        }
        return trimmed
    }

    // MARK: Icons and vectors

    /// An inline SVG node (`createSvg`) for icon or AI vector markup, keeping the markup's aspect ratio.
    public static func svg(markup: String, name: String, parent: String, center: PagePoint, side: Double) -> Node {
        let ratio = SVGMarkup.aspectRatio(markup) ?? 1
        let width = ratio >= 1 ? side : side * ratio
        let height = ratio >= 1 ? side / ratio : side
        var json = base("svg", name: name, parent: parent, frame: PageRect.centered(at: center, width: width.rounded(), height: height.rounded()))
        json["markup"] = .string(markup)
        json["role"] = "icon"
        return Node(json: json)
    }

    /// An image node for a generated or library asset, fitted inside `maxSide` and centered.
    public static func image(assetId: String, pixelWidth: Double?, pixelHeight: Double?, parent: String, center: PagePoint, maxSide: Double, name: String) -> Node {
        let w = max(1, pixelWidth ?? maxSide)
        let h = max(1, pixelHeight ?? maxSide)
        let fit = min(maxSide / w, maxSide / h)
        return NodeFactory.image(
            parent: parent,
            assetId: assetId,
            frame: PageRect.centered(at: center, width: (w * fit).rounded(), height: (h * fit).rounded()),
            name: name
        )
    }
}

/// Small helpers for SVG markup (sizing only; Convex sanitizes markup on commit).
public enum SVGMarkup {
    /// width / height from `viewBox` (or `width` / `height` attributes) of the root element.
    public static func aspectRatio(_ markup: String) -> Double? {
        if let viewBox = attribute("viewBox", in: markup) {
            let numbers = viewBox.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
            if numbers.count == 4, numbers[2] > 0, numbers[3] > 0 { return numbers[2] / numbers[3] }
        }
        if let w = attribute("width", in: markup).flatMap(leadingNumber), let h = attribute("height", in: markup).flatMap(leadingNumber), w > 0, h > 0 {
            return w / h
        }
        return nil
    }

    /// Value of `name="..."` on the root `<svg>` element.
    static func attribute(_ name: String, in markup: String) -> String? {
        guard let open = markup.range(of: "<svg"), let close = markup[open.upperBound...].firstIndex(of: ">") else { return nil }
        let tag = markup[open.upperBound..<close]
        for quote in ["\"", "'"] {
            if let start = tag.range(of: " \(name)=\(quote)") ?? tag.range(of: "\n\(name)=\(quote)") ?? tag.range(of: "\t\(name)=\(quote)") {
                let rest = tag[start.upperBound...]
                if let end = rest.firstIndex(of: Character(quote)) { return String(rest[..<end]) }
            }
        }
        return nil
    }

    static func leadingNumber(_ value: String) -> Double? {
        let digits = value.prefix { $0.isNumber || $0 == "." }
        return Double(digits)
    }

    /// Replaces `currentColor` with `hex` (Iconify icons draw with currentColor).
    public static func tinted(_ markup: String, hex: String) -> String {
        markup.replacingOccurrences(of: "currentColor", with: hex)
    }

    /// Rejects markup that can never pass the server sanitizer (scripts, foreign objects, event handlers).
    public static func isPlausiblySafe(_ markup: String) -> Bool {
        let lower = markup.lowercased()
        guard lower.contains("<svg") else { return false }
        let banned = ["<script", "<foreignobject", "javascript:", " onload=", " onclick=", " onerror=", "<iframe"]
        return !banned.contains { lower.contains($0) }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
