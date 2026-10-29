param(
    [Parameter(Mandatory = $true)]
    [string]$InputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$mapping = @()
Get-ChildItem -LiteralPath $InputDirectory -File |
    Where-Object { $_.Extension -in @('.wmf', '.emf') } |
    Sort-Object Name |
    ForEach-Object {
        $target = Join-Path $OutputDirectory ($_.BaseName + '.png')
        if ((Test-Path -LiteralPath $target) -and
            (Get-Item -LiteralPath $target).LastWriteTimeUtc -ge $_.LastWriteTimeUtc) {
            $mapping += [ordered]@{
                source = $_.FullName
                target = $target
                ok = $true
                cache_hit = $true
            }
        }
        else {
            $image = $null
            try {
                $image = [System.Drawing.Image]::FromFile($_.FullName)
                $image.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
                $mapping += [ordered]@{
                    source = $_.FullName
                    target = $target
                    width = $image.Width
                    height = $image.Height
                    ok = $true
                }
            }
            catch {
                $mapping += [ordered]@{
                    source = $_.FullName
                    target = $target
                    ok = $false
                    error = $_.Exception.Message
                }
            }
            finally {
                if ($null -ne $image) {
                    $image.Dispose()
                }
            }
        }
    }

ConvertTo-Json -InputObject $mapping -Depth 4 -Compress
