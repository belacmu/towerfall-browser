using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace TowerFallBrowser;

// Produces TowerFall.Patch.dll the way the FortRise launcher does (FortLauncher/Program.cs Launch):
// clear the 32-bit flags on TowerFall.exe, then run FortRise's own FortRiseHandler.TryPatch, which
// MonoMods TowerFall.FortRise.mm.dll into it. The result is cached next to the patch module, keyed
// on the exact inputs, so it only reruns when the game or FortRise changes.
//
// Shared by the browser host and tools/FortRisePatch (the same code on desktop .NET, for testing).
public static class FortRisePatcher
{
	public const string PatchModule = "TowerFall.FortRise.mm.dll";
	public const string PatchFile = "TowerFall.Patch.dll";

	// Bump when BrowserFixups changes, so cached patches are redone.
	private const int FixupsVersion = 3;

	// fortriseDir holds TowerFall.FortRise.mm.dll plus the assemblies TowerFall.exe references
	// (FNA.dll, Steamworks.NET.dll); MonoMod resolves dependencies from the working directory.
	public static string EnsurePatched(string exePath, string fortriseDir, string fortriseVersion, ILoggerFactory loggers)
	{
		ILogger log = loggers.CreateLogger("FortRise");
		string patchFile = Path.Combine(fortriseDir, PatchFile);
		string stampFile = patchFile + ".inputs";
		string stamp = $"{fortriseVersion} fixups{FixupsVersion} {Sha256(exePath)} {Sha256(Path.Combine(fortriseDir, PatchModule))}";
		if (File.Exists(patchFile) && File.Exists(stampFile) && File.ReadAllText(stampFile) == stamp)
		{
			log.LogInformation("TowerFall.Patch.dll is up to date, skipping patch.");
			return patchFile;
		}

		using var exe = new MemoryStream();
		using (ModuleDefinition module = ModuleDefinition.ReadModule(exePath))
		{
			// What FortLauncher's Remove32BitFlagsPatcher does.
			module.Attributes &= ~(ModuleAttributes.Required32Bit | ModuleAttributes.Preferred32Bit);
			module.Write(exe);
		}
		exe.Position = 0;

		string previousDir = Directory.GetCurrentDirectory();
		Directory.SetCurrentDirectory(fortriseDir);
		try
		{
			var started = System.Diagnostics.Stopwatch.StartNew();
			var handler = new FortLauncher.FortRiseHandler(fortriseDir, new List<string>(), log, loggers);
			if (!handler.TryPatch(exe, patchFile))
			{
				throw new Exception("FortRise failed to patch TowerFall.exe (see the log above).");
			}
			log.LogInformation("Patched TowerFall.exe in {Seconds:0.0}s.", started.Elapsed.TotalSeconds);
			BrowserFixups(patchFile, log);
		}
		finally
		{
			Directory.SetCurrentDirectory(previousDir);
		}
		File.WriteAllText(stampFile, stamp);
		return patchFile;
	}

	// Browser-specific changes to the patched game, applied after FortRise's MonoMod pass: calls to
	// APIs that don't fit the browser are sent to TowerFallBrowser.BrowserShims instead.
	private static void BrowserFixups(string patchFile, ILogger log)
	{
		byte[] bytes = File.ReadAllBytes(patchFile);
		using var module = ModuleDefinition.ReadModule(new MemoryStream(bytes));
		var host = new AssemblyNameReference("TowerFallBrowser", new Version(1, 0, 0, 0));
		module.AssemblyReferences.Add(host);
		var shims = new TypeReference("TowerFallBrowser", "BrowserShims", module, host);
		var platform = new MethodReference("Platform", module.TypeSystem.String, shims);
		var location = new MethodReference("AssemblyLocation", module.TypeSystem.String, shims);
		location.Parameters.Add(new ParameterDefinition(module.ImportReference(typeof(System.Reflection.Assembly))));

		int platforms = 0, locations = 0;
		foreach (TypeDefinition type in module.GetTypes())
		{
			foreach (MethodDefinition method in type.Methods)
			{
				if (!method.HasBody) continue;
				foreach (Instruction instr in method.Body.Instructions)
				{
					if ((instr.OpCode != OpCodes.Call && instr.OpCode != OpCodes.Callvirt) || instr.Operand is not MethodReference called)
					{
						continue;
					}
					// The game picks save and content paths by asking SDL for the OS name; FortRise
					// already rewrote the game's SDL2 calls to SDL3.
					if (called.Name == "SDL_GetPlatform" && called.DeclaringType.FullName is "SDL3.SDL" or "SDL2.SDL")
					{
						instr.OpCode = OpCodes.Call;
						instr.Operand = platform;
						platforms++;
					}
					// FortRise's Relinker reads loaded assemblies' files via Assembly.Location.
					else if (called.Name == "get_Location" && called.DeclaringType.FullName == "System.Reflection.Assembly")
					{
						instr.OpCode = OpCodes.Call;
						instr.Operand = location;
						locations++;
					}
				}
			}
		}
		module.Write(patchFile);
		// MonoMod's symbols no longer match the rewritten module.
		File.Delete(Path.ChangeExtension(patchFile, ".pdb"));
		log.LogInformation("Browser fixups: {Platforms} platform checks and {Locations} assembly locations answered by the host.", platforms, locations);
	}

	private static string Sha256(string path)
	{
		using FileStream f = File.OpenRead(path);
		return Convert.ToHexString(SHA256.HashData(f));
	}
}

// Minimal console logging (Microsoft.Extensions.Logging's console logger uses a background
// queue thread and ANSI colors; plain Console.WriteLine is what we want in the browser).
public sealed class PlainConsoleLoggerProvider : ILoggerProvider
{
	public ILogger CreateLogger(string categoryName) => new Logger(categoryName);

	public void Dispose()
	{
	}

	private sealed class Logger(string category) : ILogger
	{
		public IDisposable BeginScope<TState>(TState state) where TState : notnull => null;

		// TOWERFALL_LOG=debug (the page's ?debug) includes debug output, e.g. FortRise's list of
		// Harmony patches and why mods were skipped.
		private static readonly LogLevel Minimum =
			Environment.GetEnvironmentVariable("TOWERFALL_LOG") == "debug" ? LogLevel.Debug : LogLevel.Information;

		public bool IsEnabled(LogLevel logLevel) => logLevel >= Minimum;

		public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception exception, Func<TState, Exception, string> formatter)
		{
			if (!IsEnabled(logLevel)) return;
			string line = $"[{logLevel}][{category}] {formatter(state, exception)}";
			if (exception != null) line += Environment.NewLine + exception;
			if (logLevel >= LogLevel.Warning) Console.Error.WriteLine(line);
			else Console.WriteLine(line);
		}
	}
}
