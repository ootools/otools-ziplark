//! OTools 原生插件 cdylib：把上游 Ziplark 的 Tauri 命令层移植成
//! `{method, payload}` → `{ok, data|error}` 的 FFI 调用。
//!
//! 宿主把 `otools_plugin_invoke` 放进 `spawn_blocking`，所以这里同步阻塞执行
//! 即可；`ot-plugin-ffi` 负责 panic 捕获，防止引擎里的 panic 掀翻宿主进程。

mod commands;
mod helpers;
mod state;

use serde_json::{json, Value};

fn dispatch_json(method: &str, payload: Value) -> Value {
    match commands::dispatch(method, payload) {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn invoke_impl(input_ptr: *const u8, input_len: usize, output_len: *mut usize) -> *mut u8 {
    if input_ptr.is_null() || output_len.is_null() {
        return std::ptr::null_mut();
    }

    let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let parsed: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(error) => {
            let response = json!({ "ok": false, "error": format!("Invalid input: {}", error) });
            let encoded = serde_json::to_vec(&response)
                .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
            return ot_plugin_ffi::take_json_response(encoded, output_len);
        }
    };

    let (method, payload) = match parsed {
        Value::Object(map) => (
            map.get("method")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            map.get("payload").cloned().unwrap_or(Value::Null),
        ),
        _ => (String::new(), Value::Null),
    };

    let response = dispatch_json(&method, payload);
    let encoded = serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
    ot_plugin_ffi::take_json_response(encoded, output_len)
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    ot_plugin_ffi::guard_owned_invoke(
        env!("CARGO_PKG_NAME"),
        input_ptr,
        input_len,
        output_len,
        invoke_impl,
    )
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    ot_plugin_ffi::free_response(ptr, len)
}
