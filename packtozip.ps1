$files = Get-ChildItem -Exclude ("*.zip","*.log")
Compress-Archive -DestinationPath GlitterDrag-AutoCompressed.zip -Path $files -Force -CompressionLevel Fastest
Write-Host "ѹ�����Ѵ���"