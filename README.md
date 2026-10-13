# Pi Dictate — local Whisper

Local fork of [amosblomqvist/pi-dictate](https://github.com/amosblomqvist/pi-dictate), based on commit `3208b563e3adfd070ac7b256a09ba9fc7b869f50`. Upstream MIT license retained in `LICENSE`.

Uses OpenAI's Whisper model through **whisper.cpp**, with Metal acceleration on Apple Silicon. No Deepgram, OpenAI API, credentials, local HTTP server, or audio uploads. Unlike upstream's streaming service, transcription starts **after you stop recording** and takes a few seconds depending on recording length and hardware. The model loads for each dictation.

## Requirements

- macOS with [Pi](https://github.com/earendil-works/pi) installed (tested on Apple M2).
- `whisper-cli` and SoX `rec` from Homebrew.
- Default model: `~/.cache/whisper/ggml-small.en.bin` (English, 487,614,201 bytes).
- Model SHA-256: `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`.

The Python `whisper` package is not required. Models and dependencies are downloaded separately, not included in this repository.

## Use

Run `/reload` in Pi after installation.

1. Focus an input field.
2. **Alt+M** starts recording; a red dot and live mic meter appear.
3. **Alt+M** stops recording; a spinner shows local transcription.
4. The finished text is appended, never automatically submitted.
5. **Alt+N** cancels recording or transcription and discards the result.

Commands: `/dictate`, `/dictate start`, `/dictate stop`, `/dictate cancel`, `/dictate status`.

Works in the main editor and dialogs. In quiz/ask-user-question dialogs, **Tab into the note/Other text field first**, and keep it focused until the text arrives. Opaque dialogs do not expose their internal input focus. If the focused component changes after stopping, the transcript is copied to the macOS clipboard instead of being inserted into the wrong dialog.

macOS must allow your terminal microphone access: System Settings → Privacy & Security → Microphone. Option must send Alt/Meta (iTerm2: Profile → Keys → Option key → Esc+). If Option+M types `µ`, change that terminal setting or use `/dictate` commands.

## Privacy and resource limits

Recording starts only on an explicit shortcut/command in interactive Pi. The extension never starts a microphone on load or in RPC/print mode. PCM audio is buffered in memory, limited to five minutes. Stop writes a WAV and transcript inside a private temporary directory, removed after success, cancellation, or errors. Cancellation and session shutdown terminate child processes; a force-kill fallback handles stuck children. Inference has a five-minute timeout.

As with any temporary files, a hard crash or power loss can leave `pi-dictate-*` directories under the OS temporary directory. Debug mode logs only shortcut/lifecycle information, not speech. Once you submit dictated text, Pi sends that text to your selected assistant provider as usual.

The first decode may take longer while Metal compiles shaders (about 23 seconds in the initial test on this M2; subsequent processing was about 2.4 seconds for a short sentence).

Whisper can hallucinate text in noise or silence. Very short/digitally silent input is skipped, but **review the transcription before submitting**.

## Install

```sh
brew install whisper-cpp sox
mkdir -p ~/.cache/whisper
curl -fL --retry 3 \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
  -o ~/.cache/whisper/ggml-small.en.bin.part && \
  mv ~/.cache/whisper/ggml-small.en.bin.part ~/.cache/whisper/ggml-small.en.bin
pi install git:github.com/nithilgadde/pi-dictate-local
```

Dependencies and model download require the internet once. Actual dictation does not.

## Configuration

Optional environment variables, set in the shell that launches Pi:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DICTATE_WHISPER_MODEL` | `~/.cache/whisper/ggml-small.en.bin` | Local whisper.cpp GGML model file |
| `DICTATE_WHISPER_BIN` | `whisper-cli` | Decoder executable path |
| `DICTATE_REC_BIN` | `rec` | SoX recorder executable path |
| `DICTATE_LANGUAGE` | `en` | Whisper language code or `auto` |
| `DICTATE_DEBUG` | unset | Enable shortcut debug log at `/tmp/dictate-debug.log` |

For other languages, download a **multilingual** model (e.g. `ggml-small.bin`, not `.en.bin`) and set `DICTATE_LANGUAGE=auto` or a language code. For faster decoding with lower accuracy, use `ggml-base.en.bin`. Executable discovery also checks `/opt/homebrew/bin` and `/usr/local/bin`.

## Development

```sh
git clone https://github.com/nithilgadde/pi-dictate-local.git
cd pi-dictate-local
npm install --ignore-scripts
npm run check
npm test  # Node 24; fake subprocesses, no microphone required
```

`index.ts` retains upstream's focus-aware UI and shortcuts. `local-whisper.ts` owns audio capture, WAV encoding, bounded processes, cancellation, and transcription. Pi supplies its own packages at runtime.

Install this repository rather than the upstream git package, which uses Deepgram. To uninstall: `pi remove git:github.com/nithilgadde/pi-dictate-local`, then `/reload`. For a local-path installation, pass that path to `pi remove` instead. Homebrew dependencies and the model are not removed.
