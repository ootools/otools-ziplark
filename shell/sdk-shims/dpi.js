/* Minimal local stand-in for @tauri-apps/api/dpi.
   The vendored SDK only constructs these value objects; no real DPI calls are
   made from Ziplark. Kept local so the SDK ESM can load with an import map. */

export class LogicalPosition {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; this.type = 'Logical'; }
}
export class LogicalSize {
  constructor(width = 0, height = 0) { this.width = width; this.height = height; this.type = 'Logical'; }
}
export class PhysicalPosition {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; this.type = 'Physical'; }
  toLogical(scaleFactor) { return new LogicalPosition(this.x / scaleFactor, this.y / scaleFactor); }
}
export class PhysicalSize {
  constructor(width = 0, height = 0) { this.width = width; this.height = height; this.type = 'Physical'; }
  toLogical(scaleFactor) { return new LogicalSize(this.width / scaleFactor, this.height / scaleFactor); }
}
export class Position {
  constructor(value) {
    this.type = (value && value.type) || 'Logical';
    if (this.type === 'Physical') {
      this.x = value.x; this.y = value.y;
    } else {
      this.x = value && value.x; this.y = value && value.y;
    }
  }
}
export class Size {
  constructor(value) {
    this.type = (value && value.type) || 'Logical';
    this.width = value && value.width; this.height = value && value.height;
  }
}
