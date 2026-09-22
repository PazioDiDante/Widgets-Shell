function wrapPowerShellWithParentWatchdog(script, parentPid = process.pid) {
  const normalizedParentPid = Number(parentPid);
  if (!Number.isSafeInteger(normalizedParentPid) || normalizedParentPid <= 0) {
    throw new Error(`Invalid PowerShell parent PID: ${parentPid}`);
  }

  return `
$widgetsParentProcessId = ${normalizedParentPid}
$widgetsParentProcess = Get-Process -Id $widgetsParentProcessId -ErrorAction SilentlyContinue
if (-not $widgetsParentProcess) {
  exit 0
}
$widgetsParentProcess.EnableRaisingEvents = $true
$widgetsParentExitSubscription = Register-ObjectEvent -InputObject $widgetsParentProcess -EventName Exited -Action { [Environment]::Exit(0) }

${script}
`;
}

module.exports = {
  wrapPowerShellWithParentWatchdog
};
