import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface WhisperConfig {
  model: string;
  binary: string;
  recorder: string;
  language: string;
  maxSeconds: number;
  timeoutMs: number;
}

export function getConfig(env = process.env): WhisperConfig {
  return {
    model: (env.DICTATE_WHISPER_MODEL || join(homedir(), ".cache/whisper/ggml-small.en.bin")).replace(/^~(?=\/)/, homedir()),
    binary: env.DICTATE_WHISPER_BIN || "whisper-cli",
    recorder: env.DICTATE_REC_BIN || "rec",
    language: env.DICTATE_LANGUAGE || "en",
    maxSeconds: 300,
    timeoutMs: 300_000,
  };
}

function findExecutable(command: string): string {
  const candidates = command.includes("/") ? [command] :
    [...(process.env.PATH || "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].map(p => join(p, command));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return path; } catch {}
  }
  throw new Error(`Cannot find ${command}. Install dependencies: brew install whisper-cpp sox`);
}

export function validateConfig(config: WhisperConfig): WhisperConfig {
  try { accessSync(config.model, constants.R_OK); }
  catch { throw new Error(`Whisper model not found: ${config.model}. See the pi-dictate-local README for model setup.`); }
  return { ...config, binary: findExecutable(config.binary), recorder: findExecutable(config.recorder) };
}

/** 16 kHz, mono, signed little-endian PCM -> standard RIFF/WAVE. */
export function pcmToWav(pcm: Buffer): Buffer {
  const size = pcm.length - pcm.length % 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + size, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(size, 40);
  return Buffer.concat([header, pcm.subarray(0, size)]);
}

function terminate(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

export interface RecordingCallbacks {
  onAudio(chunk: Buffer): void;
  onError(error: Error): void;
  onLimit(): void;
}

/** One bounded recording. No servers, sockets, downloads, or shell commands. */
export class LocalDictation {
  private recorder?: ChildProcess;
  private decoder?: ChildProcess;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private cancelled = false;
  private stopping = false;
  private recError?: Error;
  private recorderDone: Promise<void> = Promise.resolve();
  private limitTimer?: NodeJS.Timeout;

  constructor(private config: WhisperConfig, private callbacks: RecordingCallbacks) {}

  start(): void {
    this.config = validateConfig(this.config);
    const child = spawn(this.config.recorder, [
      "-q", "--buffer", "512", "-r", "16000", "-c", "1", "-b", "16",
      "-e", "signed-integer", "-L", "-t", "raw", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.recorder = child;
    let stderr = "";
    child.stderr!.on("data", data => { stderr = (stderr + data).slice(-4096); });
    const fail = (error: Error) => {
      this.recError = error;
      if (!this.cancelled) this.callbacks.onError(error);
    };
    this.recorderDone = new Promise(resolve => {
      child.once("error", error => fail(new Error(`Microphone recorder: ${error.message}`)));
      child.once("close", (code, signal) => {
        clearTimeout(this.limitTimer);
        resolve();
        if (!this.stopping && !this.cancelled && !this.recError) {
          fail(new Error(`Microphone recorder stopped (${code ?? signal}). ${stderr.trim()} Check terminal microphone permission in macOS System Settings.`));
        }
      });
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (this.cancelled) return;
      const remaining = this.config.maxSeconds * 32000 - this.bytes;
      const bounded = chunk.subarray(0, Math.max(0, remaining));
      this.chunks.push(bounded);
      this.bytes += bounded.length;
      this.callbacks.onAudio(bounded);
      if (remaining <= chunk.length && !this.stopping) this.callbacks.onLimit();
    });
    this.limitTimer = setTimeout(() => {
      if (!this.stopping && !this.cancelled) this.callbacks.onLimit();
    }, this.config.maxSeconds * 1000);
  }

  cancel(): void {
    this.cancelled = true;
    clearTimeout(this.limitTimer);
    terminate(this.recorder);
    terminate(this.decoder);
    this.chunks = [];
  }

  async stop(): Promise<string> {
    this.stopping = true;
    clearTimeout(this.limitTimer);
    terminate(this.recorder);
    await this.recorderDone;
    if (this.cancelled) return "";
    if (this.recError) throw this.recError;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (pcm.length < 8000) return ""; // Less than 250 ms is not useful speech.
    // Avoid Whisper's hallucinations on digital silence. Quiet real speech is retained.
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    if (peak < 32) return "";
    const dir = mkdtempSync(join(tmpdir(), "pi-dictate-")); // private 0700 directory
    try {
      const wav = join(dir, "audio.wav");
      const output = join(dir, "transcript");
      writeFileSync(wav, pcmToWav(pcm), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.config.binary, [
          "-m", this.config.model, "-f", wav, "-l", this.config.language,
          "-otxt", "-of", output, "-nt", "-np",
        ], { stdio: ["ignore", "ignore", "pipe"] });
        this.decoder = child;
        let stderr = "";
        let timedOut = false;
        child.stderr!.on("data", data => { stderr = (stderr + data).slice(-4096); });
        const timer = setTimeout(() => { timedOut = true; terminate(child); }, this.config.timeoutMs);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          if (this.cancelled) resolve();
          else if (timedOut) reject(new Error("Local Whisper transcription timed out. Try a smaller model."));
          else if (code !== 0) reject(new Error(`Whisper exited (${code ?? signal}): ${stderr.trim()}`));
          else resolve();
        });
      });
      if (this.cancelled) return "";
      return readFileSync(join(dir, "transcript.txt"), "utf8")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    } finally {
      this.decoder = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
