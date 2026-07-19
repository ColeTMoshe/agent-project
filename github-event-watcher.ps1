$ErrorActionPreference = 'Stop'

$Project = 'C:\Users\Marc\agent'
$Repository = 'ColeTMoshe/agent-project'
$StateDirectory = Join-Path $Project '.opencode'
$StateFile = Join-Path $StateDirectory 'github-watch-state.json'
$EventFile = Join-Path $StateDirectory 'github-events.json'
$LogFile = Join-Path $StateDirectory 'github-event-watcher.log'
$IntervalSeconds = 10
$MaxItems = 20

New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null

function Get-Snapshot {
  $issues = gh api "repos/$Repository/issues?state=all&per_page=$MaxItems" --jq '.[] | select(.pull_request == null) | {number, title, state, body, updated_at}' |
    ForEach-Object {
      $item = $_ | ConvertFrom-Json
      [ordered]@{ number = $item.number; title = $item.title; state = $item.state; body = $item.body; updated_at = $item.updated_at; comments = @(Get-GitHubComments $item.number) }
    }
  $pulls = gh api "repos/$Repository/pulls?state=all&per_page=$MaxItems" --jq '.[] | {number, title, state, body, updated_at}' |
    ForEach-Object {
      $item = $_ | ConvertFrom-Json
      [ordered]@{ number = $item.number; title = $item.title; state = $item.state; body = $item.body; updated_at = $item.updated_at; comments = @(Get-GitHubComments $item.number) }
    }
  $commits = gh api "repos/$Repository/commits?per_page=$MaxItems" --jq '.[] | {sha, message: .commit.message}' |
    ForEach-Object { $_ | ConvertFrom-Json }
  return [ordered]@{
    issues = @($issues)
    pull_requests = @($pulls)
    commits = @($commits)
  }
}

function Get-GitHubComments($Number) {
  gh api "repos/$Repository/issues/$Number/comments?per_page=$MaxItems" --jq '.[] | {id, timestamp: .created_at, username: .user.login, content: .body}' |
    ForEach-Object { $_ | ConvertFrom-Json }
}

function Get-Hash($Value) {
  $json = $Value | ConvertTo-Json -Depth 10 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Get-GitHubFingerprint($Snapshot) {
  $rows = @()
  $rows += @($Snapshot.issues | ForEach-Object { "issue|$($_.number)|$($_.state)|$($_.title)|$($_.body)|$((@($_.comments | Where-Object { $_.username -ne 'ColeTMoshe' }) | ForEach-Object { $_.id }) -join ',')" })
  $rows += @($Snapshot.pull_requests | ForEach-Object { "pull|$($_.number)|$($_.state)|$($_.title)|$($_.body)|$((@($_.comments | Where-Object { $_.username -ne 'ColeTMoshe' }) | ForEach-Object { $_.id }) -join ',')" })
  $rows += @($Snapshot.commits | ForEach-Object { "commit|$($_.sha)|$($_.message)" })
  return ($rows -join "`n")
}

function Get-ItemHashes($Snapshot) {
  $hashes = [ordered]@{}
  foreach ($item in @($Snapshot.issues)) {
    $commentIds = (@($item.comments | Where-Object { $_.username -ne 'ColeTMoshe' } | ForEach-Object { $_.id }) -join ',')
    $hashes["issue/$($item.number)"] = Get-Hash "issue|$($item.number)|$($item.state)|$($item.title)|$($item.body)|$commentIds"
  }
  foreach ($item in @($Snapshot.pull_requests)) {
    $commentIds = (@($item.comments | Where-Object { $_.username -ne 'ColeTMoshe' } | ForEach-Object { $_.id }) -join ',')
    $hashes["pull/$($item.number)"] = Get-Hash "pull|$($item.number)|$($item.state)|$($item.title)|$($item.body)|$commentIds"
  }
  foreach ($item in @($Snapshot.commits)) {
    $hashes["commit/$($item.sha)"] = Get-Hash "commit|$($item.sha)|$($item.message)"
  }
  return $hashes
}

function Get-ChangedItems($Current, $Previous) {
  $previousHashes = @{}
  if ($null -ne $Previous.item_hashes) {
    foreach ($property in $Previous.item_hashes.psobject.Properties) { $previousHashes[$property.Name] = [string]$property.Value }
  }
  $changes = @()
  foreach ($property in $Current.GetEnumerator()) {
    if ($previousHashes[$property.Key] -ne [string]$property.Value) { $changes += [ordered]@{ ref = $property.Key; hash = $property.Value } }
  }
  return @($changes)
}

function Write-NewCommentLogs($Snapshot, $Previous) {
  $knownGitHubIds = @($Previous.github_comment_ids)
  foreach ($item in @($Snapshot.issues) + @($Snapshot.pull_requests)) {
    foreach ($comment in @($item.comments)) {
      $key = "$($item.number)|$($comment.id)"
      if ($knownGitHubIds -notcontains $key) {
        [ordered]@{ kind = 'github_issue_comment'; timestamp = $comment.timestamp; username = $comment.username; id = $comment.id; source = $item.number; content = $comment.content } | ConvertTo-Json -Compress | Add-Content -LiteralPath $LogFile
      }
    }
  }
}

Write-Host "Watching $Repository every $IntervalSeconds seconds."
Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] Watching $Repository; latest $MaxItems GitHub items"

while ($true) {
  try {
    $snapshot = Get-Snapshot
    $githubHash = Get-Hash (Get-GitHubFingerprint $snapshot)
    $itemHashes = Get-ItemHashes $snapshot
    $hash = $githubHash
    $previous = if (Test-Path -LiteralPath $StateFile) {
      Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    } else { $null }

    if ($null -ne $previous) { Write-NewCommentLogs $snapshot $previous }

    $githubChanged = $null -ne $previous -and $previous.github_hash -ne $githubHash
    $needsCompactEvent = $null -ne $previous -and $null -eq $previous.item_hashes

    if ($githubChanged -or $needsCompactEvent) {
      $event = [ordered]@{
        detected_at = (Get-Date).ToUniversalTime().ToString('o')
        repository = $Repository
        previous_hash = $previous.hash
        current_hash = $hash
        trigger = if ($githubChanged) { 'github_change' } else { 'watcher_format_update' }
        changed = if ($githubChanged) { @(Get-ChangedItems $itemHashes $previous) } else { @() }
      }
      $event | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EventFile -Encoding utf8
      Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] Change detected ($($event.trigger)); updated $EventFile"
      Write-Host "[$(Get-Date -Format o)] GitHub change detected; updated $EventFile" -ForegroundColor Green
    }

    $githubCommentIds = @($snapshot.issues + $snapshot.pull_requests | ForEach-Object { $item = $_; @($item.comments | ForEach-Object { "$($item.number)|$($_.id)" }) })
    @{ hash = $hash; github_hash = $githubHash; github_comment_ids = $githubCommentIds; item_hashes = $itemHashes; checked_at = (Get-Date).ToUniversalTime().ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding utf8
  } catch {
    Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] GitHub check failed: $($_.Exception.Message)"
    Write-Warning "GitHub check failed: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $IntervalSeconds
}
