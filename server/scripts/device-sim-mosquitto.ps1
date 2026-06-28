param(
    [string]$DeviceId = 'dev-001',
    [string]$BrokerHost = 'e3133611.ala.cn-hangzhou.emqxsl.cn',
    [int]$BrokerPort = 8883,
    [ValidateSet('mqtt', 'mqtts')]
    [string]$Protocol = 'mqtts',
    [string]$Username = 'Device',
    [string]$Password = 'mqtt',
    [string]$TopicPrefix = 'v1/devices',
    [string]$CaFile = 'D:\PERSONAL\Project\26_4\web\ride_helmet_web\server\emqxsl-ca.crt',
    [switch]$Insecure,
    [int]$Qos = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NowMs {
  $now = [DateTimeOffset]::UtcNow
  return [int64]$now.ToUnixTimeMilliseconds()
}

function New-CommandArgs {
    param([int]$MqttQos, [switch]$IncludeTopic)
    $args = @(
      '-h', $BrokerHost,
      '-p', [string]$BrokerPort,
      '-u', $Username,
      '-P', $Password,
      '-q', [string]$MqttQos
    )
    if ($Protocol -eq 'mqtts') {
      if ($CaFile) {
        if (Test-Path -Path $CaFile -PathType Leaf) {
          $args += '--cafile'
          $args += $CaFile
        } else {
          Write-Warning "未找到 CA 文件 $CaFile，自动切换为 --insecure（可按需改 CA 文件或使用 -Insecure）。"
          $args += '--insecure'
        }
      } elseif ($Insecure) {
        $args += '--insecure'
      } else {
        $args += '--insecure'
      }
    }
    return $args
}

function Publish-Mqtt {
    param(
      [string]$Suffix,
      [object]$Payload,
      [int]$MqttQos = $Qos
    )
    $payloadObj = if ($Payload -is [string]) { $Payload } else { $Payload | ConvertTo-Json -Compress -Depth 20 }
    $topic = "$TopicPrefix/$DeviceId/$Suffix"
    $args = New-CommandArgs -MqttQos $MqttQos
    $args += @('-t', $topic, '-m', $payloadObj)
    & $script:mosquittoPub @args
    if ($LASTEXITCODE -ne 0) {
      throw "mosquitto_pub failed with exit code $LASTEXITCODE"
    }
}

function New-TelemetryPayload {
    param([hashtable]$Extra = @{})
    $payload = @{
      deviceId = $DeviceId
      ts = Get-NowMs
      lng = $script:state.lng
      lat = $script:state.lat
      speed = $script:state.speed
      heading = $script:state.heading
      altitude = $script:state.altitude
      accuracy = $script:state.accuracy
      heart_rate = $script:state.heart_rate
      temperature = $script:state.temperature
      humidity = $script:state.humidity
      battery = $script:state.battery
      low_power = $script:state.low_power
      location_source = 'sim'
    }
    foreach ($key in $Extra.Keys) { $payload[$key] = $Extra[$key] }
    return $payload
}

function Send-StatusOrAck {
    param(
      [string]$CmdId,
      [string]$Action,
      [bool]$Ok = $true,
      [string]$Message = ''
    )
    $ts = Get-NowMs
    if ($Action -eq 'status') {
      $payload = @{
        deviceId = $DeviceId
        cmdId = $CmdId
        online = $Ok
        status = if ($Ok) { 'ok' } else { 'failed' }
        message = $Message
        battery = $script:state.battery
        low_power = $script:state.low_power
        ts = $ts
      }
      Publish-Mqtt -Suffix 'status' -Payload $payload -MqttQos 0
    } else {
      $payload = @{
        deviceId = $DeviceId
        cmdId = $CmdId
        ok = $Ok
        message = $Message
        battery = $script:state.battery
        low_power = $script:state.low_power
        ts = $ts
      }
      Publish-Mqtt -Suffix 'ack' -Payload $payload -MqttQos 0
    }
  Write-Host "已回包 -> $Action (cmdId=$CmdId, ok=$Ok)"
}

function Process-IncomingCommands {
  $incoming = Receive-Job -Job $listener -Keep -ErrorAction SilentlyContinue
  if (-not $incoming) { return $false }
  foreach ($line in $incoming) {
    $raw = [string]$line
    $idx = $raw.IndexOf(' ')
    if ($idx -lt 1) { continue }
    $topic = $raw.Substring(0, $idx)
    $payloadText = $raw.Substring($idx + 1)
    try {
      $payload = $payloadText | ConvertFrom-Json -ErrorAction Stop
      Handle-Command -Topic $topic -Payload $payload
    } catch {
      Write-Warning "无法解析命令 JSON: $payloadText"
    }
  }
  return $true
}

function Read-CharChoice {
  param([int]$TimeoutMs = 200)
  $endTime = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $endTime) {
    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($null -eq $key) { return $null }
      $ch = $key.KeyChar
      if ([string]::IsNullOrWhiteSpace($ch)) { return $null }
      Write-Host "选择: $ch"
      return $ch
    }
    Start-Sleep -Milliseconds 20
    Process-IncomingCommands | Out-Null
  }
  return $null
}

function Show-Menu {
  Write-Host '1) 发送 telemetry'
  Write-Host '2) 发送 telemetry(含碰撞字段)'
  Write-Host '3) 手动发送 events/collision'
  Write-Host '4) 手动发送 events/sos'
  Write-Host '5) 更新经纬度'
  Write-Host '6) 更新电量'
  Write-Host '7) 更新传感器(心率/温度/湿度/速度/方向)'
  Write-Host '8) 切换 low_power'
  Write-Host '9) 发送设备主动 status（无需 cmdId）'
  Write-Host 'q) 退出'
}

function Supports-KeyPolling {
  try {
    $null = [Console]::KeyAvailable
    return $true
  } catch {
    return $false
  }
}

function Get-Bool {
  param($Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [bool]) { return [bool]$Value }
  $str = [string]$Value
  switch ($str.ToLowerInvariant()) {
    '1' { return $true }
    'true' { return $true }
    'yes' { return $true }
    '0' { return $false }
    'false' { return $false }
    'no' { return $false }
    default { return [bool]$Value }
  }
}

function Resolve-LowPowerValue {
  param($PayloadValue)
  if ($null -eq $PayloadValue) { return $null }
  if ($PayloadValue -is [hashtable]) {
    if ($PayloadValue.ContainsKey('low_power')) { return Get-Bool $PayloadValue['low_power'] }
    if ($PayloadValue.ContainsKey('lowPower')) { return Get-Bool $PayloadValue['lowPower'] }
    if ($PayloadValue.ContainsKey('lowPowerMode')) { return Get-Bool $PayloadValue['lowPowerMode'] }
    return $null
  }
  if ($PayloadValue -is [pscustomobject]) {
    if ($null -ne $PayloadValue.PSObject.Properties['low_power']) { return Get-Bool $PayloadValue.low_power }
    if ($null -ne $PayloadValue.PSObject.Properties['lowPower']) { return Get-Bool $PayloadValue.lowPower }
    if ($null -ne $PayloadValue.PSObject.Properties['lowPowerMode']) { return Get-Bool $PayloadValue.lowPowerMode }
  }
  return $null
}

function Handle-Command {
  param([string]$Topic, [psobject]$Payload)

  if (-not $Topic -or $Topic -ne "$TopicPrefix/$DeviceId/cmd") { return }

  $cmdId = $Payload.cmdId
  if (-not $cmdId) {
    Write-Warning "收到命令但缺少 cmdId，已忽略: $($Payload | ConvertTo-Json -Compress -Depth 20)"
    return
  }

  $type = [string]$Payload.type
  $action = [string]$Payload.action
  Write-Host "收到命令: type=$type action=$action cmdId=$cmdId"

  switch ("$type/$action") {
    'request/status' {
      Send-StatusOrAck -CmdId $cmdId -Action 'ack' -Ok $true -Message 'request/status received'
      Start-Sleep -Milliseconds 200
      Publish-Mqtt -Suffix 'status' -Payload @{
        deviceId = $DeviceId
        cmdId = $cmdId
        online = $true
        status = 'ok'
        message = 'status ok'
        battery = $script:state.battery
        low_power = $script:state.low_power
        ts = Get-NowMs
      } -MqttQos 0
      Write-Host "已回包 -> status (cmdId=$cmdId, online=$true)"
    }
    'power/set' {
      $target = Resolve-LowPowerValue $Payload.value
      if ($null -ne $target) {
        $script:state.low_power = [bool]$target
      }
      Send-StatusOrAck -CmdId $cmdId -Action 'ack' -Ok $true -Message 'power set applied'
    }
    default {
      Send-StatusOrAck -CmdId $cmdId -Action 'ack' -Ok $false -Message "unsupported command: $type/$action"
    }
  }
}

function Read-IntNumber {
  param([string]$Prompt, [double]$DefaultValue)
  while ($true) {
    $input = Read-Host "$Prompt (current: $DefaultValue, empty keep)"
    if ([string]::IsNullOrWhiteSpace($input)) { return $DefaultValue }
    $num = 0.0
    if ([double]::TryParse($input, [ref]$num)) { return $num }
    Write-Host "请输入数字"
  }
}

function Read-BoolInput {
  param([string]$Prompt, [bool]$DefaultValue)
  while ($true) {
    $input = Read-Host "$Prompt (y/n, empty keep: $($DefaultValue.ToString().ToLower()))"
    if ([string]::IsNullOrWhiteSpace($input)) { return $DefaultValue }
    switch ($input.ToLowerInvariant()) {
      'y' { return $true }
      'yes' { return $true }
      'true' { return $true }
      'n' { return $false }
      'no' { return $false }
      'false' { return $false }
      default { Write-Host '请输入 y / n' }
    }
  }
}

function Send-CollisionEvent {
  param([string]$EventType)
  $level = Read-Host "事件等级 level (default high)"
  if ([string]::IsNullOrWhiteSpace($level)) { $level = 'high' }
  $score = Read-IntNumber '事件强度 score (number)' 3.8
  $message = Read-Host '事件描述 message (default collision detected)'
  if ([string]::IsNullOrWhiteSpace($message)) { $message = 'collision detected' }

  $payload = @{
    deviceId = $DeviceId
    ts = Get-NowMs
    level = $level
    score = [double]$score
    lng = $script:state.lng
    lat = $script:state.lat
    speed = $script:state.speed
    location_source = 'sim'
    message = $message
  }
  Publish-Mqtt -Suffix "events/$EventType" -Payload $payload -MqttQos 0
  Write-Host "已发送 $EventType 事件: level=$level score=$score"
}

$mosquittoSub = Get-Command mosquitto_sub -ErrorAction SilentlyContinue
if (-not $mosquittoSub) { throw '未找到 mosquitto_sub，可执行脚本前先确认 Mosquitto CLI 已加入 PATH。' }
if (-not (Get-Command mosquitto_pub -ErrorAction SilentlyContinue)) { throw '未找到 mosquitto_pub，可执行脚本前先确认 Mosquitto CLI 已加入 PATH。' }
$script:mosquittoPub = (Get-Command mosquitto_pub).Source

if (-not $CaFile -and $Protocol -eq 'mqtts') {
  $candidate = Join-Path (Split-Path -Path $PSScriptRoot -Parent) 'emqxsl-ca.crt'
  if (Test-Path $candidate) { $CaFile = $candidate }
}
if ($Protocol -eq 'mqtts' -and -not $CaFile -and -not $Insecure) {
  Write-Warning '未指定 CA 且未启用 -Insecure，脚本将使用 --insecure 连接以避免证书校验失败。'
  $Insecure = $true
}

$script:state = [ordered]@{
  lng = 116.397428
  lat = 39.90923
  speed = 12.5
  heading = 90
  altitude = 30
  accuracy = 5
  heart_rate = 86
  temperature = 28.6
  humidity = 61.2
  battery = 78
  low_power = $false
}

Write-Host "启动开发板替代脚本 (deviceId=$DeviceId)"
Write-Host "监听命令 topic: $TopicPrefix/$DeviceId/cmd"

$subArgs = New-CommandArgs -MqttQos 1
$subArgs += @('-t', "$TopicPrefix/$DeviceId/cmd", '-v')
$listener = Start-Job -Name 'helmet-device-cmd-listener' -ArgumentList @($mosquittoSub.Source, $subArgs) -ScriptBlock {
  param($exe, $args)
  & $exe @args
}

try {
  $supportsKeyPoll = Supports-KeyPolling
  if (-not $supportsKeyPoll) {
    Write-Host '当前终端不支持按键监听，将使用 Enter 输入模式（需手动回车选择）。'
  } else {
    Write-Host '按 1-9 或 q 任意时刻快速响应命令（无需回车）。按回车模式下可直接无感知处理刷新命令。'
    Show-Menu
  }

  while ($true) {
    if (-not (Process-IncomingCommands)) {
      # no command to process in this tick
    }

    Write-Host ''
    Write-Host "当前状态 => lng=$($script:state.lng), lat=$($script:state.lat), battery=$($script:state.battery), low_power=$($script:state.low_power), heart=$($script:state.heart_rate), temp=$($script:state.temperature), hum=$($script:state.humidity)"
    if ($supportsKeyPoll) {
      $choice = Read-CharChoice -TimeoutMs 250
      if (-not $choice) {
        continue
      }
      Show-Menu
    } else {
      Write-Host '1) 发送 telemetry'
      Write-Host '2) 发送 telemetry(含碰撞字段)'
      Write-Host '3) 手动发送 events/collision'
      Write-Host '4) 手动发送 events/sos'
      Write-Host '5) 更新经纬度'
      Write-Host '6) 更新电量'
      Write-Host '7) 更新传感器(心率/温度/湿度/速度/方向)'
      Write-Host '8) 切换 low_power'
      Write-Host '9) 发送设备主动 status（无需 cmdId）'
      Write-Host 'q) 退出'
      $choice = Read-Host '选择'
    }

    switch ($choice) {
      '1' {
        $topicTail = Read-Host 'telemetry 主题尾巴(默认 telemetry/gnss)'
        if ([string]::IsNullOrWhiteSpace($topicTail)) { $topicTail = 'telemetry/gnss' }
        $payload = New-TelemetryPayload
        Publish-Mqtt -Suffix $topicTail -Payload $payload -MqttQos 0
      }
      '2' {
        $topicTail = Read-Host 'telemetry 主题尾巴(默认 telemetry/gnss)'
        if ([string]::IsNullOrWhiteSpace($topicTail)) { $topicTail = 'telemetry/gnss' }
        $score = Read-IntNumber 'collision_score' 3.8
        $level = Read-Host 'collision_level (default high)'
        if ([string]::IsNullOrWhiteSpace($level)) { $level = 'high' }
        $payload = New-TelemetryPayload @{
          collision = $true
          collision_score = $score
          collision_level = $level
          message = 'collision detected'
        }
        Publish-Mqtt -Suffix $topicTail -Payload $payload -MqttQos 0
      }
      '3' { Send-CollisionEvent -EventType 'collision' }
      '4' { Send-CollisionEvent -EventType 'sos' }
      '5' {
        $script:state.lng = Read-IntNumber '请输入 lng' $script:state.lng
        $script:state.lat = Read-IntNumber '请输入 lat' $script:state.lat
      }
      '6' {
        $script:state.battery = Read-IntNumber '请输入 battery' $script:state.battery
      }
      '7' {
        $script:state.heart_rate = Read-IntNumber 'heart_rate' $script:state.heart_rate
        $script:state.temperature = Read-IntNumber 'temperature' $script:state.temperature
        $script:state.humidity = Read-IntNumber 'humidity' $script:state.humidity
        $script:state.speed = Read-IntNumber 'speed' $script:state.speed
        $script:state.heading = Read-IntNumber 'heading' $script:state.heading
      }
      '8' {
        $script:state.low_power = Read-BoolInput '设置 low_power' $script:state.low_power
      }
      '9' {
        $msg = Read-Host 'status.message (default manual status)'
        if ([string]::IsNullOrWhiteSpace($msg)) { $msg = 'manual status' }
        $payload = @{
          deviceId = $DeviceId
          ts = Get-NowMs
          online = $true
          status = 'manual'
          message = $msg
          battery = $script:state.battery
          low_power = $script:state.low_power
        }
        Publish-Mqtt -Suffix 'status' -Payload $payload -MqttQos 0
      }
      'q' { break }
      default {
        Write-Host '无效输入'
      }
    }
    if ($choice -eq 'q') { break }
  }
}
finally {
  if ($listener -and (Get-Job -Id $listener.Id -ErrorAction SilentlyContinue)) {
    Stop-Job -Job $listener -ErrorAction SilentlyContinue
    Remove-Job -Job $listener -ErrorAction SilentlyContinue
  }
  Write-Host '模拟器已退出，命令监听已关闭。'
}
