import { CaptureApi } from './capture-factory';
/** 只再导出类型；实现与错误类都在宿主。 */
export type * from './capture-factory';
/**
 * 截屏 API，转发到 `window.otools.capture`（apiVersion >= 1）。
 *
 * 错误类请用 `window.otools.CaptureError`：它才是运行时唯一那份实现。
 */
export declare const capture: CaptureApi;
