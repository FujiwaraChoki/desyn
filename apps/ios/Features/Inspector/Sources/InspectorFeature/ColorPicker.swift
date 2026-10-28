import DesignSystem
import SharedKit
import SwiftUI
import UIKit

/// The sun color picker (DESIGN_SYSTEM: HSV area + hue + alpha + eyedropper + swatches): a saturation / brightness
/// field with a glowing thumb, hue and alpha tracks, a hex field, document / recent / palette swatches and the
/// system picker for its eyedropper. `onChange(hex, final)` previews while dragging and commits on release.
public struct SunColorPicker: View {
    private let hex: String
    private let showsAlpha: Bool
    private let documentColors: [(name: String, hex: String)]
    private let onChange: (String, Bool) -> Void

    @State private var hsv: HSV
    @State private var hexText: String
    @State private var showSystemPicker = false
    @AppStorage("inspector.recentColors") private var recentStorage = ""
    @FocusState private var hexFocused: Bool

    public init(hex: String, showsAlpha: Bool = true, documentColors: [(name: String, hex: String)] = [], onChange: @escaping (String, Bool) -> Void) {
        self.hex = hex
        self.showsAlpha = showsAlpha
        self.documentColors = documentColors
        self.onChange = onChange
        let rgba = RGBA(hex: hex) ?? RGBA(r: 1, g: 0.69, b: 0.18)
        _hsv = State(initialValue: rgba.hsv)
        _hexText = State(initialValue: String(rgba.hex.dropFirst()).uppercased())
    }

    public static let palette = [
        "#ffffff", "#e8e1d3", "#7a7468", "#2b2b2b", "#111111", "#000000",
        "#ffd66b", "#ffb02e", "#ff6a1f", "#c4451c", "#8a5a00", "#5aa9ff",
        "#ff5c5c", "#f472b6", "#a78bfa", "#4ade80", "#14b8a6", "#1d5fbf",
    ]

    private var recent: [String] {
        recentStorage.split(separator: ",").map(String.init).filter { RGBA(hex: $0) != nil }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            SaturationField(hsv: $hsv) { final in emit(final: final) }
                .frame(height: 188)
            HueTrack(hsv: $hsv) { final in emit(final: final) }
            if showsAlpha {
                AlphaTrack(hsv: $hsv) { final in emit(final: final) }
            }
            HStack(spacing: Spacing.sm) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(uiColor: UIColor(hex: hsv.rgba.hex)))
                    .frame(width: 44, height: 44)
                    .background(CheckerboardView().clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous)))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
                    .accessibilityHidden(true)
                HStack(spacing: 4) {
                    Text("#").font(.dsMono).foregroundStyle(Palette.muted)
                    TextField("Hex", text: $hexText)
                        .font(.dsMono)
                        .foregroundStyle(Palette.foreground)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .focused($hexFocused)
                        .submitLabel(.done)
                        .onSubmit(commitHex)
                        .tint(Palette.sun)
                }
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: Spacing.touchTarget)
                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                        .strokeBorder(hexFocused ? Palette.sun.opacity(0.6) : Palette.borderSubtle, lineWidth: hexFocused ? 2 : 1)
                }
                Button {
                    showSystemPicker = true
                } label: {
                    Image(systemName: "eyedropper.halffull")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Palette.foreground)
                        .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("Eyedropper and system colors")
            }
            if !documentColors.isEmpty {
                swatchRow("Document", documentColors.map(\.hex))
            }
            if !recent.isEmpty {
                swatchRow("Recent", recent)
            }
            swatchRow("Palette", Self.palette)
        }
        .onChange(of: hexFocused) { _, focused in
            if !focused { commitHex() }
        }
        .onChange(of: hex) { _, newValue in
            // External changes (undo, collaborators) move the picker unless the person is typing.
            guard !hexFocused, let rgba = RGBA(hex: newValue), rgba.hex != hsv.rgba.hex else { return }
            hsv = rgba.hsv
            hexText = String(rgba.hex.dropFirst()).uppercased()
        }
        .sheet(isPresented: $showSystemPicker) {
            SystemColorPicker(initial: UIColor(hex: hsv.rgba.hex)) { color in
                let picked = RGBA(hex: color.hexString) ?? hsv.rgba
                hsv = picked.hsv
                emit(final: true)
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func swatchRow(_ title: String, _ colors: [String]) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(title).font(.dsFootnote).foregroundStyle(Palette.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(Array(colors.enumerated()), id: \.offset) { _, swatch in
                        let selected = RGBA(hex: swatch)?.opaqueHex == hsv.rgba.opaqueHex
                        Button {
                            if let rgba = RGBA(hex: swatch) {
                                hsv = rgba.hsv
                                emit(final: true)
                            }
                        } label: {
                            Circle()
                                .fill(Color(uiColor: UIColor(hex: swatch)))
                                .frame(width: 30, height: 30)
                                .overlay(Circle().strokeBorder(selected ? Palette.sun : Palette.border, lineWidth: selected ? 2.5 : 1))
                                .frame(width: 38, height: Spacing.touchTarget)
                                .dsGlow(selected, radius: 8)
                        }
                        .buttonStyle(PressScaleStyle())
                        .accessibilityLabel(swatch)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
            }
        }
    }

    private func emit(final: Bool) {
        let value = showsAlpha ? hsv.rgba.hex : hsv.rgba.opaqueHex
        if !hexFocused { hexText = String(value.dropFirst()).uppercased() }
        onChange(value, final)
        if final { remember(value) }
    }

    private func commitHex() {
        guard let rgba = RGBA(hex: hexText) else {
            hexText = String(hsv.rgba.hex.dropFirst()).uppercased()
            return
        }
        guard rgba.hex != hsv.rgba.hex else { return }
        hsv = rgba.hsv
        emit(final: true)
    }

    private func remember(_ hex: String) {
        var list = RecentColors(colors: recent, limit: 12)
        list.add(String(hex.prefix(7)))
        recentStorage = list.colors.joined(separator: ",")
    }
}

/// Saturation (x) / brightness (y) field for the current hue.
private struct SaturationField: View {
    @Binding var hsv: HSV
    let onChange: (Bool) -> Void

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack {
                Color(hue: hsv.h / 360, saturation: 1, brightness: 1)
                LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .leading, endPoint: .trailing)
                LinearGradient(colors: [.black.opacity(0), .black], startPoint: .top, endPoint: .bottom)
                Circle()
                    .fill(Color(uiColor: UIColor(hex: HSV(h: hsv.h, s: hsv.s, v: hsv.v).rgba.opaqueHex)))
                    .frame(width: 26, height: 26)
                    .overlay(Circle().strokeBorder(.white, lineWidth: 3))
                    .shadow(color: Palette.sun.opacity(0.55), radius: 8)
                    .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
                    .position(x: hsv.s * size.width, y: (1 - hsv.v) * size.height)
                    .allowsHitTesting(false)
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        hsv.s = min(1, max(0, drag.location.x / max(1, size.width)))
                        hsv.v = min(1, max(0, 1 - drag.location.y / max(1, size.height)))
                        onChange(false)
                    }
                    .onEnded { _ in onChange(true) }
            )
        }
        .accessibilityElement()
        .accessibilityLabel("Saturation and brightness")
        .accessibilityValue("\(Int(hsv.s * 100)) percent saturation, \(Int(hsv.v * 100)) percent brightness")
        .accessibilityAdjustableAction { direction in
            hsv.v = min(1, max(0, hsv.v + (direction == .increment ? 0.05 : -0.05)))
            onChange(true)
        }
    }
}

/// The hue rainbow with a ringed thumb.
private struct HueTrack: View {
    @Binding var hsv: HSV
    let onChange: (Bool) -> Void

    var body: some View {
        Track(fraction: hsv.h / 360, thumb: Color(hue: hsv.h / 360, saturation: 1, brightness: 1)) {
            LinearGradient(colors: stride(from: 0.0, through: 1.0, by: 1.0 / 6).map { Color(hue: $0, saturation: 1, brightness: 1) }, startPoint: .leading, endPoint: .trailing)
        } onDrag: { fraction, final in
            hsv.h = min(359.99, max(0, fraction * 360))
            onChange(final)
        }
        .accessibilityLabel("Hue")
        .accessibilityValue("\(Int(hsv.h)) degrees")
        .accessibilityAdjustableAction { direction in
            hsv.h = (hsv.h + (direction == .increment ? 10 : -10) + 360).truncatingRemainder(dividingBy: 360)
            onChange(true)
        }
    }
}

/// Opacity over a checkerboard.
private struct AlphaTrack: View {
    @Binding var hsv: HSV
    let onChange: (Bool) -> Void

    var body: some View {
        let opaque = Color(uiColor: UIColor(hex: HSV(h: hsv.h, s: hsv.s, v: hsv.v).rgba.opaqueHex))
        Track(fraction: hsv.a, thumb: opaque.opacity(hsv.a)) {
            ZStack {
                CheckerboardView()
                LinearGradient(colors: [opaque.opacity(0), opaque], startPoint: .leading, endPoint: .trailing)
            }
        } onDrag: { fraction, final in
            hsv.a = min(1, max(0, fraction))
            onChange(final)
        }
        .accessibilityLabel("Opacity")
        .accessibilityValue("\(Int((hsv.a * 100).rounded())) percent")
        .accessibilityAdjustableAction { direction in
            hsv.a = min(1, max(0, hsv.a + (direction == .increment ? 0.1 : -0.1)))
            onChange(true)
        }
    }
}

/// A 28 pt capsule track with a draggable thumb.
private struct Track<TrackFill: View>: View {
    let fraction: Double
    let thumb: Color
    @ViewBuilder let fill: () -> TrackFill
    let onDrag: (Double, Bool) -> Void

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                fill()
                    .clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(Palette.borderSubtle, lineWidth: 1))
                Circle()
                    .fill(thumb)
                    .frame(width: 26, height: 26)
                    .overlay(Circle().strokeBorder(.white, lineWidth: 3))
                    .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                    .offset(x: CGFloat(fraction) * (proxy.size.width - 26))
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in onDrag(Double((drag.location.x - 13) / max(1, proxy.size.width - 26)), false) }
                    .onEnded { drag in onDrag(Double((drag.location.x - 13) / max(1, proxy.size.width - 26)), true) }
            )
        }
        .frame(height: 28)
        .frame(minHeight: Spacing.touchTarget)
        .accessibilityElement()
    }
}

/// Transparency checkerboard.
struct CheckerboardView: View {
    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 6
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            for row in 0..<Int((size.height / cell).rounded(.up)) {
                for column in 0..<Int((size.width / cell).rounded(.up)) where (row + column).isMultiple(of: 2) {
                    context.fill(Path(CGRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell, width: cell, height: cell)), with: .color(Color(white: 0.85)))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// UIKit's color picker (eyedropper, spectrum, saved colors) for what the sun picker does not cover.
private struct SystemColorPicker: UIViewControllerRepresentable {
    let initial: UIColor
    let onPick: (UIColor) -> Void

    func makeUIViewController(context: Context) -> UIColorPickerViewController {
        let picker = UIColorPickerViewController()
        picker.selectedColor = initial
        picker.supportsAlpha = true
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIColorPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    final class Coordinator: NSObject, UIColorPickerViewControllerDelegate {
        let onPick: (UIColor) -> Void

        init(onPick: @escaping (UIColor) -> Void) {
            self.onPick = onPick
        }

        func colorPickerViewController(_ viewController: UIColorPickerViewController, didSelect color: UIColor, continuously: Bool) {
            guard !continuously else { return }
            onPick(color)
        }
    }
}
