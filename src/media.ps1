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

function Poll {
  $s = $script:mgr.GetCurrentSession()
  if (-not $s) { $script:last = ''; return '{}' }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $o = @{ title = $p.Title; artist = $p.Artist; status = "$($info.PlaybackStatus)"; canPrev = [bool]$info.Controls.IsPreviousEnabled; canNext = [bool]$info.Controls.IsNextEnabled }
  # the cover is read only when the track changed (the app remembers the last one)
  try { $tl = $s.GetTimelineProperties(); $po = $tl.Position.TotalSeconds; if ("$($info.PlaybackStatus)" -eq 'Playing') { $po += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds }; $o.pos = [int]$po; $o.end = [int]$tl.EndTime.TotalSeconds } catch {}
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
        $cur = $script:mgr.GetCurrentSession()
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
