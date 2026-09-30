// glance menu-bar daemon: registers a global hotkey and shows what it is doing.
//
// Deliberately uses Carbon's RegisterEventHotKey rather than a CGEventTap or
// NSEvent.addGlobalMonitorForEvents. Those two observe *all* keystrokes and so
// require Input Monitoring or Accessibility. RegisterEventHotKey asks the
// window server to deliver one specific chord and nothing else, which needs no
// privacy permission at all.
//
// That is not a shortcut — it is the point. glance never asks for the
// permissions that would let it read what you type or control your machine, so
// it cannot do either even if it were compromised.
import Cocoa
import Carbon.HIToolbox
import AVFoundation

enum State {
    case idle, listening, thinking

    var symbol: String {
        switch self {
        case .idle:      return "eye"
        case .listening: return "waveform"
        case .thinking:  return "ellipsis.circle"
        }
    }
    var label: String {
        switch self {
        case .idle:      return "glance — idle"
        case .listening: return "glance — listening"
        case .thinking:  return "glance — thinking"
        }
    }
}

final class App: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var hotKeyRef: EventHotKeyRef?
    private var typeHotKeyRef: EventHotKeyRef?
    private var running = false
    private let repoRoot: String

    override init() {
        // Walk up from the executable until we find the repo, rather than
        // counting directories. The depth differs between a bare binary
        // (<repo>/bin/glance-hotkey) and the app bundle
        // (<repo>/bin/glance.app/Contents/MacOS/glance), and hardcoding either
        // one silently breaks the other.
        var dir = URL(fileURLWithPath: CommandLine.arguments[0])
            .resolvingSymlinksInPath()
            .deletingLastPathComponent()
        var found: String? = nil
        for _ in 0..<8 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("bin/glance-run").path) {
                found = dir.path
                break
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        repoRoot = found ?? dir.path
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setState(.idle)

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Ask out loud", action: #selector(trigger), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Type a question…", action: #selector(askTyped), keyEquivalent: ""))
        menu.addItem(.separator())
        for text in ["⌥Space — ask out loud", "⌥⇧Space — type a question"] {
            let hint = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            hint.isEnabled = false
            menu.addItem(hint)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit glance", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusItem.menu = menu

        log("repo root: \(repoRoot)")
        registerHotKey()
        requestMicrophoneAccess()
    }

    /// Ask for the microphone up front, rather than letting the first ⌥Space
    /// fail silently.
    ///
    /// macOS grants this per *application*, so the grant the user's terminal
    /// holds does not carry over to this daemon. It also cannot be requested at
    /// all from a bare executable — the process must be a bundled .app with
    /// NSMicrophoneUsageDescription in its Info.plist, or TCC denies it without
    /// ever showing a prompt.
    private func requestMicrophoneAccess() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            log("microphone: granted")
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] ok in
                self?.log("microphone: \(ok ? "granted" : "denied")")
                if !ok { self?.warnNoMic() }
            }
        default:
            log("microphone: denied")
            warnNoMic()
        }
    }

    private func warnNoMic() {
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText = "glance needs the microphone"
            a.informativeText = "Voice questions will not work until glance is allowed to use the microphone.\n\nOpen System Settings > Privacy & Security > Microphone and switch glance on."
            a.addButton(withTitle: "Open Settings")
            a.addButton(withTitle: "Later")
            if a.runModal() == .alertFirstButtonReturn,
               let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func log(_ msg: String) {
        FileHandle.standardError.write("glance: \(msg)\n".data(using: .utf8)!)
    }

    private func setState(_ s: State) {
        DispatchQueue.main.async {
            let img = NSImage(systemSymbolName: s.symbol, accessibilityDescription: s.label)
            self.statusItem.button?.image = img
            self.statusItem.button?.toolTip = s.label
        }
    }

    private func registerHotKey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let userData else { return noErr }
            var hkID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject),
                              EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            let app = Unmanaged<App>.fromOpaque(userData).takeUnretainedValue()
            if hkID.id == 2 { app.askTyped() } else { app.trigger() }
            return noErr
        }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), nil)

        // ⌥Space — ask out loud.
        let voiceID = EventHotKeyID(signature: OSType(0x474C4E43 /* GLNC */), id: 1)
        let s1 = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey),
                                     voiceID, GetApplicationEventTarget(), 0, &hotKeyRef)
        // ⌥⇧Space — type the question instead. Speaking is wrong in a meeting,
        // and wrong for anything containing an identifier or a file path.
        let typeID = EventHotKeyID(signature: OSType(0x474C4E43 /* GLNC */), id: 2)
        let s2 = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey | shiftKey),
                                     typeID, GetApplicationEventTarget(), 0, &typeHotKeyRef)
        log(s1 == noErr ? "⌥Space registered (voice), no permissions required"
                        : "could not register ⌥Space (error \(s1))")
        log(s2 == noErr ? "⌥⇧Space registered (typed)"
                        : "could not register ⌥⇧Space (error \(s2))")
    }

    /// Ask by typing: a small panel instead of the microphone.
    @objc func askTyped() {
        guard !running else { NSSound.beep(); return }
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "Ask about your screen"
        alert.informativeText = "glance will capture the screen your mouse is on."
        alert.addButton(withTitle: "Ask")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "what is this error telling me?"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let question = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }

        // Single-quote safely: the question goes through bash -lc.
        let escaped = question.replacingOccurrences(of: "'", with: "'\\''")
        run(command: "./bin/glance-run --ask '\(escaped)'", listening: false)
    }

    @objc func trigger() {
        // One at a time. A second press mid-answer would talk over the first.
        guard !running else { NSSound.beep(); return }
        run(command: "./bin/glance-run", listening: true)
    }

    private func run(command: String, listening: Bool) {
        running = true
        setState(listening ? .listening : .thinking)

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-lc", "cd '\(repoRoot)' && \(command)"]
        if listening {
            // Once recording stops, the rest is capture + model + speech.
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in
                if self?.running == true { self?.setState(.thinking) }
            }
        }
        task.terminationHandler = { [weak self] _ in
            self?.running = false
            self?.setState(.idle)
        }
        do { try task.run() } catch {
            running = false
            setState(.idle)
            NSSound.beep()
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
// Menu bar only: no Dock icon, no window.
app.setActivationPolicy(.accessory)
app.run()
