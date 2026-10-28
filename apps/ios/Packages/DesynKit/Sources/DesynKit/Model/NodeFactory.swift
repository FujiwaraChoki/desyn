import Foundation

/// Valid nodes with the same defaults as the @desyn/schema factories (`createRect`, `createText`, ...).
/// `parent` is set by the `create` op that inserts the subtree.
public enum NodeFactory {
    public static let defaultShapeColor = "#d9d9d9"
    public static let defaultTextColor = "#111111"
    public static let defaultFontFamily = "Inter"

    /// Fields every node shares (schema `base()`).
    static func base(type: NodeType, name: String, id: String, parent: String, frame: PageRect) -> [String: JSONValue] {
        [
            "id": .string(id),
            "type": .string(type.rawValue),
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

    static func shaped(_ color: String) -> [String: JSONValue] {
        ["fills": .array([Fill.solid(.hex(color)).jsonValue]), "strokes": [], "cornerRadius": 0]
    }

    /// A page (`createPage`): white background, clipping, no bleed unless given.
    public static func page(
        id: String = DesynID.new(),
        name: String = "Page",
        width: Double,
        height: Double,
        unit: PageUnit = .px,
        bleed: Double = 0,
        background: String = "#ffffff"
    ) -> Node {
        var json = base(type: .page, name: name, id: id, parent: Design.rootID, frame: PageRect(x: 0, y: 0, width: width, height: height))
        json["children"] = []
        json["clip"] = true
        json["unit"] = .string(unit.rawValue)
        json["background"] = .array([Fill.solid(.hex(background)).jsonValue])
        json["bleed"] = .number(bleed)
        return Node(json: json)
    }

    /// A rectangle (`createRect`).
    public static func rect(id: String = DesynID.new(), parent: String, frame: PageRect, color: String = defaultShapeColor, cornerRadius: Double = 0) -> Node {
        var json = base(type: .rect, name: "Rectangle", id: id, parent: parent, frame: frame)
        json.merge(shaped(color)) { _, new in new }
        json["cornerRadius"] = .number(cornerRadius)
        return Node(json: json)
    }

    /// An ellipse (`createEllipse`).
    public static func ellipse(id: String = DesynID.new(), parent: String, frame: PageRect, color: String = defaultShapeColor) -> Node {
        var json = base(type: .ellipse, name: "Ellipse", id: id, parent: parent, frame: frame)
        json.merge(shaped(color)) { _, new in new }
        return Node(json: json)
    }

    /// A polygon / triangle (`createPolygon`).
    public static func polygon(id: String = DesynID.new(), parent: String, frame: PageRect, sides: Int = 3, color: String = defaultShapeColor) -> Node {
        var json = base(type: .polygon, name: sides == 3 ? "Triangle" : "Polygon", id: id, parent: parent, frame: frame)
        json.merge(shaped(color)) { _, new in new }
        json["sides"] = .int(max(3, sides))
        return Node(json: json)
    }

    /// A star (`createStar`).
    public static func star(id: String = DesynID.new(), parent: String, frame: PageRect, color: String = defaultShapeColor) -> Node {
        var json = base(type: .star, name: "Star", id: id, parent: parent, frame: frame)
        json.merge(shaped(color)) { _, new in new }
        json["points"] = 5
        json["innerRatio"] = 0.382
        return Node(json: json)
    }

    /// A line along +x (`createLine`): height 0, 2 px stroke.
    public static func line(id: String = DesynID.new(), parent: String, from: PagePoint, length: Double, color: String = defaultTextColor) -> Node {
        var json = base(type: .line, name: "Line", id: id, parent: parent, frame: PageRect(x: from.x, y: from.y, width: length, height: 0))
        json["strokes"] = .array([Stroke(color: .hex(color), width: 2).jsonValue])
        json["startCap"] = "none"
        json["endCap"] = "none"
        return Node(json: json)
    }

    /// A text box (`createText`): auto height, fixed width.
    public static func text(
        id: String = DesynID.new(),
        parent: String,
        text: String,
        origin: PagePoint,
        width: Double = 320,
        fontSize: Double = 24,
        fontWeight: Double = 400,
        fontFamily: String = defaultFontFamily,
        color: String = defaultTextColor,
        align: String = "left",
        name: String = "Text",
        role: String? = nil
    ) -> Node {
        let height = (fontSize * 1.2).rounded()
        var json = base(type: .text, name: name, id: id, parent: parent, frame: PageRect(x: origin.x, y: origin.y, width: width, height: height))
        json["runs"] = .array([TextRun(text: text).jsonValue])
        json["style"] = TextStyle.standard(fontFamily: fontFamily, fontWeight: fontWeight, fontSize: fontSize, color: color).jsonValue
        json["paragraph"] = ParagraphStyle.standard(align: align).jsonValue
        json["autoResize"] = "height"
        json["verticalAlign"] = "top"
        if let role { json["role"] = .string(role) }
        return Node(json: json)
    }

    /// An image (`createImage`) showing asset `assetId`, filling its box.
    public static func image(id: String = DesynID.new(), parent: String, assetId: String, frame: PageRect, name: String = "Image") -> Node {
        var json = base(type: .image, name: name, id: id, parent: parent, frame: frame)
        json["assetId"] = .string(assetId)
        json["fit"] = "fill"
        json["cornerRadius"] = 0
        json["strokes"] = []
        json["role"] = "photo"
        return Node(json: json)
    }

    /// A filled vector path (`createPath`); `d` is in the node's local box (0...width, 0...height).
    public static func path(id: String = DesynID.new(), parent: String, frame: PageRect, d: String, color: String, name: String = "Drawing") -> Node {
        var json = base(type: .path, name: name, id: id, parent: parent, frame: frame)
        json.merge(shaped(color)) { _, new in new }
        json["paths"] = .array([["d": .string(d), "fillRule": "nonzero"]])
        return Node(json: json)
    }

    /// A copy of a subtree with fresh ids (duplicate / paste). Returns the nodes in `create` order (root first)
    /// and the id map.
    public static func cloneSubtree(_ nodes: [Node], offset: PagePoint = PagePoint(x: 0, y: 0)) -> (nodes: [Node], ids: [String: String]) {
        var ids: [String: String] = [:]
        for node in nodes {
            ids[node.id] = DesynID.new()
        }
        let cloned = nodes.enumerated().map { index, node -> Node in
            var json = node.json
            json["id"] = .string(ids[node.id] ?? DesynID.new())
            if let parent = node.parent, let mapped = ids[parent] {
                json["parent"] = .string(mapped)
            }
            if let children = json["children"]?.arrayValue {
                json["children"] = .array(children.compactMap(\.stringValue).map { .string(ids[$0] ?? $0) })
            }
            if index == 0 {
                json["x"] = .number(node.x + offset.x)
                json["y"] = .number(node.y + offset.y)
                if !node.name.isEmpty { json["name"] = .string(node.name) }
            }
            return Node(json: json)
        }
        return (cloned, ids)
    }
}

/// Plain geometry used by the model layer (independent of CoreGraphics so the kit builds anywhere).
public struct PagePoint: Hashable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct PageRect: Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var midX: Double { x + width / 2 }
    public var midY: Double { y + height / 2 }

    /// A rectangle of `size` centered on `center`.
    public static func centered(at center: PagePoint, width: Double, height: Double) -> PageRect {
        PageRect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
    }

    /// Smallest rectangle containing both points.
    public static func spanning(_ a: PagePoint, _ b: PagePoint) -> PageRect {
        PageRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }
}
