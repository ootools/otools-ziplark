//! 插件全局状态：取消标志、进度事件队列、待打开文件。
//!
//! 宿主把 `otools_plugin_invoke` 放进 `spawn_blocking`，长任务在插件里同步
//! 阻塞执行即可，不需要自己开线程。`cancel_operation` 置位取消标志，进度
//! 回调读到后返回 `false`，core 便以 `Error::Cancelled` 收尾。

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use ziplark_core::Progress;

pub const EVENT_PROGRESS: &str = "ziplark://progress";
pub const EVENT_OPEN_FILE: &str = "ziplark-open-file";

/// 引擎对一棵小文件树每秒可能上报上千次，webview 只需要"还活着"的节奏。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
/// 即使宿主长时间不轮询，也别让队列无限增长。
const MAX_QUEUED_EVENTS: usize = 512;

struct PluginState {
    cancel: AtomicBool,
    progress_events: Mutex<VecDeque<Value>>,
    pending_file: Mutex<Option<String>>,
}

static STATE: OnceLock<PluginState> = OnceLock::new();

fn state() -> &'static PluginState {
    STATE.get_or_init(|| PluginState {
        cancel: AtomicBool::new(false),
        progress_events: Mutex::new(VecDeque::new()),
        pending_file: Mutex::new(None),
    })
}

/// 每个长命令开始前清零取消标志（一次只跑一个归档操作）。
pub fn begin_operation() {
    state().cancel.store(false, Ordering::SeqCst);
}

/// `cancel_operation`：请求正在运行的命令停下。
pub fn request_cancel() {
    state().cancel.store(true, Ordering::SeqCst);
}

fn push_event(topic: &str, payload: Value) {
    if let Ok(mut queue) = state().progress_events.lock() {
        queue.push_back(json!({ "topic": topic, "payload": payload }));
        while queue.len() > MAX_QUEUED_EVENTS {
            queue.pop_front();
        }
    }
}

/// 构造一个进度回调：检查取消、限流，并把 `Progress` 转成 poll_events 事件。
pub fn progress_callback() -> impl FnMut(Progress) -> bool {
    let mut last_sent: Option<Instant> = None;
    move |p: Progress| {
        if state().cancel.load(Ordering::Relaxed) {
            return false;
        }
        let due = last_sent.map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL);
        if due {
            last_sent = Some(Instant::now());
            if let Ok(value) = serde_json::to_value(&p) {
                push_event(EVENT_PROGRESS, value);
            }
        }
        true
    }
}

/// `poll_events`：把队列 drain 出来交给宿主（宿主每 200ms 轮询一次）。
pub fn poll_events() -> Value {
    let events: Vec<Value> = state()
        .progress_events
        .lock()
        .map(|mut queue| queue.drain(..).collect())
        .unwrap_or_default();
    json!({ "events": events })
}

/// `push_open_file`：宿主侧文件关联打开时由前端桥调用。
pub fn push_open_file(path: String) {
    if let Ok(mut pending) = state().pending_file.lock() {
        *pending = Some(path.clone());
    }
    push_event(EVENT_OPEN_FILE, json!(path));
}

/// `take_pending_file`：取走并清空待打开文件路径。
pub fn take_pending_file() -> Value {
    let taken = state()
        .pending_file
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    json!(taken)
}
