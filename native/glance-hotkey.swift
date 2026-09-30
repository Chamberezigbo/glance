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

enum State: String {
    case idle, listening, thinking, speaking, followable

    var symbol: String {
        switch self {
        case .idle:       return "eye"
        case .listening:  return "waveform"
        case .thinking:   return "ellipsis.circle"
        case .speaking:   return "speaker.wave.2"
        // Filled, so a follow-up window is visible at a glance without being
        // a different shape to learn.
        case .followable: return "eye.fill"
        }
    }
    var label: String {
        switch self {
        case .idle:       return "glance — idle"
        case .listening:  return "glance — listening"
        case .thinking:   return "glance — thinking"
        case .speaking:   return "glance — speaking"
        case .followable: return "glance — press ⌥Space again to follow up on the same screen"
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
        menu.addItem(NSMenuItem(title: "New conversation", action: #selector(newConversation), keyEquivalent: ""))
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
        watchForUnlock()
        greet()
        registerHotKey()
        requestMicrophoneAccess()
        checkScreenAccess()
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

    /// Screen Recording, asked for up front.
    ///
    /// Unlike the microphone this cannot be granted and used in the same
    /// session: macOS requires the application to be restarted before a new
    /// grant takes effect. So the message says so rather than implying it will
    /// start working on its own.
    private func checkScreenAccess() {
        if CGPreflightScreenCaptureAccess() {
            log("screen recording: granted")
            return
        }
        log("screen recording: denied")
        CGRequestScreenCaptureAccess()
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText = "glance needs to record the screen"
            a.informativeText = "Without this glance receives a picture of your empty desktop rather than your windows, and will answer as though nothing is open.\n\nSwitch glance on under Screen Recording, then quit and reopen glance — macOS does not apply this permission until the app restarts."
            a.addButton(withTitle: "Open Settings")
            a.addButton(withTitle: "Later")
            if a.runModal() == .alertFirstButtonReturn,
               let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(url)
            }
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

    private var stateTimer: Timer?

    /// Speak a greeting at login and whenever the screen is unlocked.
    ///
    /// `com.apple.screenIsUnlocked` is a distributed notification, so this needs
    /// no permission — the same reason RegisterEventHotKey was chosen over an
    /// event tap. glance still watches nothing and records nothing on its own.
    private func watchForUnlock() {
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.screenIsUnlocked"),
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.greet()
        }
    }

    /// The CLI decides the wording, the voice, and whether it greeted too
    /// recently — so a rebuild or a quick lock-unlock does not greet twice.
    private func greet() {
        guard !running else { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-lc", "cd '\(repoRoot)' && ./bin/glance-run --greet"]
        try? task.run()
    }

    /// Poll ~/.glance/state, which the CLI writes as it moves through phases.
    private func startWatchingState() {
        stateTimer?.invalidate()
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".glance/state")
        stateTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] t in
            guard let self, self.running else { t.invalidate(); return }
            guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return }
            if let phase = State(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
                self.setState(phase)
            }
        }
    }

    private var followTimer: Timer?

    /// Hold a "you can follow up" icon for as long as the CLI will treat the
    /// next press as a continuation. Kept in sync with GLANCE_FOLLOW_MS.
    private func showFollowWindow() {
        let seconds = Double(ProcessInfo.processInfo.environment["GLANCE_FOLLOW_MS"]
            .flatMap { Double($0) }.map { $0 / 1000 } ?? 45)
        setState(.followable)
        DispatchQueue.main.async { [weak self] in
            self?.followTimer?.invalidate()
            self?.followTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
                self?.setState(.idle)
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

    /// Drop the current conversation, so the next question captures afresh.
    @objc func newConversation() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-lc", "cd '\(repoRoot)' && rm -f \"$HOME/.glance/session/conversation.json\""]
        try? task.run()
        followTimer?.invalidate()
        setState(.idle)
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
        // Follow the real phase rather than guessing. The previous version
        // flipped to "thinking" on a five-second timer, so it claimed to be
        // thinking while the microphone was still open — which reads as being
        // cut off mid-sentence even when the recording is fine.
        startWatchingState()
        task.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.running = false
            DispatchQueue.main.async { self.stateTimer?.invalidate() }
            // Most questions are follow-ups about the same screen, so show that
            // the conversation is still open rather than making people guess.
            self.showFollowWindow()
        }
        do { try task.run() } catch {
            running = false
            setState(.idle)
            NSSound.beep()
        }
    }
}

// Refuse to start if another copy is already running.
//
// launchd's kickstart can leave the previous process alive, and every survivor
// puts another icon in the menu bar and competes for the same hotkey. Better to
// exit quietly than to duplicate.
let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.glance.app")
    .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
if !running.isEmpty {
    FileHandle.standardError.write("glance: another instance is already running, exiting\n".data(using: .utf8)!)
    exit(0)
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
// Menu bar only: no Dock icon, no window.
app.setActivationPolicy(.accessory)
app.run()
