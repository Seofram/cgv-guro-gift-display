import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export async function loadDesktopData<T>() {
  return invoke<T | null>("load_app_data");
}

export async function saveDesktopData<T>(data: T) {
  await invoke("save_app_data", { data });
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
