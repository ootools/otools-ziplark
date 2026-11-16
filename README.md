# otools-ziplark

把 [Ziplark](https://github.com/zhitongblog/ziplark)（MIT，Rust 归档引擎 + Tauri 2 桌面应用）
移植成 **OTools 独立原生插件**。归档运算全部在插件自带的 Rust 动态库里本地完成，
文件选择走宿主 SDK 的页面内文件树，完全离线。

- 上游快照：`9d539b6`（v0.6.0 之后的密码提示修复），原样保存在 `upstream/`，不可就地修改；构建时对 dist 拷贝应用声明过的锚点补丁（见 `scripts/build-web.mjs` 的 `MAIN_PATCH_*`）。
- 插件形态：`openMode: panel` + `native.enabled`，六平台分包（`packageMode=1`）。
- 仓库：<https://github.com/ootools/otools-ziplark>，作为 `xyito` 父仓的子模块挂在
  `otools/otools-ziplark`。

## 移植结构

```
upstream/                 上游快照（ui/ + ziplark-core/ + 命令层参考，只读）
native/
  ziplark-core/           引擎源码副本（只修了 Cargo.toml 的 workspace 继承字段 + 锁 zip=2.4.2）
  src/                    OTools cdylib 后端：28 个方法 + poll_events 事件通道
vendor/
  ot-plugin-ffi/          宿主 FFI 助手（panic 护栏）
  otools-plugin-sdk-dist/ 宿主 SDK 的 ESM 产物
shell/
  host-bridge.js          注入 window.__TAURI__：core.invoke / dialog / event.listen
  dialogs.js              open/save → SDK pickFromHostTree（绝不弹 OS picker）
  sdk-shims/              importmap 用的两个本地 ESM 桩
scripts/                   构建、打包、校验、上游/SDK 快照一致性检查
dist/                      构建产物（upstream UI 原样 + 注入桥 + SDK）
lib/                       六平台动态库（CI 生成，本地不提交）
docs/
  host-file-picker.md     PANEL 打开 OS 选择器「闪一下就消失且再也打不开」的根因
  drag-and-drop.md        宿主是否支持插件拖拽，以及正确监听方式
  file-associations.md    宿主文件关联的声明、绑定与冷启动投递链路
```

**上游 `ui/` 快照不改，构建补丁最小化**：`ui/` 原样进 dist，唯一差异是 `main.js` 的 `__ztState` 状态出口锚点（TABS 用）；它只依赖 `window.__TAURI__` 的三个入口，桥接层把它们分别映射到：

| 上游入口 | OTools 侧 |
| --- | --- |
| `T.core.invoke(cmd, args)` | `window.otools.invokeNative(cmd, args)` → 插件 cdylib |
| `T.dialog.open/save` | `otools-plugin-sdk` 的 `pickFromHostTree` 页面内 DOM 树 |
| `T.event.listen("ziplark://progress")` | `window.otools.listenNative`（宿主轮询 dylib 的 `poll_events`） |
| `T.event.listen("tauri://drag-*")` | SDK `listenTauri` + `{kind:'Webview', label}` target |
| `T.event.listen("ziplark-open-file")` | SDK `onOtoolsOpenFile`（宿主文件关联队列）+ dylib `push_open_file` |

## 两个宿主问题的结论

**1. PANEL 打开 OS 文件选择器闪一下就消失、之后再打不开**
不是权限也不是缓存。`blocking_pick_*` 把 sheet 挂到「非激活 NSPanel + Accessory 应用」上，
面板的失焦自动隐藏把 sheet 父窗口关掉，picker 立即 dismiss；而 `Panel::run_modal()` 在
`beginSheetModalForWindow` 之后还无条件 `runModal()`，双重模态在父窗口被隐藏后留下不一致状态，
后续调用在同一组条件下继续秒退。**注意**：旧结论里「rfd 复位 activation policy 打乱 AppKit
模态状态」不严谨，已在文档中更正（rfd 对已是 Accessory 的应用不做任何策略提升）。
详见 [docs/host-file-picker.md](docs/host-file-picker.md)。
**本插件完全不弹 OS picker**，所有选择走 SDK 的页面内文件树（不依赖宿主版本、Web 模式也能用）。
宿主侧已修复：PANEL 在原生对话框会话期间 hold 不隐藏（根本修复），并把三个
`tools_webview_pick_*` 改为保留 parent 的非阻塞 **async sheet**（只 `beginSheet`、不 `runModal`）；
「去掉 parent 绕开 sheet」的方案已撤回。详见 [docs/host-file-picker.md](docs/host-file-picker.md)。

**2. 宿主是否支持插件拖拽**
支持，但不是 HTML5 `dataTransfer.files`。wry 默认拦截 OS 原生 drop（所以 `File` 对象拿不到），
Tauri 会把 `tauri://drag-drop` 重发给子 webview 并带上**真实磁盘路径**；关键是要用
`{kind:'Webview', label}` 注册监听，SDK 默认的 `Any` target 会被 `emit_to_webview` 的 filter 过滤掉。
页面内 HTML5 拖拽不受影响。详见 [docs/drag-and-drop.md](docs/drag-and-drop.md)。
上游 Ziplark 原本就监听 `tauri://drag-*`，所以拖入归档即打开、拖入文件到 Create 列表都保留。

**3. 宿主文件关联**
`plugin.json` 的 `fileAssociations` 声明了 47 个归档后缀，宿主会把它们列进
「设置 → 文件关联」供绑定（声明本身不会抢占默认打开方式）。绑定后 OS 双击归档的路径经
宿主的 `otools-open-file` 敲门 + `otools_consume_open_files` 队列投递到插件；桥再写入原生层的
`push_open_file`，同时走事件通道与启动时 `take_pending_file()` 兜底，并去重避免重复打开。
详见 [docs/file-associations.md](docs/file-associations.md)。

## 本地构建

需要 Node ≥ 20 与 Rust（stable）。

```bash
# 前端（纯 Node，无 npm 依赖）
npm run build:web            # 生成 dist/

# 原生库（当前平台）
npm run build:native         # cargo build --release → lib/macOS.dylib 等

# 打成 .oplg（每平台一个包）
node scripts/pack-plugin.mjs --platform macos --arch arm64
node scripts/verify-plugin.mjs dist-pack

# 回归测试与上游快照校验
npm test
npm run sync:upstream:check
```

本机验证安装：`rsync -a --delete dist/ ~/.otools/plugins/otools-ziplark/dist/`，
把 `lib/macOS.dylib` 放到 `~/.otools/plugins/otools-ziplark/lib/`，重启宿主。
诊断日志看 `~/.otools/log/core/webview.log` 里的 `[ziplark]` 行。

## 格式支持

读 / 列 / 预览 / 校验 / 解压：ZIP（含 ZipCrypto / AES-256、多卷）、RAR / RAR5（多卷、
加密头、SFX、损坏抢救）、7z、tar 及 tar.gz/bz2/xz/zst/lz4、单流 gz/bz2/xz/zst/lz4、
ISO 9660、DEB/AR、RPM/CPIO、PKG/XAR、CAB。
创建 / 追加 / 改名 / 删除：ZIP、7z、tar 及压缩 tar（含 AES-256 与 `--split` 分卷）。
另有归档 diff、grep、哈希、转换、嵌套归档钻取、zip-slip 路径守卫。

> RAR 解压依赖官方 UnRAR 库，**不是 MIT**，且不得用于重建 RAR 压缩算法。见
> `THIRD_PARTY_NOTICES.md`。

## 发布

- `build-plugin.yml`（push main / PR / dispatch）：六平台 matrix 编译并跑 `cargo test`，
  前端 overlay 回归测试 + 快照校验，最后合并成六个 `.oplg` 并逐个独立校验。
- `release-plugin.yml`（push tag `v*`）：复用上面的构建，校验 tag 与 `plugin.json.version`
  一致后创建 GitHub Release，附上六平台 `.oplg`、SHA256SUMS、manifest 与 logo。
  `workflow_dispatch` 默认 `dry_run=true`，只构建验证、不发 Release。

**tag 必须等于 `v` + `plugin.json.version`**，否则 Release job 会直接失败。
当前版本只产出 GitHub Release 产物，尚未接入插件市场自动上架；需要上架时手动上传 `.oplg`。

## 许可

MIT（上游 Copyright © 2026 doaipm），第三方组件各自保留原许可，见 `NOTICE` 与
`THIRD_PARTY_NOTICES.md`。这是非官方移植，与上游作者无关联。
