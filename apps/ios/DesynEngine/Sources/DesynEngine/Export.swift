public extension ExportResult {
    /// File name for the export (`<name>.<extension>`).
    func fileName(_ name: String) -> String { "\(name).\(`extension`)" }
}
