import { OToolsAPI } from './otools-globals';
export interface Event<T> {
    event: string;
    id: number;
    payload: T;
}
export type UnlistenFn = () => Promise<void> | void;
export type EventTarget = {
    kind: 'Any' | 'AnyLabel';
    label?: string;
} | {
    kind: 'Window' | 'Webview' | 'WebviewWindow';
    label: string;
};
export interface ListenOptions {
    target?: string | EventTarget;
}
/** 宿主注入的 API；老宿主可能没有该字段。 */
export declare const getOtoolsApi: () => OToolsAPI | undefined;
/** 是否跑在 OTools 插件 webview 里（注入 API 是否存在）。 */
export declare const isOtoolsPluginRuntime: () => boolean;
/** 直接走 Tauri 通道（不经过宿主分流）；移植老插件时的逃生口。 */
export declare function invokeTauri<T = unknown>(command: string, payload?: unknown): Promise<T>;
/**
 * 通用命令通道。
 *
 * 实现只有一份：宿主注入运行时的 `window.otools.invoke`（apiVersion >= 2），
 * 它内部已经做了「宿主命令 / 插件 native cdylib / 旧命令别名」的分流。
 */
export declare function invoke<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
/** Tauri 事件订阅原语（webview 自带能力，不是宿主业务逻辑）。 */
export declare function listenTauri<T>(event: string, handler: (event: Event<T>) => void | Promise<void>, options?: ListenOptions): Promise<UnlistenFn>;
/** 订阅 Tauri 事件。 */
export declare function listen<T>(event: string, handler: (event: Event<T>) => void | Promise<void>, options?: ListenOptions): Promise<UnlistenFn>;
/** 发 Tauri 事件（宿主侧同样监听这条事件总线）。 */
export declare function emit<T = unknown>(event: string, payload?: T): Promise<void>;
/** 用系统默认程序打开链接。 */
export declare function openExternal(url: string): boolean;
/** 用系统默认程序打开路径。 */
export declare function openPath(fullPath: string): boolean;
