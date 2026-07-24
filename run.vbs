Set WshShell = CreateObject("WScript.Shell")
Dim htmlPath
htmlPath = WshShell.CurrentDirectory & "\index.html"

' Create HTA application
Dim htaApp
Set htaApp = CreateObject("InternetExplorer.Application")
htaApp.Navigate "about:blank"
htaApp.ToolBar = 0
htaApp.StatusBar = 0
htaApp.Visible = 0

' Write HTML content
Dim fso, stream
Set fso = CreateObject("Scripting.FileSystemObject")
Set stream = fso.CreateTextFile(htmlPath, True)
stream.Write ""
stream.Close

' Launch as HTA for windowless transparent behavior
Dim cmd
cmd = "%SystemRoot%\System32\mshta.exe """ & htmlPath & """"
WshShell.Run cmd, 1, False
