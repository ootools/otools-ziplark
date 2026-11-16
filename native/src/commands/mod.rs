//! method 分派表。每个命令返回响应里的 `data`，由 `lib.rs` 统一包成
//! `{ok:true,data:...}` 或 `{ok:false,error:"..."}`。

mod archive;
mod platform;

use serde_json::Value;

pub fn dispatch(method: &str, payload: Value) -> Result<Value, String> {
    match method {
        // 归档操作
        "detect_format" => archive::detect_format(&payload),
        "list_archive" => archive::list_archive(&payload),
        "test_archive" => archive::test_archive(&payload),
        "preview_archive_entry" => archive::preview_archive_entry(&payload),
        "extract_archive" => archive::extract_archive(&payload),
        "extract_archive_here" => archive::extract_archive_here(&payload),
        "create_archive" => archive::create_archive(&payload),
        "add_to_archive" => archive::add_to_archive(&payload),
        "remove_from_archive" => archive::remove_from_archive(&payload),
        "rename_in_archive" => archive::rename_in_archive(&payload),
        "diff_archives" => archive::diff_archives(&payload),
        "hash_archive" => archive::hash_archive(&payload),
        "convert_archive" => archive::convert_archive(&payload),
        "grep_archive" => archive::grep_archive(&payload),
        "extract_nested_archive" => archive::extract_nested_archive(&payload),

        // 状态 / 事件
        "cancel_operation" => platform::cancel_operation(),
        "take_pending_file" => platform::take_pending_file(),
        "poll_events" => platform::poll_events(),
        "push_open_file" => platform::push_open_file(&payload),

        // 应用 / 平台
        "app_version" => platform::app_version(),
        "app_is_sandboxed" => platform::app_is_sandboxed(),
        "open_url" => platform::open_url(&payload),
        "reveal_in_file_manager" => platform::reveal_in_file_manager(&payload),
        "shell_integration_status" => platform::shell_integration_status(),
        "shell_integration_install" => platform::shell_integration_install(),
        "shell_integration_uninstall" => platform::shell_integration_uninstall(),
        "selftest_action" => platform::selftest_action(),
        "selftest_log" => platform::selftest_log(),

        _ => Err(format!("Unknown method: {}", method)),
    }
}
