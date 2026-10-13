import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LocalDictation,
  getConfig,
  pcmToWav,
  validateConfig,
  type RecordingCallbacks,
  type WhisperConfig,
} from "../local-whisper.ts";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(5);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function makeExecutable(dir: string, name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  await chmod(path, 0o755);
  return path;
}

function pcmExpression(bytes: number, amplitude: number): string {
  return `const pcm = Buffer.alloc(${bytes});
for (let i = 0; i + 1 < pcm.length; i += 2) pcm.writeInt16LE(${amplitude}, i);`;
}

async function makeRecorder(
  dir: string,
  options: { bytes?: number; amplitude?: number; marker?: string; stderr?: string; exitCode?: number } = {},
): Promise<string> {
  const { bytes = 10_000, amplitude = 1_000, marker, stderr, exitCode } = options;
  return makeExecutable(dir, `recorder-${Math.random().toString(16).slice(2)}`, `
const fs = require("node:fs");
${pcmExpression(bytes, amplitude)}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
process.stdout.write(pcm, () => {
  ${marker ? `fs.writeFileSync(${JSON.stringify(marker)}, "ready");` : ""}
  ${exitCode === undefined ? "" : `process.exit(${exitCode});`}
});
${exitCode === undefined ? `process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);` : ""}
`);
}

async function fixture(t: test.TestContext): Promise<{ dir: string; model: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-dictate-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model = join(dir, "model.bin");
  await writeFile(model, "dummy model");
  return { dir, model };
}

function config(model: string, recorder: string, binary: string, overrides: Partial<WhisperConfig> = {}): WhisperConfig {
  return {
    model,
    recorder,
    binary,
    language: "en",
    maxSeconds: 2,
    timeoutMs: 2_000,
    ...overrides,
  };
}

function noOpCallbacks(overrides: Partial<RecordingCallbacks> = {}): RecordingCallbacks {
  return {
    onAudio() {},
    onError(error) { throw error; },
    onLimit() {},
    ...overrides,
  };
}

test("getConfig applies defaults, environment overrides, and ~/ expansion", () => {
  const defaults = getConfig({});
  assert.equal(defaults.model, join(homedir(), ".cache/whisper/ggml-small.en.bin"));
  assert.equal(defaults.binary, "whisper-cli");
  assert.equal(defaults.recorder, "rec");
  assert.equal(defaults.language, "en");
  assert.equal(defaults.maxSeconds, 300);
  assert.equal(defaults.timeoutMs, 300_000);

  const overridden = getConfig({
    DICTATE_WHISPER_MODEL: "~/models/test.bin",
    DICTATE_WHISPER_BIN: "/tools/whisper",
    DICTATE_REC_BIN: "/tools/rec",
    DICTATE_LANGUAGE: "fr",
  });
  assert.deepEqual(overridden, {
    model: join(homedir(), "models/test.bin"),
    binary: "/tools/whisper",
    recorder: "/tools/rec",
    language: "fr",
    maxSeconds: 300,
    timeoutMs: 300_000,
  });
});

test("validateConfig resolves readable model and executable paths", async t => {
  const { dir, model } = await fixture(t);
  const recorder = await makeExecutable(dir, "fake-rec", "process.exit(0)");
  const decoder = await makeExecutable(dir, "fake-whisper", "process.exit(0)");
  const validated = validateConfig(config(model, recorder, decoder));
  assert.equal(validated.model, model);
  assert.equal(validated.recorder, recorder);
  assert.equal(validated.binary, decoder);
});

test("validateConfig reports a missing model before trying dependencies", async t => {
  const { dir } = await fixture(t);
  const missing = join(dir, "missing-model.bin");
  assert.throws(
    () => validateConfig(config(missing, join(dir, "missing-rec"), join(dir, "missing-whisper"))),
    error => error instanceof Error && error.message.includes(`Whisper model not found: ${missing}`),
  );
});

test("validateConfig reports missing recorder and decoder executables", async t => {
  const { dir, model } = await fixture(t);
  const recorder = await makeExecutable(dir, "fake-rec", "process.exit(0)");
  const missingRecorder = join(dir, "no-recorder");
  const missingDecoder = join(dir, "no-decoder");

  assert.throws(() => validateConfig(config(model, missingRecorder, recorder)), /Cannot find .*no-recorder/);
  assert.throws(() => validateConfig(config(model, recorder, missingDecoder)), /Cannot find .*no-decoder/);
});

test("pcmToWav writes a canonical 16 kHz mono PCM header and drops an odd trailing byte", () => {
  const pcm = Buffer.from([0x34, 0x12, 0xcc, 0xed, 0xff]);
  const wav = pcmToWav(pcm);

  assert.equal(wav.length, 48);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 40);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 4);
  assert.deepEqual(wav.subarray(44), pcm.subarray(0, 4));
});

test("records, writes valid WAV, invokes whisper with expected arguments, sanitizes text, and removes temp files", async t => {
  const { dir, model } = await fixture(t);
  const recorderReady = join(dir, "recorder-ready");
  const argsFile = join(dir, "decoder-args.json");
  const wavCopy = join(dir, "captured.wav");
  const recorder = await makeRecorder(dir, { marker: recorderReady });
  const decoder = await makeExecutable(dir, "decoder", `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const input = args[args.indexOf("-f") + 1];
const output = args[args.indexOf("-of") + 1];
fs.copyFileSync(input, ${JSON.stringify(wavCopy)});
fs.writeFileSync(output + ".txt", "  hello\\n\\tworld\\u0000 from   whisper  ");
`);
  const chunks: Buffer[] = [];
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks({
    onAudio(chunk) { chunks.push(Buffer.from(chunk)); },
  }));

  dictation.start();
  await waitFor(() => exists(recorderReady), "recorder output");
  const text = await dictation.stop();

  assert.equal(text, "hello world from whisper");
  assert.equal(Buffer.concat(chunks).length, 10_000);
  const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
  assert.deepEqual(args.slice(0, 2), ["-m", model]);
  assert.equal(args[args.indexOf("-l") + 1], "en");
  assert.ok(args.includes("-otxt"));
  assert.ok(args.includes("-nt"));
  assert.ok(args.includes("-np"));
  const input = args[args.indexOf("-f") + 1]!;
  assert.match(input, /pi-dictate-[^/]+\/audio\.wav$/);
  assert.equal(await exists(dirname(input)), false, "private transcription directory should be removed");

  const wav = await readFile(wavCopy);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 10_000);
  assert.equal(wav.readUInt32LE(40), 10_000);
  assert.equal(wav.readInt16LE(44), 1_000);
});

test("short recordings return no text without starting the decoder", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderRan = join(dir, "decoder-ran");
  const recorder = await makeRecorder(dir, { bytes: 7_998, marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `require("node:fs").writeFileSync(${JSON.stringify(decoderRan)}, "yes")`);
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks());

  dictation.start();
  await waitFor(() => exists(ready), "short recording");
  assert.equal(await dictation.stop(), "");
  assert.equal(await exists(decoderRan), false);
});

test("digital silence returns no text without starting the decoder", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderRan = join(dir, "decoder-ran");
  const recorder = await makeRecorder(dir, { bytes: 10_000, amplitude: 0, marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `require("node:fs").writeFileSync(${JSON.stringify(decoderRan)}, "yes")`);
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks());

  dictation.start();
  await waitFor(() => exists(ready), "silent recording");
  assert.equal(await dictation.stop(), "");
  assert.equal(await exists(decoderRan), false);
});

test("cancel during recording terminates capture, discards audio, and never starts inference", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderRan = join(dir, "decoder-ran");
  const recorder = await makeRecorder(dir, { marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `require("node:fs").writeFileSync(${JSON.stringify(decoderRan)}, "yes")`);
  const errors: Error[] = [];
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks({ onError(error) { errors.push(error); } }));

  dictation.start();
  await waitFor(() => exists(ready), "recording before cancellation");
  dictation.cancel();

  assert.equal(await dictation.stop(), "");
  assert.deepEqual(errors, []);
  assert.equal(await exists(decoderRan), false);
});

test("cancel during inference resolves empty and removes its private temp directory", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderStarted = join(dir, "decoder-started");
  const recorder = await makeRecorder(dir, { marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(decoderStarted)}, args[args.indexOf("-f") + 1]);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`);
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks());

  dictation.start();
  await waitFor(() => exists(ready), "recording before inference");
  const stopping = dictation.stop();
  await waitFor(() => exists(decoderStarted), "decoder startup");
  const wav = await readFile(decoderStarted, "utf8");
  dictation.cancel();

  assert.equal(await stopping, "");
  assert.equal(await exists(dirname(wav)), false);
});

test("decoder failure includes bounded stderr and cleans up temp files", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderStarted = join(dir, "decoder-started");
  const recorder = await makeRecorder(dir, { marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(decoderStarted)}, args[args.indexOf("-f") + 1]);
process.stderr.write("decoder exploded");
process.exit(7);
`);
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks());

  dictation.start();
  await waitFor(() => exists(ready), "recording before failed inference");
  await assert.rejects(dictation.stop(), /Whisper exited \(7\): decoder exploded/);
  const wav = await readFile(decoderStarted, "utf8");
  assert.equal(await exists(dirname(wav)), false);
});

test("decoder timeout terminates inference and cleans up temp files", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderStarted = join(dir, "decoder-started");
  const recorder = await makeRecorder(dir, { marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(decoderStarted)}, args[args.indexOf("-f") + 1]);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`);
  const dictation = new LocalDictation(config(model, recorder, decoder, { timeoutMs: 100 }), noOpCallbacks());

  dictation.start();
  await waitFor(() => exists(ready), "recording before timed inference");
  await assert.rejects(dictation.stop(), /Local Whisper transcription timed out/);
  const wav = await readFile(decoderStarted, "utf8");
  assert.equal(await exists(dirname(wav)), false);
});

test("successful decoder without a transcript rejects and still cleans up", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const decoderStarted = join(dir, "decoder-started");
  const recorder = await makeRecorder(dir, { marker: ready });
  const decoder = await makeExecutable(dir, "decoder", `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(decoderStarted)}, args[args.indexOf("-f") + 1]);
`);
  const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks());

  dictation.start();
  await waitFor(() => exists(ready), "recording before missing transcript");
  await assert.rejects(dictation.stop(), /ENOENT/);
  const wav = await readFile(decoderStarted, "utf8");
  assert.equal(await exists(dirname(wav)), false);
});

test("unexpected recorder exit calls onError and makes stop reject", async t => {
  const { dir, model } = await fixture(t);
  const recorder = await makeRecorder(dir, { bytes: 0, stderr: "device unavailable", exitCode: 4 });
  const decoder = await makeExecutable(dir, "decoder", "process.exit(0)");
  let reported: Error | undefined;
  const reportedPromise = new Promise<void>(resolve => {
    const dictation = new LocalDictation(config(model, recorder, decoder), noOpCallbacks({
      onError(error) { reported = error; resolve(); },
    }));
    dictation.start();
    t.after(() => dictation.cancel());
    (t as any).dictation = dictation;
  });

  await reportedPromise;
  const dictation = (t as any).dictation as LocalDictation;
  assert.match(reported!.message, /Microphone recorder stopped \(4\).*device unavailable/);
  await assert.rejects(dictation.stop(), /Microphone recorder stopped \(4\)/);
});

test("byte and wall-clock limits notify callers while audio remains bounded", async t => {
  const { dir, model } = await fixture(t);
  const ready = join(dir, "ready");
  const recorder = await makeRecorder(dir, { bytes: 20_000, marker: ready });
  const decoder = await makeExecutable(dir, "decoder", "process.exit(0)");
  let audioBytes = 0;
  let byteLimit!: () => void;
  const byteLimitReached = new Promise<void>(resolve => { byteLimit = resolve; });
  const bounded = new LocalDictation(config(model, recorder, decoder, { maxSeconds: 0.1 }), noOpCallbacks({
    onAudio(chunk) { audioBytes += chunk.length; },
    onLimit() { byteLimit(); },
  }));

  bounded.start();
  await byteLimitReached;
  assert.equal(audioBytes, 3_200);
  bounded.cancel();
  assert.equal(await bounded.stop(), "");

  const quietRecorder = await makeRecorder(dir, { bytes: 0 });
  let timerLimit!: () => void;
  const timerLimitReached = new Promise<void>(resolve => { timerLimit = resolve; });
  const timed = new LocalDictation(config(model, quietRecorder, decoder, { maxSeconds: 0.03 }), noOpCallbacks({
    onLimit() { timerLimit(); },
  }));
  timed.start();
  await timerLimitReached;
  timed.cancel();
  assert.equal(await timed.stop(), "");
});
