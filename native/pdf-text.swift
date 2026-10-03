// Extract the text of a PDF, so a CV can be read before it is tailored.
//
// PDFKit rather than a dependency: pdftotext, pdfplumber and PyPDF2 are all
// absent on a stock Mac, and asking someone to install poppler before glance
// can read their own CV is a bad trade. PDFKit ships with macOS and the whole
// job is fifteen lines.
import Foundation
import PDFKit

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: pdf-text <file.pdf>\n".data(using: .utf8)!)
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let doc = PDFDocument(url: url) else {
    FileHandle.standardError.write("could not open \(url.path)\n".data(using: .utf8)!)
    exit(1)
}
var out = ""
for i in 0..<doc.pageCount {
    if let page = doc.page(at: i), let text = page.string { out += text + "\n" }
}
print(out.trimmingCharacters(in: .whitespacesAndNewlines))
