use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct TrackingAllocator;
static POINTER: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_SIZE: AtomicUsize = AtomicUsize::new(0);
static FREED_SIZE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        System.alloc(layout)
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = System.realloc(pointer, layout, size);
        if POINTER.load(Ordering::SeqCst) == pointer as usize && !result.is_null() {
            POINTER.store(result as usize, Ordering::SeqCst);
            ALLOCATED_SIZE.store(size, Ordering::SeqCst);
        }
        result
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if POINTER.load(Ordering::SeqCst) == pointer as usize {
            FREED_SIZE.store(layout.size(), Ordering::SeqCst);
        }
        System.dealloc(pointer, layout);
    }
}

#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

#[test]
fn response_free_uses_the_actual_allocation_layout_for_spare_capacity() {
    let mut output = Vec::with_capacity(8192);
    output.extend_from_slice(b"{}");
    POINTER.store(output.as_ptr() as usize, Ordering::SeqCst);
    ALLOCATED_SIZE.store(output.capacity(), Ordering::SeqCst);
    let mut length = 0;
    let response = ot_plugin_ffi::take_json_response(output, &mut length);
    assert_eq!(length, 2);
    ot_plugin_ffi::free_response(response, length);
    assert_eq!(
        FREED_SIZE.load(Ordering::SeqCst),
        ALLOCATED_SIZE.load(Ordering::SeqCst),
        "response allocation/free must agree even when serialization Vec had spare capacity"
    );
}
