/** 宿主投递敲门事件名（与宿主 platform/keyword_dispatch.rs 的 KEYWORD_DISPATCH_EVENT 对齐）。 */
export declare const OTOOLS_KEYWORD_DISPATCH_EVENT = "otools-keyword-dispatch";
export interface OtoolsKeywordDispatch {
    /** 单条派发标识（宿主生成），可用于响应回传时的关联。 */
    id: string;
    /** 小写归一化后的关键词。 */
    keyword: string;
    /** 宿主附带的任意 JSON 载荷，可为 null。 */
    payload: unknown;
    /** 派发来源：shortcut / host / mcp / plugin… */
    source: string;
    createdAtMs: number;
}
export type KeywordUnlisten = () => void | Promise<void>;
/** 订阅器签名（`window.otools.onOtoolsKeyword` 就是它）。 */
export type KeywordListener = (handler: (items: OtoolsKeywordDispatch[]) => void) => Promise<KeywordUnlisten>;
