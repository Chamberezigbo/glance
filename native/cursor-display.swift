// Prints the 1-based index of the display the mouse cursor is currently on,
// in the same ordering `screencapture -D` uses.
//
// This matters because the two obvious sources disagree: `system_profiler`
// enumerates displays in a different order than CGGetActiveDisplayList, and
// neither tells you where the user is actually looking. CGGetActiveDisplayList
// is the list `screencapture -D` indexes into, so resolving the cursor against
// it gives an index we can pass straight through.
import CoreGraphics
import Foundation

// `--check-screen` reports whether THIS process can capture the screen.
//
// Worth a flag of its own because Screen Recording is granted per application,
// and a denied screencapture does not fail — it silently returns the desktop
// wallpaper with no windows in it. glance then describes an empty desktop with
// complete confidence. An explicit preflight turns that into an error.
//
// It must run inside the process that will capture, so that it reports the
// app's grant rather than the terminal's.
if CommandLine.arguments.contains("--check-screen") {
    print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
    exit(0)
}

// Global coordinates, top-left origin — the same space as CGDisplayBounds.
let mouse = CGEvent(source: nil)?.location ?? .zero

var count: UInt32 = 0
guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
    print(1); exit(0)
}
var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
    print(1); exit(0)
}

for (i, display) in displays.enumerated() where CGDisplayBounds(display).contains(mouse) {
    print(i + 1)
    exit(0)
}

// Cursor is somewhere unexpected (mid-transition, or a display just detached).
print(1)
