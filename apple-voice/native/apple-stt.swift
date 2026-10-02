// apple-stt — on-device speech-to-text via Apple's SpeechAnalyzer (macOS 26+).
// usage: apple-stt <audio-file> [--locale <bcp47>] | --list
//
// Wraps SpeechTranscriber (Apple's current on-device STT model; the older
// SFSpeechRecognizer is deprecated and broken on macOS 26+).
import AVFoundation
import Darwin
import Foundation
import Speech

@main
struct AppleStt {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())

        if args.contains("--list") {
            let locales = await SpeechTranscriber.supportedLocales
                .map { $0.identifier(.bcp47) }
                .sorted()
            print(locales.joined(separator: "\n"))
            return
        }

        guard let path = args.first, !path.hasPrefix("-") else {
            fputs("usage: apple-stt <audio-file> [--locale <bcp47>] | --list\n", stderr)
            exit(2)
        }
        args.removeFirst()
        var requestedLocale: String?
        if let i = args.firstIndex(of: "--locale"), i + 1 < args.count {
            requestedLocale = args[i + 1]
        }

        do {
            let text = try await transcribe(path: path, requestedLocale: requestedLocale)
            print(text)
        } catch {
            fputs("apple-stt: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    /// Prefer the dictation model (better accuracy for spoken prompts) when it
    /// supports the locale; otherwise fall back to the general model.
    static func pickLocale(_ requested: String?) async -> (locale: Locale, dictation: Bool)? {
        if let locale = pick(requested, supported: await DictationTranscriber.supportedLocales) {
            return (locale, true)
        }
        if let locale = pick(requested, supported: await SpeechTranscriber.supportedLocales) {
            return (locale, false)
        }
        return nil
    }

    static func pick(_ requested: String?, supported: [Locale]) -> Locale? {
        func lang(_ l: Locale) -> String? { l.language.languageCode?.identifier.lowercased() }
        func region(_ l: Locale) -> String? { l.region?.identifier.uppercased() }

        // Deterministic, region-aware choice: exact match, then same region,
        // then en-US for English, then alphabetical order. The framework's
        // locale list has no stable order; without this, one-shot runs picked
        // a different regional English model every time (en-AU, en-SG, ...)
        // and exhausted the 5-locale system-wide allocation pool.
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
            if code == "en", let us = candidates.first(where: { region($0) == "US" }) {
                return us
            }
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

    static func transcribe(path: String, requestedLocale: String?) async throws -> String {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw fail("file not found: \(url.path)")
        }
        guard let choice = await pickLocale(requestedLocale) else {
            throw fail("no supported speech model matches '\(requestedLocale ?? "system locale")'")
        }
        let locale = choice.locale

        // Reserve the locale for this process and release it before exiting.
        // The Speech framework caps allocated locales at 5 system-wide; without
        // an explicit reserve/release pair, every one-shot invocation leaks a
        // slot until the system reaps it, and runs eventually fail with
        // "Too many allocated locales". reserve() returns false when the locale
        // is already reserved (typically by another process), in which case
        // this process does not own the slot and must not release it.
        var ownsReservation = false
        let debug = ProcessInfo.processInfo.environment["APPLE_STT_DEBUG"] == "1"
        do {
            ownsReservation = try await AssetInventory.reserve(locale: locale)
        } catch {
            fputs("apple-stt: warning: unable to reserve \(locale.identifier(.bcp47)): \(error.localizedDescription)\n", stderr)
        }
        if debug { fputs("apple-stt: debug: reserve \(locale.identifier(.bcp47)) -> \(ownsReservation)\n", stderr) }

        do {
            let text = try await run(url: url, locale: locale, useDictation: choice.dictation)
            if ownsReservation {
                let released = await AssetInventory.release(reservedLocale: locale)
                if debug { fputs("apple-stt: debug: release -> \(released)\n", stderr) }
            }
            return text
        } catch {
            if ownsReservation {
                let released = await AssetInventory.release(reservedLocale: locale)
                if debug { fputs("apple-stt: debug: release after error -> \(released)\n", stderr) }
            }
            throw error
        }
    }

    static func run(url: URL, locale: Locale, useDictation: Bool) async throws -> String {
        let audioFile: AVAudioFile
        do {
            audioFile = try AVAudioFile(forReading: url)
        } catch {
            throw fail("cannot read audio file: \(url.path)")
        }

        if useDictation {
            var preset = DictationTranscriber.Preset.longDictation
            preset.transcriptionOptions.insert(.punctuation)
            let transcriber = DictationTranscriber(locale: locale, preset: preset)
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                fputs("apple-stt: downloading dictation model for \(locale.identifier(.bcp47)) (first run only)...\n", stderr)
                try await install.downloadAndInstall()
            }
            _ = try await SpeechAnalyzer(
                inputAudioFile: audioFile,
                modules: [transcriber],
                finishAfterFile: true
            )
            var pieces: [String] = []
            for try await result in transcriber.results {
                let piece = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if !piece.isEmpty { pieces.append(piece) }
            }
            return pieces.joined(separator: " ")
        }

        let transcriber = SpeechTranscriber(
            locale: locale,
            preset: .timeIndexedTranscriptionWithAlternatives
        )

        // First run for a language downloads the on-device model.
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            fputs("apple-stt: downloading speech model for \(locale.identifier(.bcp47)) (first run only)...\n", stderr)
            try await install.downloadAndInstall()
        }

        _ = try await SpeechAnalyzer(
            inputAudioFile: audioFile,
            modules: [transcriber],
            finishAfterFile: true
        )

        var pieces: [String] = []
        for try await result in transcriber.results {
            let piece = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !piece.isEmpty { pieces.append(piece) }
        }
        return pieces.joined(separator: " ")
    }

    static func fail(_ message: String) -> NSError {
        NSError(domain: "apple-stt", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
