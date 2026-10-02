// apple-voice — live on-device dictation via Apple DictationTranscriber.
//
// Captures the microphone (or --file for testing) and streams NDJSON on stdout:
//   {"type":"ready"}
//   {"type":"result","final":<bool>,"text":"<this chunk>","display":"<full text so far>"}
//   {"type":"done","text":"<final transcript>"}
//   {"type":"error","message":"..."}
//
// Stop with SIGTERM/SIGINT or by closing stdin; the stream is finalized and
// the final "done" line is emitted before exiting.
import AVFoundation
import CoreMedia
import Darwin
import Foundation
import Speech

final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
}

final class Emitter: @unchecked Sendable {
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func emit(_ object: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        handle.write(Data(line.utf8))
    }
}

let stopper = StopFlag()
let emitter = Emitter()

func installStopHandlers(watchStdin: Bool) {
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        source.setEventHandler { stopper.stop() }
        source.resume()
    }
    // Closing stdin also stops (backup path for the Pi extension).
    if watchStdin {
        DispatchQueue.global().async {
            while let _ = readLine(strippingNewline: false) { /* discard */ }
            stopper.stop()
        }
    }
}

// Deterministic locale pick: exact match, same region, en-US for English,
// then alphabetical (see apple-stt: unordered locale lists caused churn).
func pickLocale(_ requested: String?, supported: [Locale]) -> Locale? {
    func lang(_ l: Locale) -> String? { l.language.languageCode?.identifier.lowercased() }
    func region(_ l: Locale) -> String? { l.region?.identifier.uppercased() }
    func best(for want: Locale) -> Locale? {
        guard let code = lang(want) else { return nil }
        let candidates = supported
            .filter { lang($0) == code }
            .sorted { $0.identifier(.bcp47) < $1.identifier(.bcp47) }
        if candidates.isEmpty { return nil }
        if let wantedRegion = region(want),
           let sameRegion = candidates.first(where: { region($0) == wantedRegion }) {
            return sameRegion
        }
        if code == "en", let us = candidates.first(where: { region($0) == "US" }) { return us }
        return candidates.first
    }
    if let requested, !requested.isEmpty {
        let want = Locale(identifier: requested)
        let wantID = want.identifier(.bcp47)
        if let exact = supported.first(where: {
            $0.identifier(.bcp47).caseInsensitiveCompare(wantID) == .orderedSame
        }) { return exact }
        return best(for: want)
    }
    let current = Locale.current
    let currentID = current.identifier(.bcp47)
    if let exact = supported.first(where: {
        $0.identifier(.bcp47).caseInsensitiveCompare(currentID) == .orderedSame
    }) { return exact }
    if let match = best(for: current) { return match }
    return supported.first(where: { lang($0) == "en" }) ?? supported.first
}

func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var error: NSError?
    var consumed = false
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
        if consumed { outStatus.pointee = .noDataNow; return nil }
        consumed = true
        outStatus.pointee = .haveData
        return buffer
    }
    converter.convert(to: out, error: &error, withInputFrom: inputBlock)
    return error == nil ? out : nil
}

final class TranscriptState: @unchecked Sendable {
    private let lock = NSLock()
    private var finalText = ""
    private var volatileText = ""

    func record(final: Bool, text: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        let piece = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if final {
            finalText = finalText.isEmpty ? piece : (piece.isEmpty ? finalText : finalText + " " + piece)
            volatileText = ""
        } else {
            volatileText = piece
        }
        return displayLocked()
    }

    private func displayLocked() -> String {
        if finalText.isEmpty { return volatileText }
        if volatileText.isEmpty { return finalText }
        return finalText + " " + volatileText
    }

    func display() -> String { lock.lock(); defer { lock.unlock() }; return displayLocked() }
}

@main
struct AppleVoice {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        var localeID: String?
        var filePath: String?
        var context: [String] = []
        while !args.isEmpty {
            let arg = args.removeFirst()
            switch arg {
            case "--locale":
                if !args.isEmpty { localeID = args.removeFirst() }
            case "--file":
                if !args.isEmpty { filePath = args.removeFirst() }
            case "--context":
                if !args.isEmpty {
                    context.append(contentsOf: args.removeFirst().split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
                }
            default:
                break
            }
        }

        installStopHandlers(watchStdin: filePath == nil)

        do {
            try await run(localeID: localeID, filePath: filePath, context: context)
        } catch {
            emitter.emit(["type": "error", "message": error.localizedDescription])
            exit(1)
        }
    }

    static func run(localeID: String?, filePath: String?, context: [String]) async throws {
        let analysisContext = AnalysisContext()
        if !context.isEmpty { analysisContext.contextualStrings[.general] = context }

        // Dictation model when the locale supports it; else the general model.
        let dictationLocales = await DictationTranscriber.supportedLocales
        let useDictation = pickLocale(localeID, supported: dictationLocales) != nil
        let state = TranscriptState()

        let inputStream: AsyncStream<AnalyzerInput>
        let continuation: AsyncStream<AnalyzerInput>.Continuation
        var startEngine: (() -> Void)?
        var stopEngine: (() -> Void)?

        var preset = DictationTranscriber.Preset.progressiveShortDictation
        preset.reportingOptions = [.volatileResults, .frequentFinalization]
        let dictation = DictationTranscriber(
            locale: pickLocale(localeID, supported: dictationLocales) ?? Locale(identifier: "en-US"),
            preset: preset
        )
        let speechLocales = await SpeechTranscriber.supportedLocales
        var speechPreset = SpeechTranscriber.Preset.progressiveTranscription
        speechPreset.reportingOptions = [.volatileResults]
        let speech = SpeechTranscriber(
            locale: pickLocale(localeID, supported: speechLocales) ?? Locale(identifier: "en-US"),
            preset: speechPreset
        )

        let module: any SpeechModule = useDictation ? dictation : speech
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await install.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw NSError(domain: "apple-voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "no compatible audio format"])
        }

        let analyzer = SpeechAnalyzer(modules: [module])
        try await analyzer.setContext(analysisContext)
        try await analyzer.prepareToAnalyze(in: format)
        (inputStream, continuation) = AsyncStream<AnalyzerInput>.makeStream()

        let resultsTask = Task {
            if useDictation {
                for try await result in dictation.results {
                    let display = state.record(final: result.isFinal, text: String(result.text.characters))
                    emitter.emit(["type": "result", "final": result.isFinal, "text": String(result.text.characters), "display": display])
                }
            } else {
                for try await result in speech.results {
                    let display = state.record(final: result.isFinal, text: String(result.text.characters))
                    emitter.emit(["type": "result", "final": result.isFinal, "text": String(result.text.characters), "display": display])
                }
            }
        }

        if let filePath {
            startEngine = {
                Task.detached {
                    do {
                        let file = try AVAudioFile(forReading: URL(fileURLWithPath: filePath))
                        guard let converter = AVAudioConverter(from: file.processingFormat, to: format) else { return }
                        let chunk: AVAudioFrameCount = 4096
                        while !stopper.isStopped && file.framePosition < file.length {
                            guard let inBuf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) else { break }
                            try file.read(into: inBuf, frameCount: chunk)
                            if inBuf.frameLength == 0 { break }
                            if let outBuf = convert(inBuf, with: converter, to: format) {
                                continuation.yield(AnalyzerInput(buffer: outBuf))
                            }
                            try? await Task.sleep(nanoseconds: 40_000_000)
                        }
                    } catch {
                        emitter.emit(["type": "error", "message": error.localizedDescription])
                    }
                    continuation.finish()
                    stopper.stop()
                }
            }
            stopEngine = { continuation.finish() }
        } else {
            let engine = AVAudioEngine()
            startEngine = {
                let input = engine.inputNode
                let micFormat = input.outputFormat(forBus: 0)
                guard let converter = AVAudioConverter(from: micFormat, to: format) else {
                    emitter.emit(["type": "error", "message": "cannot convert microphone format"])
                    return
                }
                input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in
                    guard !stopper.isStopped else { return }
                    if let outBuf = convert(buffer, with: converter, to: format) {
                        continuation.yield(AnalyzerInput(buffer: outBuf))
                    }
                }
                engine.prepare()
                do {
                    try engine.start()
                } catch {
                    emitter.emit(["type": "error", "message": "microphone unavailable: \(error.localizedDescription)"])
                }
            }
            stopEngine = {
                engine.stop()
                engine.inputNode.removeTap(onBus: 0)
                continuation.finish()
            }
        }

        try await analyzer.start(inputSequence: inputStream)
        startEngine?()
        emitter.emit(["type": "ready"])

        // Wait until stopped (SIGTERM/SIGINT/stdin EOF), then finalize.
        while !stopper.isStopped {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        stopEngine?()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        try await resultsTask.value

        emitter.emit(["type": "done", "text": state.display()])
        exit(0)
    }
}
