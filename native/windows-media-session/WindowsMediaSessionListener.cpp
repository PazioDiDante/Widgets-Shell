#include <windows.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <cwctype>
#include <iostream>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

using namespace winrt;
using namespace Windows::Media::Control;

namespace {

void ExitWhenParentStops(DWORD parentProcessId) {
  if (parentProcessId == 0 || parentProcessId == GetCurrentProcessId()) {
    return;
  }

  HANDLE parentProcess = OpenProcess(SYNCHRONIZE, FALSE, parentProcessId);
  if (!parentProcess) {
    return;
  }

  const DWORD waitResult = WaitForSingleObject(parentProcess, INFINITE);
  CloseHandle(parentProcess);
  if (waitResult == WAIT_OBJECT_0) {
    ExitProcess(0);
  }
}

DWORD ReadParentProcessId(int argc, wchar_t* argv[]) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::wstring_view(argv[index]) != L"--parent-pid") {
      continue;
    }

    wchar_t* end = nullptr;
    const unsigned long value = std::wcstoul(argv[index + 1], &end, 10);
    if (end && *end == L'\0' && value <= MAXDWORD) {
      return static_cast<DWORD>(value);
    }
  }

  return 0;
}

bool HasArgument(int argc, wchar_t* argv[], std::wstring_view expected) {
  for (int index = 1; index < argc; ++index) {
    if (std::wstring_view(argv[index]) == expected) {
      return true;
    }
  }

  return false;
}

HWND ReadWindowHandleArgument(int argc, wchar_t* argv[], std::wstring_view expected) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::wstring_view(argv[index]) != expected) {
      continue;
    }

    wchar_t* end = nullptr;
    const unsigned long long value = std::wcstoull(argv[index + 1], &end, 10);
    if (end && *end == L'\0' && value != 0) {
      return reinterpret_cast<HWND>(static_cast<uintptr_t>(value));
    }
  }

  return nullptr;
}

std::string ToUtf8(hstring const& value) {
  if (value.empty()) {
    return {};
  }

  const int size = WideCharToMultiByte(
    CP_UTF8,
    0,
    value.c_str(),
    static_cast<int>(value.size()),
    nullptr,
    0,
    nullptr,
    nullptr
  );
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(
    CP_UTF8,
    0,
    value.c_str(),
    static_cast<int>(value.size()),
    result.data(),
    size,
    nullptr,
    nullptr
  );
  return result;
}

std::string EscapeJson(std::string const& value) {
  std::string result;
  result.reserve(value.size() + 8);

  for (const unsigned char character : value) {
    switch (character) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (character < 0x20) {
          const char hex[] = "0123456789abcdef";
          result += "\\u00";
          result += hex[(character >> 4) & 0x0f];
          result += hex[character & 0x0f];
        } else {
          result += static_cast<char>(character);
        }
    }
  }

  return result;
}

WORD MediaVirtualKey(std::string const& command) {
  if (command == "previous") {
    return VK_MEDIA_PREV_TRACK;
  }
  if (command == "play-pause") {
    return VK_MEDIA_PLAY_PAUSE;
  }
  if (command == "next") {
    return VK_MEDIA_NEXT_TRACK;
  }
  return 0;
}

void ReadMediaCommands(bool testMode = false) {
  std::string command;
  while (std::getline(std::cin, command)) {
    if (!command.empty() && command.back() == '\r') {
      command.pop_back();
    }

    const WORD virtualKey = MediaVirtualKey(command);
    if (virtualKey == 0) {
      continue;
    }

    if (testMode) {
      std::cout
        << "{\"type\":\"media-key-test\",\"command\":\""
        << EscapeJson(command)
        << "\"}\n"
        << std::flush;
      continue;
    }

    INPUT inputs[2]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = virtualKey;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = virtualKey;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, inputs, sizeof(INPUT));
  }
}

HWND desktopTargetWindow = nullptr;
HHOOK desktopMouseHook = nullptr;
DWORD desktopHookThreadId = 0;

bool IsDesktopPoint(POINT point) {
  const HWND hitWindow = WindowFromPoint(point);
  if (hitWindow == desktopTargetWindow) {
    return true;
  }

  const HWND rootWindow = GetAncestor(hitWindow, GA_ROOT);
  wchar_t className[128]{};
  GetClassNameW(rootWindow ? rootWindow : hitWindow, className, 128);
  const std::wstring_view value(className);
  return value == L"Progman" || value == L"WorkerW";
}

LRESULT CALLBACK HandleDesktopMouse(int code, WPARAM message, LPARAM data) {
  if (
    code >= 0
    && (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP)
    && IsWindowVisible(desktopTargetWindow)
  ) {
    const auto* mouse = reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    RECT bounds{};
    if (
      mouse
      && GetWindowRect(desktopTargetWindow, &bounds)
      && mouse->pt.x >= bounds.left
      && mouse->pt.x < bounds.right
      && mouse->pt.y >= bounds.top
      && mouse->pt.y < bounds.bottom
      && IsDesktopPoint(mouse->pt)
    ) {
      if (message == WM_RBUTTONUP) {
        std::cout << "DESKTOP_WIDGET_CONTEXT\n" << std::flush;
      }
      return 1;
    }
  }

  return CallNextHookEx(desktopMouseHook, code, message, data);
}

void CALLBACK CheckDesktopTarget(HWND, UINT, UINT_PTR, DWORD) {
  if (!IsWindow(desktopTargetWindow)) {
    PostThreadMessageW(desktopHookThreadId, WM_QUIT, 0, 0);
  }
}

int RunDesktopWidgetHook(HWND targetWindow) {
  if (!targetWindow || !IsWindow(targetWindow)) {
    std::cerr << "Desktop widget target window is unavailable.\n" << std::flush;
    return 2;
  }

  desktopTargetWindow = targetWindow;
  desktopHookThreadId = GetCurrentThreadId();
  desktopMouseHook = SetWindowsHookExW(
    WH_MOUSE_LL,
    HandleDesktopMouse,
    GetModuleHandleW(nullptr),
    0
  );
  if (!desktopMouseHook) {
    std::cerr << "Unable to install the desktop widget mouse hook.\n" << std::flush;
    return 3;
  }

  const UINT_PTR watchdogTimer = SetTimer(nullptr, 0, 500, CheckDesktopTarget);
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (watchdogTimer) {
    KillTimer(nullptr, watchdogTimer);
  }
  UnhookWindowsHookEx(desktopMouseHook);
  desktopMouseHook = nullptr;
  desktopTargetWindow = nullptr;
  return 0;
}

int MoveWindowToBottom(HWND window) {
  if (!window || !IsWindow(window)) {
    return 2;
  }

  return SetWindowPos(
    window,
    HWND_BOTTOM,
    0,
    0,
    0,
    0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
  ) ? 0 : 3;
}

int RunDesktopIntegrationTest() {
  const HWND window = CreateWindowExW(
    0,
    L"STATIC",
    L"Widgets helper test",
    WS_POPUP,
    0,
    0,
    32,
    32,
    nullptr,
    nullptr,
    GetModuleHandleW(nullptr),
    nullptr
  );
  if (!window) {
    return 4;
  }

  const int moveResult = MoveWindowToBottom(window);
  if (moveResult != 0) {
    DestroyWindow(window);
    return moveResult;
  }

  std::thread([window]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    PostMessageW(window, WM_CLOSE, 0, 0);
  }).detach();
  return RunDesktopWidgetHook(window);
}

std::string PlaybackStatusName(GlobalSystemMediaTransportControlsSessionPlaybackStatus status) {
  switch (status) {
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed: return "Closed";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened: return "Opened";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing: return "Changing";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped: return "Stopped";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing: return "Playing";
    case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused: return "Paused";
    default: return "Unknown";
  }
}

int64_t ToMilliseconds(Windows::Foundation::TimeSpan value) {
  return std::max<int64_t>(
    0,
    std::chrono::duration_cast<std::chrono::milliseconds>(value).count()
  );
}

bool IsSpotifySession(GlobalSystemMediaTransportControlsSession const& session) {
  std::wstring source = session.SourceAppUserModelId().c_str();
  std::transform(source.begin(), source.end(), source.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return source.find(L"spotify") != std::wstring::npos;
}

class SpotifySessionListener {
 public:
  void Run() {
    manager_ = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
    sessionsChangedToken_ = manager_.SessionsChanged([this](auto const&, auto const&) {
      AttachSpotifySession();
    });
    AttachSpotifySession();

    while (true) {
      std::this_thread::sleep_for(std::chrono::hours(24));
    }
  }

 private:
  void AttachSpotifySession() {
    std::scoped_lock lock(sessionMutex_);
    DetachSpotifySession();

    for (auto const& candidate : manager_.GetSessions()) {
      if (IsSpotifySession(candidate)) {
        session_ = candidate;
        break;
      }
    }

    if (!session_) {
      WriteLine("{\"type\":\"ready\",\"sessionFound\":false,\"sourceAppId\":\"\"}");
      return;
    }

    playbackChangedToken_ = session_.PlaybackInfoChanged([this](auto const& sender, auto const&) {
      EmitPlayback(sender);
    });
    mediaChangedToken_ = session_.MediaPropertiesChanged([this](auto const& sender, auto const&) {
      WriteLine(
        "{\"type\":\"media-properties-changed\",\"sourceAppId\":\""
        + EscapeJson(ToUtf8(sender.SourceAppUserModelId()))
        + "\"}"
      );
    });

    const std::string source = EscapeJson(ToUtf8(session_.SourceAppUserModelId()));
    WriteLine(
      "{\"type\":\"ready\",\"sessionFound\":true,\"sourceAppId\":\""
      + source
      + "\"}"
    );
    EmitPlayback(session_);
  }

  void DetachSpotifySession() {
    if (!session_) {
      return;
    }

    try {
      session_.PlaybackInfoChanged(playbackChangedToken_);
    } catch (...) {
    }
    try {
      session_.MediaPropertiesChanged(mediaChangedToken_);
    } catch (...) {
    }
    session_ = nullptr;
  }

  void EmitPlayback(GlobalSystemMediaTransportControlsSession const& session) {
    try {
      const auto info = session.GetPlaybackInfo();
      const auto timeline = session.GetTimelineProperties();
      const std::string playbackStatus = PlaybackStatusName(info.PlaybackStatus());
      const bool isPlaying = info.PlaybackStatus()
        == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
      WriteLine(
        "{\"type\":\"playback\",\"sourceAppId\":\""
        + EscapeJson(ToUtf8(session.SourceAppUserModelId()))
        + "\",\"playbackStatus\":\""
        + playbackStatus
        + "\",\"isPlaying\":"
        + (isPlaying ? "true" : "false")
        + ",\"positionMs\":"
        + std::to_string(ToMilliseconds(timeline.Position()))
        + ",\"endTimeMs\":"
        + std::to_string(ToMilliseconds(timeline.EndTime()))
        + "}"
      );
    } catch (...) {
    }
  }

  void WriteLine(std::string const& line) {
    std::scoped_lock lock(outputMutex_);
    std::cout << line << '\n' << std::flush;
  }

  GlobalSystemMediaTransportControlsSessionManager manager_{ nullptr };
  GlobalSystemMediaTransportControlsSession session_{ nullptr };
  event_token sessionsChangedToken_{};
  event_token playbackChangedToken_{};
  event_token mediaChangedToken_{};
  std::mutex sessionMutex_;
  std::mutex outputMutex_;
};

void WriteUnavailable(std::string const& message) {
  std::cout
    << "{\"type\":\"unavailable\",\"message\":\""
    << EscapeJson(message)
    << "\"}\n"
    << std::flush;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  SetConsoleOutputCP(CP_UTF8);

  const DWORD parentProcessId = ReadParentProcessId(argc, argv);
  if (parentProcessId != 0) {
    std::thread(ExitWhenParentStops, parentProcessId).detach();
  }

  if (HasArgument(argc, argv, L"--watch-parent-only")) {
    while (true) {
      std::this_thread::sleep_for(std::chrono::hours(24));
    }
  }

  if (HasArgument(argc, argv, L"--command-channel-test")) {
    ReadMediaCommands(true);
    return 0;
  }

  if (HasArgument(argc, argv, L"--desktop-integration-test")) {
    return RunDesktopIntegrationTest();
  }

  if (const HWND targetWindow = ReadWindowHandleArgument(argc, argv, L"--desktop-widget-hook")) {
    return RunDesktopWidgetHook(targetWindow);
  }

  if (const HWND targetWindow = ReadWindowHandleArgument(argc, argv, L"--move-window-bottom")) {
    return MoveWindowToBottom(targetWindow);
  }

  std::thread(ReadMediaCommands, false).detach();

  try {
    init_apartment(apartment_type::multi_threaded);
    SpotifySessionListener listener;
    listener.Run();
  } catch (hresult_error const& error) {
    WriteUnavailable(ToUtf8(error.message()));
    return 1;
  } catch (std::exception const& error) {
    WriteUnavailable(error.what());
    return 1;
  } catch (...) {
    WriteUnavailable("Unknown Windows media session error.");
    return 1;
  }
}
