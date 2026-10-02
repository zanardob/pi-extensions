/**
 * Deepgram Nova-3 helpers: live WebSocket streaming and pre-recorded files.
 *
 * Auth uses the Sec-WebSocket-Protocol subprotocol form (["token", key])
 * because the standard WebSocket API cannot set an Authorization header.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const LIVE_BASE = "wss://api.deepgram.com/v1/listen";
const FILE_BASE = "https://api.deepgram.com/v1/listen";

export function buildLiveUrl(options: {
  model: string;
  language: string;
  endpointingMs: number;
  keyterms: string[];
}): string {
  const url = new URL(LIVE_BASE);
  url.searchParams.set("model", options.model);
  if (options.language) url.searchParams.set("language", options.language);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("vad_events", "true");
  url.searchParams.set("endpointing", String(options.endpointingMs));
  url.searchParams.set("utterance_end_ms", "1000");
  for (const term of options.keyterms) url.searchParams.append("keyterm", term);
  return url.toString();
}

export type LiveBackend = {
  /** Graceful stop: end audio, flush the transcript, then exit. */
  stop: () => void;
  /** Abrupt stop: kill audio capture and close the socket immediately. */
  kill: () => void;
};

export function startDeepgramLive(options: {
  apiKey: string;
  url: string;
  ffmpegPath: string;
  audioInput: string;
  onDisplay: (display: string) => void;
  onReady: () => void;
  onExit: (error: string | null) => void;
}): LiveBackend {
  const ffmpeg = spawn(
    options.ffmpegPath,
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", options.audioInput, "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let ffmpegLog = "";
  let finalText = "";
  let interim = "";
  let finished = false;
  let stopping = false;
  let error: string | null = null;
  const pending: Buffer[] = [];
  let buffered = Buffer.alloc(0);

  const socket = new WebSocket(options.url, ["token", options.apiKey]);

  const isOpen = () => socket.readyState === WebSocket.OPEN;
  const sendAudio = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const frameBytes = 3200; // 100 ms of 16 kHz mono linear16
    while (buffered.length >= frameBytes && isOpen()) {
      socket.send(buffered.subarray(0, frameBytes));
      buffered = buffered.subarray(frameBytes);
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    try { ffmpeg.kill("SIGTERM"); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
    options.onExit(error);
  };
  const fail = (message: string) => {
    error = error ?? message;
    finish();
  };

  ffmpeg.stderr?.on("data", (chunk: Buffer) => {
    ffmpegLog = (ffmpegLog + chunk.toString()).slice(-2000);
  });
  ffmpeg.stdout?.on("data", (chunk: Buffer) => {
    if (isOpen()) sendAudio(chunk);
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(chunk);
  });
  ffmpeg.on("error", (spawnError) => {
    fail(`cannot start audio capture: ${spawnError.message}`);
  });
  ffmpeg.on("close", (code) => {
    if (stopping || finished) return;
    const detail = ffmpegLog.trim().split("\n").slice(-2).join("; ");
    fail(`audio capture stopped (${code})${detail ? `: ${detail}` : ""}`);
  });

  socket.onopen = () => {
    options.onReady();
    for (const chunk of pending.splice(0)) sendAudio(chunk);
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let message: { type?: string; is_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "Results") return;
    const transcript = String(message.channel?.alternatives?.[0]?.transcript ?? "");
    if (message.is_final) {
      const piece = transcript.trim();
      if (piece) finalText = finalText ? `${finalText} ${piece}` : piece;
      interim = "";
    } else {
      interim = transcript.trim();
    }
    const display = [finalText, interim].filter(Boolean).join(" ");
    if (display) options.onDisplay(display);
  };
  socket.onerror = () => {
    error = error ?? "Deepgram connection error";
  };
  socket.onclose = (event) => {
    if (!stopping && !finished) {
      error = error ?? `Deepgram closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
    }
    finish();
  };

  return {
    stop: () => {
      if (stopping || finished) return;
      stopping = true;
      try { ffmpeg.kill("SIGTERM"); } catch { /* ignore */ }
      try {
        if (isOpen()) socket.send(JSON.stringify({ type: "CloseStream" }));
      } catch { /* ignore */ }
      setTimeout(finish, 4000); // safety net if the server never closes
    },
    kill: () => {
      stopping = true;
      try { ffmpeg.kill("SIGKILL"); } catch { /* ignore */ }
      try { socket.close(); } catch { /* ignore */ }
      finish();
    },
  };
}

const MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".wave": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".caf": "audio/x-caf",
};

export function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export async function transcribeWithDeepgram(options: {
  apiKey: string;
  path: string;
  model: string;
  language: string;
  keyterms: string[];
}): Promise<string> {
  const url = new URL(FILE_BASE);
  url.searchParams.set("model", options.model);
  if (options.language) url.searchParams.set("language", options.language);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  for (const term of options.keyterms) url.searchParams.append("keyterm", term);

  const body = await readFile(options.path);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${options.apiKey}`,
      "Content-Type": mimeFor(options.path),
    },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`Deepgram ${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new Error("Deepgram returned an empty transcript");
  }
  return transcript.trim();
}
