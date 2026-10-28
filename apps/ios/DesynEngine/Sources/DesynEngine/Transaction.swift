import Foundation

/// `Transaction.source` (DOCUMENT_MODEL section 5).
public enum TransactionSource: String, Sendable, CaseIterable {
    case user, ai, workflow, `import`, template, system
}

/// Builds contract transactions and ids on the Swift side.
public enum DesynTransaction {
    /// Alphabet of generated ids (`[a-z0-9]`, 12 characters).
    static let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    /// A new 12-character id from the system CSPRNG (same format as `newId()` in `@desyn/schema`).
    public static func newID() -> String {
        var rng = SystemRandomNumberGenerator()
        return String((0..<12).map { _ in alphabet[Int(rng.next(upperBound: UInt64(alphabet.count)))] })
    }

    /// A `Transaction` JSON with a fresh id around `opsJSON` (a JSON `Op[]`, embedded verbatim so numbers and
    /// keys are not re-encoded).
    public static func json(
        opsJSON: String,
        label: String,
        source: TransactionSource = .user,
        id: String = DesynTransaction.newID(),
        actor: [String: String]? = nil,
        timestamp: Date = Date()
    ) throws -> String {
        guard let opsData = opsJSON.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: opsData)) is [Any]
        else {
            throw EngineError.InvalidJson(detail: "ops must be a JSON array")
        }
        var header: [String: Any] = [
            "id": id,
            "label": label,
            "source": source.rawValue,
            "ts": Int64((timestamp.timeIntervalSince1970 * 1000).rounded()),
        ]
        if let actor {
            header["actor"] = actor
        }
        let data = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys, .withoutEscapingSlashes])
        // `{...}` -> `{...,"ops":[...]}`
        let object = String(decoding: data, as: UTF8.self)
        return String(object.dropLast()) + ",\"ops\":" + opsJSON + "}"
    }
}
