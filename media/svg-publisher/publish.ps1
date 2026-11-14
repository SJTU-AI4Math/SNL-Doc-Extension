$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    Add-Type -Path (Join-Path $PSScriptRoot 'Publisher.cs')
    [SnlSvgPublisher]::Publish($request.root, [string[]]@($request.files.name), [string[]]@($request.files.bytes))
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
