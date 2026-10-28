import AppGroupKit
import AppIntents
import DesynKit
import FeatureCore
import Foundation

// Shortcuts and Siri: "Create design from prompt" (creates a design and lets the AI build it, then opens it) and
// "Open recent design". They run in the app (openAppWhenRun), so they use the signed-in session.

/// Design kinds offered in Shortcuts.
enum DesignKindOption: String, AppEnum {
    case socialPost = "social-post"
    case story
    case poster
    case flyer
    case presentation
    case thumbnail
    case banner
    case invitation
    case businessCard = "business-card"
    case logo

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Design type")

    static let caseDisplayRepresentations: [DesignKindOption: DisplayRepresentation] = [
        .socialPost: "Social post",
        .story: "Story",
        .poster: "Poster",
        .flyer: "Flyer",
        .presentation: "Presentation",
        .thumbnail: "Video thumbnail",
        .banner: "Banner",
        .invitation: "Invitation",
        .businessCard: "Business card",
        .logo: "Logo",
    ]
}

struct CreateDesignFromPromptIntent: AppIntent {
    static let title: LocalizedStringResource = "Create Design from Prompt"
    static let description = IntentDescription("Creates a new design and lets Desyn's AI build it from your description, as real layers you can edit.")
    static let openAppWhenRun = true

    @Parameter(title: "Prompt", description: "What the design is about and how it should feel.", requestValueDialog: "What should the design be?")
    var prompt: String

    @Parameter(title: "Type", description: "The kind of design. Desyn picks one from the prompt when empty.")
    var kind: DesignKindOption?

    static var parameterSummary: some ParameterSummary {
        Summary("Create \(\.$kind) from \(\.$prompt)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let app = DesynSuite.app else {
            throw IntentFailure.notReady
        }
        let created = try await DesignCreator.create(app: app, kind: kind.map { DesignKind(rawValue: $0.rawValue) }, prompt: prompt)
        return .result(dialog: "Creating \u{201C}\(created.name)\u{201D}. The AI is building it now.")
    }
}

/// A design from the recent-designs snapshot (Shortcuts parameter).
struct RecentDesignEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Design")
    static let defaultQuery = RecentDesignQuery()

    let id: String
    let name: String
    let kindLabel: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(kindLabel)")
    }
}

struct RecentDesignQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [RecentDesignEntity] {
        all().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [RecentDesignEntity] {
        all()
    }

    private func all() -> [RecentDesignEntity] {
        (RecentDesignsStore.shared().load()?.designs ?? []).map {
            RecentDesignEntity(id: $0.id, name: $0.name, kindLabel: $0.kindLabel)
        }
    }
}

struct OpenRecentDesignIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Recent Design"
    static let description = IntentDescription("Opens one of your recent designs in Desyn.")
    static let openAppWhenRun = true

    @Parameter(title: "Design")
    var design: RecentDesignEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let app = DesynSuite.app else { throw IntentFailure.notReady }
        guard app.session.phase == .signedIn else { throw IntentFailure.signedOut }
        app.openDesign = DesignRoute(designId: design.id, name: design.name)
        return .result()
    }
}

enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    case notReady
    case signedOut

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notReady: "Desyn is still starting. Try again in a moment."
        case .signedOut: "Sign in to Desyn first, then try again."
        }
    }
}

struct DesynShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CreateDesignFromPromptIntent(),
            phrases: [
                "Create a design with \(.applicationName)",
                "Design something with \(.applicationName)",
            ],
            shortTitle: "Create from prompt",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: OpenRecentDesignIntent(),
            phrases: [
                "Open \(\.$design) in \(.applicationName)",
                "Open my recent design in \(.applicationName)",
            ],
            shortTitle: "Open recent design",
            systemImageName: "clock"
        )
    }

    static let shortcutTileColor: ShortcutTileColor = .orange
}
