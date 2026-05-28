import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const USER = process.env.USER || userInfo().username;
const COMMAND_PATH = `/Users/${USER}/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const EXEC_ENV = { ...process.env, PATH: COMMAND_PATH, USER };
const AUTO_REFRESH_INTERVAL_MS = 1500;

type ExecResult = {
  stdout: string;
  stderr: string;
};

type RefreshOptions = {
  isBackground?: boolean;
};

class CommandError extends Error {
  code?: string | number;
  stderr: string;

  constructor(message: string, options: { code?: string | number; stderr: string }) {
    super(message);
    this.name = "CommandError";
    this.code = options.code;
    this.stderr = options.stderr;
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

function runCommand(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: EXEC_ENV, timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new CommandError(error.message, {
              code: (error as NodeJS.ErrnoException).code,
              stderr,
            }),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
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
  return !window["is-minimized"] && !window["is-hidden"] && window["has-ax-reference"] === true;
}

function sortWindows(windows: YabaiWindow[]): YabaiWindow[] {
  if (windows.length <= 1) {
    return windows;
  }

  return [...windows].sort((a, b) => {
    const focusComparison = Number(a["has-focus"] === true) - Number(b["has-focus"] === true);
    if (focusComparison !== 0) {
      return focusComparison;
    }

    const visibleComparison = Number(b["is-visible"] === true) - Number(a["is-visible"] === true);
    if (visibleComparison !== 0) {
      return visibleComparison;
    }

    const appComparison = a.app.localeCompare(b.app);
    if (appComparison !== 0) {
      return appComparison;
    }

    return a.title.localeCompare(b.title);
  });
}

function formatCommand(window: YabaiWindow): string {
  return `yabai -m window --focus ${window.id}`;
}

function formatCommandError(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException & { stderr?: string };
  const message = [nodeError.stderr, nodeError.message].filter(Boolean).join("\n").trim();

  if (nodeError.code === "ENOENT") {
    return "yabai was not found on the configured PATH";
  }

  if (/socket|connection|connect|running/i.test(message)) {
    return "yabai may not be running or its socket is unavailable";
  }

  return message || "Unknown command failure";
}

async function loadWindows(): Promise<YabaiWindow[]> {
  const { stdout } = await runCommand("yabai", ["-m", "query", "--windows"]);
  return sortWindows(parseYabaiWindows(stdout).filter(isFocusableWindow));
}

async function focusWindow(window: YabaiWindow): Promise<void> {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: `Focusing ${window.app}`,
    message: window.title || `Window ${window.id}`,
  });

  try {
    await runCommand("yabai", ["-m", "window", "--focus", String(window.id)]);
    toast.style = Toast.Style.Success;
    toast.title = `Focused ${window.app}`;
    toast.message = window.title || `Window ${window.id}`;
  } catch (focusError) {
    try {
      await runCommand("open", ["-a", window.app]);
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

function accessoriesForWindow(window: YabaiWindow): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  if (window["has-focus"] === true) {
    accessories.push({
      text: "Focused",
      icon: { source: Icon.Dot, tintColor: Color.Green },
    });
  }

  if (window["is-visible"] === true) {
    accessories.push({
      text: "Visible",
      icon: { source: Icon.Eye, tintColor: Color.Blue },
    });
  }

  accessories.push({ text: `S${window.space}` }, { text: `D${window.display}` });

  return accessories;
}

export default function Command() {
  const [windows, setWindows] = useState<YabaiWindow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();
  const isRefreshingRef = useRef(false);

  const refresh = useCallback(async ({ isBackground = false }: RefreshOptions = {}) => {
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;

    if (!isBackground) {
      setIsLoading(true);
    }

    try {
      const nextWindows = await loadWindows();
      setWindows(nextWindows);
      setErrorMessage(undefined);

      if (nextWindows.length === 0 && !isBackground) {
        await showToast({
          style: Toast.Style.Failure,
          title: "No focusable yabai windows",
          message: "Hidden, minimized, and non-AX windows are ignored",
        });
      }
    } catch (error) {
      const message = formatCommandError(error);
      setErrorMessage(message);

      if (!isBackground) {
        setWindows([]);
        await showToast({
          style: Toast.Style.Failure,
          title: "Could not query yabai windows",
          message,
        });
      }
    } finally {
      isRefreshingRef.current = false;

      if (!isBackground) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();

    const interval = setInterval(() => {
      void refresh({ isBackground: true });
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [refresh]);

  const emptyTitle = errorMessage ? "Could not query yabai windows" : "No focusable yabai windows";
  const emptyDescription = errorMessage ?? "Hidden, minimized, and non-AX windows are ignored.";

  const items = useMemo(() => windows, [windows]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search yabai windows/apps">
      <List.EmptyView title={emptyTitle} description={emptyDescription} />
      {items.map((window) => (
        <List.Item
          key={window.id}
          title={window.app}
          subtitle={`${window.title || "Untitled window"} - Space ${window.space} - Display ${window.display}`}
          accessories={accessoriesForWindow(window)}
          keywords={[window.app, window.title, String(window.space)]}
          actions={
            <ActionPanel>
              <Action
                title="Focus Window"
                icon={Icon.Window}
                onAction={() => void focusWindow(window)}
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
          }
        />
      ))}
    </List>
  );
}
