import CoreText
import DesynEngine
import EditorFeature
import Foundation
import Observation
import SharedKit
import SwiftUI
import UIKit

/// Fonts beyond the bundled set: downloads Google Fonts families on demand (cached on disk for offline use),
/// registers them with Core Text so the font picker previews each family in itself, and with the engine so text
/// renders in them. Also answers the engine's font requests, so a design that uses a Google family renders right
/// when it opens.
@MainActor
@Observable
public final class FontService {
    public static let shared = FontService()

    /// Families being downloaded.
    public private(set) var loading: Set<String> = []
    /// Families that could not be loaded (offline, unknown family).
    public private(set) var failed: Set<String> = []
    /// Bumps when a family becomes previewable (views re-render their previews).
    public private(set) var revision = 0

    @ObservationIgnored private let client: GoogleFontsClient
    /// Core Text PostScript name per "family|weight|italic".
    @ObservationIgnored private var postScriptNames: [String: String] = [:]
    /// Faces handed to each engine (an editor's engine lives as long as the editor).
    @ObservationIgnored private var engineFaces: [EngineFaces] = []
    @ObservationIgnored private var inFlight: [String: Task<Data?, Never>] = [:]

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        client = GoogleFontsClient(cacheDirectory: caches.appendingPathComponent("DesynFonts", isDirectory: true))
    }

    private static func key(_ family: String, _ weight: Int, _ italic: Bool) -> String {
        "\(family.lowercased())|\(weight)|\(italic ? 1 : 0)"
    }

    // MARK: Previews

    /// A SwiftUI font showing `family` (bundled families directly; downloaded ones once registered), else nil.
    public func previewFont(_ family: String, size: CGFloat, weight: Int = 400, italic: Bool = false) -> Font? {
        _ = revision
        if Self.appFamilies.contains(family) {
            return Font.custom(family, size: size).weight(Self.swiftUIWeight(weight)).italic(italic)
        }
        let catalog = FontFamily.named(family)
        let resolved = catalog?.nearestWeight(Double(weight)) ?? weight
        if let name = postScriptNames[Self.key(family, resolved, italic)] ?? postScriptNames[Self.key(family, resolved, false)]
            ?? postScriptNames[Self.key(family, 400, false)]
        {
            return Font.custom(name, size: size)
        }
        return nil
    }

    /// Families the design system registers with Core Text at launch (previews need no download).
    static let appFamilies: Set<String> = ["Instrument Sans", "Instrument Serif", "JetBrains Mono"]

    /// Downloads and registers the regular face of `family` for its preview (no engine involvement).
    public func loadPreview(_ family: String) async {
        guard !Self.appFamilies.contains(family), postScriptNames[Self.key(family, 400, false)] == nil else { return }
        let weight = FontFamily.named(family)?.nearestWeight(400) ?? 400
        _ = await data(family: family, weight: weight, italic: false)
    }

    // MARK: Engine

    /// Makes `family` at `weight` / `italic` available to the editor's engine (and previews). False when it could
    /// not be loaded.
    @discardableResult
    public func ensure(_ family: String, weight: Double, italic: Bool, in model: EditorModel) async -> Bool {
        if FontFamily.bundledFamilies.contains(family) { return true }
        let resolved = FontFamily.named(family)?.nearestWeight(weight) ?? Int((weight / 100).rounded() * 100)
        let key = Self.key(family, resolved, italic)
        let engine = model.designEngine
        engineFaces.removeAll { $0.engine == nil }
        if engineFaces.contains(where: { $0.engine === engine && $0.keys.contains(key) }) { return true }
        guard let bytes = await data(family: family, weight: resolved, italic: italic) else { return false }
        let ok = await model.registerFont(bytes, family: family)
        if ok {
            if let entry = engineFaces.first(where: { $0.engine === engine }) {
                entry.keys.insert(key)
            } else {
                engineFaces.append(EngineFaces(engine: engine, keys: [key]))
            }
        }
        return ok
    }

    /// Loads the families the engine asked for since the last call (text using a family it does not have, scripts
    /// without a fallback). Emoji requests are covered by the bundled emoji font.
    public func serviceEngineRequests(for model: EditorModel) async {
        let requests = await model.designEngine.takeFontRequests()
        var seen = Set<String>()
        for request in requests where request.reason != .emoji {
            let family = request.family
            let key = Self.key(family, Int(request.weight), request.italic)
            guard seen.insert(key).inserted, !failed.contains(family) else { continue }
            await ensure(family, weight: Double(request.weight), italic: request.italic, in: model)
        }
    }

    // MARK: Loading

    private func data(family: String, weight: Int, italic: Bool) async -> Data? {
        let key = Self.key(family, weight, italic)
        if let running = inFlight[key] { return await running.value }
        let client = self.client
        loading.insert(family)
        let task = Task<Data?, Never> {
            try? await client.fontData(family: family, weight: weight, italic: italic)
        }
        inFlight[key] = task
        let data = await task.value
        inFlight[key] = nil
        loading.remove(family)
        guard let data else {
            failed.insert(family)
            return nil
        }
        failed.remove(family)
        if postScriptNames[key] == nil, let name = Self.registerWithCoreText(data) {
            postScriptNames[key] = name
            revision &+= 1
        }
        return data
    }

    /// Registers font bytes for this process; returns the PostScript name SwiftUI can use.
    private static func registerWithCoreText(_ data: Data) -> String? {
        guard let provider = CGDataProvider(data: data as CFData), let font = CGFont(provider) else { return nil }
        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterGraphicsFont(font, &error) {
            // Already registered (same face loaded twice) still leaves a usable name.
            error?.release()
        }
        return font.postScriptName as String?
    }

    static func swiftUIWeight(_ weight: Int) -> Font.Weight {
        switch weight {
        case ..<150: .thin
        case ..<250: .ultraLight
        case ..<350: .light
        case ..<450: .regular
        case ..<550: .medium
        case ..<650: .semibold
        case ..<750: .bold
        case ..<850: .heavy
        default: .black
        }
    }
}

/// The font faces registered with one engine (held weakly: a closed editor's engine goes away).
private final class EngineFaces {
    weak var engine: DesynEngine?
    var keys: Set<String>

    init(engine: DesynEngine, keys: Set<String>) {
        self.engine = engine
        self.keys = keys
    }
}
