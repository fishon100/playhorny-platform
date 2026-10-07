<#
  跳出 Windows 通知，附上可點的預覽連結。
  用法：.\tools\notify.ps1 -Title "部署完成" -Message "已更新遊戲" -Links @{ "開啟遊戲" = "https://..." }
  手機推播（選用）：在 tools\notify.config.json 填入 {"ntfy_topic": "你的主題"}，並在手機安裝 ntfy App 訂閱同一主題。
#>
param(
    [Parameter(Mandatory)] [string]$Title,
    [string]$Message = "",
    [System.Collections.Specialized.OrderedDictionary]$Links = ([ordered]@{})
)

function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }

# ---- 電腦：Windows 通知（按鈕直接開啟連結）----
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $first = @($Links.Values)[0]
    $launch = if ($first) { " activationType=`"protocol`" launch=`"$(Esc $first)`"" } else { "" }
    $actions = ($Links.GetEnumerator() | Select-Object -First 5 | ForEach-Object {
        "<action content=`"$(Esc $_.Key)`" activationType=`"protocol`" arguments=`"$(Esc $_.Value)`"/>"
    }) -join ""
    $xml = "<toast$launch><visual><binding template=`"ToastGeneric`"><text>$(Esc $Title)</text><text>$(Esc $Message)</text></binding></visual><actions>$actions</actions></toast>"
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
    Write-Host "已送出電腦通知"
} catch {
    Write-Warning "電腦通知失敗：$($_.Exception.Message)"
}

# ---- 手機：ntfy 推播（選用）----
$cfgPath = Join-Path $PSScriptRoot "notify.config.json"
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.ntfy_topic) {
            $server = if ($cfg.ntfy_server) { $cfg.ntfy_server } else { "https://ntfy.sh" }
            $payload = [ordered]@{
                topic   = $cfg.ntfy_topic
                title   = $Title
                message = $Message
                tags    = @("video_game")
                actions = @($Links.GetEnumerator() | Select-Object -First 3 | ForEach-Object { @{ action = "view"; label = $_.Key; url = $_.Value } })
            }
            if (@($Links.Values)[0]) { $payload.click = @($Links.Values)[0] }
            $body = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 4 -Compress))
            Invoke-RestMethod -Method Post -Uri $server -Body $body -ContentType "application/json; charset=utf-8" | Out-Null
            Write-Host "已送出手機推播（ntfy）"
        }
    } catch {
        Write-Warning "手機推播失敗：$($_.Exception.Message)"
    }
}
