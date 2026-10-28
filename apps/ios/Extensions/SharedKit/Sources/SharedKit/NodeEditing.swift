import DesynKit
import Foundation

/// Op builders for the inspector. Every function is pure: it reads the nodes as they are and returns the ops of one
/// edit, so the same builder serves the live preview and the final commit. Values are clamped to the ranges of
/// docs/DOCUMENT_MODEL.md.
public enum NodeEditing {
    // MARK: Paint

    /// Where a node's main color lives.
    public enum PaintSlot: Equatable, Sendable {
        /// `fills` of shaped nodes and frames.
        case fills
        /// `style.fills` of text.
        case textFills
        /// `background` of pages.
        case background
        /// `strokes[0].fills` of lines (a line has no fill).
        case lineStroke
    }

    public static func paintSlot(for node: Node) -> PaintSlot? {
        switch node.type {
        case .text: .textFills
        case .page: .background
        case .line: .lineStroke
        case .rect, .ellipse, .polygon, .star, .path, .frame, .boolean: .fills
        default: node.json["fills"] != nil ? .fills : nil
        }
    }

    /// The paint layers of `node` in its slot (bottom to top).
    public static func paints(of node: Node) -> [Fill] {
        switch paintSlot(for: node) {
        case .fills: node.fills
        case .textFills: node.textStyle?.fills ?? []
        case .background: node.background
        case .lineStroke: node.strokes.first?.fills ?? []
        case nil: []
        }
    }

    /// Replaces the paint layers of `node`.
    public static func setPaints(_ fills: [Fill], on node: Node) -> [Op] {
        let value = JSONValue.array(fills.map(\.jsonValue))
        switch paintSlot(for: node) {
        case .fills:
            return [.update(id: node.id, set: ["fills": value], unset: [])]
        case .textFills:
            return setTextStyle("fills", value, on: node)
        case .background:
            return [.update(id: node.id, set: ["background": value], unset: [])]
        case .lineStroke:
            var strokes = node.strokes
            if strokes.isEmpty {
                strokes = [Stroke(color: .hex(NodeFactory.defaultTextColor), width: 2)]
            }
            strokes[0].set("fills", value)
            return [.update(id: node.id, set: ["strokes": .array(strokes.map(\.jsonValue))], unset: [])]
        case nil:
            return []
        }
    }

    /// Sets the solid color of every node (the first paint layer becomes solid; layers above it are kept).
    public static func setSolidColor(_ hex: String, opacity: Double? = nil, on nodes: [Node]) -> [Op] {
        nodes.flatMap { node -> [Op] in
            guard paintSlot(for: node) != nil else { return [] }
            var fills = paints(of: node)
            var solid = Fill.solid(.hex(hex.lowercased()))
            if let opacity { solid.opacity = opacity } else if let first = fills.first { solid.opacity = first.opacity }
            if fills.isEmpty {
                fills = [solid]
            } else {
                fills[0] = solid
            }
            return setPaints(fills, on: node)
        }
    }

    /// A linear gradient (`angle` degrees, 0 = left to right per the schema's CSS-like convention of the renderer).
    public static func linearGradient(angle: Double, stops: [(pos: Double, hex: String)]) -> Fill {
        Fill.linear(angle: angle, stops: stops.map { GradientStop(pos: min(1, max(0, $0.pos)), color: .hex($0.hex.lowercased())) })
    }

    /// A centered radial gradient.
    public static func radialGradient(stops: [(pos: Double, hex: String)]) -> Fill {
        Fill(json: [
            "type": "radial", "cx": 0.5, "cy": 0.5, "rx": 0.5, "ry": 0.5,
            "stops": .array(stops.map { GradientStop(pos: min(1, max(0, $0.pos)), color: .hex($0.hex.lowercased())).jsonValue }),
        ])
    }

    /// Stops of a gradient as (pos, hex) pairs (references resolve to nil and are skipped).
    public static func stops(of fill: Fill) -> [(pos: Double, hex: String)] {
        fill.stops.compactMap { stop in stop.color?.hex.map { (stop.pos, $0) } }.sorted { $0.pos < $1.pos }
    }

    // MARK: Strokes

    /// The node's strokes slot exists (shapes, frames, lines, images, svg, text outlines).
    public static func supportsStroke(_ node: Node) -> Bool {
        switch node.type {
        case .rect, .ellipse, .polygon, .star, .path, .frame, .boolean, .line, .image, .svg, .text: true
        default: false
        }
    }

    /// Sets the first stroke (creating it when missing).
    public static func setStroke(color: String, width: Double, align: String? = nil, dash: [Double]? = nil, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node -> Op? in
            guard supportsStroke(node) else { return nil }
            var strokes = node.strokes
            var stroke = strokes.first ?? Stroke(color: .hex(color), width: width, align: node.type == .text ? "outside" : "inside")
            stroke.set("fills", .array([Fill.solid(.hex(color.lowercased())).jsonValue]))
            stroke.width = max(0, min(500, width))
            if let align { stroke.set("align", .string(align)) }
            if let dash { stroke.set("dash", dash.isEmpty ? nil : .array(dash.map { .number(max(0, $0)) })) }
            if strokes.isEmpty { strokes = [stroke] } else { strokes[0] = stroke }
            return .update(id: node.id, set: ["strokes": .array(strokes.map(\.jsonValue))], unset: [])
        }
    }

    /// Removes every stroke (lines keep theirs: a line without a stroke is invisible).
    public static func removeStrokes(on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard supportsStroke(node), node.type != .line, !node.strokes.isEmpty else { return nil }
            return .update(id: node.id, set: ["strokes": []], unset: [])
        }
    }

    /// Line end caps (`none | arrow | triangle | circle | square | diamond | bar`).
    public static func setLineCaps(start: String?, end: String?, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.type == .line else { return nil }
            var set: [String: JSONValue] = [:]
            if let start { set["startCap"] = .string(start) }
            if let end { set["endCap"] = .string(end) }
            return set.isEmpty ? nil : .update(id: node.id, set: set, unset: [])
        }
    }

    // MARK: Effects

    public enum EffectKind: String, CaseIterable, Sendable {
        case dropShadow, innerShadow, layerBlur, backgroundBlur, glow, noise

        /// Effects of the plan feature `effects.advanced` (the web editor gates the same four).
        public var isAdvanced: Bool {
            switch self {
            case .innerShadow, .backgroundBlur, .glow, .noise: true
            case .dropShadow, .layerBlur: false
            }
        }

        public var title: String {
            switch self {
            case .dropShadow: "Drop shadow"
            case .innerShadow: "Inner shadow"
            case .layerBlur: "Blur"
            case .backgroundBlur: "Background blur"
            case .glow: "Glow"
            case .noise: "Grain"
            }
        }

        /// A tasteful default (soft shadow, sun glow).
        public var defaultEffect: Effect {
            switch self {
            case .dropShadow: Effect.dropShadow(x: 0, y: 12, blur: 32, spread: 0, color: "#00000059")
            case .innerShadow:
                Effect(json: ["type": "innerShadow", "x": 0, "y": 2, "blur": 8, "spread": 0, "color": "#00000040"])
            case .layerBlur: Effect(json: ["type": "layerBlur", "radius": 8])
            case .backgroundBlur: Effect(json: ["type": "backgroundBlur", "radius": 20])
            case .glow: Effect(json: ["type": "glow", "radius": 24, "strength": 0.6, "color": "#ffb02e"])
            case .noise: Effect(json: ["type": "noise", "amount": 0.15, "scale": 1, "mono": true])
            }
        }
    }

    public static func addEffect(_ kind: EffectKind, on nodes: [Node]) -> [Op] {
        nodes.map { node in
            .update(id: node.id, set: ["effects": .array((node.effects + [kind.defaultEffect]).map(\.jsonValue))], unset: [])
        }
    }

    /// Sets field `key` of effect `index` (same index on every node that has it).
    public static func setEffect(index: Int, key: String, value: JSONValue, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.effects.indices.contains(index) else { return nil }
            return .patch(id: node.id, path: [.key("effects"), .index(index), .key(key)], value: value)
        }
    }

    public static func removeEffect(index: Int, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            var effects = node.effects
            guard effects.indices.contains(index) else { return nil }
            effects.remove(at: index)
            return .update(id: node.id, set: ["effects": .array(effects.map(\.jsonValue))], unset: [])
        }
    }

    // MARK: Appearance

    public static func setOpacity(_ value: Double, on nodes: [Node]) -> [Op] {
        nodes.map { .update(id: $0.id, set: ["opacity": .number(min(1, max(0, value)))], unset: []) }
    }

    public static let blendModes = [
        "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light",
        "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
    ]

    public static func setBlend(_ mode: String, on nodes: [Node]) -> [Op] {
        guard blendModes.contains(mode) else { return [] }
        return nodes.map { .update(id: $0.id, set: ["blend": .string(mode)], unset: []) }
    }

    /// Uniform radius, or per corner (tl, tr, br, bl).
    public static func setCornerRadius(_ radius: CornerRadius, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.json["cornerRadius"] != nil else { return nil }
            let clamped: CornerRadius
            switch radius {
            case let .uniform(value): clamped = .uniform(max(0, value.rounded()))
            case let .corners(tl, tr, br, bl):
                clamped = .corners(max(0, tl.rounded()), max(0, tr.rounded()), max(0, br.rounded()), max(0, bl.rounded()))
            }
            return .update(id: node.id, set: ["cornerRadius": clamped.jsonValue], unset: [])
        }
    }

    public static func setCornerSmoothing(_ value: Double, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.json["cornerRadius"] != nil, node.type != .image else { return nil }
            return .update(id: node.id, set: ["cornerSmoothing": .number(min(1, max(0, value)))], unset: [])
        }
    }

    public static func setFlag(_ key: String, _ value: Bool, on nodes: [Node]) -> [Op] {
        nodes.map { .update(id: $0.id, set: [key: .bool(value)], unset: []) }
    }

    // MARK: Text

    /// Sets `style.<key>` and drops run-level overrides of the same key, so the change shows everywhere in the box.
    public static func setTextStyle(_ key: String, _ value: JSONValue, on node: Node) -> [Op] {
        setTextStyles([key: value], on: node)
    }

    /// Sets several `style` keys at once; runs are rewritten once, without overrides of any of those keys.
    public static func setTextStyles(_ values: [String: JSONValue], on node: Node) -> [Op] {
        guard node.type == .text, !values.isEmpty else { return [] }
        var ops: [Op] = values.keys.sorted().map { key in
            .patch(id: node.id, path: [.key("style"), .key(key)], value: values[key]!)
        }
        let runs = node.runs
        if runs.contains(where: { run in values.keys.contains { run.style?[$0] != nil } }) {
            let cleaned = runs.map { run -> TextRun in
                guard var style = run.style else { return run }
                for key in values.keys { style[key] = nil }
                var copy = run
                copy.set("style", style.isEmpty ? nil : .object(style))
                return copy
            }
            ops.append(.update(id: node.id, set: ["runs": .array(cleaned.map(\.jsonValue))], unset: []))
        }
        return ops
    }

    public static func setTextStyle(_ key: String, _ value: JSONValue, on nodes: [Node]) -> [Op] {
        nodes.flatMap { setTextStyle(key, value, on: $0) }
    }

    public static func setParagraph(_ key: String, _ value: JSONValue, on nodes: [Node]) -> [Op] {
        nodes.filter { $0.type == .text }.map { .patch(id: $0.id, path: [.key("paragraph"), .key(key)], value: value) }
    }

    public static func setTextField(_ key: String, _ value: JSONValue, on nodes: [Node]) -> [Op] {
        nodes.filter { $0.type == .text }.map { .update(id: $0.id, set: [key: value], unset: []) }
    }

    /// Font family + weight (+ italic) in one edit.
    public static func setFont(family: String, weight: Double?, italic: Bool?, on nodes: [Node]) -> [Op] {
        nodes.flatMap { node -> [Op] in
            var values: [String: JSONValue] = ["fontFamily": .string(family)]
            if let weight { values["fontWeight"] = .number(weight) }
            if let italic { values["fontStyle"] = .string(italic ? "italic" : "normal") }
            return setTextStyles(values, on: node)
        }
    }

    /// Line height: `auto`, or a percent of the size.
    public static func setLineHeight(percent: Double?, on nodes: [Node]) -> [Op] {
        let value: JSONValue = percent.map { ["unit": "percent", "value": .number(max(50, min(400, $0.rounded())))] } ?? ["unit": "auto", "value": 0]
        return setParagraph("lineHeight", value, on: nodes)
    }

    /// Text presets (Heading, Body, ...) and named text styles: style keys + paragraph keys + an optional styleRef.
    public static func applyTextStyle(_ style: [String: JSONValue], paragraph: [String: JSONValue] = [:], styleRef: String? = nil, on nodes: [Node]) -> [Op] {
        nodes.flatMap { node -> [Op] in
            guard node.type == .text else { return [] }
            var ops = setTextStyles(style, on: node)
            for (key, value) in paragraph.sorted(by: { $0.key < $1.key }) {
                ops.append(.patch(id: node.id, path: [.key("paragraph"), .key(key)], value: value))
            }
            if let styleRef {
                ops.append(.update(id: node.id, set: ["styleRef": .string(styleRef)], unset: []))
            } else if node.string("styleRef") != nil {
                ops.append(.update(id: node.id, set: [:], unset: ["styleRef"]))
            }
            return ops
        }
    }

    // MARK: Images

    public static let imageFilters = [
        "vivid", "warm", "cool", "mono", "noir", "vintage", "fade", "dramatic", "film", "sunset", "matte", "chrome",
        "lush", "dusk",
    ]

    /// `ImageAdjust` with every field (schema defaults) merged with the node's current values.
    public static func adjustments(of node: Node) -> [String: JSONValue] {
        var adjust: [String: JSONValue] = [
            "brightness": 0, "contrast": 0, "saturation": 0, "hue": 0, "temperature": 0, "tint": 0, "exposure": 0,
            "vignette": 0, "blur": 0, "grayscale": 0, "sepia": 0, "sharpen": 0, "grain": 0,
        ]
        for (key, value) in node.object("adjust") ?? [:] {
            adjust[key] = value
        }
        return adjust
    }

    /// Sets one image adjustment (or `filter`, nil removes it).
    public static func setAdjustment(_ key: String, _ value: JSONValue?, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.type == .image else { return nil }
            var adjust = adjustments(of: node)
            adjust[key] = value
            return .update(id: node.id, set: ["adjust": .object(adjust)], unset: [])
        }
    }

    public static func resetAdjustments(on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.type == .image, node.json["adjust"] != nil else { return nil }
            return .update(id: node.id, set: [:], unset: ["adjust"])
        }
    }

    /// `fill | fit | crop | tile`.
    public static func setImageFit(_ fit: String, on nodes: [Node]) -> [Op] {
        nodes.compactMap { node in
            guard node.type == .image || node.type == .video else { return nil }
            return .update(id: node.id, set: ["fit": .string(fit)], unset: [])
        }
    }

    // MARK: Layout options

    public static func setConstraints(h: String?, v: String?, on nodes: [Node]) -> [Op] {
        nodes.map { node in
            let current = node.object("constraints") ?? [:]
            let value: JSONValue = [
                "h": .string(h ?? current["h"]?.stringValue ?? "left"),
                "v": .string(v ?? current["v"]?.stringValue ?? "top"),
            ]
            return .update(id: node.id, set: ["constraints": value], unset: [])
        }
    }

    // MARK: Animation

    public static let animationPresets = [
        "fade", "rise", "drop", "slide-left", "slide-right", "zoom-in", "zoom-out", "pop", "rotate", "wipe", "typewriter",
        "pulse", "float", "shake", "blur-in",
    ]

    /// Presets that loop (emphasis) rather than enter or exit.
    public static let loopPresets: Set<String> = ["pulse", "float", "shake"]

    public static let easings = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "spring"]

    /// The animations of `node` (DOCUMENT_MODEL `Animation`).
    public static func animations(of node: Node) -> [[String: JSONValue]] {
        (node.json["anim"]?.arrayValue ?? []).compactMap(\.objectValue)
    }

    /// Replaces the animation of `phase` (`in` | `out` | `loop`) with `preset`, or removes it (`nil`).
    public static func setAnimation(phase: String, preset: String?, durationMs: Double? = nil, startMs: Double? = nil, easing: String? = nil, on nodes: [Node]) -> [Op] {
        nodes.map { node in
            var list = animations(of: node)
            let existing = list.firstIndex { $0["phase"]?.stringValue == phase }
            if let preset {
                var anim: [String: JSONValue] = existing.map { list[$0] } ?? [
                    "id": .string(DesynID.new()),
                    "phase": .string(phase),
                    "startMs": .number(phase == "out" ? 2000 : 0),
                    "durationMs": .number(phase == "loop" ? 1200 : 600),
                    "easing": .string(preset == "pop" ? "spring" : "ease-out"),
                ]
                anim["preset"] = .string(preset)
                if let durationMs { anim["durationMs"] = .number(max(50, min(60000, durationMs.rounded()))) }
                if let startMs { anim["startMs"] = .number(max(0, min(600_000, startMs.rounded()))) }
                if let easing, easings.contains(easing) { anim["easing"] = .string(easing) }
                if let existing { list[existing] = anim } else { list.append(anim) }
            } else if let existing {
                list.remove(at: existing)
            }
            if list.isEmpty {
                return .update(id: node.id, set: [:], unset: ["anim"])
            }
            return .update(id: node.id, set: ["anim": .array(list.map(JSONValue.object))], unset: [])
        }
    }

    /// Page transition (`none | fade | slide | push | zoom | dissolve`) and auto-advance duration.
    public static func setPageTransition(kind: String, durationMs: Double, on page: Node) -> [Op] {
        guard page.type == .page else { return [] }
        if kind == "none" {
            return [.update(id: page.id, set: [:], unset: ["transition"])]
        }
        return [.update(id: page.id, set: ["transition": ["kind": .string(kind), "durationMs": .number(max(100, min(5000, durationMs.rounded())))]], unset: [])]
    }

    public static func setPageDuration(_ ms: Double?, on page: Node) -> [Op] {
        guard page.type == .page else { return [] }
        guard let ms else { return [.update(id: page.id, set: [:], unset: ["durationMs"])] }
        return [.update(id: page.id, set: ["durationMs": .number(max(500, min(600_000, ms.rounded())))], unset: [])]
    }
}
