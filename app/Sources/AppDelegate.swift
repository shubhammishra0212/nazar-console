// AppDelegate.swift — one window holding one WKWebView that shows web/index.html from inside the app bundle.
//
// The interesting part is the web view configuration: a page loaded from file:// is not a "secure origin", so WebKit
// would normally refuse getUserMedia. Two private WKPreferences switch that check off, and a WKUIDelegate answers the
// page's camera request (macOS still asks the user once, using NSCameraUsageDescription from Info.plist). Timer
// throttling for hidden windows is switched off too, so the photo and verdict timing stays exact when the console is
// covered by slides on stage.

import AppKit
import AVFoundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private let bridge = Bridge()
    private var noNap: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = Menu.build()

        let content = WKUserContentController()
        content.add(bridge, name: "nazar")
        content.addUserScript(WKUserScript(source: Settings.injectionScript, injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.userContentController = content
        config.mediaTypesRequiringUserActionForPlayback = []
        let prefs = config.preferences
        setPrivate(prefs, "developerExtrasEnabled", true)                    // right-click › Inspect Element
        setPrivate(prefs, "mediaDevicesEnabled", true)                       // navigator.mediaDevices on file://
        setPrivate(prefs, "mediaCaptureRequiresSecureConnection", false)
        setPrivate(prefs, "hiddenPageDOMTimerThrottlingEnabled", false)      // exact timers when covered
        setPrivate(prefs, "pageVisibilityBasedProcessSuppressionEnabled", false)
        noNap = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep],
                                                      reason: "Timing the inspection photo and verdict")

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        bridge.web = web

        let visible = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let size = NSSize(width: min(1520, visible.width - 40), height: min(940, visible.height - 40))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "NAZAR Console"
        window.minSize = NSSize(width: 1100, height: 700)
        window.backgroundColor = NSColor(srgbRed: 0x23 / 255, green: 0x28 / 255, blue: 0x2C / 255, alpha: 1)
        window.contentView = web
        window.setFrameAutosaveName("NAZARConsoleWindow")
        if !window.setFrameUsingName("NAZARConsoleWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)
        bridge.window = window

        loadPage()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The page from the bundle. NAZAR_WEB_DIR=/path/to/repo/web loads the working copy instead (for development).
    private func loadPage() {
        let env = ProcessInfo.processInfo.environment["NAZAR_WEB_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        let dir = env ?? Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
    }

    private func setPrivate(_ prefs: WKPreferences, _ key: String, _ value: Bool) {
        let setter = "_set" + key.prefix(1).uppercased() + key.dropFirst() + ":"
        if prefs.responds(to: NSSelectorFromString(setter)) { prefs.setValue(value, forKey: key) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { bridge.shutdown() }

    @objc func reloadPage(_ sender: Any?) { web.reload() }

    // MARK: camera permission for the page

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard type == .camera else { decisionHandler(.deny); return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            decisionHandler(.grant)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { decisionHandler(granted ? .grant : .deny) }
            }
        default:
            decisionHandler(.deny)
        }
    }

    // MARK: navigation: stay inside the bundle, open anything else in the browser

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    /// If WebKit's page process dies, bring the screen back instead of leaving a blank window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.log("web content process ended, reloading")
        bridge.shutdown()
        loadPage()
    }
}
