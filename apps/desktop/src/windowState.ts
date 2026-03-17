import * as FS from "node:fs";
import * as Path from "node:path";

import { screen } from "electron";
import type { BrowserWindow, Rectangle } from "electron";

const WINDOW_STATE_FILE_NAME = "window-state.json";
const WINDOW_STATE_VERSION = 1;
const WINDOW_VISIBILITY_THRESHOLD = 0.2;
const WINDOW_STATE_PERSIST_DEBOUNCE_MS = 250;

type PersistedWindowMode = "normal" | "maximized";

interface PersistedWindowState {
  readonly version: 1;
  readonly bounds: Rectangle;
  readonly mode: PersistedWindowMode;
  readonly restoreAsMaximizedFromFullScreen: boolean;
}

export interface ResolvedWindowState {
  readonly bounds: Rectangle;
  readonly mode: PersistedWindowMode;
  readonly restoreAsMaximizedFromFullScreen: boolean;
}

interface LoadWindowStateParams {
  readonly userDataPath: string;
  readonly defaultBounds: Rectangle;
  readonly minWidth: number;
  readonly minHeight: number;
}

interface AttachWindowStatePersistenceParams {
  readonly window: BrowserWindow;
  readonly userDataPath: string;
}

function getWindowStateFilePath(userDataPath: string): string {
  return Path.join(userDataPath, WINDOW_STATE_FILE_NAME);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPersistedWindowMode(value: unknown): value is PersistedWindowMode {
  return value === "normal" || value === "maximized";
}

function parsePersistedWindowState(raw: string): PersistedWindowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const { version, bounds, mode, restoreAsMaximizedFromFullScreen } = parsed as {
    version?: unknown;
    bounds?: Record<string, unknown>;
    mode?: unknown;
    restoreAsMaximizedFromFullScreen?: unknown;
  };

  if (
    version !== WINDOW_STATE_VERSION ||
    !isPersistedWindowMode(mode) ||
    typeof restoreAsMaximizedFromFullScreen !== "boolean"
  ) {
    return null;
  }

  if (typeof bounds !== "object" || bounds === null) {
    return null;
  }

  const { x, y, width, height } = bounds;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return {
    version: WINDOW_STATE_VERSION,
    bounds: {
      x,
      y,
      width,
      height,
    },
    mode,
    restoreAsMaximizedFromFullScreen,
  };
}

function sanitizeBounds(bounds: Rectangle, minWidth: number, minHeight: number): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(minWidth, Math.round(bounds.width)),
    height: Math.max(minHeight, Math.round(bounds.height)),
  };
}

function intersectionArea(a: Rectangle, b: Rectangle): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) {
    return 0;
  }

  return (right - left) * (bottom - top);
}

function isWindowVisibleEnough(bounds: Rectangle): boolean {
  const display = screen.getDisplayMatching(bounds);
  const visibleArea = intersectionArea(bounds, display.workArea);
  const totalArea = bounds.width * bounds.height;

  if (totalArea <= 0) {
    return false;
  }

  return visibleArea / totalArea >= WINDOW_VISIBILITY_THRESHOLD;
}

function centerBoundsInDisplay(displayBounds: Rectangle, width: number, height: number): Rectangle {
  return {
    x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
    y: Math.round(displayBounds.y + (displayBounds.height - height) / 2),
    width,
    height,
  };
}

function buildDefaultWindowState(
  defaultBounds: Rectangle,
  minWidth: number,
  minHeight: number,
): ResolvedWindowState {
  const primaryDisplay = screen.getPrimaryDisplay();
  const width = Math.max(minWidth, Math.round(defaultBounds.width));
  const height = Math.max(minHeight, Math.round(defaultBounds.height));

  return {
    bounds: centerBoundsInDisplay(primaryDisplay.workArea, width, height),
    mode: "normal",
    restoreAsMaximizedFromFullScreen: false,
  };
}

function readRestorableWindowState(window: BrowserWindow): PersistedWindowState {
  return {
    version: WINDOW_STATE_VERSION,
    bounds: window.getBounds(),
    mode: window.isMaximized() ? "maximized" : "normal",
    restoreAsMaximizedFromFullScreen: false,
  };
}

function persistWindowState(state: PersistedWindowState, userDataPath: string): void {
  try {
    const filePath = getWindowStateFilePath(userDataPath);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[desktop] failed to persist window state", error);
  }
}

export function loadWindowState({
  userDataPath,
  defaultBounds,
  minWidth,
  minHeight,
}: LoadWindowStateParams): ResolvedWindowState {
  const fallback = buildDefaultWindowState(defaultBounds, minWidth, minHeight);
  const filePath = getWindowStateFilePath(userDataPath);

  if (!FS.existsSync(filePath)) {
    return fallback;
  }

  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }

  const parsed = parsePersistedWindowState(raw);
  if (!parsed) {
    return fallback;
  }

  const bounds = sanitizeBounds(parsed.bounds, minWidth, minHeight);
  if (!isWindowVisibleEnough(bounds)) {
    return fallback;
  }

  return {
    bounds,
    mode: parsed.mode,
    restoreAsMaximizedFromFullScreen: parsed.restoreAsMaximizedFromFullScreen,
  };
}

export function attachWindowStatePersistence({
  window,
  userDataPath,
}: AttachWindowStatePersistenceParams): void {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRestorableState = readRestorableWindowState(window);

  const resolvePersistedWindowState = (): PersistedWindowState => {
    if (window.isFullScreen()) {
      return {
        ...lastRestorableState,
        mode: "maximized",
        restoreAsMaximizedFromFullScreen: true,
      };
    }

    lastRestorableState = readRestorableWindowState(window);
    return lastRestorableState;
  };

  const clearPersistTimer = () => {
    if (persistTimer === null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
  };

  const persistNow = () => {
    clearPersistTimer();
    persistWindowState(resolvePersistedWindowState(), userDataPath);
  };

  const schedulePersist = () => {
    clearPersistTimer();
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistWindowState(resolvePersistedWindowState(), userDataPath);
    }, WINDOW_STATE_PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  window.on("resize", schedulePersist);
  window.on("move", schedulePersist);
  window.on("maximize", persistNow);
  window.on("unmaximize", persistNow);
  window.on("enter-full-screen", persistNow);
  window.on("leave-full-screen", persistNow);
  window.on("close", persistNow);
}
