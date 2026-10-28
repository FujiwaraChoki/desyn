import AppGroupKit
import DesignSystem
import SwiftUI
import UIKit
import WidgetKit

/// Home screen widgets: recent designs (small: the latest; medium: three; large: six), each opening its design,
/// with a create button. Data comes from the snapshot the app keeps in the App Group container.
@main
struct DesynWidgets: WidgetBundle {
    init() {
        DSFont.registerFonts()
    }

    var body: some Widget {
        RecentDesignsWidget()
    }
}

struct RecentDesignsEntry: TimelineEntry {
    let date: Date
    let snapshot: RecentDesignsSnapshot?
    /// Thumbnails by design id (decoded once per timeline).
    let thumbnails: [String: UIImage]
}

struct RecentDesignsProvider: TimelineProvider {
    private let store = RecentDesignsStore.shared()

    func placeholder(in context: Context) -> RecentDesignsEntry {
        RecentDesignsEntry(date: Date(), snapshot: nil, thumbnails: [:])
    }

    func getSnapshot(in context: Context, completion: @escaping (RecentDesignsEntry) -> Void) {
        completion(entry(limit: limit(for: context.family)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentDesignsEntry>) -> Void) {
        // The app reloads timelines whenever the library changes; refresh hourly for the relative dates.
        let entry = entry(limit: limit(for: context.family))
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(3600))))
    }

    private func limit(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall: 1
        case .systemMedium: 3
        default: 6
        }
    }

    private func entry(limit: Int) -> RecentDesignsEntry {
        let snapshot = store.load()
        var thumbnails: [String: UIImage] = [:]
        for design in (snapshot?.designs ?? []).prefix(limit) {
            if let file = design.thumbnailFile, let data = store.thumbnailData(file), let image = UIImage(data: data) {
                thumbnails[design.id] = image
            }
        }
        return RecentDesignsEntry(date: Date(), snapshot: snapshot, thumbnails: thumbnails)
    }
}

struct RecentDesignsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.desyn.recent-designs", provider: RecentDesignsProvider()) { entry in
            RecentDesignsView(entry: entry)
                .containerBackground(for: .widget) {
                    ZStack {
                        Color(hex: "0A0A0A")
                        RadialGradient(
                            colors: [Color(hex: "FFB02E").opacity(0.28), .clear],
                            center: UnitPoint(x: 0.9, y: 0.0),
                            startRadius: 0,
                            endRadius: 260
                        )
                    }
                }
        }
        .configurationDisplayName("Recent designs")
        .description("Jump back into what you were designing.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct RecentDesignsView: View {
    let entry: RecentDesignsEntry
    @Environment(\.widgetFamily) private var family

    private let sun = Color(hex: "FFB02E")
    private let foreground = Color(hex: "EDEDED")
    private let muted = Color(hex: "918E89")

    var body: some View {
        if let snapshot = entry.snapshot, snapshot.signedIn {
            if snapshot.designs.isEmpty {
                empty(title: "your canvas is *waiting*.", detail: "Tap to create your first design.", link: RecentDesignsSnapshot.createLink)
            } else {
                switch family {
                case .systemSmall: small(snapshot)
                case .systemMedium: list(snapshot, count: 3, columns: 3)
                default: list(snapshot, count: 6, columns: 3)
                }
            }
        } else {
            empty(title: "open *desyn*.", detail: entry.snapshot == nil ? "Your recent designs appear here." : "Sign in to see your designs.", link: nil)
        }
    }

    // MARK: Layouts

    private func small(_ snapshot: RecentDesignsSnapshot) -> some View {
        let design = snapshot.designs[0]
        return VStack(alignment: .leading, spacing: 6) {
            thumbnail(design)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Text(design.name)
                .font(.custom(DSFont.sansFamily, size: 13).weight(.semibold))
                .foregroundStyle(foreground)
                .lineLimit(1)
            Text(design.updatedAt, style: .relative)
                .font(.custom(DSFont.sansFamily, size: 11))
                .foregroundStyle(muted)
                .lineLimit(1)
        }
        .widgetURL(snapshot.link(for: design.id))
    }

    private func list(_ snapshot: RecentDesignsSnapshot, count: Int, columns: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                headline(snapshot.ownerName.map { "recent, *\($0.lowercased())*" } ?? "recent *designs*")
                Spacer()
                Link(destination: RecentDesignsSnapshot.createLink) {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color(hex: "0A0A0A"))
                        .frame(width: 26, height: 26)
                        .background(sun, in: Circle())
                }
                .accessibilityLabel("Create a design")
            }
            let designs = Array(snapshot.designs.prefix(count))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns), spacing: 8) {
                ForEach(designs) { design in
                    Link(destination: snapshot.link(for: design.id)) {
                        VStack(alignment: .leading, spacing: 4) {
                            thumbnail(design)
                                .frame(height: family == .systemLarge ? 96 : 74)
                            Text(design.name)
                                .font(.custom(DSFont.sansFamily, size: 11).weight(.medium))
                                .foregroundStyle(foreground)
                                .lineLimit(1)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func thumbnail(_ design: RecentDesign) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(hex: "171717"))
            if let image = entry.thumbnails[design.id] {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .padding(6)
            } else {
                VStack(spacing: 4) {
                    Circle().fill(sun.opacity(0.85)).frame(width: 14, height: 14).shadow(color: sun.opacity(0.6), radius: 6)
                    Text(design.kindLabel)
                        .font(.custom(DSFont.sansFamily, size: 10))
                        .foregroundStyle(muted)
                        .lineLimit(1)
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
    }

    private func empty(title: String, detail: String, link: URL?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Circle()
                .fill(LinearGradient(colors: [Color(hex: "FFD66B"), sun, Color(hex: "FF6A1F")], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 22, height: 22)
                .shadow(color: sun.opacity(0.6), radius: 8)
            Spacer(minLength: 0)
            headline(title)
            Text(detail)
                .font(.custom(DSFont.sansFamily, size: 12))
                .foregroundStyle(muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(link)
    }

    /// Instrument Serif with the one italic sun word (`*word*`).
    private func headline(_ markup: String) -> some View {
        var text = AttributedString()
        for (index, part) in markup.split(separator: "*", omittingEmptySubsequences: false).enumerated() where !part.isEmpty {
            var segment = AttributedString(String(part))
            segment.font = .custom(index % 2 == 1 ? DSFont.serifItalic : DSFont.serifRegular, size: 20)
            segment.foregroundColor = index % 2 == 1 ? sun : foreground
            text.append(segment)
        }
        return Text(text).lineLimit(2)
    }
}
