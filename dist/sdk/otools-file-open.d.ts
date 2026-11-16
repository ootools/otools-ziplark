import { FileOpenListener } from './file-open-factory';
export { OTOOLS_FILE_DELIVER_EVENT, parseLaunchOpenFiles, toOpenFileEntries, type OtoolsOpenFileEntry, type FileOpenListener, type FileOpenUnlisten, } from './file-open-factory';
/** 订阅宿主投递的文件，转发到 `window.otools.onOtoolsOpenFile`。 */
export declare const onOtoolsOpenFile: FileOpenListener;
