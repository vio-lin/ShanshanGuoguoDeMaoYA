/// <reference types="vite/client" />

// Tauri v2 全局 API（withGlobalTauri 开启后注入 window.__TAURI__）
interface Window {
  __TAURI__?: {
    core: {
      invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    };
    event: {
      listen<T = unknown>(channel: string, cb: (event: { payload: T }) => void): Promise<() => void>;
    };
    window: {
      getCurrentWindow(): {
        startDragging(): Promise<void>;
        hide(): Promise<void>;
        show(): Promise<void>;
        setFocus(): Promise<void>;
        eval(code: string): Promise<void>;
      };
    };
  };
}
