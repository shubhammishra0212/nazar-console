// CameraControls.swift — the webcam's own picture settings (exposure, gain, mains frequency...) through CoreMediaIO.
//
// A web page can show the camera (getUserMedia) but cannot change its exposure. On the rig, the Logitech C270 on
// automatic exposure turned the shiny washer face 100 % pure white, so the AI saw nothing. A fixed exposure of about
// 1.5 ms with gain 0 fixed it. macOS exposes the UVC controls of a USB camera as CMIO "feature controls"; we find the
// device whose name matches the page's camera label and read or write its controls.
//
// Units are the camera's own: UVC exposure is in 100 µs steps (15 = 1.5 ms), power-line is 0 off / 1 50 Hz / 2 60 Hz.

import Foundation
import CoreAudio
import CoreMediaIO

enum CameraControls {
    /// Our names for the controls the page knows, and their CMIO class IDs.
    private static let kinds: [(String, Int)] = [
        ("exposure", kCMIOExposureControlClassID),
        ("gain", kCMIOGainControlClassID),
        ("brightness", kCMIOBrightnessControlClassID),
        ("contrast", kCMIOContrastControlClassID),
        ("saturation", kCMIOSaturationControlClassID),
        ("sharpness", kCMIOSharpnessControlClassID),
        ("whitebalance", kCMIOWhiteBalanceControlClassID),
        ("backlight", kCMIOBacklightCompensationControlClassID),
        ("powerline", kCMIOPowerLineFrequencyControlClassID),
    ]

    private static func address(_ selector: Int) -> CMIOObjectPropertyAddress {
        CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(selector),
                                  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    }

    private static func children(_ obj: CMIOObjectID, _ selector: Int) -> [CMIOObjectID] {
        var a = address(selector)
        var size: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == 0, size > 0 else { return [] }
        var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
        var used: UInt32 = 0
        guard CMIOObjectGetPropertyData(obj, &a, 0, nil, size, &used, &ids) == 0 else { return [] }
        return Array(ids.prefix(Int(used) / MemoryLayout<CMIOObjectID>.size))
    }

    private static func name(_ obj: CMIOObjectID) -> String {
        var a = address(kCMIOObjectPropertyName)
        var value: Unmanaged<CFString>?
        var used: UInt32 = 0
        let size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard CMIOObjectGetPropertyData(obj, &a, 0, nil, size, &used, &value) == 0, let v = value else { return "" }
        return v.takeRetainedValue() as String
    }

    private static func read<T>(_ obj: CMIOObjectID, _ selector: Int, as initial: T) -> T? {
        var a = address(selector)
        guard CMIOObjectHasProperty(obj, &a) else { return nil }
        var v = initial
        var used: UInt32 = 0
        let ok = CMIOObjectGetPropertyData(obj, &a, 0, nil, UInt32(MemoryLayout<T>.size), &used, &v) == 0
        return ok ? v : nil
    }

    private static func canWrite(_ obj: CMIOObjectID, _ selector: Int) -> Bool {
        var a = address(selector)
        var settable: DarwinBoolean = false
        return CMIOObjectHasProperty(obj, &a) && CMIOObjectIsPropertySettable(obj, &a, &settable) == 0 && settable.boolValue
    }

    @discardableResult
    private static func write<T>(_ obj: CMIOObjectID, _ selector: Int, _ value: T) -> Bool {
        var a = address(selector)
        var v = value
        return CMIOObjectSetPropertyData(obj, &a, 0, nil, UInt32(MemoryLayout<T>.size), &v) == 0
    }

    /// The CMIO device for a getUserMedia label such as "C270 HD WEBCAM" (labels sometimes carry a "(046d:0825)" tail).
    private static func device(named label: String) -> CMIOObjectID? {
        let want = label.lowercased().replacingOccurrences(of: #"\s*\([0-9a-f]{4}:[0-9a-f]{4}\)"#, with: "",
                                                           options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard !want.isEmpty else { return nil }
        let devices = children(CMIOObjectID(kCMIOObjectSystemObject), kCMIOHardwarePropertyDevices)
        let named = devices.map { ($0, name($0).lowercased()) }
        return (named.first { $0.1 == want } ?? named.first { $0.1.contains(want) || want.contains($0.1) && !$0.1.isEmpty })?.0
    }

    private static func controls(of dev: CMIOObjectID) -> [String: CMIOObjectID] {
        var found: [String: CMIOObjectID] = [:]
        for c in children(dev, kCMIOObjectPropertyOwnedObjects) {
            guard let cls = read(c, kCMIOObjectPropertyClass, as: CMIOClassID(0)) else { continue }
            if let kind = kinds.first(where: { CMIOClassID($0.1) == cls }) { found[kind.0] = c }
        }
        return found
    }

    /// Every control the camera offers: key, value, min, max, settable, auto (only when the camera has automatic).
    /// nil = no such camera (e.g. a phone camera through Continuity, which has no UVC controls).
    static func describe(camera label: String) -> [[String: Any]]? {
        guard let dev = device(named: label) else { return nil }
        let ctl = controls(of: dev)
        return kinds.compactMap { (key, _) -> [String: Any]? in
            guard let c = ctl[key],
                  let v = read(c, kCMIOFeatureControlPropertyNativeValue, as: Float32(0)) else { return nil }
            var d: [String: Any] = ["key": key, "value": Double(v),
                                    "settable": canWrite(c, kCMIOFeatureControlPropertyNativeValue)]
            if let r = read(c, kCMIOFeatureControlPropertyNativeRange, as: AudioValueRange()), r.mMaximum > r.mMinimum {
                d["min"] = r.mMinimum
                d["max"] = r.mMaximum
            }
            if canWrite(c, kCMIOFeatureControlPropertyAutomaticManual),
               let am = read(c, kCMIOFeatureControlPropertyAutomaticManual, as: UInt32(0)) {
                d["auto"] = am != 0
            }
            return d
        }
    }

    /// Set one control. `auto` switches automatic on/off; a `value` switches automatic off first.
    static func set(camera label: String, key: String, auto: Bool?, value: Double?) -> Bool {
        guard let dev = device(named: label), let c = controls(of: dev)[key] else { return false }
        var ok = true
        let hasAuto = canWrite(c, kCMIOFeatureControlPropertyAutomaticManual)
        if let auto, hasAuto {
            ok = write(c, kCMIOFeatureControlPropertyAutomaticManual, UInt32(auto ? 1 : 0)) && ok
        }
        if let value {
            if hasAuto && auto == nil { write(c, kCMIOFeatureControlPropertyAutomaticManual, UInt32(0)) }
            ok = write(c, kCMIOFeatureControlPropertyNativeValue, Float32(value)) && ok
        }
        return ok
    }
}
