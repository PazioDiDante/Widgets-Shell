@echo off
setlocal
where cl.exe >nul 2>nul
if errorlevel 1 (
  echo Open an x64 Native Tools Command Prompt for Visual Studio with the C++ workload installed.
  exit /b 1
)

cl.exe /nologo /std:c++20 /EHsc /O2 /W4 /DUNICODE /D_UNICODE ^
  native\windows-media-session\WindowsMediaSessionListener.cpp ^
  /Fo:"%TEMP%\widgets-windows-media-session.obj" ^
  /Fe:native\windows-media-session\windows-media-session-v3.exe ^
  /link windowsapp.lib user32.lib
