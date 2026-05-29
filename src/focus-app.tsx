import {
  Action,
  ActionPanel,
  clearSearchBar,
  getApplications,
  getFrontmostApplication,
  Icon,
  List,
  showToast,
  Toast,
  updateCommandMetadata,
} from "@raycast/api";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const USER = process.env.USER || userInfo().username;
const HOME_DIRECTORY = process.env.HOME || homedir();
const COMMAND_SEARCH_DIRECTORIES = [
  join(HOME_DIRECTORY, ".nix-profile/bin"),
  "/nix/var/nix/profiles/default/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
const COMMAND_PATH = COMMAND_SEARCH_DIRECTORIES.join(":");
const EXEC_ENV = { ...process.env, PATH: COMMAND_PATH, USER };
const COMMAND_TIMEOUT_MS = 5000;
const OPEN_COMMAND = "/usr/bin/open";
const STARTUP_REFRESH_DELAYS_MS = [400, 900, 1600, 3000];
const BACKGROUND_REFRESH_INTERVAL_MS = 1000;
const FOCUS_SHORTCUT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;
const APP_SEARCH_DIRECTORIES = [
  "/Applications",
  join(HOME_DIRECTORY, "Applications"),
  "/System/Applications",
  "/System/Applications/Utilities",
  "/Applications/Utilities",
];
const IGNORED_APP_NAMES = new Set(["raycast"]);
const TITLE_SUFFIX_NOISE_PATTERNS = [/ - Audio playing$/i, / - \d+ new items?$/i];

type ExecResult = {
  stdout: string;
  stderr: string;
};

type RefreshOptions = {
  isBackground?: boolean;
};

type AppIconsByName = Map<string, string>;
type AppIconFallbacksByName = Map<string, string | undefined>;
type WindowSnapshot = {
  windows: YabaiWindow[];
  focusedAppKey?: string;
  focusedAppName?: string;
};
type WindowGroups = {
  unfocusedWindows: YabaiWindow[];
  focusedAppWindows: YabaiWindow[];
};

class CommandError extends Error {
  code?: string | number;
  commandName?: string;
  signal?: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;

  constructor(
    message: string,
    options: {
      code?: string | number;
      commandName?: string;
      signal?: NodeJS.Signals | null;
      stderr: string;
      timedOut?: boolean;
    },
  ) {
    super(message);
    this.name = "CommandError";
    this.code = options.code;
    this.commandName = options.commandName;
    this.signal = options.signal;
    this.stderr = options.stderr;
    this.timedOut = options.timedOut ?? false;
  }
}

type YabaiWindow = {
  id: number;
  app: string;
  title: string;
  space: number;
  display: number;
  "is-minimized": boolean;
  "is-hidden": boolean;
  "has-ax-reference": boolean;
  "is-visible"?: boolean;
  "has-focus"?: boolean;
};

let yabaiPath: string | undefined;

function isExecutablePath(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveYabaiPath(): string {
  if (yabaiPath && isExecutablePath(yabaiPath)) {
    return yabaiPath;
  }

  for (const directory of COMMAND_SEARCH_DIRECTORIES) {
    const candidate = join(directory, "yabai");

    if (isExecutablePath(candidate)) {
      yabaiPath = candidate;
      return candidate;
    }
  }

  throw new CommandError("yabai was not found in the configured executable locations", {
    code: "ENOENT",
    commandName: "yabai",
    stderr: "",
  });
}

function runCommand(file: string, args: string[], commandName: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: EXEC_ENV, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const nodeError = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          };
          reject(
            new CommandError(nodeError.message, {
              code: nodeError.code,
              commandName,
              signal: nodeError.signal,
              stderr,
              timedOut: nodeError.killed === true && nodeError.signal === "SIGTERM",
            }),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function runYabai(args: string[]): Promise<ExecResult> {
  return runCommand(resolveYabaiPath(), args, "yabai");
}

function runOpen(args: string[]): Promise<ExecResult> {
  return runCommand(OPEN_COMMAND, args, "open");
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseYabaiWindows(stdout: string): YabaiWindow[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Invalid JSON returned by yabai: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid yabai response: expected an array of windows");
  }

  const windows: YabaiWindow[] = [];

  for (const item of parsed) {
    const window = asObject(item);
    if (!window) {
      continue;
    }

    const id = asNumber(window.id);
    const app = asString(window.app);
    const title = asString(window.title) ?? "";
    const space = asNumber(window.space);
    const display = asNumber(window.display);
    const isMinimized = asBoolean(window["is-minimized"]);
    const isHidden = asBoolean(window["is-hidden"]);
    const hasAxReference = asBoolean(window["has-ax-reference"]);

    if (
      id === undefined ||
      app === undefined ||
      space === undefined ||
      display === undefined ||
      isMinimized === undefined ||
      isHidden === undefined ||
      hasAxReference === undefined
    ) {
      continue;
    }

    windows.push({
      id,
      app,
      title,
      space,
      display,
      "is-minimized": isMinimized,
      "is-hidden": isHidden,
      "has-ax-reference": hasAxReference,
      "is-visible": asBoolean(window["is-visible"]),
      "has-focus": asBoolean(window["has-focus"]),
    });
  }

  return windows;
}

function isFocusableWindow(window: YabaiWindow): boolean {
  return (
    !IGNORED_APP_NAMES.has(appNameKey(window.app)) &&
    !window["is-minimized"] &&
    !window["is-hidden"] &&
    window["has-ax-reference"] === true
  );
}

function sortWindows(windows: YabaiWindow[], focusedAppKey: string | undefined): YabaiWindow[] {
  if (windows.length <= 1) {
    return windows;
  }

  return [...windows].sort((a, b) => {
    const focusedAppComparison =
      Number(isFocusedAppWindow(a, focusedAppKey)) - Number(isFocusedAppWindow(b, focusedAppKey));
    if (focusedAppComparison !== 0) {
      return focusedAppComparison;
    }

    const appComparison = a.app.localeCompare(b.app);
    if (appComparison !== 0) {
      return appComparison;
    }

    return a.title.localeCompare(b.title);
  });
}

function focusedAppKeyForWindows(windows: YabaiWindow[]): string | undefined {
  const focusedWindow = windows.find(
    (window) => window["has-focus"] === true && !IGNORED_APP_NAMES.has(appNameKey(window.app)),
  );

  if (focusedWindow) {
    return appNameKey(focusedWindow.app);
  }

  return undefined;
}

function isFocusedAppWindow(window: YabaiWindow, focusedAppKey: string | undefined): boolean {
  return focusedAppKey !== undefined && appNameKey(window.app) === focusedAppKey;
}

function groupWindowsByFocusedApp(
  windows: YabaiWindow[],
  focusedAppKey: string | undefined,
): WindowGroups {
  const unfocusedWindows: YabaiWindow[] = [];
  const focusedAppWindows: YabaiWindow[] = [];

  for (const window of windows) {
    if (isFocusedAppWindow(window, focusedAppKey)) {
      focusedAppWindows.push(window);
    } else {
      unfocusedWindows.push(window);
    }
  }

  return { unfocusedWindows, focusedAppWindows };
}

function areWindowListsEqual(a: YabaiWindow[], b: YabaiWindow[]): boolean {
  return a.length === b.length && a.every((window, index) => areWindowsEqual(window, b[index]));
}

function areWindowsEqual(a: YabaiWindow, b: YabaiWindow | undefined): boolean {
  return (
    b !== undefined &&
    a.id === b.id &&
    a.app === b.app &&
    a.title === b.title &&
    a.space === b.space &&
    a.display === b.display &&
    a["is-minimized"] === b["is-minimized"] &&
    a["is-hidden"] === b["is-hidden"] &&
    a["has-ax-reference"] === b["has-ax-reference"] &&
    a["is-visible"] === b["is-visible"] &&
    a["has-focus"] === b["has-focus"]
  );
}

function shortcutForUnfocusedWindow(index: number): Action.Props["shortcut"] | undefined {
  const key = FOCUS_SHORTCUT_KEYS[index];

  return key ? { modifiers: ["cmd"], key } : undefined;
}

function formatCommand(window: YabaiWindow): string {
  return `yabai -m window --focus ${window.id}`;
}

function formatSubtitle(window: YabaiWindow): string {
  return compactWindowTitle(window);
}

function compactWindowTitle(window: YabaiWindow): string {
  let title = window.title.trim();

  if (!title || title === window.app) {
    return "";
  }

  const appSuffix = ` - ${window.app}`;
  title = title.endsWith(appSuffix) ? title.slice(0, -appSuffix.length).trim() : title;

  for (const pattern of TITLE_SUFFIX_NOISE_PATTERNS) {
    title = title.replace(pattern, "").trim();
  }

  return title;
}

function formatCommandError(error: unknown): string {
  const commandError = error instanceof CommandError ? error : undefined;
  const message = [commandError?.stderr, formatErrorMessage(error)]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (commandError?.timedOut) {
    return `${commandError.commandName ?? "Command"} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
  }

  if (commandError?.code === "ENOENT" && commandError.commandName === "yabai") {
    return `yabai was not found in: ${COMMAND_SEARCH_DIRECTORIES.join(", ")}`;
  }

  if (commandError?.code === "ENOENT" && commandError.commandName === "open") {
    return `${OPEN_COMMAND} was not found`;
  }

  if (/socket|connection|connect|running/i.test(message)) {
    return "yabai may not be running or its socket is unavailable";
  }

  return message || "Unknown command failure";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

async function loadWindows(): Promise<WindowSnapshot> {
  const { stdout } = await runYabai(["-m", "query", "--windows"]);
  const allWindows = parseYabaiWindows(stdout);
  const focusableWindows = allWindows.filter(isFocusableWindow);
  const focusedAppKey =
    (await frontmostAppKeyForWindows(focusableWindows)) ?? focusedAppKeyForWindows(allWindows);
  const windows = sortWindows(focusableWindows, focusedAppKey);
  const focusedAppName = windows.find((window) => isFocusedAppWindow(window, focusedAppKey))?.app;

  return { windows, focusedAppKey, focusedAppName };
}

async function frontmostAppKeyForWindows(windows: YabaiWindow[]): Promise<string | undefined> {
  try {
    const frontmostApplication = await getFrontmostApplication();
    const frontmostAppKey = appNameKey(
      frontmostApplication.localizedName ?? frontmostApplication.name,
    );

    if (IGNORED_APP_NAMES.has(frontmostAppKey)) {
      return undefined;
    }

    return windows.some((window) => isFocusedAppWindow(window, frontmostAppKey))
      ? frontmostAppKey
      : undefined;
  } catch {
    return undefined;
  }
}

function appNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function findAppBundlePath(appName: string): string | undefined {
  if (!appName || appName.includes("/")) {
    return undefined;
  }

  const bundleName = `${appName}.app`;

  for (const directory of APP_SEARCH_DIRECTORIES) {
    const appPath = join(directory, bundleName);

    if (existsSync(appPath)) {
      return appPath;
    }
  }

  return undefined;
}

async function loadAppIconsByName(): Promise<AppIconsByName> {
  const applications = await getApplications();
  const iconsByName: AppIconsByName = new Map();

  for (const application of applications) {
    iconsByName.set(appNameKey(application.name), application.path);

    if (application.localizedName) {
      iconsByName.set(appNameKey(application.localizedName), application.path);
    }
  }

  return iconsByName;
}

async function focusWindow(window: YabaiWindow): Promise<void> {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Focusing ${window.app}`,
    message: window.title || `Window ${window.id}`,
  });

  try {
    await runYabai(["-m", "window", "--focus", String(window.id)]);
    toast.style = Toast.Style.Success;
    toast.title = `Focused ${window.app}`;
    toast.message = window.title || `Window ${window.id}`;
  } catch (focusError) {
    try {
      await runOpen(["-a", window.app]);
      toast.style = Toast.Style.Success;
      toast.title = `Opened ${window.app}`;
      toast.message = `Yabai focus failed: ${formatCommandError(focusError)}`;
    } catch (openError) {
      toast.style = Toast.Style.Failure;
      toast.title = `Could not focus ${window.app}`;
      toast.message = `${formatCommandError(focusError)}; fallback failed: ${formatCommandError(openError)}`;
    }
  }
}

function iconForWindow(
  window: YabaiWindow,
  appIconsByName: AppIconsByName,
  appIconFallbacksByName: AppIconFallbacksByName,
): List.Item.Props["icon"] {
  const appKey = appNameKey(window.app);
  const appPath = appIconsByName.get(appKey) ?? appIconFallbacksByName.get(appKey);

  if (!appPath) {
    return Icon.AppWindow;
  }

  return { fileIcon: appPath };
}

export default function Command() {
  const [windows, setWindows] = useState<YabaiWindow[]>([]);
  const [focusedAppKey, setFocusedAppKey] = useState<string>();
  const [focusedAppName, setFocusedAppName] = useState<string>();
  const [appIconsByName, setAppIconsByName] = useState<AppIconsByName>(() => new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [searchText, setSearchText] = useState("");
  const isMountedRef = useRef(true);
  const isRefreshingRef = useRef(false);
  const pendingRefreshRef = useRef<RefreshOptions | undefined>(undefined);

  useEffect(() => {
    isMountedRef.current = true;
    void clearSearchBar({ forceScrollToTop: true });
    void updateCommandMetadata({ subtitle: null });

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async function refreshWindows({
    isBackground = false,
  }: RefreshOptions = {}) {
    if (isRefreshingRef.current) {
      pendingRefreshRef.current = {
        isBackground: (pendingRefreshRef.current?.isBackground ?? true) && isBackground,
      };
      return;
    }

    isRefreshingRef.current = true;

    if (!isBackground) {
      setIsLoading(true);
    }

    try {
      const nextWindowSnapshot = await loadWindows();
      if (!isMountedRef.current) {
        return;
      }

      setWindows((currentWindows) =>
        areWindowListsEqual(currentWindows, nextWindowSnapshot.windows)
          ? currentWindows
          : nextWindowSnapshot.windows,
      );
      setFocusedAppKey((currentFocusedAppKey) =>
        currentFocusedAppKey === nextWindowSnapshot.focusedAppKey
          ? currentFocusedAppKey
          : nextWindowSnapshot.focusedAppKey,
      );
      setFocusedAppName((currentFocusedAppName) =>
        currentFocusedAppName === nextWindowSnapshot.focusedAppName
          ? currentFocusedAppName
          : nextWindowSnapshot.focusedAppName,
      );
      setErrorMessage((currentErrorMessage) =>
        currentErrorMessage === undefined ? currentErrorMessage : undefined,
      );

      if (nextWindowSnapshot.windows.length === 0 && !isBackground) {
        await showToast({
          style: Toast.Style.Failure,
          title: "No focusable yabai windows",
          message: "Hidden, minimized, and non-AX windows are ignored",
        });
      }
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      const message = formatCommandError(error);
      setErrorMessage(message);
      setWindows((currentWindows) => (currentWindows.length === 0 ? currentWindows : []));
      setFocusedAppKey((currentFocusedAppKey) =>
        currentFocusedAppKey === undefined ? currentFocusedAppKey : undefined,
      );
      setFocusedAppName((currentFocusedAppName) =>
        currentFocusedAppName === undefined ? currentFocusedAppName : undefined,
      );
      if (!isBackground) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Could not query yabai windows",
          message,
        });
      }
    } finally {
      isRefreshingRef.current = false;

      if (isMountedRef.current && !isBackground) {
        setIsLoading(false);
      }

      const pendingRefresh = pendingRefreshRef.current;
      pendingRefreshRef.current = undefined;

      if (pendingRefresh && isMountedRef.current) {
        void refreshWindows(pendingRefresh);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();

    const timeouts = STARTUP_REFRESH_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        void refresh({ isBackground: true });
      }, delay),
    );
    const refreshInterval = setInterval(() => {
      void refresh({ isBackground: true });
    }, BACKGROUND_REFRESH_INTERVAL_MS);

    return () => {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      clearInterval(refreshInterval);
    };
  }, [refresh]);

  useEffect(() => {
    async function loadAppIcons() {
      try {
        const nextAppIconsByName = await loadAppIconsByName();

        if (isMountedRef.current) {
          setAppIconsByName(nextAppIconsByName);
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }

        await showToast({
          style: Toast.Style.Failure,
          title: "Could not load app icons",
          message: formatErrorMessage(error),
        });
      }
    }

    void loadAppIcons();
  }, []);

  const emptyTitle = errorMessage ? "Could not query yabai windows" : "No focusable yabai windows";
  const emptyDescription = errorMessage ?? "Hidden, minimized, and non-AX windows are ignored.";

  const { unfocusedWindows } = useMemo(
    () => groupWindowsByFocusedApp(windows, focusedAppKey),
    [focusedAppKey, windows],
  );
  const appIconFallbacksByName = useMemo(() => {
    const fallbackPaths: AppIconFallbacksByName = new Map();

    for (const window of windows) {
      const appKey = appNameKey(window.app);

      if (!appIconsByName.has(appKey) && !fallbackPaths.has(appKey)) {
        fallbackPaths.set(appKey, findAppBundlePath(window.app));
      }
    }

    return fallbackPaths;
  }, [appIconsByName, windows]);

  const focusSelectedWindow = useCallback(async (window: YabaiWindow) => {
    setSearchText("");

    try {
      await clearSearchBar({ forceScrollToTop: true });
    } catch {
      // Keep focusing usable even if Raycast cannot clear the search bar.
    }

    await focusWindow(window);
  }, []);

  const renderWindowItem = (
    window: YabaiWindow,
    options: { focusShortcut?: Action.Props["shortcut"]; canFocus: boolean },
  ) => (
    <List.Item
      key={window.id}
      icon={iconForWindow(window, appIconsByName, appIconFallbacksByName)}
      title={window.app}
      subtitle={formatSubtitle(window) || undefined}
      keywords={[window.app, window.title, String(window.space)]}
      actions={
        options.canFocus && (
          <ActionPanel>
            <Action
              title="Focus Window"
              icon={Icon.Window}
              shortcut={options.focusShortcut}
              onAction={() => void focusSelectedWindow(window)}
            />
            <Action.CopyToClipboard
              title="Copy Yabai Focus Command"
              shortcut={{ modifiers: ["cmd"], key: "." }}
              content={formatCommand(window)}
            />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={refresh}
            />
          </ActionPanel>
        )
      }
    />
  );

  return (
    <List
      isLoading={isLoading}
      navigationTitle={focusedAppName ?? "Focus App"}
      searchBarPlaceholder="Search yabai windows/apps"
      searchText={searchText}
      filtering
      onSearchTextChange={setSearchText}
    >
      <List.EmptyView title={emptyTitle} description={emptyDescription} />
      {unfocusedWindows.map((window, index) =>
        renderWindowItem(window, {
          canFocus: true,
          focusShortcut: shortcutForUnfocusedWindow(index),
        }),
      )}
    </List>
  );
}
