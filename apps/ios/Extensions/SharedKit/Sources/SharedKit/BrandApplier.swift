import DesynKit
import Foundation

/// Restyles a page with a brand kit without a model call: headings and body text take the kit's fonts, the page's
/// accent colors map onto the kit's colors (most used first, in role order), the background follows the kit's
/// background color, and text keeps a readable contrast. The kit is attached to the design and its colors are added
/// to the design's named colors. (For a judgment-based restyle the AI dock runs `apply_brand`.)
public enum BrandApplier {
    public struct Result: Equatable, Sendable {
        public let ops: [Op]
        public let recolored: Int
        public let refonted: Int
    }

    /// Roles that make a text a heading.
    static let headingRoles: Set<String> = ["headline", "hero", "subhead", "eyebrow", "slide-title", "quote", "stat", "price", "cta", "button", "logo"]

    /// Kit colors used for accents, in role priority order.
    static func accentPalette(_ colors: [BrandKitDetail.BrandColor]) -> [String] {
        let priority = ["primary", "secondary", "accent", "highlight", "brand"]
        let usable = colors.filter { color in
            guard let role = color.role?.lowercased() else { return true }
            return role != "background" && role != "text" && role != "neutral"
        }
        let sorted = usable.sorted { lhs, rhs in
            let li = priority.firstIndex(of: lhs.role?.lowercased() ?? "") ?? priority.count
            let ri = priority.firstIndex(of: rhs.role?.lowercased() ?? "") ?? priority.count
            return li < ri
        }
        var seen = Set<String>()
        return sorted.map { $0.value.lowercased() }.filter { RGBA(hex: $0) != nil && seen.insert($0).inserted }
    }

    static func roleColor(_ role: String, in colors: [BrandKitDetail.BrandColor]) -> String? {
        colors.first { $0.role?.lowercased() == role }.map { $0.value.lowercased() }.flatMap { RGBA(hex: $0) != nil ? $0 : nil }
    }

    static func isNeutral(_ hex: String) -> Bool {
        guard let color = RGBA(hex: hex) else { return true }
        return color.hsv.s < 0.12 || color.hsv.v < 0.08
    }

    /// Ops that apply `kit` to `page` and its descendants (`nodes` = the page subtree, page first). `design` gives the
    /// existing named colors so applying twice adds nothing twice.
    public static func apply(_ kit: BrandKitDetail, page: Node, nodes: [Node], existingStyleColors: [(id: String, name: String, value: String)], brandKitId: String) -> Result {
        var ops: [Op] = []
        var recolored = 0
        var refonted = 0

        // 1. Accent color map: chromatic colors by use count -> kit accents in role order.
        var usage: [String: Int] = [:]
        for node in nodes where node.id != page.id {
            for fill in NodeEditing.paints(of: node) where fill.type == "solid" {
                if let hex = fill.color?.hex?.lowercased(), !isNeutral(hex) {
                    usage[String(hex.prefix(7)), default: 0] += 1
                }
            }
        }
        let accents = accentPalette(kit.colors)
        var colorMap: [String: String] = [:]
        if !accents.isEmpty {
            let ranked = usage.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key)
            for (index, hex) in ranked.enumerated() {
                colorMap[hex] = accents[index % accents.count]
            }
        }

        // 2. Background.
        let background = roleColor("background", in: kit.colors)
        var pageBackground = page.background.first?.color?.hex.map { String($0.lowercased().prefix(7)) }
        if let background, page.type == .page {
            var fills = page.background
            if fills.isEmpty || fills[0].type == "solid" {
                if fills.isEmpty { fills = [Fill.solid(.hex(background))] } else { fills[0].color = .hex(background) }
                ops += NodeEditing.setPaints(fills, on: page)
                pageBackground = background
                recolored += 1
            }
        }
        let backdrop = pageBackground.flatMap { RGBA(hex: $0) }
        let textColor = roleColor("text", in: kit.colors)

        // 3. Nodes.
        let headingFont = kit.fonts.heading
        let bodyFont = kit.fonts.body ?? kit.fonts.heading
        let textSizes = nodes.filter { $0.type == .text }.compactMap { $0.textStyle?.fontSize }.sorted(by: >)
        let headingThreshold = textSizes.isEmpty ? .infinity : textSizes[min(textSizes.count - 1, max(0, textSizes.count / 3))]

        for node in nodes where node.id != page.id {
            if node.type == .text {
                var values: [String: JSONValue] = [:]
                let size = node.textStyle?.fontSize ?? 0
                let isHeading = node.role.map { headingRoles.contains($0) } ?? (size >= headingThreshold && textSizes.count > 1)
                if let slot = isHeading ? headingFont : bodyFont, slot.family != node.textStyle?.fontFamily {
                    values["fontFamily"] = .string(slot.family)
                    if let weight = slot.weight { values["fontWeight"] = .number(weight) }
                    if let style = slot.style { values["fontStyle"] = .string(style == "italic" ? "italic" : "normal") }
                    refonted += 1
                }
                // Text color: mapped accent, else the kit's text color for neutral text, then a contrast check.
                if let current = node.textStyle?.colorHex.map({ String($0.lowercased().prefix(7)) }) {
                    var next = colorMap[current] ?? (isNeutral(current) ? (textColor ?? current) : current)
                    if let backdrop, let candidate = RGBA(hex: next), candidate.contrast(with: backdrop) < 3 {
                        next = textColor.flatMap { RGBA(hex: $0) }.map { $0.contrast(with: backdrop) >= 3 ? $0.opaqueHex : backdrop.readableTextHex }
                            ?? backdrop.readableTextHex
                    }
                    if next != current {
                        var fills = node.textStyle?.fills ?? []
                        if fills.isEmpty { fills = [Fill.solid(.hex(next))] } else { fills[0].color = .hex(next) }
                        values["fills"] = .array(fills.map(\.jsonValue))
                        recolored += 1
                    }
                }
                ops += NodeEditing.setTextStyles(values, on: node)
            } else if NodeEditing.paintSlot(for: node) != nil {
                var fills = NodeEditing.paints(of: node)
                var changed = false
                for index in fills.indices where fills[index].type == "solid" {
                    guard let hex = fills[index].color?.hex?.lowercased(), let mapped = colorMap[String(hex.prefix(7))] else { continue }
                    fills[index].color = .hex(mapped)
                    changed = true
                }
                if changed {
                    ops += NodeEditing.setPaints(fills, on: node)
                    recolored += 1
                }
            }
        }

        // 4. Attach the kit and add its colors as named colors.
        ops.append(.doc(set: ["brandKitId": .string(brandKitId)], unset: []))
        let existing = Set(existingStyleColors.map { $0.value.lowercased() })
        for color in kit.colors where !existing.contains(color.value.lowercased()) && RGBA(hex: color.value) != nil {
            ops.append(.styles(path: [.key("colors"), .key(DesynID.new())], value: ["name": .string(color.name), "value": .string(color.value.lowercased())]))
        }
        return Result(ops: ops, recolored: recolored, refonted: refonted)
    }
}
