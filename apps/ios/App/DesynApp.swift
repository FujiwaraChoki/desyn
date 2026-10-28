import AppFeature
import DesignSystem
import SwiftUI

@main
struct DesynApp: App {
    @State private var model: AppModel

    init() {
        DesignSystem.bootstrap()
        let model = AppModel()
        _model = State(initialValue: model)
        // Editor features, settings, links and widgets (apps/ios/Extensions/App).
        DesynSuite.install(app: model)
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .desynSuite(model)
        }
    }
}
