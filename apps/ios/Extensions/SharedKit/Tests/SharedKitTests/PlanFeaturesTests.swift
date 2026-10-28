import DesynKit
import SharedKit
import XCTest

/// Plan gating of work done on the device and the shapes of the calls that feed it (review fixes).
final class PlanFeaturesTests: XCTestCase {
    func testTableMirrorsPlansJSON() {
        // config/plans.json: Free exports PNG / JPG / PDF only; Pro and self-host export everything.
        let free = PlanFeatures.resolve(live: nil, plan: "free")
        XCTAssertTrue(free.allows("export.png"))
        XCTAssertTrue(free.allows("export.pdf"))
        XCTAssertFalse(free.allows("export.svg"))
        XCTAssertFalse(free.allows("export.pdfPrint"))
        XCTAssertFalse(free.allows("charts"))
        for plan in ["pro", "selfhost"] {
            let features = PlanFeatures.resolve(live: nil, plan: plan)
            for format in FileFormat.allCases {
                XCTAssertTrue(features.allows(format.requiredFeature), "\(plan) \(format)")
            }
            XCTAssertTrue(features.allows("export.pdfPrint"))
        }
    }

    func testLiveFeaturesWinAndUnknownPlansFallBackToFree() {
        let flagged = PlanFeatures.resolve(live: ["export.svg": true, "charts": true], plan: "free")
        XCTAssertTrue(flagged.allows("export.svg"))
        XCTAssertTrue(flagged.allows("charts"))
        XCTAssertFalse(flagged.allows("export.pptx"), "keys the server did not send keep the plan's value")
        XCTAssertEqual(PlanFeatures.resolve(live: nil, plan: "enterprise"), PlanFeatures.resolve(live: nil, plan: "free"))
        XCTAssertFalse(PlanFeatures(values: [:]).allows("export.png"))
    }

    func testExportRequirements() {
        var plan = ExportPlan()
        plan.format = .svg
        XCTAssertEqual(plan.requiredFeatures, ["export.svg"])
        plan.format = .pdf
        XCTAssertEqual(plan.requiredFeatures, ["export.pdf"])
        plan.pdfCropMarks = true
        XCTAssertEqual(plan.requiredFeatures, ["export.pdf", "export.pdfPrint"])
        plan.format = .png
        XCTAssertFalse(plan.usesPrintOptions, "print options only count for PDFs")
        XCTAssertEqual(FileFormat.gif.requiredFeature, "export.video")
        XCTAssertEqual(FileFormat.jpeg.requiredFeature, "export.jpg")
        XCTAssertFalse(PlanFeatures.resolve(live: nil, plan: "free").allowsAll(ExportPlan.withFormat(.pdf, print: true).requiredFeatures))
    }

    func testLockedMessagesNameTheFeatureWithoutPurchaseLinks() {
        XCTAssertEqual(PlanFeatures.lockedMessage("charts"), "Charts are part of Desyn Pro.")
        XCTAssertEqual(PlanFeatures.lockedMessage("export.svg"), "SVG export is part of Desyn Pro.")
        XCTAssertEqual(PlanFeatures.lockedMessage("unknown"), "This feature is part of Desyn Pro.")
    }

    func testProfileFeaturesAndImportResultDecode() async throws {
        let me = #"""
        {"userId":"u1","email":"ann@example.com","name":"Ann","image":null,"emailVerified":true,"edition":"hosted","plan":"free","planName":"Free",
         "limits":{},"features":{"export.svg":false,"charts":true},"role":"user","isAdmin":false,"locale":null,"timezone":null,
         "onboarding":{"completed":true,"step":"done"},"appearance":{"theme":"dark"},"aiSettings":{},"flags":{},"defaultWorkspaceId":"w1",
         "marketingOptIn":false,"hasStripeCustomer":false,"provisioned":true,"createdAt":1}
        """#
        // designs.importDesign returns the number of validation warnings.
        let imported = #"{"designId":"d9","key":"keyaaaaaaaaa","warnings":2,"pending":false}"#
        let transport = RecordingTransport(responses: ["accounts/profiles:me": me, "designs/designs:importDesign": imported])
        let api = DesynAPI(transport: transport)
        var profile: AccountProfile?
        for try await value in api.accountProfileUpdates() { profile = value }
        XCTAssertEqual(profile?.features?["charts"], true)
        let features = PlanFeatures.resolve(live: profile?.features, plan: profile?.plan)
        XCTAssertTrue(features.allows("charts"))
        XCTAssertFalse(features.allows("export.svg"))
        let result = try await api.importDesign(workspaceId: "w1", designJSON: "{}", name: "Photo")
        XCTAssertEqual(result.designId, "d9")
        XCTAssertEqual(result.warnings, 2)
        XCTAssertEqual(result.pending, false)
    }
}

private extension ExportPlan {
    static func withFormat(_ format: FileFormat, print: Bool) -> ExportPlan {
        var plan = ExportPlan()
        plan.format = format
        plan.pdfBleed = print
        return plan
    }
}
