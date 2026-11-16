import { KeywordListener } from './keyword-factory';
export { OTOOLS_KEYWORD_DISPATCH_EVENT, type OtoolsKeywordDispatch, type KeywordUnlisten, } from './keyword-factory';
/** 订阅宿主派发的关键词，转发到 `window.otools.onOtoolsKeyword`。 */
export declare const onOtoolsKeyword: KeywordListener;
