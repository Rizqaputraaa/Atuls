param([string]$Last = '', [switch]$Loop)
# Windows "now playing". -Loop: one long-running process that answers one line on stdin with one JSON line on stdout (starting a new
# PowerShell every few seconds cost far more than the work itself). Without -Loop it answers once and exits.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
function Await($op, $type) {
  $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $t = $m.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result
}
$script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$script:last = $Last

# move the playback position by some seconds (for players that have no previous / next track, such as a podcast or a single video)
function Seek($sess, [double]$secs) {
  $info = $sess.GetPlaybackInfo()
  if (-not $info.Controls.IsPlaybackPositionEnabled) { return }
  $tl = $sess.GetTimelineProperties()
  $pos = $tl.Position.TotalSeconds
  if ("$($info.PlaybackStatus)" -eq 'Playing') { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds } # the timeline is a snapshot taken a moment ago
  $pos += $secs
  $end = $tl.EndTime.TotalSeconds
  if ($pos -lt 0) { $pos = 0 }
  if ($end -gt 0 -and $pos -gt $end) { $pos = $end }
  $null = Await ($sess.TryChangePlaybackPositionAsync([long]($pos * 10000000))) ([bool])
}

# Things the user does not want to count as music (a page such as Instagram or TikTok in the browser): words that are looked for in the title, the artist and
# the name of the program. A session that matches is skipped, so the music underneath keeps showing. The words come in ATULS_MEDIA_BLOCK, separated by |.
$script:block = @(([string]$env:ATULS_MEDIA_BLOCK).ToLower().Split('|') | Where-Object { $_ })
function PropsOf($sess) { Await ($sess.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) }
function IsBlocked($sess, $p) {
  if (-not $script:block.Count) { return $false }
  $hay = ("$($p.Title) $($p.Artist) $($sess.SourceAppUserModelId)").ToLower()
  foreach ($b in $script:block) { if ($hay.Contains($b)) { return $true } }
  return $false
}
# the session to show and to drive: the current one, unless it is blocked, then the first other one that is not
function PickSession {
  $cur = $script:mgr.GetCurrentSession()
  $list = @()
  if ($cur) { $list += $cur }
  if ($script:block.Count) { foreach ($x in $script:mgr.GetSessions()) { if (-not $cur -or $x.SourceAppUserModelId -ne $cur.SourceAppUserModelId) { $list += $x } } }
  foreach ($x in $list) { try { $px = PropsOf $x; if (-not (IsBlocked $x $px)) { return @{ s = $x; p = $px } } } catch {} }
  return $null
}

function Poll {
  $pick = PickSession
  if (-not $pick) { if ($script:mgr.GetCurrentSession()) { return '{"blocked":true}' } $script:last = ''; return '{}' } # something plays but the user ignores it: say so, the music that was showing stays
  $s = $pick.s; $p = $pick.p
  $info = $s.GetPlaybackInfo()
  $o = @{ title = $p.Title; artist = $p.Artist; status = "$($info.PlaybackStatus)"; canPrev = [bool]$info.Controls.IsPreviousEnabled; canNext = [bool]$info.Controls.IsNextEnabled }
  # the cover is read only when the track changed (the app remembers the last one)
  try { $tl = $s.GetTimelineProperties(); $po = $tl.Position.TotalSeconds; if ("$($info.PlaybackStatus)" -eq 'Playing') { $po += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds }; $o.pos = [math]::Round($po, 2); $o.end = [math]::Round($tl.EndTime.TotalSeconds, 1) } catch {}
  $key = "$($p.Title)|$($p.Artist)"
  if ($key -ne $script:last) {
    $script:last = $key
    $o.key = $key
    try {
      if ($p.Thumbnail) {
        $rs = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        # the stream object is a bare COM object in PowerShell, so the .NET bridge is called through reflection
        $mi = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
        $st = $mi.Invoke($null, @(,$rs))
        $ms = New-Object System.IO.MemoryStream
        $st.CopyTo($ms)
        if ($ms.Length -gt 0 -and $ms.Length -lt 3000000) { $o.thumb = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($ms.ToArray()) } else { $o.thumb = '' }
      } else { $o.thumb = '' }
    } catch { $o.thumb = ''; $o.thumbErr = "$($_.Exception.Message)" }
  }
  return ($o | ConvertTo-Json -Compress)
}

if ($Loop) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  # ReadLine returns null when the app has gone (the pipe closes), which ends this process: no orphan is left behind
  # a line is either empty (just answer) or a command for the player: play = pause/resume, next, prev. The player is driven through the
  # system's media session directly, which is instant and works for any player that shows up in the Windows media overlay.
  while ($null -ne ($cmd = [Console]::In.ReadLine())) {
    try {
      $c = $cmd.Trim()
      if ($c -eq 'play' -or $c -eq 'next' -or $c -eq 'prev') {
        $pk = PickSession; $cur = if ($pk) { $pk.s } else { $null }
        if ($cur) {
          if ($c -eq 'play') { $null = Await ($cur.TryTogglePlayPauseAsync()) ([bool]) }
          elseif ($c -eq 'next') { if ($cur.GetPlaybackInfo().Controls.IsNextEnabled) { $null = Await ($cur.TrySkipNextAsync()) ([bool]) } else { Seek $cur 10 } }
          else { if ($cur.GetPlaybackInfo().Controls.IsPreviousEnabled) { $null = Await ($cur.TrySkipPreviousAsync()) ([bool]) } else { Seek $cur -10 } }
          Start-Sleep -Milliseconds 150 # let the player update its state before it is read back
        }
      }
      $json = Poll
    } catch { $json = '{}' }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
} else {
  Poll
}
