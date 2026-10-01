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
    case idle, listening, thinking, speaking, followable, task

    var symbol: String {
        switch self {
        case .idle:       return "eye"
        case .listening:  return "waveform"
        case .thinking:   return "ellipsis.circle"
        case .speaking:   return "speaker.wave.2"
        // Filled, so a follow-up window is visible at a glance without being
        // a different shape to learn.
        case .followable: return "eye.fill"
        // A task in progress outlasts any one answer, so the menu bar has to
        // show it: otherwise the only reminder lives in a panel that times out.
        case .task:       return "checklist"
        }
    }
    var label: String {
        switch self {
        case .idle:       return "glance — idle"
        case .listening:  return "glance — listening"
        case .thinking:   return "glance — thinking"
        case .speaking:   return "glance — speaking"
        case .followable: return "glance — press ⌥Space again to follow up on the same screen"
        case .task:       return "glance — task in progress, ⌥N for the next step"
        }
    }
}

/// A text box that submits on Return and grows to fit what you type.
///
/// The original was a single-line NSTextField: long questions scrolled sideways
/// and everything already typed disappeared, so you could not read back what you
/// had written before sending it.
final class QuestionTextView: NSTextView {
    var onSubmit: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // Return sends. Shift-Return inserts a line break, for the rare question
        // that wants one.
        if event.keyCode == 36 && !event.modifierFlags.contains(.shift) {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}

/// A small panel of text near the cursor.
///
/// Non-activating, so it never steals focus from what you are working in —
/// which matters because the answer is usually about that window. Floating
/// level, so it sits above normal windows without being a screen overlay.
/// No permission of any kind: this is an ordinary window, drawn by us.
/// A badge beside the cursor while glance is working.
///
/// Deliberately tiny — about the size of the pointer itself. Between pressing
/// the hotkey and hearing anything there is a long pause, and showing nothing
/// during it feels broken rather than busy. But a panel of text for "Thinking…"
/// is too much furniture for a wait: it covers what you are looking at and
/// says nothing you did not already know. A small pulsing dot is enough to mean
/// "it heard you", and gets out of the way.
final class StatusBadge {
    private var panel: NSPanel?
    private var icon: NSImageView?
    private var pulse: Timer?
    private var phase = ""

    private let size: CGFloat = 26

    func show(_ newPhase: String) {
        guard newPhase != phase else { return }
        phase = newPhase

        let symbol: String = {
            switch newPhase {
            case "listening": return "waveform"
            case "speaking":  return "speaker.wave.2.fill"
            default:          return "ellipsis"
            }
        }()

        if panel == nil { build() }
        icon?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: newPhase)
        reposition()
        startPulse()
    }

    func hide() {
        phase = ""
        pulse?.invalidate(); pulse = nil
        guard let p = panel else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.15
            p.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            self?.panel?.orderOut(nil); self?.panel = nil; self?.icon = nil
        })
    }

    private func build() {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.ignoresMouseEvents = true      // never in the way of a click
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.alphaValue = 0

        let blur = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = size / 2   // a circle, so it reads as a badge
        blur.layer?.masksToBounds = true

        let iv = NSImageView(frame: NSRect(x: 5, y: 5, width: size - 10, height: size - 10))
        iv.imageScaling = .scaleProportionallyUpOrDown
        iv.contentTintColor = .labelColor
        blur.addSubview(iv)

        p.contentView = blur
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            p.animator().alphaValue = 1
        }
        panel = p; icon = iv
    }

    /// Sit just below-right of the pointer, like a cursor badge, and stay on
    /// whichever screen the pointer is on.
    private func reposition() {
        guard let p = panel else { return }
        let m = NSEvent.mouseLocation
        var origin = NSPoint(x: m.x + 14, y: m.y - size - 10)
        let screen = NSScreen.screens.first { $0.frame.contains(m) } ?? NSScreen.main
        if let vf = screen?.visibleFrame {
            origin.x = min(max(vf.minX + 4, origin.x), vf.maxX - size - 4)
            origin.y = min(max(vf.minY + 4, origin.y), vf.maxY - size - 4)
        }
        p.setFrameOrigin(origin)
    }

    /// A slow breathing fade, so a sixteen-second wait still looks alive.
    private func startPulse() {
        pulse?.invalidate()
        var up = false
        pulse = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            guard let iv = self?.icon else { return }
            up.toggle()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.55
                iv.animator().alphaValue = up ? 1.0 : 0.4
            }
            self?.reposition()
        }
    }
}

/// The answer panel's content view.
///
/// Hovering pauses the countdown and clicking pins the panel open. Both exist
/// because an answer that disappears while you are still acting on it is the
/// worst failure this tool has: the information is gone, and spoken text cannot
/// be re-read. Following steps is exactly what glance is best at, and exactly
/// where a four-second timeout hurts most.
final class PanelView: NSVisualEffectView {
    var onHover: ((Bool) -> Void)?
    var onClick: (() -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds,
                               options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent)  { onHover?(false) }
    override func mouseDown(with event: NSEvent)    { onClick?() }
}

final class AnswerPanel {
    private var panel: NSPanel?
    private var dismissTimer: Timer?
    private var pinned = false
    private var hovering = false
    /// Non-nil while showing a task: the full checklist, for expanding into.
    private var checklist: [(text: String, done: Bool, current: Bool)] = []
    private var expanded = false
    private var taskHeader = ""
    private var anchorPoint = NSPoint.zero

    private func armDismiss(after seconds: Double) {
        dismissTimer?.invalidate()
        dismissTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self, !self.pinned, !self.hovering else { return }
            self.hide()
        }
    }

    /// Show the step the user is on, with the rest one click away.
    ///
    /// Collapsed by default: a six-line checklist parked beside the cursor
    /// covers the thing being worked on, and only one line of it is actionable
    /// at a time. The count carries the sense of progress that the list would.
    func showTask(header: String, step: String, steps: [(String, Bool, Bool)], near point: NSPoint) {
        checklist = steps.map { (text: $0.0, done: $0.1, current: $0.2) }
        taskHeader = header
        expanded = false
        show(renderTask(step: step), near: point, isError: false, isTask: true)
    }

    private func renderTask(step: String) -> String {
        if !expanded { return "\(taskHeader)\n\(step)" }
        let lines = checklist.map { item -> String in
            let mark = item.done ? "✓" : (item.current ? "●" : "○")
            return "\(mark)  \(item.text)"
        }
        return "\(taskHeader)\n" + lines.joined(separator: "\n")
    }

    func show(_ text: String, near point: NSPoint, isError: Bool = false, isTask: Bool = false) {
        if !isTask { checklist = []; expanded = false }
        if panel == nil { anchorPoint = point }
        hide()

        let font = NSFont.systemFont(ofSize: 14)
        let maxWidth: CGFloat = 380
        let inset: CGFloat = 16

        let label = NSTextField(wrappingLabelWithString: text)
        label.font = font
        // Failures read in the system's warning colour, so a problem is obvious
        // before a word of it is read.
        label.textColor = isError ? .systemRed : .labelColor
        label.isSelectable = true          // so an identifier can be copied out
        label.preferredMaxLayoutWidth = maxWidth - inset * 2
        label.setFrameSize(label.fittingSize)

        let w = min(maxWidth, label.frame.width + inset * 2)
        let h = label.frame.height + inset * 2 + 14   // room for the hint line

        // Keep it fully on whichever screen the cursor is on.
        let screen = NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main
        var origin = NSPoint(x: point.x + 18, y: point.y - h - 18)
        if let vf = screen?.visibleFrame {
            origin.x = min(max(vf.minX + 8, origin.x), vf.maxX - w - 8)
            origin.y = min(max(vf.minY + 8, origin.y), vf.maxY - h - 8)
        }

        let p = NSPanel(contentRect: NSRect(x: origin.x, y: origin.y, width: w, height: h),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.ignoresMouseEvents = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let blur = PanelView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 12
        blur.layer?.masksToBounds = true

        // Hovering holds it open. Standard behaviour for anything that
        // auto-dismisses, and invisible until you need it.
        blur.onHover = { [weak self] inside in
            guard let self else { return }
            self.hovering = inside
            if inside { self.dismissTimer?.invalidate() }
            else if !self.pinned { self.armDismiss(after: 3.0) }
        }
        // Clicking pins it until clicked again. A thin border marks the state,
        // so a pinned panel does not look like one that forgot to close.
        blur.onClick = { [weak self] in
            guard let self else { return }
            if !self.checklist.isEmpty {
                // A task expands to the whole checklist, and stays open while
                // expanded — you opened it to read it.
                self.expanded.toggle()
                self.pinned = self.expanded
                blur.layer?.borderWidth = self.expanded ? 1.5 : 0
                blur.layer?.borderColor = NSColor.controlAccentColor.cgColor
                let current = self.checklist.first(where: { $0.current })?.text ?? ""
                self.show(self.renderTask(step: current), near: self.anchorPoint, isError: false, isTask: true)
                if !self.expanded { self.armDismiss(after: 4.0) }
                return
            }
            self.pinned.toggle()
            blur.layer?.borderWidth = self.pinned ? 1.5 : 0
            blur.layer?.borderColor = NSColor.controlAccentColor.cgColor
            if self.pinned { self.dismissTimer?.invalidate() } else { self.armDismiss(after: 3.0) }
        }

        let hint = NSTextField(labelWithString:
            checklist.isEmpty ? "click to keep · ⌥R to repeat" : "click for all · ⌥N next step")
        hint.font = NSFont.systemFont(ofSize: 10)
        hint.textColor = .tertiaryLabelColor
        hint.sizeToFit()
        hint.setFrameOrigin(NSPoint(x: inset, y: 5))
        blur.addSubview(hint)

        label.setFrameOrigin(NSPoint(x: inset, y: inset + 12))
        blur.addSubview(label)
        p.contentView = blur
        p.orderFrontRegardless()
        panel = p

        // Long answers need longer on screen. Roughly 200 words per minute,
        // floored so a three-word answer does not vanish before it is seen.
        let words = text.split(separator: " ").count
        // Errors stay longer: they usually name a fix worth reading twice.
        let base = max(4.0, min(30.0, Double(words) / 200.0 * 60.0 + 2.5))
        let seconds = isError ? max(base, 12.0) : base
        armDismiss(after: seconds)
    }

    func hide() {
        dismissTimer?.invalidate()
        dismissTimer = nil
        pinned = false
        hovering = false
        panel?.orderOut(nil)
        panel = nil
    }
}

final class App: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var hotKeyRef: EventHotKeyRef?
    private var typeHotKeyRef: EventHotKeyRef?
    private var repeatHotKeyRef: EventHotKeyRef?
    private var nextHotKeyRef: EventHotKeyRef?
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
        menu.autoenablesItems = false
        menu.addItem(NSMenuItem(title: "Ask out loud", action: #selector(trigger), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Type a question…", action: #selector(askTyped), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Repeat last answer", action: #selector(repeatLast), keyEquivalent: ""))
        nextItem = NSMenuItem(title: "Next step", action: #selector(nextStep), keyEquivalent: "")
        clearTaskItem = NSMenuItem(title: "Clear task", action: #selector(clearTask), keyEquivalent: "")
        menu.addItem(nextItem!)
        menu.addItem(clearTaskItem!)
        menu.addItem(NSMenuItem(title: "New conversation", action: #selector(newConversation), keyEquivalent: ""))
        menu.addItem(.separator())
        for text in ["⌥Space — ask out loud", "⌥⇧Space — type a question",
                     "⌥R — repeat last answer", "⌥N — next step"] {
            let hint = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            hint.isEnabled = false
            menu.addItem(hint)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit glance", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusItem.menu = menu
        updateTaskMenu()

        log("repo root: \(repoRoot)")
        watchForUnlock()
        watchForAnswers()
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
    private let answerPanel = AnswerPanel()
    private let badge = StatusBadge()
    private var nextItem: NSMenuItem?
    private var clearTaskItem: NSMenuItem?
    private var taskActive = false
    private var lastTaskAt: Double = 0
    private var lastPhase = ""
    private var lastAnswerAt: Double = 0

    private var answerWatch: Timer?

    /// Watch for answers continuously, not only during a hotkey run.
    ///
    /// Answers also arrive from `glance` typed in a terminal, and those deserve
    /// the panel just as much. Polling a small file twice a second is cheaper
    /// than an FSEvents stream and simpler to reason about.
    private func watchForAnswers() {
        // Quarter-second, because this also drives the badge: any slower and
        // the gap between pressing the key and seeing anything feels dead.
        answerWatch = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.pollPhase()
            self?.pollTask()
            self?.showAnswerIfNew()
        }
        // Ignore whatever is already on disk, so restarting does not replay the
        // last answer.
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".glance/answer.json")
        if let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let at = obj["at"] as? Double {
            lastAnswerAt = at
        }
    }

    /// Follow the phase the CLI reports, and show the badge while it works.
    ///
    /// A stale file is ignored: if a run is killed the phase never returns to
    /// idle, and a badge that sat beside the cursor forever would be worse than
    /// none at all.
    private func pollPhase() {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".glance/state")
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        let phase = raw.trimmingCharacters(in: .whitespacesAndNewlines)

        if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
           let modified = attrs[.modificationDate] as? Date,
           Date().timeIntervalSince(modified) > 120 {
            badge.hide()
            return
        }
        guard phase != lastPhase else { return }
        lastPhase = phase

        switch phase {
        case "listening", "thinking", "speaking":
            setState(State(rawValue: phase) ?? .idle)
            badge.show(phase)
        default:
            // A task outlives any single answer, so idle must not erase it.
            setState(taskActive ? .task : .idle)
            badge.hide()
        }
    }

    /// Follow the task the CLI is tracking.
    ///
    /// Reads the same way as the answer and phase files — one small JSON file,
    /// polled, with the menu reflecting whether a task exists at all. The
    /// panel is only redrawn when the step actually changes, so a task sitting
    /// at step three does not reappear every quarter second.
    private func pollTask() {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".glance/task-display.json")
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let at = obj["at"] as? Double else {
            if taskActive {
                taskActive = false
                updateTaskMenu()
                setState(.idle)
            }
            return
        }

        if !taskActive { taskActive = true; updateTaskMenu() }

        guard at > lastTaskAt else { return }
        lastTaskAt = at

        let current = (obj["current"] as? Int) ?? 0
        let total = (obj["total"] as? Int) ?? 0
        let step = (obj["step"] as? String) ?? ""
        let raw = (obj["steps"] as? [[String: Any]]) ?? []
        let steps: [(String, Bool, Bool)] = raw.enumerated().map { i, d in
            ((d["text"] as? String) ?? "", (d["done"] as? Bool) ?? false, i == current - 1)
        }

        setState(.task)
        statusItem.button?.toolTip = "glance — step \(current) of \(total)"
        DispatchQueue.main.async { [weak self] in
            self?.badge.hide()
            self?.answerPanel.showTask(header: "Step \(current) of \(total)",
                                       step: step, steps: steps,
                                       near: NSEvent.mouseLocation)
        }
    }

    /// Task-only menu items are hidden when there is no task to act on.
    private func updateTaskMenu() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.nextItem?.isHidden = !self.taskActive
            self.clearTaskItem?.isHidden = !self.taskActive
        }
    }

    /// Show the answer the CLI just wrote, positioned by the cursor.
    private func showAnswerIfNew() {
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".glance/answer.json")
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = obj["text"] as? String,
              let at = obj["at"] as? Double,
              at > lastAnswerAt else { return }
        lastAnswerAt = at
        let isError = (obj["isError"] as? Bool) ?? false
        DispatchQueue.main.async { [weak self] in
            self?.badge.hide()
            self?.answerPanel.show(text, near: NSEvent.mouseLocation, isError: isError)
            if isError { NSSound.beep() }
        }
    }

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
            self.showAnswerIfNew()
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
            switch hkID.id {
            case 2:  app.askTyped()
            case 3:  app.repeatLast()
            case 4:  app.nextStep()
            default: app.trigger()
            }
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
        // ⌥R — bring the last answer back. Mnemonic, and nothing else uses it.
        let repeatID = EventHotKeyID(signature: OSType(0x474C4E43 /* GLNC */), id: 3)
        let s3 = RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(optionKey),
                                     repeatID, GetApplicationEventTarget(), 0, &repeatHotKeyRef)
        log(s2 == noErr ? "⌥⇧Space registered (typed)"
                        : "could not register ⌥⇧Space (error \(s2))")
        // ⌥N — tick the current step and move to the next.
        let nextID = EventHotKeyID(signature: OSType(0x474C4E43 /* GLNC */), id: 4)
        let s4 = RegisterEventHotKey(UInt32(kVK_ANSI_N), UInt32(optionKey),
                                     nextID, GetApplicationEventTarget(), 0, &nextHotKeyRef)
        log(s3 == noErr ? "⌥R registered (repeat last answer)"
                        : "could not register ⌥R (error \(s3))")
        log(s4 == noErr ? "⌥N registered (next step)"
                        : "could not register ⌥N (error \(s4))")
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

        // A scrolling, wrapping text view rather than a single-line field, so a
        // long question stays visible instead of scrolling out of sight.
        let width: CGFloat = 360, height: CGFloat = 92
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.autohidesScrollers = true

        let text = QuestionTextView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        text.minSize = NSSize(width: 0, height: height)
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = true
        text.font = NSFont.systemFont(ofSize: 13)
        text.isRichText = false
        text.isAutomaticQuoteSubstitutionEnabled = false
        text.textContainerInset = NSSize(width: 4, height: 6)
        text.onSubmit = { [weak alert] in
            // Drive the default button, so Return behaves exactly like clicking Ask.
            alert?.buttons.first?.performClick(nil)
        }
        scroll.documentView = text

        alert.accessoryView = scroll
        alert.window.initialFirstResponder = text

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let question = text.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }

        // Single-quote safely: the question goes through bash -lc.
        let escaped = question.replacingOccurrences(of: "'", with: "'\\''")
        run(command: "./bin/glance-run --ask '\(escaped)'", listening: false)
    }

    /// Drop the current conversation, so the next question captures afresh.
    /// Show and speak the last answer again.
    ///
    /// Allowed to run even while a glance is in flight: wanting the previous
    /// answer back is most likely precisely when you are busy acting on it.
    @objc func repeatLast() { runDetached("./bin/glance-run --repeat") }

    /// Tick the current step and move on.
    @objc func nextStep() { runDetached("./bin/glance-run --next") }

    /// Drop the task. Recoverable with `glance task restore`.
    @objc func clearTask() {
        runDetached("./bin/glance-run --task-clear")
        taskActive = false
        setState(.idle)
    }

    private func runDetached(_ command: String) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-lc", "cd '\(repoRoot)' && \(command)"]
        try? task.run()
    }

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
            self.showAnswerIfNew()
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
