import SwiftUI
import UniformTypeIdentifiers

struct MIDIFile: Identifiable, Hashable {
    let url: URL
    var id: String { url.lastPathComponent }
    var title: String { String(url.deletingPathExtension().lastPathComponent.dropFirst(37)) }
}

@MainActor
final class Library: ObservableObject {
    @Published var files: [MIDIFile] = []
    @Published var error: String?
    private let directory: URL
    init() {
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("MIDI", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try reload()
        } catch { self.error = error.localizedDescription }
    }
    func reload() throws {
        files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { ["mid", "midi"].contains($0.pathExtension.lowercased()) }
            .map { MIDIFile(url: $0) }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
    func importFiles(_ urls: [URL]) {
        var failures: [String] = []
        for url in urls {
            let granted = url.startAccessingSecurityScopedResource()
            defer { if granted { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 10 * 1024 * 1024 else { throw ImportError.tooLarge }
                let data = try Data(contentsOf: url)
                guard data.count <= 10 * 1024 * 1024 else { throw ImportError.tooLarge }
                guard data.prefix(4) == Data("MThd".utf8) else { throw ImportError.notMIDI }
                let name = url.deletingPathExtension().lastPathComponent
                let target = directory.appendingPathComponent("\(UUID().uuidString)-\(name).mid")
                try data.write(to: target, options: .atomic)
            } catch { failures.append("\(url.lastPathComponent): \(error.localizedDescription)") }
        }
        do { try reload() } catch { failures.append(error.localizedDescription) }
        if !failures.isEmpty { error = failures.joined(separator: "\n") }
    }
    func remove(_ file: MIDIFile) {
        do { try FileManager.default.removeItem(at: file.url); try reload() }
        catch { self.error = error.localizedDescription }
    }
    func addDemo() {
        // Format 0, 480 PPQ: C-major melody with a bass accompaniment.
        var track: [UInt8] = [0,0xFF,0x58,4,4,2,24,8, 0,0xFF,0x51,3,7,0xA1,0x20]
        let pitches: [UInt8] = [60,62,64,65,67,64,62,60,64,65,67,69,67,64,62,60]
        for (i, pitch) in pitches.enumerated() {
            track += [0,0x90,pitch,85, 0,0x91,UInt8(i < 8 ? 48 : 43),60,
                      0x83,0x60,0x80,pitch,0, 0,0x81,UInt8(i < 8 ? 48 : 43),0]
        }
        track += [0,0xFF,0x2F,0]
        let count = UInt32(track.count)
        let header: [UInt8] = [0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,1,0xE0,0x4D,0x54,0x72,0x6B,
                                UInt8((count >> 24) & 255), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255)]
        do {
            try Data(header + track).write(to: directory.appendingPathComponent("\(UUID().uuidString)-First light.mid"), options: .atomic)
            try reload()
        } catch { self.error = error.localizedDescription }
    }
    enum ImportError: LocalizedError {
        case tooLarge, notMIDI
        var errorDescription: String? {
            switch self {
            case .tooLarge: return "Files must be 10 MB or smaller."
            case .notMIDI: return "This is not a Standard MIDI file."
            }
        }
    }
}

struct LibraryView: View {
    @StateObject private var library = Library()
    @State private var importing = false
    private let green = Color(red: 0.14, green: 0.36, blue: 0.29)
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("FROM MIDI TO MANUSCRIPT").font(.caption.weight(.semibold)).tracking(2).foregroundStyle(green)
                        Text("Make room\nfor your music.").font(.system(size: 40, weight: .regular, design: .serif))
                        Text("Turn your MIDI files into readable scores.").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "music.quarternote.3").font(.system(size: 52)).foregroundStyle(green).accessibilityHidden(true)
                }.padding(24)
                HStack {
                    Text("YOUR LIBRARY").font(.caption.weight(.semibold)).tracking(1.5)
                    Spacer()
                    Text("\(library.files.count) scores").font(.caption).foregroundStyle(.secondary)
                }.padding(.horizontal, 24).padding(.bottom, 12)
                if library.files.isEmpty {
                    VStack(spacing: 18) {
                        Image(systemName: "doc.badge.plus").font(.system(size: 38)).foregroundStyle(green)
                        Text("Every score starts with a file.").font(.title3).fontDesign(.serif)
                        Text("Choose one or more .mid or .midi files from Files, iCloud Drive, or another provider.")
                            .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 340)
                        Button("Import MIDI files", systemImage: "plus") { importing = true }.buttonStyle(.borderedProminent)
                        Button("Try a sample score") { library.addDemo() }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(24)
                } else {
                    List {
                        ForEach(library.files) { file in
                            NavigationLink(value: file) {
                                HStack(spacing: 16) {
                                    Image(systemName: "music.note.list").font(.title2).foregroundStyle(green).frame(width: 44, height: 54).background(green.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(file.title).font(.headline)
                                        Text("MIDI · On this device").font(.caption).foregroundStyle(.secondary)
                                    }
                                }.padding(.vertical, 5)
                            }.swipeActions { Button("Delete", role: .destructive) { library.remove(file) } }
                        }
                    }.listStyle(.plain).scrollContentBackground(.hidden)
                }
                HStack(spacing: 6) {
                    Image(systemName: "lock.shield")
                    Text("Private by design. Converted entirely on your device.")
                }.font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(16)
            }
            .background(Color(red: 0.96, green: 0.96, blue: 0.93))
            .navigationTitle("Staves").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("Import", systemImage: "plus") { importing = true } } }
            .navigationDestination(for: MIDIFile.self) { ScoreView(file: $0) }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.midi, .data], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): library.importFiles(urls)
                case .failure(let error): library.error = error.localizedDescription
                }
            }
            .alert("Import or library issue", isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.error = nil } })) {
                Button("OK") { library.error = nil }
            } message: { Text(library.error ?? "") }
        }.tint(green)
    }
}
