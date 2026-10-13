@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=%~dp0\..\node_modules"
)
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\@google\gemini-cli\bundle\gemini.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\..\@google\gemini-cli\bundle\gemini.js" %*
)
