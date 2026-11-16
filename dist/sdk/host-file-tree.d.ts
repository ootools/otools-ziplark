import { HostTreePicker } from './host-tree-factory';
import { OToolsHostDirEntry, OToolsHostReadFilePayload, OToolsHostBrowsePayload } from './otools-globals';
export type { HostDirEntry, HostReadFilePayload, HostBrowsePayload, PickFromHostTreeOptions, HostPickSource, HostPickResult, } from './host-tree-factory';
type HostDirEntry = OToolsHostDirEntry;
type HostReadFilePayload = OToolsHostReadFilePayload;
type HostBrowsePayload = OToolsHostBrowsePayload;
/** 列宿主某目录（含根列表与父路径），对应 `tools_webview_browse_dialog`。 */
export declare function browseHostDir(path?: string): Promise<HostBrowsePayload>;
/** 列宿主目录下的一层条目（对应 `tools_webview_list_dir`）。 */
export declare function listHostDir(path: string): Promise<HostDirEntry[]>;
/** 读宿主文件内容（对应 `tools_webview_read_file`）。 */
export declare function readHostFile(path: string): Promise<HostReadFilePayload>;
/**
 * 宿主文件系统 DOM 选择树。
 *
 * 实现只有一份：宿主注入运行时的 `window.otools.pickFromHostTree`（apiVersion >= 2）。
 * SDK 不再带本地兜底，避免两套渲染器分叉。
 */
export declare const pickFromHostTree: HostTreePicker;
