# Lists the Microsoft Store (packaged) apps of this user with the path of their logo, as JSON: [{name, id, logo}]
$ErrorActionPreference = 'SilentlyContinue'
$loc = @{}
Get-AppxPackage | ForEach-Object { $loc[$_.PackageFamilyName] = $_.InstallLocation }
$prefer = @('targetsize-48', 'targetsize-44', 'scale-200', 'scale-100', 'targetsize-32', 'targetsize-256', 'scale-400')
$out = @()
foreach ($a in Get-StartApps) {
  if ($a.AppID -notmatch '!') { continue }
  $pfn, $appid = $a.AppID -split '!', 2
  $dir = $loc[$pfn]
  $logo = ''
  if ($dir) {
    $mf = Join-Path $dir 'AppxManifest.xml'
    if (Test-Path $mf) {
      [xml]$x = Get-Content $mf -Raw
      $node = @($x.Package.Applications.Application) | Where-Object { $_.Id -eq $appid } | Select-Object -First 1
      if (-not $node) { $node = @($x.Package.Applications.Application)[0] }
      $rel = $node.VisualElements.Square44x44Logo
      if (-not $rel) { $rel = $node.VisualElements.SmallLogo }
      if ($rel) {
        $base = Join-Path $dir ($rel -replace '\.png$', '')
        $folder = Split-Path $base
        $leaf = Split-Path $base -Leaf
        $files = @(Get-ChildItem $folder -Filter "$leaf*.png" | Where-Object { $_.Name -notmatch 'altform|contrast' })
        if (-not $files.Count) { $files = @(Get-ChildItem $folder -Filter "$leaf*.png") }
        foreach ($p in $prefer) { $hit = $files | Where-Object { $_.Name -match [regex]::Escape($p) } | Select-Object -First 1; if ($hit) { $logo = $hit.FullName; break } }
        if (-not $logo -and $files.Count) { $logo = $files[0].FullName }
      }
    }
  }
  $out += [pscustomobject]@{ name = $a.Name; id = $a.AppID; logo = $logo }
}
ConvertTo-Json -InputObject @($out) -Compress
