# hum.ps1: the same metrics as hum.exe, for Windows machines where Smart App
# Control blocks unsigned binaries. Windows PowerShell 5.1, no modules.
param(
  [Parameter(Mandatory)][string]$Endpoint,
  [Parameter(Mandatory)][string]$TokenFile,
  [string]$HostName = $env:COMPUTERNAME.ToLower(),
  [int]$IntervalSeconds = 15,
  [switch]$Once
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$version = "0.2.0-ps"
$token = (Get-Content -Raw $TokenFile).Trim()
$log = Join-Path (Split-Path $TokenFile) "hum.log"

function Str($k, $v) { @{ key = $k; value = @{ stringValue = "$v" } } }
function Nanos($t) { "$(([DateTimeOffset]$t).ToUnixTimeMilliseconds())000000" }

function Snapshot {
  $now = Nanos (Get-Date)
  $os = Get-CimInstance Win32_OperatingSystem
  $boot = Nanos $os.LastBootUpTime
  $metrics = New-Object System.Collections.ArrayList
  $hostAttr = Str "host.name" $HostName

  function Gauge($name, $unit, $v, $extra) {
    $attrs = @($hostAttr) + @($extra | Where-Object { $_ })
    [void]$metrics.Add(@{ name = $name; unit = $unit; gauge = @{ dataPoints = @(
      @{ timeUnixNano = $now; asDouble = [double]$v; attributes = $attrs }) } })
  }
  function Counter($name, $unit, $v, $extra) {
    [void]$metrics.Add(@{ name = $name; unit = $unit; sum = @{
      aggregationTemporality = 2; isMonotonic = $true; dataPoints = @(
        @{ startTimeUnixNano = $boot; timeUnixNano = $now; asInt = "$([uint64]$v)"; attributes = @($hostAttr, $extra) }) } })
  }

  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  Gauge "system.cpu.utilization" "1" ($cpu / 100) $null
  Gauge "system.cpu.logical.count" "{cpu}" ([Environment]::ProcessorCount) $null

  $total = [double]$os.TotalVisibleMemorySize * 1024
  $used = $total - [double]$os.FreePhysicalMemory * 1024
  Gauge "system.memory.limit" "By" $total $null
  Gauge "system.memory.usage" "By" $used (Str "system.memory.state" "used")
  Gauge "system.memory.utilization" "1" ($used / $total) $null

  foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3") {
    if (-not $d.Size) { continue }
    $mp = Str "system.filesystem.mountpoint" $d.DeviceID
    Gauge "system.filesystem.limit" "By" $d.Size $mp
    Gauge "system.filesystem.utilization" "1" (1 - $d.FreeSpace / $d.Size) $mp
  }

  $rx = 0; $tx = 0
  foreach ($n in Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface) {
    $rx += $n.BytesReceivedPersec; $tx += $n.BytesSentPersec
  }
  Counter "system.network.io" "By" $rx (Str "network.io.direction" "receive")
  Counter "system.network.io" "By" $tx (Str "network.io.direction" "transmit")

  Gauge "system.uptime" "s" ([int]((Get-Date) - $os.LastBootUpTime).TotalSeconds) $null

  # GPU load the way Task Manager counts it: per engine type, the sum over
  # engines, then the busiest type. Works for any vendor's WDDM driver.
  $engines = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
  if ($engines) {
    $byType = @{}
    foreach ($e in $engines) {
      if ($e.Name -match "engtype_(.+)$") { $byType[$Matches[1]] += [double]$e.UtilizationPercentage }
    }
    $busiest = ($byType.Values | Measure-Object -Maximum).Maximum
    $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue |
      Measure-Object -Property DedicatedUsage, SharedUsage -Sum
    $name = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
    $at = @((Str "hw.id" "gpu0"), (Str "hw.name" $name), (Str "hw.vendor" "windows"))
    Gauge "hw.gpu.utilization" "1" ([Math]::Min(100, $busiest) / 100) $at
    Gauge "hw.gpu.memory.usage" "By" (($mem | Measure-Object -Property Sum -Sum).Sum) $at
  }

  @{ resourceMetrics = @(@{
    resource = @{ attributes = @(
      (Str "service.name" "hum"), (Str "service.version" $version), $hostAttr,
      (Str "host.arch" "amd64"), (Str "os.type" "windows")) }
    scopeMetrics = @(@{ scope = @{ name = "hum"; version = $version }; metrics = @($metrics) })
  }) }
}

if ($Once) { Snapshot | ConvertTo-Json -Depth 12; return }

"$(Get-Date -Format s) hum $version reporting $HostName to $Endpoint every ${IntervalSeconds}s" | Add-Content $log
$failing = $false
while ($true) {
  try {
    $body = Snapshot | ConvertTo-Json -Depth 12 -Compress
    Invoke-RestMethod -Method Post -Uri $Endpoint -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
      -ContentType "application/json" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 10 | Out-Null
    if ($failing) { "$(Get-Date -Format s) export recovered" | Add-Content $log; $failing = $false }
  } catch {
    if (-not $failing) { "$(Get-Date -Format s) export failing: $($_.Exception.Message)" | Add-Content $log; $failing = $true }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
