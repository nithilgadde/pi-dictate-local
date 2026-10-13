/**
 * Local Whisper fork of amosblomqvist/pi-dictate (MIT).
 * Alt+M starts/stops; Alt+N cancels. Audio stays on this machine.
 * Captures 16 kHz PCM with SoX, transcribes with whisper.cpp after stopping.
 * Retains upstream's global shortcuts, level meter and focus-aware delivery.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { getConfig, validateConfig, LocalDictation } from "./local-whisper.ts";
import { appendFileSync } from "node:fs";

// Optional forensic logging: run pi with DICTATE_DEBUG=1 to append timestamped
// shortcut events to /tmp/dictate-debug.log. Never logs audio or transcripts.
const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (msg: string) => {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

type State = "idle" | "recording" | "stopping";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The TUI handle is captured once via a zero-height widget factory (the only
// extension-API surface that exposes it). With it we can:
//   1. Listen to ALL terminal input via tui.addInputListener — listeners run
//      before the focused component, so alt+m works even while a custom
//      dialog has stolen focus from the main editor (extension shortcuts are
//      otherwise only matched by the main editor component).
//   2. Use getFocusedComponent() to decide where the transcript goes.
// Older Pi builds fall back to the upstream private-property lookup.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// const PEAK_BLOCKS = ["⠀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Compute normalized RMS (0..1) over a buffer of signed 16-bit little-endian PCM samples. */
function rmsFromPcm16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const s = buf.readInt16LE(i);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

/** Map a normalized RMS value to one of PEAK_BLOCKS by converting to dB and clamping into the visible range. */
function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  const idx = Math.floor(t * (PEAK_BLOCKS.length - 1));
  return PEAK_BLOCKS[idx]!;
}

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let recording: LocalDictation | null = null;
  let activeCtx: ExtensionContext | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Generation guards keep late results from cancelled sessions out of the UI.
  let generation = 0;
  // Audio meter state. `meter` is a ring of recent RMS values, newest at
  // index METER_CELLS-1. `currentLevel` is the most recent RMS observed from
  // any audio chunk — the meter tick just samples it. Crucially we never reset
  // it: empty ticks re-render the last observed value, so the bars never drop
  // to silence just because no chunk happened to arrive in that 60ms window.
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let currentLevel = 0;

  const setStatus = (msg: string | undefined) => {
    if (!activeCtx) return;
    activeCtx.ui.setStatus("dictate", msg);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  };

  /** Start the meter ticking. Each tick shifts the ring and samples currentLevel. */
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    currentLevel = 0;
    // Recording dot: a text glyph colored via the theme, not an emoji — emoji
    // presentation renders double-width in its own baked-in color and visually
    // shouts in the footer. `●` is the same dot pi's own docs use for
    // indicators; theme "error" gives the red. (If you ever want strictly
    // ASCII, swap the glyph for "O".)
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      setStatus(`${dot} ${meter.map(rmsToBlock).join("")} listening…`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };

  /** Animate the dictate status row with a braille spinner + suffix message. */
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;

  /** Resolve where dictated text would go RIGHT NOW, based on keyboard focus. */
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.getFocusedComponent?.() ?? tuiHandle?.focusedComponent;
    if (!focused) return null;
    // Editor-like focus: the main chat editor, custom editors, and the
    // ctx.ui.editor()/input() popups (their inner pi-tui Editor hangs off
    // `.editor`). These accept a guaranteed direct setText append.
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    // Opaque component with input handling (quiz/ask selects, selectors):
    // we can type into it, but whether the text lands depends on its
    // internal focus (e.g. the quiz note field must be Tab-focused).
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const flush = (text: string, stoppedFocus: unknown) => {
    if (!activeCtx || !text) return;

    // Legacy fallback: no TUI handle captured (older Pi) —
    // append to the main chat editor exactly as before.
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + text);
      return;
    }

    // Local inference takes time: never inject into a different dialog that
    // appeared AFTER stop. Preserve the transcript via clipboard instead.
    const focused = tuiHandle?.getFocusedComponent?.() ?? tuiHandle?.focusedComponent;
    const target = focused === stoppedFocus ? resolveTarget() : null;
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      target.editor.setText(current + sep + text);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      // Synthetic typing: the component routes the text wherever its
      // internal focus is. Text is plain printable words (whitespace
      // already normalized), so no keybindings/autocomplete can trigger.
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    // Nothing to type into: don't throw the transcript away — stash it on
    // the clipboard and say so.
    const ctx = activeCtx;
    const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    let failed = false;
    const reportFailure = () => {
      if (failed) return;
      failed = true;
      ctx.ui.notify("Clipboard unavailable. Transcript: " + text, "warning");
    };
    p.on("error", reportFailure);
    p.stdin.on("error", reportFailure);
    p.on("close", code => {
      if (code !== 0) reportFailure();
      else if (!failed) ctx.ui.notify("Dictation finished but focus changed or no input is focused — transcript copied to clipboard", "warning");
    });
    p.stdin.end(text);
  };

  const cleanup = () => {
    generation++;
    recording?.cancel();
    recording = null;
    stopSpinner();
    stopMeter();
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
  };

  const startDictation = (ctx: ExtensionContext) => {
    activeCtx = ctx;
    const myGeneration = ++generation;
    try {
      recording = new LocalDictation(getConfig(), {
        onAudio: chunk => {
          if (myGeneration === generation) currentLevel = rmsFromPcm16(chunk);
        },
        onError: error => {
          if (myGeneration !== generation) return;
          ctx.ui.notify(error.message, "error");
          cleanup();
        },
        onLimit: () => {
          if (myGeneration !== generation) return;
          ctx.ui.notify("Five-minute dictation limit reached; transcribing locally.", "info");
          void stopDictation();
        },
      });
      state = "recording";
      recording.start();
      startMeter();
    } catch (error) {
      ctx.ui.notify(String(error), "error");
      cleanup();
    }
  };

  const stopDictation = async () => {
    if (state !== "recording" || !recording) return;
    state = "stopping";
    stopMeter();
    startSpinner("transcribing locally…");
    const myGeneration = generation;
    const stoppedFocus = tuiHandle?.getFocusedComponent?.() ?? tuiHandle?.focusedComponent;
    try {
      const text = await recording.stop();
      if (myGeneration !== generation) return;
      if (text) flush(text, stoppedFocus);
      else activeCtx?.ui.notify("No speech detected.", "info");
    } catch (error) {
      if (myGeneration === generation) activeCtx?.ui.notify(String(error), "error");
    } finally {
      if (myGeneration === generation) cleanup();
    }
  };

  const cancelDictation = () => {
    if (state !== "idle") cleanup();
  };

  /** Toggle dictation, gated on there being somewhere for the text to go. */
  const toggleDictation = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      void stopDictation();
    }
    // Ignore toggles during inference; Alt+N still cancels immediately.
  };

  // Global input listener: catches alt+m/alt+n before ANY focused component,
  // which is what makes dictation work inside dialogs. Registered once the
  // TUI handle is captured (see session_start below).
  const onGlobalInput = (data: string) => {
    const toggleKey = matchesKey(data, Key.alt("m"));
    const cancelKey = matchesKey(data, Key.alt("n"));
    // Consume our repeat/release events too, so the editor's fallback
    // shortcut handler cannot interpret a held key as another toggle.
    if (isKeyRelease(data) || isKeyRepeat(data)) {
      return toggleKey || cancelKey ? { consume: true } : undefined;
    }
    if (toggleKey) {
      dbg(`alt+m (data=${JSON.stringify(data)}) state=${state}`);
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if (cancelKey) {
      dbg(`alt+n (data=${JSON.stringify(data)}) state=${state}`);
      cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    // Capture the TUI handle via an invisible zero-height widget. The
    // listener function reference is stable, so even if the factory re-runs
    // the TUI's listener Set de-dupes it.
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      removeInputListener?.();
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  pi.registerCommand("dictate", {
    description: "Local Whisper dictation: start, stop, cancel, or status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        try {
          const config = validateConfig(getConfig());
          ctx.ui.notify(`Local Whisper ready (state: ${state})\nModel: ${config.model}\nDecoder: ${config.binary}\nRecorder: ${config.recorder}\nLanguage: ${config.language}\nAlt+M: toggle; Alt+N: cancel`, "info");
        } catch (error) { ctx.ui.notify(String(error), "error"); }
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Microphone dictation requires interactive Pi.", "warning");
        return;
      }
      if (action === "cancel") cancelDictation();
      else if (action === "stop") await stopDictation();
      else if (action === "" || action === "start") {
        if (action === "start" && state !== "idle") return;
        toggleDictation(ctx);
      } else ctx.ui.notify("Usage: /dictate [start|stop|cancel|status]", "info");
    },
  });

  // Shortcut registrations kept as a fallback for contexts where the TUI
  // handle was never captured (older Pi): they only fire when
  // the main editor is focused, but that's precisely the legacy path. When
  // the listener IS installed it consumes the key first, so no double-fire.
  pi.registerShortcut(Key.alt("m"), {
    description: "Toggle voice dictation (local Whisper)",
    handler: async (ctx) => {
      toggleDictation(ctx);
    },
  });

  // Dedicated cancel binding. Dictation-only — a no-op when no dictation is
  // in flight, so it's safe to hammer without affecting anything else.
  pi.registerShortcut(Key.alt("n"), {
    description: "Cancel voice dictation (discard transcript)",
    handler: async () => {
      cancelDictation();
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
    removeInputListener?.();
    removeInputListener = null;
    tuiHandle = null;
    lastCtx = null;
  });
}
