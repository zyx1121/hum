# Installs hum on Windows. Run as Administrator next to hum.exe, hum.ps1 and a
# file named token:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Endpoint <url> [-HostName <name>]
# hum.exe runs as a service. Where Smart App Control is on it blocks unsigned
# binaries, so hum.ps1 runs as a SYSTEM startup task instead.
param(
  [Parameter(Mandatory)][string]$Endpoint,
  [string]$HostName = ""
)
$ErrorActionPreference = "Stop"
$bin = "$env:ProgramFiles\hum"
$data = "$env:ProgramData\hum"
New-Item -ItemType Directory -Force $bin, $data | Out-Null

# Remove any previous install, either flavour.
if (Get-Service hum -ErrorAction SilentlyContinue) {
  Stop-Service hum -Force -ErrorAction SilentlyContinue
  sc.exe delete hum | Out-Null
  Start-Sleep 2
}
if (Get-ScheduledTask hum -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask hum -ErrorAction SilentlyContinue
  Unregister-ScheduledTask hum -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like "*\hum\hum.ps1*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Move-Item -Force "$PSScriptRoot\token" "$data\token"
# Only SYSTEM and Administrators may read the token.
icacls $data /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
icacls "$data\token" /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null

$sac = (Get-MpComputerStatus -ErrorAction SilentlyContinue).SmartAppControlState
if ($sac -eq "On") {
  Copy-Item -Force "$PSScriptRoot\hum.ps1" "$bin\hum.ps1"
  $argline = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bin\hum.ps1`" -Endpoint $Endpoint -TokenFile `"$data\token`""
  if ($HostName) { $argline += " -HostName $HostName" }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argline
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "S-1-5-18" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask hum -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Reports host metrics over OTLP" | Out-Null
  Start-ScheduledTask hum
  "hum.ps1 installed as startup task (Smart App Control is on)"
} else {
  Copy-Item -Force "$PSScriptRoot\hum.exe" "$bin\hum.exe"
  $argline = "-endpoint $Endpoint -token-file `"$data\token`""
  if ($HostName) { $argline += " -host $HostName" }
  New-Service -Name hum -DisplayName "hum" -Description "Reports host metrics over OTLP" `
    -BinaryPathName "`"$bin\hum.exe`" $argline" -StartupType Automatic | Out-Null
  sc.exe failure hum reset= 86400 actions= restart/30000/restart/30000/restart/30000 | Out-Null
  Start-Service hum
  "hum.exe installed as service"
}
