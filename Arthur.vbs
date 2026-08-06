' Arthur's launcher.
'
' Starts the backend with no console window, waits for it to answer, then opens
' the UI in a chromeless Chrome window. This is what the Desktop and Start-menu
' shortcuts point at.
'
' VBScript rather than a .bat because a batch file always flashes a console
' window, and `Run ..., 0` here genuinely hides it - the whole point of the
' Phase 6 exit criterion is "zero terminal commands", and a black rectangle
' blinking on every launch fails that in spirit.
'
' Deliberately does NOT start Ollama. A second `ollama serve` grabs port 11434
' and leaves the tray app silently crash-looping; Ollama's own installer already
' puts it in Startup. If it is not up, Arthur loads and says so in the UI.

Option Explicit

Dim shell, fso, root, url, port
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
port = 5178
url = "http://localhost:" & port

' --- Already running? ---------------------------------------------------------
' Launching twice is the most likely mis-click once there is a desktop icon.
' The second copy would fail on the port anyway, so reuse the first: just open
' another window onto it.
If Not PortIsOpen(port) Then
    ' `cmd /c` so npm's shim resolves; window style 0 hides it entirely.
    shell.Run "cmd /c cd /d """ & root & "\backend"" && npm run serve", 0, False
    If Not WaitForPort(port, 90) Then
        MsgBox "Arthur's backend did not start." & vbCrLf & vbCrLf & _
               "Run setup.bat in " & root & " to install and build it.", _
               vbExclamation, "Arthur"
        WScript.Quit 1
    End If
End If

' --- Open the window ----------------------------------------------------------
Dim chrome
chrome = FindChrome()

If chrome = "" Then
    ' No Chrome: the app still works in whatever the default browser is, it just
    ' looks like a web page rather than a desktop app. Better than refusing.
    shell.Run url, 1, False
Else
    ' --app is what removes the address bar, tabs and browser chrome, and gives
    ' the window its own taskbar entry with Arthur's icon.
    shell.Run """" & chrome & """ --app=" & url, 1, False
End If

' ------------------------------------------------------------------- helpers --

Function FindChrome()
    Dim candidates, path, i
    candidates = Array( _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"))

    FindChrome = ""
    For i = 0 To UBound(candidates)
        path = candidates(i)
        If fso.FileExists(path) Then
            FindChrome = path
            Exit Function
        End If
    Next
End Function

' True when something is listening on the port.
'
' Uses netstat rather than opening a socket because VBScript has no socket, and
' a WinHTTP request to a dead port waits for a full connect timeout on every
' poll - which would make the loop below take minutes instead of seconds.
Function PortIsOpen(p)
    Dim exec, output
    Set exec = shell.Exec("cmd /c netstat -ano -p tcp | findstr LISTENING | findstr :" & p & " ")
    output = exec.StdOut.ReadAll()
    PortIsOpen = (InStr(output, ":" & p) > 0)
End Function

Function WaitForPort(p, seconds)
    Dim waited
    waited = 0
    Do While waited < seconds
        If PortIsOpen(p) Then
            WaitForPort = True
            Exit Function
        End If
        WScript.Sleep 500
        waited = waited + 0.5
    Loop
    WaitForPort = False
End Function
