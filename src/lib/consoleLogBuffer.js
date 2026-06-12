import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    errorLogs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
    errorEmitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
  global._consoleLogBufferState.errorEmitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}
if (!state.errorEmitter) {
  state.errorEmitter = new EventEmitter();
  state.errorEmitter.setMaxListeners(50);
}
if (!state.errorLogs) {
  state.errorLogs = [];
}

function getTimestamp() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

// Detect a leading [HH:MM:SS] or [H:MM:SS] timestamp already added by the caller
const LEADING_TS_RE = /^\[\d{1,2}:\d{2}:\d{2}\]/;

function toLogLine(level, args) {
  const text = args.map(formatArg).join(" ");
  // Avoid double-stamping: if the caller already prepended [HH:MM:SS], don't add another
  if (LEADING_TS_RE.test(text)) return text;
  return `${getTimestamp()} ${text}`;
}

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function appendLine(line) {
  state.logs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.emitter.emit("line", line);
}

function appendErrorLine(line) {
  state.errorLogs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.errorLogs.length > maxLines) {
    state.errorLogs = state.errorLogs.slice(-maxLines);
  }
  state.errorEmitter.emit("line", line);
}

export function initConsoleLogCapture() {
  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      const line = toLogLine(level, args);
      appendLine(line);
      if (level === "error") appendErrorLine(line);
      state.originals[level](...args);
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}

export function getErrorLogs() {
  return state.errorLogs;
}

export function clearErrorLogs() {
  state.errorLogs = [];
  state.errorEmitter.emit("clear");
}

export function getErrorEmitter() {
  return state.errorEmitter;
}
