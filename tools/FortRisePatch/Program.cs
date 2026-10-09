// Usage: FortRisePatch <TowerFall.exe> <work dir>
// Sets up a FortRise folder in <work dir> the way the browser does (patch module, our FNA and
// Steamworks.NET stub) and runs the patch step.
using System;
using System.IO;
using Microsoft.Extensions.Logging;
using TowerFallBrowser;

string exe = Path.GetFullPath(args[0]);
string dir = Path.GetFullPath(args[1]);
string repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../.."));
Directory.CreateDirectory(dir);
File.Copy(Path.Combine(repo, "vendor/fortrise/data", FortRisePatcher.PatchModule), Path.Combine(dir, FortRisePatcher.PatchModule), true);
File.Copy(Path.Combine(repo, "vendor/FNA/bin/Release/net8.0/FNA.dll"), Path.Combine(dir, "FNA.dll"), true);
File.Copy(Path.Combine(repo, "vendor/check/stub/Steamworks.NET.dll"), Path.Combine(dir, "Steamworks.NET.dll"), true);
using ILoggerFactory loggers = LoggerFactory.Create(b => b.AddProvider(new PlainConsoleLoggerProvider()));
string version = File.ReadAllText(Path.Combine(repo, "vendor/fortrise/version.txt")).Trim();
Console.WriteLine(FortRisePatcher.EnsurePatched(exe, dir, version, loggers));
