// SerialPort.swift — the USB link to the ESP32, written with plain POSIX calls (no Xcode, no frameworks).
//
// open() + termios puts the port in raw 8N1 mode, TIOCEXCL stops any other app (Arduino IDE, a second console)
// from opening it while we hold it, and IOSSIOSPEED lets us use any baud rate. A DispatchSourceRead wakes us when
// bytes arrive. A read that returns 0 or an error means the cable was pulled (or the simulator quit): we close the
// port and report it as "unexpected", so the page can show CONNECTION LOST and reconnect when the port comes back.

import Foundation

// These two ioctl numbers are C macros that Swift cannot import, so they are spelled out here.
private let ioctlExclusive: UInt = 0x2000_740D   // TIOCEXCL  = _IO('t', 13)
private let ioctlSpeed: UInt = 0x8008_5402       // IOSSIOSPEED = _IOW('T', 2, speed_t)

enum SerialError: Error, CustomStringConvertible {
    case open(String, Int32), setup(String, Int32)
    var description: String {
        switch self {
        case let .open(path, e):
            if e == EBUSY { return "\(path) is in use by another app. Close the Arduino Serial Monitor and try again." }
            return "Could not open \(path): \(String(cString: strerror(e)))"
        case let .setup(step, e): return "Could not set up the port (\(step)): \(String(cString: strerror(e)))"
        }
    }
}

final class SerialPort {
    let path: String
    /// Raw bytes from the board, delivered on the main queue.
    var onData: ((Data) -> Void)?
    /// The port closed. `unexpected` is true when the cable was pulled or the read failed.
    var onClose: ((_ reason: String, _ unexpected: Bool) -> Void)?

    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "nazar.serial")
    private var finished = false

    init(path: String) { self.path = path }

    func open(baud: Int) throws {
        let f = Darwin.open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard f >= 0 else { throw SerialError.open(path, errno) }
        if ioctl(f, ioctlExclusive) != 0 {
            let e = errno; Darwin.close(f); throw SerialError.open(path, e == 0 ? EBUSY : e)
        }
        var t = termios()
        guard tcgetattr(f, &t) == 0 else { let e = errno; Darwin.close(f); throw SerialError.setup("tcgetattr", e) }
        cfmakeraw(&t)                                       // no echo, no line editing, no CR/LF translation
        t.c_cflag |= tcflag_t(CLOCAL | CREAD | CS8)         // 8 data bits, ignore modem lines, enable receiver
        t.c_cflag &= ~tcflag_t(PARENB | CSTOPB | CRTSCTS)   // no parity, 1 stop bit, no hardware flow control
        withUnsafeMutableBytes(of: &t.c_cc) { cc in          // return from read() at once with what is there
            cc[Int(VMIN)] = 0
            cc[Int(VTIME)] = 0
        }
        cfsetspeed(&t, speed_t(baud))
        guard tcsetattr(f, TCSANOW, &t) == 0 else { let e = errno; Darwin.close(f); throw SerialError.setup("tcsetattr", e) }
        var speed = speed_t(baud)
        _ = ioctl(f, ioctlSpeed, &speed)                    // exact baud even if it is not a standard one; ptys refuse, that is fine
        tcflush(f, TCIOFLUSH)                               // drop anything left from before we opened it
        fd = f

        let src = DispatchSource.makeReadSource(fileDescriptor: f, queue: queue)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        src.setCancelHandler { Darwin.close(f) }
        source = src
        src.resume()
    }

    private func readAvailable() {
        var buf = [UInt8](repeating: 0, count: 4096)
        let n = Darwin.read(fd, &buf, buf.count)
        if n > 0 {
            let data = Data(buf[0..<n])
            DispatchQueue.main.async { self.onData?(data) }
        } else if n == 0 || (errno != EAGAIN && errno != EINTR) {
            // 0 bytes on a "readable" port, or ENXIO / EIO: the device is gone
            finish(reason: "The board stopped answering (cable unplugged?)", unexpected: true)
        }
    }

    func write(_ text: String) {
        let bytes = Array(text.utf8)
        queue.async { [weak self] in
            guard let self, self.fd >= 0, !self.finished else { return }
            var off = 0
            var tries = 0
            while off < bytes.count && tries < 50 {
                let n = bytes[off...].withUnsafeBufferPointer { Darwin.write(self.fd, $0.baseAddress, $0.count) }
                if n > 0 { off += n } else if errno == EAGAIN { tries += 1; usleep(2000) } else { break }
            }
        }
    }

    func close() {
        queue.async { [weak self] in self?.finish(reason: "Disconnected", unexpected: false) }
    }

    /// Runs on `queue`. Cancelling the source closes the file descriptor in its cancel handler.
    private func finish(reason: String, unexpected: Bool) {
        guard !finished else { return }
        finished = true
        source?.cancel()
        source = nil
        fd = -1
        DispatchQueue.main.async { self.onClose?(reason, unexpected) }
    }

    // MARK: - which ports to offer

    /// `/dev/cu.*` ports that could be an ESP32, USB-looking names first. Bluetooth and debug ports are hidden.
    /// `NAZAR_EXTRA_PORT=/dev/ttys004` (comma-separated) adds simulator ports for testing.
    static func available() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: "/dev")) ?? []
        let hidden = ["bluetooth", "debug-console", "wlan", "airpods", "headphones"]
        let usbHints = ["usbserial", "usbmodem", "slab", "wchusb", "ch34", "cp210", "ftdi"]
        let cu = names.filter { $0.hasPrefix("cu.") }
            .filter { n in !hidden.contains { n.lowercased().contains($0) } }
            .map { "/dev/" + $0 }
        func isUSB(_ p: String) -> Bool { usbHints.contains { p.lowercased().contains($0) } }
        var list = cu.filter(isUSB).sorted() + cu.filter { !isUSB($0) }.sorted()
        if let extra = ProcessInfo.processInfo.environment["NAZAR_EXTRA_PORT"] {
            let extras = extra.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            list = extras.filter { !$0.isEmpty && FileManager.default.fileExists(atPath: $0) } + list
        }
        return list
    }
}
