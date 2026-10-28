import DesynKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest

final class PKCETests: XCTestCase {
    func testChallengeMatchesRFC7636Vector() {
        // RFC 7636 appendix B.
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "s")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testGeneratedPairsFitTheServerRules() {
        let pkce = PKCE()
        XCTAssertEqual(pkce.verifier.count, 64)
        XCTAssertEqual(pkce.challenge.count, 43)
        XCTAssertNil(pkce.challenge.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        XCTAssertNotEqual(PKCE().verifier, pkce.verifier)
    }

    func testAuthorizeURL() throws {
        let pkce = PKCE(verifier: String(repeating: "a", count: 43), state: "xyz")
        let url = AppEnvironment.production.nativeAuthorizeURL(pkce: pkce)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.host, "app.desyn.app")
        XCTAssertEqual(components.path, "/native/authorize")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items["client"], "ios")
        XCTAssertEqual(items["redirect_uri"], "desyn://auth/callback")
        XCTAssertEqual(items["code_challenge"], pkce.challenge)
        XCTAssertEqual(items["code_challenge_method"], "S256")
        XCTAssertEqual(items["state"], "xyz")
    }

    func testSha256Hex() {
        XCTAssertEqual(sha256Hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}

final class AuthProviderTests: XCTestCase {
    private func jwt(exp: TimeInterval) -> String {
        let payload = PKCE.base64URL(Data(#"{"sub":"u","exp":\#(Int(exp))}"#.utf8))
        return "eyJhbGciOiJSUzI1NiJ9.\(payload).sig"
    }

    func testRefreshIsScheduledAMinuteBeforeExpiry() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let token = jwt(exp: 1_000_000 + 900)
        XCTAssertEqual(DesynAuthProvider.refreshDelay(jwt: token, now: now), 840, accuracy: 0.001)
        XCTAssertEqual(DesynAuthProvider.refreshDelay(jwt: jwt(exp: 1_000_000 + 30), now: now), 15)
        XCTAssertEqual(DesynAuthProvider.refreshDelay(jwt: "not-a-jwt", now: now), 600)
    }
}

/// Answers every request of a stubbed URL session with a canned response and records the request.
final class StubURLProtocol: URLProtocol {
    struct Recorded {
        let method: String?
        let url: URL?
        let authorization: String?
        let body: Data
    }

    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var responseBody = Data()
    nonisolated(unsafe) static var recorded: [Recorded] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        Self.recorded.append(Recorded(
            method: request.httpMethod,
            url: request.url,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: body
        ))
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class AccountDeletionTests: XCTestCase {
    private func client() -> AuthClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return AuthClient(environment: .production, session: URLSession(configuration: configuration))
    }

    override func setUp() {
        StubURLProtocol.recorded = []
        StubURLProtocol.status = 200
        StubURLProtocol.responseBody = Data(#"{"success":true,"message":"User deleted"}"#.utf8)
    }

    func testDeletesWithTheBearerSessionAndOptionalPassword() async throws {
        let auth = client()
        try await auth.deleteAccount(sessionToken: "tok", password: "hunter22")
        try await auth.deleteAccount(sessionToken: "tok", password: nil)
        XCTAssertEqual(StubURLProtocol.recorded.count, 2)
        let first = StubURLProtocol.recorded[0]
        XCTAssertEqual(first.method, "POST")
        XCTAssertEqual(first.url, AppEnvironment.production.convexSiteURL.appendingPathComponent("api/auth/delete-user"))
        XCTAssertEqual(first.authorization, "Bearer tok")
        XCTAssertEqual(try JSONValue.parse(String(decoding: first.body, as: UTF8.self)), ["password": "hunter22"])
        XCTAssertEqual(try JSONValue.parse(String(decoding: StubURLProtocol.recorded[1].body, as: UTF8.self)), [:])
    }

    func testRefusalsExplainWhatToDo() async {
        StubURLProtocol.status = 400
        let cases: [(code: String, expected: String)] = [
            ("INVALID_PASSWORD", "INVALID_PASSWORD"),
            ("SESSION_EXPIRED", "SESSION_EXPIRED"),
            ("CREDENTIAL_ACCOUNT_NOT_FOUND", "NO_PASSWORD"),
        ]
        for item in cases {
            StubURLProtocol.responseBody = Data(#"{"code":"\#(item.code)","message":"raw"}"#.utf8)
            do {
                try await client().deleteAccount(sessionToken: "tok", password: nil)
                XCTFail("expected \(item.code) to throw")
            } catch let error as DesynError {
                XCTAssertEqual(error.code, item.expected)
                XCTAssertNotEqual(error.message, "raw")
            } catch {
                XCTFail("unexpected \(error)")
            }
        }
    }
}
