// make_icon.swift — draws the app icon: the white Team Parakh eye on a graphite macOS squircle, 1024 x 1024 PNG.
//   swift make_icon.swift assets/eye-white-1024.png out.png
// Apple's icon grid: the shape is 824 px inside a 1024 canvas (100 px margin), corner radius about 185 px.

import AppKit

let args = CommandLine.arguments
guard args.count == 3, let eye = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: swift make_icon.swift <eye.png> <out.png>\n".data(using: .utf8)!)
    exit(1)
}

let side = 1024
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)

// soft drop shadow under the tile, like system icons
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 24
shadow.set()
NSColor(srgbRed: 0x23 / 255, green: 0x28 / 255, blue: 0x2C / 255, alpha: 1).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

// the eye, centred, filling about 70 % of the tile
let eyeSide: CGFloat = 580
eye.draw(in: NSRect(x: (CGFloat(side) - eyeSide) / 2, y: (CGFloat(side) - eyeSide) / 2, width: eyeSide, height: eyeSide),
         from: .zero, operation: .sourceOver, fraction: 1)

NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
