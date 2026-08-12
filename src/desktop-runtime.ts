import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export type DesktopDisplayStatus = {
  controller: boolean;
  running: boolean;
  expected: boolean;
  abnormal: boolean;
  incidentId: string | null;
  incidentAt: string | null;
  lastSyncAt: string | null;
};

export function isDesktopRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export function getDesktopView(): "admin" | "display" | null {
  if (!isDesktopRuntime()) return null;
  const label = getCurrentWebviewWindow().label;
  return label === "display" || label === "monitor-preview"
    ? "display"
    : "admin";
}

export async function loadDesktopData<T>() {
  return invoke<T | null>("load_app_data");
}

export async function saveDesktopData<T>(data: T) {
  await invoke("save_app_data", { data });
}

export async function markDesktopReady(view: "admin" | "display") {
  await invoke("mark_frontend_ready", { view });
}

export async function subscribeToDesktopData<T>(
  onData: (data: T) => void,
): Promise<UnlistenFn> {
  return listen<T>("inventory-updated", (event) => onData(event.payload));
}

export async function openDesktopDisplay(preview = false) {
  await invoke("open_display_window", { preview });
}

export async function closeDesktopDisplay() {
  await invoke("close_display_window");
}

export async function getDesktopDisplayStatus() {
  return invoke<DesktopDisplayStatus>("display_status");
}
