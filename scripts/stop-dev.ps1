# Stops ONLY the Node processes that belong to this repository (dev servers, watchers, test runners).
# It never touches other Node processes on the machine. Usage: npm run stop
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.ToLower()
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and (
    $_.CommandLine.ToLower().Contains($root) -or $_.CommandLine.ToLower().Contains("@homerelay/"))
}
if (-not $procs) { Write-Host "No HomeRelay processes found."; exit 0 }
foreach ($p in $procs) {
  $short = $p.CommandLine; if ($short.Length -gt 90) { $short = $short.Substring(0, 90) + "..." }
  Write-Host ("Stopping PID {0}: {1}" -f $p.ProcessId, $short)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
