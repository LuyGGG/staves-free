import SwiftUI
import WebKit

@MainActor
final class ScoreModel: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var isLoading = true
    @Published var canExport = false
    @Published var error: String?
    @Published var shareItem: ExportItem?
    let file: MIDIFile
    let webView: WKWebView
    private var musicXML: String?
    private let request = UUID().uuidString
    private let bridge: MessageBridge

    init(file: MIDIFile) {
        self.file = file
        let messageBridge = MessageBridge()
        bridge = messageBridge
        let config = WKWebViewConfiguration()
        config.userContentController.add(messageBridge, name: "staves")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        bridge.owner = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        guard let page = Bundle.main.url(forResource: "score", withExtension: "html", subdirectory: "Resources") else {
            error = "The score renderer is missing from the app bundle."
            isLoading = false
            return
        }
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        do {
            let data = try Data(contentsOf: file.url)
            let args: [String] = [data.base64EncodedString(), file.title, request]
            let json = try JSONSerialization.data(withJSONObject: args)
            let text = String(decoding: json, as: UTF8.self)
            webView.evaluateJavaScript("window.loadMIDI.apply(null, \(text))") { [weak self] _, error in
                if let error { self?.fail(error.localizedDescription) }
            }
        } catch { fail(error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("The score renderer ran out of resources. Reopen this score or select a smaller MIDI file.") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
    }
    fileprivate func receive(_ body: Any) {
        guard let message = body as? [String: Any], let type = message["type"] as? String,
              message["request"] as? String == request else { return }
        if type == "converted", let xml = message["xml"] as? String {
            musicXML = xml
            isLoading = false
            canExport = true
        } else if type == "error" {
            fail(message["message"] as? String ?? "This file could not be converted.")
        }
    }
    private func fail(_ message: String) {
        isLoading = false
        canExport = false
        musicXML = nil
        error = message
    }
    private func exportURL(extension ext: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Staves-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safeName = file.title.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        return folder.appendingPathComponent(safeName.isEmpty ? "Score" : safeName).appendingPathExtension(ext)
    }
    func exportXML() {
        guard let musicXML, canExport else { return }
        do {
            let url = try exportURL(extension: "musicxml")
            try musicXML.write(to: url, atomically: true, encoding: .utf8)
            shareItem = ExportItem(url: url)
        } catch { self.error = error.localizedDescription }
    }
    func exportPDF() {
        guard canExport else { return }
        let renderer = A4Renderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        let pageCount = renderer.numberOfPages
        guard pageCount > 0, pageCount <= 1000 else { error = "This score could not be paginated. Try fewer parts."; return }
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, renderer.paperRect, [kCGPDFContextTitle as String: file.title])
        for page in 0..<pageCount {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        do {
            let url = try exportURL(extension: "pdf")
            try (data as Data).write(to: url)
            shareItem = ExportItem(url: url)
        } catch { self.error = error.localizedDescription }
    }
}

private final class MessageBridge: NSObject, WKScriptMessageHandler {
    weak var owner: ScoreModel?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // WKWebView delivers script messages on the main thread.
        MainActor.assumeIsolated { owner?.receive(message.body) }
    }
}
private final class A4Renderer: UIPrintPageRenderer {
    override var paperRect: CGRect { CGRect(x: 0, y: 0, width: 595.2, height: 841.8) }
    override var printableRect: CGRect { paperRect.insetBy(dx: 28, dy: 32) }
}
struct ExportItem: Identifiable {
    let id = UUID()
    let url: URL
}
private struct ScoreWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
struct ScoreView: View {
    let file: MIDIFile
    @StateObject private var model: ScoreModel
    init(file: MIDIFile) {
        self.file = file
        _model = StateObject(wrappedValue: ScoreModel(file: file))
    }
    var body: some View {
        ScoreWebView(webView: model.webView)
            .overlay { if model.isLoading { ProgressView("Writing your score…").padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
            .navigationTitle(file.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Export PDF", systemImage: "doc.richtext") { model.exportPDF() }
                        Button("Export MusicXML", systemImage: "music.note.list") { model.exportXML() }
                    } label: { Label("Export", systemImage: "square.and.arrow.up") }
                        .disabled(!model.canExport)
                }
            }
            .sheet(item: $model.shareItem) { ShareSheet(url: $0.url) }
            .alert("Score issue", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
                Button("OK") { model.error = nil }
            } message: { Text(model.error ?? "") }
    }
}
