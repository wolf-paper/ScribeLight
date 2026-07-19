import { getCurrentWindow } from '@tauri-apps/api/window';

export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface LifecycleAdapter {
  onCloseRequested(handler: (event: CloseRequestEvent) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

export const tauriLifecycle: LifecycleAdapter = {
  onCloseRequested: (handler) => getCurrentWindow().onCloseRequested(handler),
  destroy: () => getCurrentWindow().destroy()
};
