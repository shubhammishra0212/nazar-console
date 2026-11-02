// Bridge.swift — the two-way link between the page (JavaScript) and the Mac (Swift).
//
//   page → Mac:  window.webkit.messageHandlers.nazar.postMessage({cmd: "open", path: "/dev/cu.usbserial-0001", baud: 115200})
//   Mac → page:  window.NazarNative.opened("/dev/cu.usbserial-0001")   (evaluateJavaScript)
//
// Every message is a small JSON object with a `cmd`. The page never touches files, ports or the camera hardware
// itself; it asks the bridge. In a normal browser the page uses its own Demo stand-in instead (web/js/bridge.js).

import AppKit
import UniformTypeIdentifiers
import WebKit

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var web: WKWebView?
    weak var window: NSWindow?
    private var port: SerialPort?
    private var awake: NSObjectProtocol?

    // MARK: page → Mac

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let cmd = m["cmd"] as? String else { return }
        switch cmd {
        case "listPorts":
            call("ports", SerialPort.available())
        case "open":
            openPort(m["path"] as? String ?? "", baud: m["baud"] as? Int ?? 115_200)
        case "close":
            port?.close()
        case "write":
            port?.write(m["text"] as? String ?? "")
        case "saveFile":
            saveFile(name: m["name"] as? String ?? "nazar.txt", text: m["text"] as? String, base64: m["base64"] as? String)
        case "saveSettings":
            if let data = m["data"] { Settings.save(data) }
        case "log":
            FileHandle.standardError.write(("[page] " + (m["text"] as? String ?? "") + "\n").data(using: .utf8)!)
        case "camDescribe":
            let cam = m["camera"] as? String ?? ""
            call("camInfo", cam, CameraControls.describe(camera: cam) as Any? ?? NSNull())
        case "camSet":
            let cam = m["camera"] as? String ?? ""
            var ok = true
            for item in m["items"] as? [[String: Any]] ?? [] {
                guard let key = item["key"] as? String else { continue }
                ok = CameraControls.set(camera: cam, key: key, auto: item["auto"] as? Bool,
                                        value: (item["value"] as? NSNumber)?.doubleValue) && ok
            }
            if m["quiet"] as? Bool != true {
                call("camInfo", cam, CameraControls.describe(camera: cam) as Any? ?? NSNull(), ok)
            }
        case "openFile":
            openFile(m["path"] as? String ?? "")
        case "keepAwake":
            keepAwake(m["on"] as? Bool ?? false)
        default:
            log("unknown bridge command \(cmd)")
        }
    }

    // MARK: serial

    private func openPort(_ path: String, baud: Int) {
        port?.onClose = nil
        port?.close()
        let p = SerialPort(path: path)
        p.onData = { [weak self] data in self?.call("data", String(decoding: data, as: UTF8.self)) }
        p.onClose = { [weak self, weak p] reason, unexpected in
            guard let self, let p, self.port === p else { return }
            self.port = nil
            self.keepAwake(false)
            self.log("port closed: \(reason)\(unexpected ? " (unexpected)" : "")")
            self.call("closed", reason, unexpected)
        }
        do {
            try p.open(baud: baud)
            port = p
            keepAwake(true)
            log("port open: \(path) @ \(baud)")
            call("opened", path)
        } catch {
            log("open failed: \(error)")
            call("error", "\(error)")
        }
    }

    func shutdown() { port?.onClose = nil; port?.close() }

    // MARK: files

    private func saveFile(name: String, text: String?, base64: String?) {
        guard let data = base64.flatMap({ Data(base64Encoded: $0) }) ?? text?.data(using: .utf8) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        let ext = (name as NSString).pathExtension
        if let t = UTType(filenameExtension: ext) { panel.allowedContentTypes = [t] }
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            guard r == .OK, let url = panel.url else { self?.call("saved", NSNull()); return }
            do { try data.write(to: url); self?.call("saved", url.path) } catch { self?.call("error", "Could not save: \(error.localizedDescription)") }
        }
        if let w = window { panel.beginSheetModal(for: w, completionHandler: finish) } else { finish(panel.runModal()) }
    }

    /// Start AI: open `Start Vision.command` / `Start Agent.command` in Terminal.
    private func openFile(_ path: String) {
        let full = (path as NSString).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: full) else {
            call("opened_file", path, false, "Not found: \(full)")
            return
        }
        let ok = NSWorkspace.shared.open(URL(fileURLWithPath: full))
        call("opened_file", path, ok, ok ? "" : "macOS refused to open it")
    }

    // MARK: display awake while the line is connected

    private func keepAwake(_ on: Bool) {
        if on, awake == nil {
            awake = ProcessInfo.processInfo.beginActivity(options: [.idleDisplaySleepDisabled, .userInitiated],
                                                          reason: "NAZAR line is connected")
        } else if !on, let a = awake {
            ProcessInfo.processInfo.endActivity(a)
            awake = nil
        }
    }

    // MARK: Mac → page

    func call(_ fn: String, _ args: Any...) {
        let array = args.map { $0 is NSNull ? NSNull() : $0 }
        guard let data = try? JSONSerialization.data(withJSONObject: array, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript("window.NazarNative && window.NazarNative.\(fn) && window.NazarNative.\(fn).apply(null, \(json))")
    }

    func log(_ text: String) {
        FileHandle.standardError.write(("[nazar] " + text + "\n").data(using: .utf8)!)
    }
}
