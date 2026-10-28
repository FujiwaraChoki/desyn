// Foundation-only tests of FeatureCore (also run on Linux by scripts/linux-check.sh).
import FeatureCore
import Foundation
import XCTest

final class DeepLinkTests: XCTestCase {
    private let app = URL(string: "https://app.desyn.app")!

    func testMagicLinkUniversalLink() {
        let url = URL(string: "https://app.desyn.app/api/auth/magic-link/verify?token=abc123&callbackURL=desyn%3A%2F%2Fauth%2Fmagic")!
        XCTAssertEqual(DeepLink(url: url, appURL: app), .magicLink(token: "abc123"))
    }

    func testMagicLinkWithoutTokenIsIgnored() {
        let url = URL(string: "https://app.desyn.app/api/auth/magic-link/verify?callbackURL=x")!
        XCTAssertNil(DeepLink(url: url, appURL: app))
    }

    func testBrowserBounceAndDesignAndShareLinks() {
        XCTAssertEqual(DeepLink(url: URL(string: "desyn://auth/magic?error=INVALID_TOKEN")!, appURL: app), .magicLinkUsedInBrowser(error: "INVALID_TOKEN"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://app.desyn.app/design/k57abc")!, appURL: app), .design(id: "k57abc"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://app.desyn.app/share/tok_1")!, appURL: app), .share(token: "tok_1"))
    }

    func testForeignHostsAndPathsAreIgnored() {
        XCTAssertNil(DeepLink(url: URL(string: "https://evil.example/design/k57abc")!, appURL: app))
        XCTAssertNil(DeepLink(url: URL(string: "http://app.desyn.app/design/k57abc")!, appURL: app))
        XCTAssertNil(DeepLink(url: URL(string: "https://app.desyn.app/settings/profile")!, appURL: app))
        XCTAssertNil(DeepLink(url: URL(string: "desyn://auth/callback?code=1")!, appURL: app), "the PKCE callback belongs to ASWebAuthenticationSession")
    }
}

final class FormattingTests: XCTestCase {
    func testRelativeDates() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        XCTAssertEqual(RelativeDate.string(for: now.addingTimeInterval(-20), now: now, calendar: calendar), "Just now")
        XCTAssertEqual(RelativeDate.string(for: now.addingTimeInterval(-300), now: now, calendar: calendar), "5 min ago")
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!
        XCTAssertEqual(RelativeDate.string(for: yesterday, now: now, calendar: calendar), "Yesterday")
    }

    func testGreetings() {
        XCTAssertEqual(Greeting.forHour(7), "Good morning")
        XCTAssertEqual(Greeting.forHour(13), "Good afternoon")
        XCTAssertEqual(Greeting.forHour(22), "Good evening")
        XCTAssertEqual(Greeting.forHour(3), "Good evening")
    }
}
