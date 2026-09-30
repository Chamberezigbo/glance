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
