import DesignSystem
import DesynKit
import PanelKit
import SharedKit
import SwiftUI

/// Content of data layers: chart type and values, table cells and size, QR payload and colors.
struct DataSection: View {
    let model: InspectorModel

    var body: some View {
        if let node = model.first {
            switch node.type {
            case .chart: ChartEditor(model: model, node: node)
            case .table: TableEditor(model: model, node: node)
            case .qr: QREditor(model: model, node: node)
            default: EmptyView()
            }
        }
    }
}

// MARK: Charts

private struct ChartEditor: View {
    let model: InspectorModel
    let node: Node

    @State private var data = ElementFactory.ChartData(labels: [], series: [])
    @State private var loadedFor = ""

    private var options: [String: JSONValue] { node.object("options") ?? [:] }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            PanelSection("Chart") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Spacing.sm), count: 4), spacing: Spacing.sm) {
                    ForEach(ElementFactory.ChartKind.allCases) { kind in
                        let selected = node.string("chart") == kind.rawValue
                        Button {
                            model.edit("Change chart type", final: true) { nodes in
                                nodes.map { .update(id: $0.id, set: ["chart": .string(kind.rawValue)], unset: []) }
                            }
                        } label: {
                            VStack(spacing: 4) {
                                Image(systemName: kind.systemImage).font(.system(size: 18))
                                Text(kind.title).font(.dsCaption).lineLimit(1)
                            }
                            .foregroundStyle(selected ? Palette.sun : Palette.foreground)
                            .frame(maxWidth: .infinity, minHeight: 56)
                            .background(selected ? Palette.sun.opacity(0.12) : Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(selected ? Palette.sun.opacity(0.5) : Color.clear, lineWidth: 1))
                        }
                        .buttonStyle(PressScaleStyle())
                        .accessibilityLabel("\(kind.title) chart")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                PanelToggle("Legend", isOn: options["legend"]?.boolValue ?? true) { setOption("legend", .bool($0)) }
                PanelToggle("Grid lines", isOn: options["grid"]?.boolValue ?? true) { setOption("grid", .bool($0)) }
                PanelToggle("Value labels", isOn: options["labels"]?.boolValue ?? true) { setOption("labels", .bool($0)) }
            }
            PanelSection("Data", trailing: {
                Button {
                    data.labels.append(nextLabel)
                    for index in data.series.indices { data.series[index].values.append(0) }
                    save()
                } label: {
                    Label("Row", systemImage: "plus").font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
                }
                .foregroundStyle(Palette.sun)
            }) {
                if data.series.count < 6 {
                    Button {
                        data.series.append((name: "Series \(data.series.count + 1)", values: Array(repeating: 0, count: data.labels.count)))
                        save()
                    } label: {
                        Label("Add series", systemImage: "plus.circle").font(.dsFootnote)
                    }
                    .foregroundStyle(Palette.sun)
                    .frame(minHeight: 32)
                }
                ScrollView(.horizontal, showsIndicators: true) {
                    Grid(alignment: .leading, horizontalSpacing: Spacing.xs, verticalSpacing: Spacing.xs) {
                        GridRow {
                            Text("Label").font(.dsCaption).foregroundStyle(Palette.muted).frame(width: 96, alignment: .leading)
                            ForEach(data.series.indices, id: \.self) { s in
                                CellField(text: data.series[s].name, width: 96, mono: false) { value in
                                    data.series[s].name = value
                                    save()
                                }
                            }
                        }
                        ForEach(data.labels.indices, id: \.self) { row in
                            GridRow {
                                CellField(text: data.labels[row], width: 96, mono: false) { value in
                                    data.labels[row] = value
                                    save()
                                }
                                ForEach(data.series.indices, id: \.self) { s in
                                    CellField(text: Self.format(data.series[s].values[safe: row] ?? 0), width: 96, mono: true) { value in
                                        guard data.series[s].values.indices.contains(row) else { return }
                                        data.series[s].values[row] = Double(value.replacingOccurrences(of: ",", with: ".")) ?? 0
                                        save()
                                    }
                                }
                                Button {
                                    guard data.labels.count > 1 else { return }
                                    data.labels.remove(at: row)
                                    for index in data.series.indices where data.series[index].values.indices.contains(row) {
                                        data.series[index].values.remove(at: row)
                                    }
                                    save()
                                } label: {
                                    Image(systemName: "minus.circle").foregroundStyle(Palette.muted).frame(width: 32, height: 36)
                                }
                                .accessibilityLabel("Remove row \(row + 1)")
                            }
                        }
                    }
                }
            }
        }
        .onAppear(perform: load)
        .onChange(of: node.id) { _, _ in load() }
    }

    private var nextLabel: String {
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        return data.labels.count < letters.count ? String(letters[data.labels.count]) : "\(data.labels.count + 1)"
    }

    private func load() {
        guard loadedFor != node.id else { return }
        loadedFor = node.id
        data = ElementFactory.ChartData(node: node)
    }

    private func save() {
        let value = data.jsonValue(keeping: node)
        model.edit("Edit chart data", final: true) { nodes in
            nodes.filter { $0.type == .chart }.map { .update(id: $0.id, set: ["data": value], unset: []) }
        }
    }

    private func setOption(_ key: String, _ value: JSONValue) {
        model.edit("Change chart options", final: true) { nodes in
            nodes.filter { $0.type == .chart }.map { .patch(id: $0.id, path: [.key("options"), .key(key)], value: value) }
        }
    }

    static func format(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(value)
    }
}

/// A text cell that reports its value when editing ends.
private struct CellField: View {
    let text: String
    let width: CGFloat
    let mono: Bool
    let onCommit: (String) -> Void

    @State private var value = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: $value)
            .font(mono ? .dsMono : .dsCallout)
            .foregroundStyle(Palette.foreground)
            .keyboardType(mono ? .numbersAndPunctuation : .default)
            .focused($focused)
            .submitLabel(.done)
            .onSubmit { onCommit(value) }
            .padding(.horizontal, Spacing.sm)
            .frame(width: width, height: 36)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(focused ? Palette.sun.opacity(0.6) : Palette.borderSubtle, lineWidth: 1))
            .tint(Palette.sun)
            .onAppear { value = text }
            .onChange(of: text) { _, newValue in if !focused { value = newValue } }
            .onChange(of: focused) { _, isFocused in
                if !isFocused, value != text { onCommit(value) }
            }
    }
}

// MARK: Tables

private struct TableEditor: View {
    let model: InspectorModel
    let node: Node

    private var rows: Int { node.json["rows"]?.intValue ?? 1 }
    private var cols: Int { node.json["cols"]?.intValue ?? 1 }

    var body: some View {
        let grid = ElementFactory.tableTexts(node)
        VStack(alignment: .leading, spacing: Spacing.xl) {
            PanelSection("Table") {
                HStack(spacing: Spacing.md) {
                    Stepper("Rows \(rows)", value: Binding(get: { rows }, set: { resize(rows: $0, cols: cols) }), in: 1...40)
                        .font(.dsCallout)
                }
                HStack(spacing: Spacing.md) {
                    Stepper("Columns \(cols)", value: Binding(get: { cols }, set: { resize(rows: rows, cols: $0) }), in: 1...12)
                        .font(.dsCallout)
                }
                PanelToggle("Header row", isOn: node.bool("header") ?? true) { on in
                    model.edit("Change table header", final: true) { nodes in nodes.map { .update(id: $0.id, set: ["header": .bool(on)], unset: []) } }
                }
                PanelToggle("Striped rows", isOn: node.bool("stripe") ?? false) { on in
                    model.edit("Change table stripes", final: true) { nodes in nodes.map { .update(id: $0.id, set: ["stripe": .bool(on)], unset: []) } }
                }
            }
            PanelSection("Cells") {
                ScrollView(.horizontal, showsIndicators: true) {
                    Grid(horizontalSpacing: Spacing.xs, verticalSpacing: Spacing.xs) {
                        ForEach(grid.indices, id: \.self) { r in
                            GridRow {
                                ForEach(grid[r].indices, id: \.self) { c in
                                    CellField(text: grid[r][c], width: 110, mono: false) { value in
                                        let table = node
                                        model.edit("Edit cell", final: true) { _ in ElementFactory.setTableCell(row: r, col: c, text: value, on: table) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .tint(Palette.sun)
    }

    private func resize(rows: Int, cols: Int) {
        let table = node
        model.edit("Resize table", final: true) { _ in ElementFactory.resizeTable(rows: rows, cols: cols, on: table) }
    }
}

// MARK: QR codes

private struct QREditor: View {
    let model: InspectorModel
    let node: Node

    @State private var payload = ""
    @State private var editingColor: String?

    var body: some View {
        PanelSection("QR code") {
            HStack(spacing: Spacing.sm) {
                DSTextField("Link or text", text: $payload, prompt: "https://", kind: .plain, submitLabel: .done) { save() }
                DSButton("Update", kind: .primary, size: .small) { save() }
                    .frame(width: 100)
                    .disabled(ElementFactory.qrPayload(payload).isEmpty || ElementFactory.qrPayload(payload) == node.string("data"))
            }
            HStack(spacing: Spacing.md) {
                colorButton("Code", key: "fg")
                colorButton("Background", key: "bg")
            }
            if let key = editingColor {
                SunColorPicker(hex: node.string(key) ?? (key == "fg" ? "#000000" : "#ffffff"), showsAlpha: false) { hex, final in
                    model.edit("Change QR color", final: final) { nodes in nodes.map { .update(id: $0.id, set: [key: .string(hex)], unset: []) } }
                }
                .id(key)
                if let fg = RGBA(hex: node.string("fg") ?? "#000000"), let bg = RGBA(hex: node.string("bg") ?? "#ffffff"), fg.contrast(with: bg) < 3 {
                    InlineNotice("Low contrast makes the code hard to scan. Use a darker code on a lighter background.", tone: .warning)
                }
            }
            IconSegments(selection: node.string("errorCorrection") ?? "M", options: [
                ("L", "l.square", "Low error correction"),
                ("M", "m.square", "Medium error correction"),
                ("Q", "q.square", "Quartile error correction"),
                ("H", "h.square", "High error correction"),
            ]) { level in
                model.edit("Change QR error correction", final: true) { nodes in nodes.map { .update(id: $0.id, set: ["errorCorrection": .string(level)], unset: []) } }
            }
            PanelToggle("Rounded dots", isOn: node.bool("rounded") ?? false) { on in
                model.edit("Change QR style", final: true) { nodes in nodes.map { .update(id: $0.id, set: ["rounded": .bool(on)], unset: []) } }
            }
        }
        .onAppear { payload = node.string("data") ?? "" }
    }

    private func colorButton(_ title: String, key: String) -> some View {
        Button {
            editingColor = editingColor == key ? nil : key
        } label: {
            HStack(spacing: Spacing.sm) {
                Circle()
                    .fill(Color(hex: node.string(key) ?? "#000000"))
                    .frame(width: 24, height: 24)
                    .overlay(Circle().strokeBorder(editingColor == key ? Palette.sun : Palette.border, lineWidth: editingColor == key ? 2 : 1))
                Text(title).font(.dsCallout).foregroundStyle(Palette.foreground)
            }
            .padding(.horizontal, Spacing.md)
            .frame(maxWidth: .infinity, minHeight: Spacing.touchTarget, alignment: .leading)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        }
        .buttonStyle(PressScaleStyle())
    }

    private func save() {
        let data = ElementFactory.qrPayload(payload)
        guard !data.isEmpty else { return }
        payload = data
        model.edit("Change QR content", final: true) { nodes in nodes.map { .update(id: $0.id, set: ["data": .string(data)], unset: []) } }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
