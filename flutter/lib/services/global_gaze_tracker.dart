import 'dart:async';
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';
import 'package:win32/win32.dart';

import 'character_behavior_service.dart';

/// 全局视线跟踪器（Windows）：
/// 即使鼠标不在宠物窗口内，也持续获取屏幕鼠标位置，
/// 换算成相对窗口客户区的归一化坐标并更新宠物视线，实现"无论鼠标在哪都看鼠标"。
///
/// 性能优化：
/// - 20Hz 轮询（50ms），Native 侧会自行平滑插值；
/// - FFI 结构体内存复用，不在热路径上反复 malloc/free；
/// - 鼠标位置与窗口矩形均未变化，或视线目标变化极小时，跳过 Native 调用。
class GlobalGazeTracker {
  GlobalGazeTracker(this._behavior);

  final CharacterBehaviorService _behavior;

  Timer? _timer;
  bool _running = false;

  /// 窗口句柄（FLUTTER_RUNNER_WIN32_WINDOW 类名唯一标识本进程窗口）。
  HWND? _hwnd;

  // 复用 Native 内存，避免热路径分配。
  Pointer<POINT>? _cursor;
  Pointer<RECT>? _rect;
  Pointer<POINT>? _origin;

  int _lastMouseX = -2147483648;
  int _lastMouseY = -2147483648;
  int _lastClientL = -2147483648;
  int _lastClientT = -2147483648;
  int _lastClientR = -2147483648;
  int _lastClientB = -2147483648;
  int _lastOriginX = -2147483648;
  int _lastOriginY = -2147483648;
  double _lastNormX = -1;
  double _lastNormY = -1;
  bool _hasLast = false;

  /// 开始全局轮询（Windows 平台有效；其他平台 no-op）。
  void start() {
    if (!Platform.isWindows || _running) return;
    _running = true;
    _findWindow();
    _timer = Timer.periodic(const Duration(milliseconds: 50), (_) => _poll());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _running = false;
  }

  void _ensureBuffers() {
    _cursor ??= calloc.allocate<POINT>(sizeOf<POINT>());
    _rect ??= calloc.allocate<RECT>(sizeOf<RECT>());
    _origin ??= calloc.allocate<POINT>(sizeOf<POINT>());
  }

  /// 通过类名查找本应用的窗口句柄。
  void _findWindow() {
    try {
      final className = 'FLUTTER_RUNNER_WIN32_WINDOW'.toNativeUtf16();
      try {
        final result = FindWindow(PCWSTR(className), null);
        if (result.value.address != 0) _hwnd = result.value;
      } finally {
        calloc.free(className);
      }
    } catch (_) {
      _hwnd = null;
    }
  }

  /// 轮询：仅在鼠标/窗口/视线目标真正变化时调用 Native 更新。
  void _poll() {
    try {
      var hwnd = _hwnd;
      if (hwnd == null || hwnd.address == 0) {
        _findWindow();
        hwnd = _hwnd;
        if (hwnd == null || hwnd.address == 0) return;
      }

      _ensureBuffers();
      final cursor = _cursor!;
      final rect = _rect!;
      final origin = _origin!;

      if (!GetCursorPos(cursor).value) return;
      final mouseX = cursor.ref.x;
      final mouseY = cursor.ref.y;

      if (!GetClientRect(hwnd, rect).value) return;
      final clientL = rect.ref.left;
      final clientT = rect.ref.top;
      final clientW = rect.ref.right - rect.ref.left;
      final clientH = rect.ref.bottom - rect.ref.top;
      if (clientW <= 0 || clientH <= 0) return;

      origin.ref.x = 0;
      origin.ref.y = 0;
      if (!ClientToScreen(hwnd, origin)) return;
      final originX = origin.ref.x;
      final originY = origin.ref.y;

      final clientR = rect.ref.right;
      final clientB = rect.ref.bottom;

      // 鼠标、窗口矩形和窗口屏幕位置都没变：无需重新计算。
      if (_hasLast &&
          mouseX == _lastMouseX &&
          mouseY == _lastMouseY &&
          clientL == _lastClientL &&
          clientT == _lastClientT &&
          clientR == _lastClientR &&
          clientB == _lastClientB &&
          originX == _lastOriginX &&
          originY == _lastOriginY) {
        return;
      }

      final normX = (mouseX - originX) / clientW;
      final normY = (mouseY - originY) / clientH;

      // 变化小于阈值时跳过 Native 调用；Native 会保留上一个目标并平滑过渡。
      if (_hasLast &&
          (normX - _lastNormX).abs() < 0.004 &&
          (normY - _lastNormY).abs() < 0.004) {
        _lastMouseX = mouseX;
        _lastMouseY = mouseY;
        _lastClientL = clientL;
        _lastClientT = clientT;
        _lastClientR = clientR;
        _lastClientB = clientB;
        _lastOriginX = originX;
        _lastOriginY = originY;
        return;
      }

      _lastMouseX = mouseX;
      _lastMouseY = mouseY;
      _lastClientL = clientL;
      _lastClientT = clientT;
      _lastClientR = clientR;
      _lastClientB = clientB;
      _lastOriginX = originX;
      _lastOriginY = originY;
      _lastNormX = normX;
      _lastNormY = normY;
      _hasLast = true;

      _behavior.updateLookTarget(normX, normY);
    } catch (_) {
      // 轮询失败静默忽略
    }
  }

  void dispose() {
    stop();
    if (_cursor != null) {
      calloc.free(_cursor!);
      _cursor = null;
    }
    if (_rect != null) {
      calloc.free(_rect!);
      _rect = null;
    }
    if (_origin != null) {
      calloc.free(_origin!);
      _origin = null;
    }
  }
}
