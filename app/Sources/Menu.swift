// Menu.swift — the menu bar. The Edit menu matters more than it looks: without it, Cmd-C / Cmd-V do nothing in the
// page's text boxes (serial send box, limits).

import AppKit

enum Menu {
    static func build() -> NSMenu {
        let bar = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "About NAZAR Console", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide NAZAR Console", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit NAZAR Console", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        add(app, to: bar)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        add(edit, to: bar)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload Screen", action: #selector(AppDelegate.reloadPage(_:)), keyEquivalent: "r")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]
        add(view, to: bar)

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        add(window, to: bar)
        NSApp.windowsMenu = window
        return bar
    }

    private static func add(_ menu: NSMenu, to bar: NSMenu) {
        let item = NSMenuItem()
        item.submenu = menu
        bar.addItem(item)
    }
}
