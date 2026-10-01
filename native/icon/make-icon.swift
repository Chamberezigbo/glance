// Draws the glance app icon at every size macOS asks for.
//
// The mark: an eye whose iris is a screen. An eye alone is generic — every
// monitoring tool uses one, and it reads as surveillance, which is the opposite
// of what glance does. Putting a window inside the pupil says what it actually
// looks at, and the single open eye says it looks once rather than watching.
//
// Drawn in code rather than exported from a design tool so each size is
// rendered at its own scale: at 16pt a traced-down 1024px artwork turns to mud.
import AppKit
import CoreGraphics

func drawIcon(size: CGFloat, ctx: CGContext) {
    // Apple's grid: the rounded square sits inset, not edge to edge.
    let margin = size * 0.082
    let box = CGRect(x: margin, y: margin, width: size - margin * 2, height: size - margin * 2)
    let radius = box.width * 0.2237

    // Background: a deep indigo, a shade that reads as "attention" without the
    // alarm of red. Lighter at the top so it sits correctly under macOS's
    // top-down lighting.
    let bg = CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.saveGState()
    ctx.addPath(bg)
    ctx.clip()
    let colors = [
        CGColor(red: 0.36, green: 0.38, blue: 0.86, alpha: 1),
        CGColor(red: 0.17, green: 0.17, blue: 0.42, alpha: 1),
    ] as CFArray
    if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                             colors: colors, locations: [0, 1]) {
        ctx.drawLinearGradient(grad,
                               start: CGPoint(x: box.midX, y: box.maxY),
                               end: CGPoint(x: box.midX, y: box.minY),
                               options: [])
    }
    ctx.restoreGState()

    // The eye: two symmetric arcs. Width and height chosen so it stays an eye
    // rather than becoming a circle at small sizes.
    let eyeW = box.width * 0.72
    let eyeH = eyeW * 0.40
    let cx = box.midX, cy = box.midY
    // Cubic rather than quadratic: a quad curve meets the corner at a hard cusp,
    // which looked pointed and mechanical. Pulling the control points inward
    // gives the soft almond an eye actually has.
    let k = eyeW * 0.26
    let eye = CGMutablePath()
    eye.move(to: CGPoint(x: cx - eyeW / 2, y: cy))
    eye.addCurve(to: CGPoint(x: cx + eyeW / 2, y: cy),
                 control1: CGPoint(x: cx - k, y: cy + eyeH),
                 control2: CGPoint(x: cx + k, y: cy + eyeH))
    eye.addCurve(to: CGPoint(x: cx - eyeW / 2, y: cy),
                 control1: CGPoint(x: cx + k, y: cy - eyeH),
                 control2: CGPoint(x: cx - k, y: cy - eyeH))

    // Below ~48px an outlined eye and its iris merge into a blob: there are not
    // enough pixels to keep the gap between them open. So small sizes get a
    // SOLID eye with the screen knocked out of it — bold, and still unmistakably
    // an eye at 16px. Larger sizes keep the lighter outline, which looks better
    // when there is room for it. Drawing each size for itself is what Apple
    // does, and the reason a single scaled artwork never looks right.
    let solid = size < 48
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.97))
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.97))

    // Geometry for the screen is needed before the eye is filled, because at
    // small sizes the two are drawn as one path with a hole in it.
    let scrWPre = eyeW * (solid ? 0.40 : 0.345)
    let scrHPre = scrWPre * 0.74
    let screenRect = CGRect(x: cx - scrWPre / 2, y: cy - scrHPre / 2, width: scrWPre, height: scrHPre)
    let scrRadiusPre = max(scrWPre * 0.16, 0.8)
    let screenPath = CGPath(roundedRect: screenRect, cornerWidth: scrRadiusPre,
                            cornerHeight: scrRadiusPre, transform: nil)

    if solid {
        // One path, even-odd filled, so the screen is a genuine hole showing the
        // gradient behind. Clearing instead would punch through to transparency,
        // which is invisible against a light background.
        let combined = CGMutablePath()
        combined.addPath(eye)
        combined.addPath(screenPath)
        ctx.addPath(combined)
        ctx.fillPath(using: .evenOdd)
    } else {
        ctx.setLineWidth(max(size * 0.034, 1.2))
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.addPath(eye)
        ctx.strokePath()
    }

    // The iris is a screen: a rounded rectangle in a display's proportions,
    // filled so it reads as a pupil at a distance and as a monitor up close.
    let scrW = scrWPre, scrH = scrHPre, screen = screenRect
    if !solid {
        // The large icon fills the screen solid, with the glint punched out of
        // it below — again even-odd, for the same reason.
        if size >= 64 {
            let r = scrW * 0.17
            let glint = CGPath(ellipseIn: CGRect(x: screen.minX + scrW * 0.15,
                                                 y: screen.maxY - scrH * 0.15 - r * 2,
                                                 width: r * 2, height: r * 2), transform: nil)
            let combined = CGMutablePath()
            combined.addPath(screenPath)
            combined.addPath(glint)
            ctx.addPath(combined)
            ctx.fillPath(using: .evenOdd)
        } else {
            ctx.addPath(screenPath)
            ctx.fillPath()
        }
    }

    // A glint in the upper left. It does double duty: the highlight a pupil has,
    // and the reflection on a screen. One shape, so it survives being shrunk —
    // unlike the lines of "content" it replaced, which turned to mush. Dropped
    // below 32px, where there is no room for it to be anything but noise.
}

func render(size: Int, to url: URL) {
    let s = CGFloat(size)
    guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high
    drawIcon(size: s, ctx: ctx)
    guard let image = ctx.makeImage() else { return }
    let rep = NSBitmapImageRep(cgImage: image)
    if let data = rep.representation(using: .png, properties: [:]) {
        try? data.write(to: url)
    }
}

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
for size in [16, 32, 64, 128, 256, 512, 1024] {
    render(size: size, to: outDir.appendingPathComponent("icon_\(size).png"))
}
print("rendered")
