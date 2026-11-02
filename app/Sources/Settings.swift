// Settings.swift — the page's settings (limits, timing, last port, camera, AI addresses) kept as one JSON string in
// UserDefaults. The native side never interprets them; it stores what the page sends and hands it back, injected as
// `window.__NAZAR_SAVED` before any page script runs, so the first frame already uses the saved limits.

import Foundation

enum Settings {
    private static let key = "consoleSettings"

    /// The saved JSON object as text, or "null" when nothing has been saved yet.
    static func json() -> String {
        guard let s = UserDefaults.standard.string(forKey: key),
              let d = s.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: d)) is [String: Any] else { return "null" }
        return s
    }

    static func save(_ object: Any) {
        guard JSONSerialization.isValidJSONObject(object),
              let d = try? JSONSerialization.data(withJSONObject: object),
              let s = String(data: d, encoding: .utf8) else { return }
        UserDefaults.standard.set(s, forKey: key)
    }

    /// Script injected at document start.
    static var injectionScript: String {
        "window.__NAZAR_SAVED = \(json()); window.__NAZAR_NATIVE = true;"
    }
}
